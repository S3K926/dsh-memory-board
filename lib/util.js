/**
 * lib/util.js —— 通用小工具 + 带 mtime 缓存的只读读盘。
 *
 * 为什么从 index.js 里拆出来：读文本、判存在、行尾/归一化、时间戳、readCached
 * 几乎每个模块都要用，是最底层的一层。它们不依赖常量、解析、写盘，所以单列成
 * 叶子模块，谁都能 import 而不成环。
 *
 * readCache 仍然是进程级单例：所有模块共用同一份缓存，写盘成功后由 fs-guards
 * 统一删键失效（跟拆分前是同一个 Map，语义没变）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─────────────────────────────────────────────────────────────── 通用小工具

/** 只读一处文本；顺手剥掉 BOM（档案是无 BOM 的，但别人给的副本未必）。 */
function readText(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function statOf(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

const sizeOf = (file) => statOf(file)?.size ?? null;

const mtimeOf = (file) => {
  const stat = statOf(file);
  return stat ? stat.mtime.toISOString() : null;
};

const splitLines = (text) => text.split(/\r?\n/);
const eolOf = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const joinLines = (lines, eol) => lines.join(eol);
const toCrlf = (text) => text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

/** 比对正文时用的归一化：抹掉行尾差异与行末空格，免得"只差一个 CR"被当成改动。 */
const normalize = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

const toInt = (value) => {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Windows 文件名里不能出现的字符。删掉的东西要留底，留底的名字得能落盘。 */
const safeFileName = (value) => String(value ?? '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);

function stamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function trimTrailingBlank(lines) {
  const out = [...lines];
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/** 删完一段后收尾：文件尾不留两行以上空行（否则每删一次就多攒一行）。 */
function collapseTailBlank(lines) {
  const out = [...lines];
  let end = out.length;
  while (end > 0 && out[end - 1].trim() === '') end -= 1;
  return out.length - end > 1 ? [...out.slice(0, end), ''] : out;
}

const excerpt = (value, length = 140) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
};

// ─────────────────────────────────────────────────────────────── 带 mtime 缓存的读

const readCache = new Map();

/** 日记 / 状态都是几百 KB，进程没改过就不重读。 */
function readCached(file) {
  const stat = statOf(file);
  if (!stat) {
    readCache.delete(file);
    return null;
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = readCache.get(file);
  if (hit && hit.key === key) return hit.text;
  const text = readText(file);
  readCache.set(file, { key, text });
  return text;
}

/**
 * 「这个绝对路径能不能当档案根 / 铺底目标」的边界检查（2026-09-28 安全修复）。
 *
 * 起因：`/api/memory/init` 与 `/api/memory/adopt` 的目标路径**完全由请求方给**，
 * 而铺底与认领都会真的往那个目录写（骨架文件；认领还会记进面板状态文件，
 * 从而决定后续每一次备份与"删除内容的归档"落在哪）。原来只拒绝"已是档案 / 文件已存在"，
 * 不拒绝位置 —— 组合起来就是"往任意新建目录写文件树"。
 *
 * 三道最便宜的闸，正常用法一点不受影响（自家档案目录都在这三条之外）：
 *   ① 原始输入带 `..` → 拒（归一化之前先看一眼，免得"看着在自家目录里"）；
 *   ② 盘符根 / 文件系统根 → 拒；
 *   ③ 系统目录（Windows / Program Files / ProgramData，以及 Unix 那批）→ 拒。
 *
 * @returns {string} '' 表示通过；否则是原因码。
 */
function unsafeTargetPath(input, resolved) {
  if (typeof resolved !== 'string' || resolved.trim() === '') return 'path-required';
  if (/(^|[\\/])\.\.([\\/]|$)/.test(String(input))) return 'path-escape';
  const norm = resolved.replace(/[\\/]+$/, '');
  if (norm === '' || norm === '/' || /^[a-zA-Z]:$/.test(norm)) return 'drive-root';
  const winLower = norm.replace(/\//g, '\\').toLowerCase();
  const winBanned = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata', 'c:\\$recycle.bin'];
  if (winBanned.some((b) => winLower === b || winLower.startsWith(b + '\\'))) return 'system-dir';
  const unixBanned = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys', '/var', '/library', '/system', '/applications'];
  if (unixBanned.some((b) => norm === b || norm.startsWith(b + '/'))) return 'system-dir';
  return '';
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  readText,
  unsafeTargetPath,
  exists,
  statOf,
  sizeOf,
  mtimeOf,
  splitLines,
  eolOf,
  joinLines,
  toCrlf,
  normalize,
  toInt,
  safeFileName,
  stamp,
  expandHome,
  trimTrailingBlank,
  collapseTailBlank,
  excerpt,
  readCache,
  readCached,
};
