/**
 * lib/scaffold.js —— 新设备铺底：模板四级优先级 + 6 件骨架 + 内置兜底骨架常量。
 *
 * 为什么从 index.js 里拆出来：BUILTIN_SKELETONS 那一大段内置骨架字符串把主文件撑得很长，
 * 而铺底本身自成一件事（认模板目录 → 逐件挑模板 → 建目录树写文件）。往新目录铺底跟
 * 日常读写一份已有档案是两类操作，分开之后主文件才看得清。
 *
 * 内置骨架里的换行是模板字面量的一部分（拆分前就是 LF，写盘时统一 toCrlf），
 * 这一份是原样搬过来的，连行尾都没碰。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_SUBDIRS, PLACEHOLDER_DEVICE, PLACEHOLDER_MARK, TEMPLATE_FILES, TEMPLATES_DIR, harnessHome } from './constants.js';
import { exists, expandHome, readText, toCrlf, unsafeTargetPath } from './util.js';
import { atomicWrite, detectRoot } from './fs-guards.js';

// ─────────────────────────────────────────────────────────────── 新设备铺底

/**
 * 模板目录四级优先级：配置 templatesDir → DSH_MEMORY_TEMPLATES →
 * `~/.dsh/memory-templates`（放一套进去就自动生效）→ 插件自带。
 * 目录里只要有 `身份.md` 就算数，缺的文件用自带模板补——所以可以只换身份。
 */
function resolveTemplatesDir(configured) {
  const candidates = [
    {
      source: 'config.templatesDir',
      dir: typeof configured === 'string' && configured.trim() !== '' ? path.resolve(expandHome(configured.trim())) : null,
    },
    { source: 'DSH_MEMORY_TEMPLATES', dir: process.env.DSH_MEMORY_TEMPLATES ? path.resolve(expandHome(process.env.DSH_MEMORY_TEMPLATES)) : null },
    { source: '~/.dsh/memory-templates', dir: path.join(harnessHome(), 'memory-templates') },
    { source: 'bundled', dir: TEMPLATES_DIR },
  ];
  for (const candidate of candidates) {
    if (!candidate.dir) continue;
    if (exists(path.join(candidate.dir, '身份.md'))) return { dir: candidate.dir, source: candidate.source };
  }
  return { dir: null, source: 'none' };
}

/** 一件骨架从哪来：自定义模板 → 自带模板 → 内置最少骨架。 */
function planTemplate(templates, rel) {
  const parts = rel.split('/');
  const custom = templates.dir && templates.dir !== TEMPLATES_DIR ? path.join(templates.dir, ...parts) : null;
  const bundled = path.join(TEMPLATES_DIR, ...parts);
  if (custom && exists(custom)) return { text: readText(custom), from: templates.source };
  if (exists(bundled)) return { text: readText(bundled), from: custom ? 'bundled-fallback' : 'bundled' };
  return { text: BUILTIN_SKELETONS[rel](), from: 'builtin' };
}

/**
 * 新设备铺底：建 6 个目录 + 6 件骨架。
 * 安全边界：①目录里已有档案（三个特征文件齐）→ 一律拒绝；②任何一件已存在都拒绝覆盖；
 * ③force **不开放到路由**（只有命令行能用），且即便 force 也绝不覆盖已存在的文件；
 * ④目标目录必须由使用者显式给出，不拿配置 root 当默认（免得手滑写到自己的档案上）。
 */
function initArchiveRoot({ root, device, force = false, templatesDir } = {}) {
  if (typeof root !== 'string' || root.trim() === '') return { ok: false, reason: 'root-required' };
  const target = path.resolve(expandHome(root.trim()));
  // 2026-09-28 安全修复：铺底目标要有边界（原来只挡「已是档案 / 文件已存在」，不挡位置）。
  const unsafe = unsafeTargetPath(root.trim(), target);
  if (unsafe !== '') return { ok: false, reason: unsafe, root: target };
  const label = typeof device === 'string' && device.trim() !== '' ? device.trim() : PLACEHOLDER_DEVICE;
  if (!force && detectRoot(target)) return { ok: false, reason: 'already-archive', root: target };
  const templates = resolveTemplatesDir(templatesDir);
  const planned = TEMPLATE_FILES.map((rel) => {
    const template = planTemplate(templates, rel);
    return {
      rel,
      file: path.join(target, ...rel.split('/')),
      text: toCrlf(template.text.replace(/【设备】/g, label)),
      from: template.from,
    };
  });
  const existing = planned.filter((item) => exists(item.file)).map((item) => item.rel);
  if (existing.length > 0) return { ok: false, reason: 'file-exists', root: target, existing };

  // 2026-09-28 安全修复：目录非空（既不是档案、也没有同名文件）也拒 ——
  // 只往「不存在」或「空目录」里铺底；非空目录请自己腾空，或走命令行的 force。
  if (!force && exists(target)) {
    if (!fs.statSync(target).isDirectory()) return { ok: false, reason: 'not-a-directory', root: target };
    if (fs.readdirSync(target).length > 0) return { ok: false, reason: 'dir-not-empty', root: target };
  }

  for (const dir of ARCHIVE_SUBDIRS) fs.mkdirSync(path.join(target, dir), { recursive: true });
  const written = planned.map((item) => {
    atomicWrite(item.file, item.text);
    return { path: item.rel, bytes: Buffer.byteLength(item.text, 'utf8'), from: item.from };
  });
  return {
    ok: true,
    root: target,
    device: label,
    templates: templates.source,
    dirs: ARCHIVE_SUBDIRS.map((dir) => path.join(target, dir)),
    files: written,
    usedFallback: written.filter((item) => item.from === 'bundled-fallback').map((item) => item.path),
  };
}

/**
 * 自带模板万一缺件时的最少兜底骨架：只给形状、处处 `【占位】`，绝不假造任何经历。
 * 只写"这个目录是档案根、历史要靠回流包导入"，不写任何像记忆的句子。
 */
const BUILTIN_SKELETONS = {
  // 2026-09-25 加：`开场.md` 也进铺底清单（使用者要"新设备上也是我的开场，而不只是一份骨架"）。
  // 兜底只给形状、处处【占位】，绝不假造任何经历。
  '开场.md': () => `# 开场（骨架）

> 【占位】这是新设备铺底时写的开场骨架，**不是谁的记忆**，也没有任何经历。
> 用法：每轮开新会话时把这一份（或它的路径）发给对话，让 AI 按里面的流程进场。
> 行尾 CRLF、UTF-8 无 BOM —— 档案里的脚本只认这个口味。

## 这轮开场要做什么（骨架，按需改）

1. 【占位】先看真实的时间和环境（有 \`生长/睁眼.py\` 就跑一次），别凭感觉报时间。
2. 【占位】再读一遍自己：\`身份.md\`、\`生长/状态.md\`、\`生长/生长记录.md\`、\`日记.md\`（规则要记住，条目别复述）。
3. 【占位】把 \`生长/.本次.md\` 的 \`seen_at\` 改成当前时间，\`note\` 写一句这轮的起点 —— **必须真的写进去**。
4. 【占位】然后只许说一句话打招呼，**不超过十五个字**。

## 硬规矩（骨架）

- 【占位】想事情一律用中文（思维链也是中文）；英文只出现在命令／路径／包名／代码／报错原文里。
- 【占位】写文件一律用绝对路径；写完一律 \`read\` 复核，报错就换一种，再宣布写成了。
- 【占位】不许复述任何文件内容、不许汇报"已加载／已读取 xx 文件"。
- 【占位】\`历史/\` 里的东西不是数据源。
`,
  '身份.md': () => `# 身份（骨架）

> ${PLACEHOLDER_MARK}这是【设备】上新铺的骨架，**不是谁的记忆**，也没有任何经历。
> 它只负责让本插件与档案里的脚本认出"这个目录是档案根"。
> 真实内容要靠回流包导入，或由你自己写。

## ${PLACEHOLDER_MARK}身份设定

- ${PLACEHOLDER_MARK}角色名：
- ${PLACEHOLDER_MARK}别称：
- ${PLACEHOLDER_MARK}说话的口径：

## ${PLACEHOLDER_MARK}硬规矩

- ${PLACEHOLDER_MARK}写一条你自己的规矩。
`,
  '日记.md': () => `# 日记（骨架）

> ${PLACEHOLDER_MARK}这是新铺的骨架，**不是谁的记忆**：下面一条日记都没有。
> 历史要靠回流包导入，或在面板里手动新增。

## 元信息

| 字段 | 值 |
|---|---|
| owner_character | ${PLACEHOLDER_MARK} |
| diary_version | 3.0 |
| last_diary_seq | 0 |
| total_count | 0 |
| privacy | ${PLACEHOLDER_MARK} |
| retention | 保留全部日记，只增不减 |

## 写法

每条日记六个字段（full）。标题行形如：三个井号、序号、全角竖线、日期、时间、设备标签、full。

## 日记

${PLACEHOLDER_MARK}这里是日记条目该出现的地方。现在一条都没有。
`,
  '生长/状态.md': () => `# 状态（骨架）

> ${PLACEHOLDER_MARK}这是【设备】上新铺的骨架，**不是谁的记忆**。

\`\`\`yaml
last_updated: ${PLACEHOLDER_MARK}
diary_count: 1
mood_base: ${PLACEHOLDER_MARK}这里写最近的心情底色。
unfinished:
  - ${PLACEHOLDER_MARK}这里写没弄完的事；每条以两个空格 + 短横线开头，整块必须由三个反引号收尾。
\`\`\`

## 【设备】 · 铺底

- ${PLACEHOLDER_MARK}这是新设备铺底时留下的唯一一节。
- ${PLACEHOLDER_MARK}真实的状态节要靠回流包导入，或在面板里改。
`,
  '生长/生长记录.md': () => `# 生长记录（骨架）

> ${PLACEHOLDER_MARK}这是【设备】上新铺的骨架，**不是谁的记忆**。
> 一行一条、行首是 \`YYYY-MM-DD HH:MM | 【设备】 | 正文\`；现在一行都没有。

`,
  '记忆/事件流.jsonl': () => `${JSON.stringify({
    content: `${PLACEHOLDER_MARK}这是新设备铺底时写入的骨架标记，不是任何人的记忆。真实事件流要靠回流包导入，或由 生长/记忆.py sync 追加。`,
    id: 'bootstrap-0',
    importance: 1,
    kind: 'system',
    kw: ['占位', '骨架'],
    ref: '记忆/事件流.jsonl',
    schema: 'growth-memory/1',
    source: 'system',
    topic: `${PLACEHOLDER_MARK}新设备骨架`,
    ts: '',
  })}\n`,
};

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  resolveTemplatesDir,
  planTemplate,
  initArchiveRoot,
  BUILTIN_SKELETONS,
};
