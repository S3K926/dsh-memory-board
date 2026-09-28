/**
 * lib/sync.js —— 同步：只调白名单里的 Python 脚本（干跑 / 真跑），外加只读的同步现状。
 *
 * 为什么从 index.js 里拆出来：这一块的规矩跟别处不一样——本插件不自己实现合并，
 * 只负责「按硬编码白名单起脚本、把报告原样带回去」。单独成文件后，白名单、
 * argv 规则（干跑绝不带 --apply）与超时值一眼可见，不会跟档案读写混在一起。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DRYRUN_TIMEOUT_MS, SYNC_SCRIPTS } from './constants.js';
import { exists, readCached, splitLines, statOf } from './util.js';

// ─────────────────────────────────────────────────────────────── 同步（调脚本，不自己重写）

let pythonCache;

/** 本机 python 命令：py → python → python3，命中即缓存。 */
function resolvePython() {
  if (pythonCache !== undefined) return pythonCache;
  pythonCache = null;
  for (const candidate of ['py', 'python', 'python3']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
    if (!probe.error && probe.status === 0) {
      pythonCache = candidate;
      break;
    }
  }
  return pythonCache;
}

function scriptPathOf(root, which) {
  const name = SYNC_SCRIPTS[which];
  return name ? path.join(root, '生长', name) : null;
}

/** 跑脚本时的环境：**强制 Python 用 UTF-8 输出**。
 * 不加这条：Windows 上中文报告按 GBK 输出，面板按 UTF-8 读 → 整片乱码（2026-09-27 实测，
 * 干跑报告里"没有要合并的来源"变成一串问号）。PYTHONIOENCODING 只管 Python 自己的 stdout/stderr，
 * 不改脚本行为、也不影响档案。 */
function pythonEnv() {
  return { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
}

/** 干跑/真跑的 argv。干跑**明确不带 --apply** —— 这条单独抽出来就是为了能被自检断言。 */
function syncArgv(script, apply) {
  return apply ? [script, '--apply'] : [script];
}

/** 只跑白名单里的脚本。 */
function runSyncScript(root, which, { apply = false, timeoutMs = DRYRUN_TIMEOUT_MS } = {}) {
  const script = scriptPathOf(root, which);
  if (!script) return { ok: false, reason: 'not-allowed', which };
  if (!exists(script)) return { ok: false, reason: 'script-missing', which, script };
  const python = resolvePython();
  if (!python) return { ok: false, reason: 'python-missing', which, script };
  const started = Date.now();
  const result = spawnSync(python, syncArgv(script, apply), {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    cwd: path.dirname(script),
    env: pythonEnv(),
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: !result.error && result.status === 0,
    which,
    script,
    python,
    applied: apply,
    exitCode: result.status,
    signal: result.signal ?? null,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message) : null,
  };
}

function safeReaddir(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const stat = statOf(path.join(dir, name));
      return stat && stat.isFile() ? { name, size: stat.size, mtime: stat.mtime.toISOString() } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.mtime.localeCompare(left.mtime));
}

function tailLines(file, count) {
  const text = readCached(file);
  if (text === null) return [];
  return splitLines(text)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count);
}

/** 同步现状（只读）：包、三个收件箱、两份日志的末尾。下划线开头的说明文件不算数据。 */
function syncStatus(root) {
  const packages = safeReaddir(path.join(root, '档案'))
    .filter((entry) => /\.(zip|md)$/i.test(entry.name) && !entry.name.startsWith('_'))
    .map((entry) => ({ name: entry.name, size: entry.size, mtime: entry.mtime }));
  const inboxes = [
    { label: '记忆\\待合并', dir: path.join(root, '记忆', '待合并'), pattern: /\.jsonl$/i },
    { label: '记忆\\待合并日记', dir: path.join(root, '记忆', '待合并日记'), pattern: /\.md$/i },
    { label: '记忆\\待合并状态', dir: path.join(root, '记忆', '待合并状态'), pattern: /\.md$/i },
  ].map((box) => {
    const files = safeReaddir(box.dir)
      .filter((entry) => box.pattern.test(entry.name) && !entry.name.startsWith('_'))
      .map((entry) => entry.name);
    return { label: box.label, count: files.length, files };
  });
  const logs = [
    { label: '记忆\\同步日志.md', file: path.join(root, '记忆', '同步日志.md') },
    { label: '记忆\\合并记录.md', file: path.join(root, '记忆', '合并记录.md') },
  ].map((item) => ({ label: item.label, exists: exists(item.file), tail: tailLines(item.file, 8) }));
  return { packages, inboxes, logs, whitelist: Object.keys(SYNC_SCRIPTS) };
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  resolvePython,
  scriptPathOf,
  syncArgv,
  runSyncScript,
  safeReaddir,
  tailLines,
  syncStatus,
};
