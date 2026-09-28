/**
 * lib/fs-guards.js —— 认根 + 写盘内核：指纹拒写 → 幂等跳过 → 改前备份 → 临时文件 + rename → 写完复核。
 *
 * 为什么从 index.js 里拆出来：这是全插件唯一允许落盘的地方（铺底另走 atomicWrite），
 * 也是「复核不过就把备份放回去、绝不留半成品」这条硬规矩的实现。把它跟业务写动作
 * 分开，是为了让「守卫」本身能被单独审查：读完这一份就能确认没有任何写入绕过它。
 *
 * 认根也放在这里：认根只认特征文件、认不出就返回 null 让使用者手填，跟写盘一样属于
 * 「路径与安全的底线」，不是业务解析。
 * 面板自选位置（后加）之后认根多了一级：面板状态文件里记的位置排在最前，但一样要过
 * 特征文件校验 —— 「面板选过」不是免检金牌。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHARACTER_FILES, DEFAULT_ROOT, BACKUP_DIR, DELETED_DIR } from './constants.js';
import { exists, expandHome, readCache, readText, safeFileName, stamp, statOf, toCrlf } from './util.js';
import { readPanelState } from './panel-state.js';

// ─────────────────────────────────────────────────────────────── 认根

/**
 * 认根只认特征文件：一个目录里同时有 身份.md + 日记.md + 生长\状态.md 才算档案根。
 * @returns 绝对路径；认不出返回 null（调用方必须让人手填，不许猜）。
 */
function detectRoot(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return null;
  const resolved = path.resolve(expandHome(candidate.trim()));
  const stat = statOf(resolved);
  if (!stat || !stat.isDirectory()) return null;
  return CHARACTER_FILES.every((rel) => exists(path.join(resolved, rel))) ? resolved : null;
}

/**
 * 认根优先级（面板自选位置之后）：
 *   面板状态文件（~/.dsh/memory-panel.json 的 root）→ 配置 root → DSH_MEMORY_ROOT → 默认 ~/.dsh/memory。
 * 每一级都拿特征文件验（跟 detectRoot 同一个判据），验不过就当这一级没配、往下一级走，
 * 并把「试过哪些、各自缺什么」原样摊开给面板，让使用者手填 —— 全程不猜、不写。
 *
 * 最后一级 default 就是「按特征文件自动识别」：detectRoot(DEFAULT_ROOT) 与它同一个判据。
 * source 是历史字段（'config.root' / 'DSH_MEMORY_ROOT' / 'default'，外部脚本在认），一个字没动；
 * 新增的 origin 是给面板显示"这个位置哪来的"（state / config / env / detected）。
 *
 * @param config 插件配置（这里只看 root）
 * @param options.stateFile 换一个面板状态文件路径（自检用，免得碰使用者的真状态文件）
 * @param options.state 直接传一份已读好的状态（自检用）
 */
function resolveRoot(config = {}, options = {}) {
  const state = options.state !== undefined ? options.state : readPanelState(options.stateFile);
  const candidates = [];
  if (state && typeof state.root === 'string' && state.root.trim() !== '') {
    candidates.push({ source: 'state', origin: 'state', value: state.root.trim() });
  }
  if (typeof config.root === 'string' && config.root.trim() !== '') {
    candidates.push({ source: 'config.root', origin: 'config', value: config.root.trim() });
  }
  if (typeof process.env.DSH_MEMORY_ROOT === 'string' && process.env.DSH_MEMORY_ROOT.trim() !== '') {
    candidates.push({ source: 'DSH_MEMORY_ROOT', origin: 'env', value: process.env.DSH_MEMORY_ROOT.trim() });
  }
  candidates.push({ source: 'default', origin: 'detected', value: DEFAULT_ROOT });

  const tried = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(expandHome(candidate.value));
    const missing = CHARACTER_FILES.filter((rel) => !exists(path.join(resolved, rel)));
    tried.push({ source: candidate.source, origin: candidate.origin, path: resolved, ok: missing.length === 0, missing });
    if (missing.length === 0) return { root: resolved, source: candidate.source, origin: candidate.origin, tried };
  }
  return { root: null, source: null, origin: null, tried };
}

// ─────────────────────────────────────────────────────────────── 写盘内核

/** 外部改动判据。写盘前对一次：变了就拒写，别盖掉别的设备刚同步过来的内容。 */
function fingerprint(file) {
  if (!exists(file)) return 'absent';
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 32)}`;
}

/** 写临时文件再 rename —— 不赌 write 工具的原子发布（档案里实测过间歇性 EINVAL）。 */
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, text, { encoding: 'utf8' });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* 清不掉临时文件不算写盘失败，报原错 */
    }
    throw error;
  }
  return file;
}

/** 改前备份到 `<根>\归档-旧版本与记录\写入备份\<名>.<时间戳>..bak`（沿用档案既有命名）。 */
function backupFile(file, root) {
  if (!exists(file)) return null;
  const dir = path.join(root, BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.basename(file, path.extname(file));
  const dest = path.join(dir, `${stem}.${stamp()}..bak`);
  fs.copyFileSync(file, dest);
  return dest;
}

/** 真删就把退路一起留：删掉的内容另存一份到 `<根>\归档-旧版本与记录\删除内容\`。 */
function archiveDeleted(root, name, text) {
  const dir = path.join(root, DELETED_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${safeFileName(name)}.${stamp()}.txt`);
  fs.writeFileSync(dest, toCrlf(text), { encoding: 'utf8' });
  return dest;
}

/**
 * 唯一的写盘入口。
 * @param file 目标文件绝对路径
 * @param root 档案根（备份落在这里）
 * @param expect 调用方读到的指纹；给了就比对，变了直接拒写
 * @param transform (currentText) => newText | null；返回 null 表示"本来就一样"，跳过
 * @param verify (nextText, beforeText) => boolean；先在内存里过一遍，写完再复核
 * @param backup 是否留备份（默认留；只有测试脚手架才关）
 */
function writeWithGuards({ file, root, expect, transform, verify, backup = true }) {
  if (!exists(file)) return { ok: false, reason: 'missing-file', file };
  const before = readText(file);
  const observed = fingerprint(file);
  if (expect !== undefined && expect !== null && expect !== '' && expect !== observed) {
    return { ok: false, reason: 'stale-fingerprint', file, fingerprint: observed };
  }
  const next = transform(before);
  if (next === null || next === before) return { ok: true, changed: false, reason: 'no-op', file };
  if (typeof verify === 'function' && verify(next, before) !== true) {
    return { ok: false, reason: 'verify-failed', file };
  }
  const saved = backup ? backupFile(file, root) : null;
  atomicWrite(file, next);
  const after = readText(file);
  if (after !== next) {
    if (saved) fs.copyFileSync(saved, file); // 复核不过就把原文放回去，不留半成品
    readCache.delete(file);
    return { ok: false, reason: 'verify-mismatch', file, backup: saved };
  }
  readCache.delete(file);
  return { ok: true, changed: true, file, backup: saved, bytes: Buffer.byteLength(after, 'utf8') };
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  detectRoot,
  resolveRoot,
  fingerprint,
  atomicWrite,
  backupFile,
  archiveDeleted,
  writeWithGuards,
};
