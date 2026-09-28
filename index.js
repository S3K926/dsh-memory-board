/**
 * dsh-memory-board ——（2026-09-27 改名；旧名 dsh-memory-panel） Host 半边：薄装配层（只剩 name / inject / apply 与对外导出面）。
 *
 * 本文件拆分前有 2056 行，什么都塞在一起。这次按职责切进 lib/，一个模块一件事：
 *   lib/constants.js   常量总表（档案路径形状、特征文件、路由表、同步白名单）
 *   lib/util.js        通用小工具 + 带 mtime 缓存的只读读盘
 *   lib/parse.js       纯文本解析（日记 / 状态节 / 生长记录 / 事件流 / 只读搜索）
 *   lib/fs-guards.js   认根 + 写盘内核（指纹拒写 → 幂等 → 备份 → 临时文件 + rename → 复核）
 *   lib/writes.js      具体写操作（追加日记 / 生长记录、改节正文、真删条目 / 节）
 *   lib/scaffold.js    新设备铺底（模板四级优先级 + 内置兜底骨架 BUILTIN_SKELETONS）
 *   lib/sync.js        同步（只调白名单里的 Python 脚本）+ 同步现状 syncStatus
 *   lib/overview.js    只读概览 archiveInfo
 *   lib/panel-state.js 面板自己选的位置（~/.dsh/memory-panel.json 的读写，认根的第一优先级）
 *   lib/locate.js      位置判定（where：archive/empty/partial/missing）与认领（adopt）
 *   lib/router.js      20 条路由的组装 + createRuntime + createWriteApi
 *   lib/selftest.js    模块层自检（node index.js --selftest）
 * 这里只剩三件事：声明 name / inject、apply 注册路由、把上面所有对外符号 re-export。
 * 搬家的规矩是行为零变化：正则、文案、常量值、路径语义、导出面一律没动。
 *
 * 为什么解析与写盘内核都在模块层、而不是塞进 apply()：
 * 独立跑 `node index.js --selftest` 时 cordis 不会调 apply，写进去就等于死代码
 * （原版第一版就栽在这儿：自检一声不吭）。所以 apply() 只做一件事——注册路由。
 *
 * 读写硬规矩（跟档案里那几条走）：
 *   ①认根只认特征文件（身份.md + 日记.md + 生长\状态.md），认不出就报错让使用者手填，不猜；
 *   ②写盘一律：指纹拒写 → 幂等跳过 → 改前备份 → 临时文件 + rename → 写完复核；
 *   ③复核不过就把备份放回去，绝不留下半成品；
 *   ④事件流只读，身份.md / 开场.md 只读；
 *   ⑤行尾一律 CRLF、编码一律 UTF-8 无 BOM（档案里那三个 Python 脚本只认这个口味）。
 *
 * 一切个人路径都从配置 / 环境变量 / 家目录推，代码里不写死任何人的档案目录。
 */

import { createRouter, createRuntime } from './lib/router.js';
import { runSelftest } from './lib/selftest.js';

/**
 * 插件名与服务声明。
 *
 * ⚠ 2026-09-25 真机上被这条打回两次（重写这一版最容易踩的坑）：
 * 1) 没导出 `name` / `inject` → `ctx.connection.fetch.register` 报
 *    `cannot get property "connection" without inject`，**18 条路由一条都没挂上**（自检 81/81 却全绿 ——
 *    自检只验逻辑，不验"真实 cordis 里拿不拿得到服务"）。
 * 2) 写成 `{ required: ['connection'] }` → 插件整个卡在 `pending (waiting for service: required)`，
 *    因为**本机 cordis 的 inject 是数组**（官方插件都是 `export const inject = ['typert', 'connection']`）。
 */
export const name = 'memory-panel';
export const inject = ['connection'];

/**
 * Host 半边：只注册路由。
 * @param ctx cordis 上下文
 * @param config 本机 cordis.patch.yml 里那一行的 config
 */
function apply(ctx, config = {}) {
  const runtime = createRuntime(config);
  runtime.log(`apply 进入（readOnly=${runtime.settings.readOnly} root=${runtime.settings.root ?? '(未配，按特征文件认)'}）`);
  for (const route of createRouter(runtime)) {
    try {
      ctx.connection.fetch.register({ path: route.path, methods: route.methods, requestBody: 'buffered', fetch: route.fetch });
      runtime.log(`路由已注册：${route.methods.join('/')} ${route.path}`);
    } catch (error) {
      runtime.log(`路由注册失败：${route.path} —— ${error && error.message ? error.message : String(error)}`);
    }
  }
}

if (process.argv.includes('--selftest')) {
  const roots = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  process.exitCode = runSelftest(roots[0]) ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────── 对外导出

// 这 6 个名字是被外部脚本 import 的既有接口，一个都不能少
export { initArchiveRoot } from './lib/scaffold.js';
export { detectRoot } from './lib/fs-guards.js';
export { diarySummary, diaryEntries, sectionsOf, searchStream } from './lib/parse.js';

// 写盘内核（命令行脚本复用同一套实现，别另抄一份）
export { writeWithGuards, atomicWrite, backupFile, fingerprint } from './lib/fs-guards.js';
export { appendGrowthLine, appendDiaryEntry } from './lib/writes.js';
export { DEFAULT_ROOT } from './lib/constants.js';

// 另一半可复用的面
export { resolveRoot } from './lib/fs-guards.js';
export { entryText, diaryMeta, sectionRaw, stateMeta, growthSummary, readStream } from './lib/parse.js';
export { editStateSection, deleteDiaryEntry, deleteStateSection } from './lib/writes.js';
export { syncStatus, syncArgv, scriptPathOf, runSyncScript } from './lib/sync.js';
export { archiveInfo } from './lib/overview.js';
export { createRouter, createRuntime } from './lib/router.js';
export { resolveTemplatesDir } from './lib/scaffold.js';

// 面板自选位置（后加）：判定一个目录是什么 / 认领一个已有档案 / 面板状态文件读写
export { inspectPath, countsOf, adoptRoot } from './lib/locate.js';
export { panelStateFile, readPanelState, writePanelState, rememberRoot } from './lib/panel-state.js';
export { SYNC_SCRIPTS, ROUTE_PATHS, CHARACTER_FILES, DIARY_FIELDS, ARCHIVE_SUBDIRS, TEMPLATE_FILES, PLACEHOLDER_MARK } from './lib/constants.js';

export { apply };
