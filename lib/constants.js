/**
 * lib/constants.js —— 全插件的常量总表：档案路径形状、特征文件、路由表、同步白名单。
 *
 * 为什么从 index.js 里拆出来：这些常量被解析、写盘、铺底、路由、自检五块共用，
 * 留在 index.js 就会让每个模块反过来 import 装配层（成环）。它们不依赖任何别的
 * 模块，放在依赖图最底层最安全。值一个都没改。
 *
 * 唯一动了的一行是 HERE：本文件搬到了 lib/ 下，所以插件根改成往上一级推；
 * 推出来的绝对路径与拆分前的 HERE 完全一致，TEMPLATES_DIR 因此一字不变。
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────── 常量

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // 本文件在 lib/ 下，插件根是上一级

/**
 * Harness 家目录：`$DSH_HOME` 优先，缺省才回落 `~/.dsh`。
 * 便携部署（U 盘随身版）与多实例共存时家目录不在 `~/.dsh`；
 * 写死会把插件自己的状态落到宿主机家目录，跟着盘走的东西反而留在别人电脑上。
 */
function harnessHome() {
  const override = process.env.DSH_HOME;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return path.join(os.homedir(), '.dsh');
}

/** 默认档案根。绝不硬编码个人路径：可用配置 root 或 DSH_MEMORY_ROOT 覆盖。 */
const DEFAULT_ROOT = path.join(harnessHome(), 'memory');

/** 认根的特征文件：三个齐了才算一个档案根。 */
const CHARACTER_FILES = ['身份.md', '日记.md', path.join('生长', '状态.md')];
const DIARY_FILE = '日记.md';
const STATE_FILE = path.join('生长', '状态.md');
const GROWTH_FILE = path.join('生长', '生长记录.md');
const STREAM_FILE = path.join('记忆', '事件流.jsonl');

const ARCHIVE_DIR = '归档-旧版本与记录';
const BACKUP_DIR = path.join(ARCHIVE_DIR, '写入备份');
const DELETED_DIR = path.join(ARCHIVE_DIR, '删除内容');

/** 铺底要建的目录树。 */
const ARCHIVE_SUBDIRS = ['生长', '记忆', '档案', '文档', ARCHIVE_DIR, '数据集'];

/** 铺底要写的 6 件骨架（身份 / 开场 / 日记 / 状态 / 生长记录 / 事件流），键是相对档案根的 POSIX 形式。 */
const TEMPLATE_FILES = ['身份.md', '开场.md', '日记.md', '生长/状态.md', '生长/生长记录.md', '记忆/事件流.jsonl'];

/** 自带模板目录（四级优先级的最后一级）。 */
const TEMPLATES_DIR = path.join(HERE, 'templates', 'basic');

/**
 * 面板自己选位置的状态文件（相对家目录；绝对路径 = harnessHome() + 这一串）。
 * 为什么单独一个文件：认档案只认特征文件，认「面板选过哪个位置」只认这一个 json——
 * 它属于插件自己，不属于用户的档案；面板写盘也只写这一个文件，永不写档案。
 */
const PANEL_STATE_FILE = 'memory-panel.json';

/** 新设备骨架的占位设备名与占位标记。 */
const PLACEHOLDER_DEVICE = '【新设备】';
const PLACEHOLDER_MARK = '【占位】';

/** 日记六字段（full 格式），顺序即档案里的顺序。 */
const DIARY_FIELDS = ['event_description', 'user_mood', 'mood_tags', 'notes', 'lively_details', 'mood_tail'];

/**
 * 同步白名单。恢复.py / 备份.py / 自主轮次.py **永不放行**：
 * 它们没有干跑闸门、会整份覆盖权威文件、会删历史包——它们不是"危险"，是"没有退路"。
 */
const SYNC_SCRIPTS = Object.freeze({
  合并记忆: '合并记忆.py',
  合并日记: '合并日记.py',
  合并状态: '合并状态.py',
  回流包: '回流包.py',
});

/** 真合并的超时：合并可能比干跑久得多。 */
const SYNC_TIMEOUT_MS = 180000;
/** 干跑超时：只是数条数、算指纹。 */
const DRYRUN_TIMEOUT_MS = 60000;

const API_PREFIX = '/api/memory';

const ROUTE_PATHS = [
  '/api/memory/info',
  '/api/memory/summary',
  '/api/memory/diary',
  '/api/memory/diary/append',
  '/api/memory/diary/delete',
  '/api/memory/state',
  '/api/memory/state/edit',
  '/api/memory/state/delete',
  '/api/memory/events',
  '/api/memory/search',
  '/api/memory/health',
  '/api/memory/write',
  '/api/memory/write/status',
  '/api/memory/growth/append',
  '/api/memory/init',
  '/api/memory/sync/status',
  '/api/memory/sync/dryrun',
  '/api/memory/sync/merge',
  // 面板自选位置（后加）：where 只读判定一个候选目录，adopt 认领一个已有档案。
  '/api/memory/where',
  '/api/memory/adopt',
];

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  DEFAULT_ROOT,
  harnessHome,
  CHARACTER_FILES,
  DIARY_FILE,
  STATE_FILE,
  GROWTH_FILE,
  STREAM_FILE,
  ARCHIVE_DIR,
  BACKUP_DIR,
  DELETED_DIR,
  ARCHIVE_SUBDIRS,
  TEMPLATE_FILES,
  TEMPLATES_DIR,
  PANEL_STATE_FILE,
  PLACEHOLDER_DEVICE,
  PLACEHOLDER_MARK,
  DIARY_FIELDS,
  SYNC_SCRIPTS,
  SYNC_TIMEOUT_MS,
  DRYRUN_TIMEOUT_MS,
  API_PREFIX,
  ROUTE_PATHS,
};
