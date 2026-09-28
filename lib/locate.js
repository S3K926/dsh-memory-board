/**
 * lib/locate.js —— 「这个目录是不是一份档案」的判定（where）+ 认领（adopt）。
 *
 * 为什么单独一份文件：这是「面板自己选位置」这条新路的业务核心。只读判定与认领各一件事，
 * 却都不属于已有的解析 / 写盘 / 概览三块——塞进任何一个都会让那一块多背一个职责。
 *
 * 三条硬规矩（跟插件其它地方一个口径）：
 *   ①判定只读：一个字节都不写。认不出就不猜、更不许写；
 *   ②判定只认特征文件（身份.md + 日记.md + 生长\状态.md），少一个就是 partial，缺哪几个全列出来；
 *   ③认领要 confirm 原样等于路径（跟「真删要原样打序号」一个路子），而且只认 archive。
 *
 * counts 的四个数字跟概览 archiveInfo 同一口径（日记条数 / 状态节数 / 生长记录非空行数 /
 * 事件流条数）；文件不在就给 null —— 「拿不到」和「0 条」是两件事，不许编。
 */

import fs from 'node:fs';
import path from 'node:path';
import { CHARACTER_FILES, DIARY_FILE, GROWTH_FILE, STATE_FILE, STREAM_FILE } from './constants.js';
import { exists, expandHome, readCached, statOf, unsafeTargetPath } from './util.js';
import { diaryEntries, growthSummary, readStream, sectionsOf } from './parse.js';
import { panelStateFile, rememberRoot } from './panel-state.js';

// ─────────────────────────────────────────────────────────────── 数数字

/** 一个文件数一个数；文件不在（或读不动）就给 null，绝不用 0 冒充。 */
function countOf(file, count) {
  if (!exists(file)) return null;
  try {
    const text = readCached(file);
    return text === null ? null : count(text);
  } catch {
    return null;
  }
}

/** 一份档案的四个数字（口径同概览：档案缺哪个文件，哪个数字就是 null）。 */
function countsOf(root) {
  return {
    diary: countOf(path.join(root, DIARY_FILE), (text) => diaryEntries(text).length),
    sections: countOf(path.join(root, STATE_FILE), (text) => sectionsOf(text).length),
    growth: countOf(path.join(root, GROWTH_FILE), (text) => growthSummary(text).lines),
    events: countOf(path.join(root, STREAM_FILE), (text) => readStream(text).length),
  };
}

/** 目录里有没有条目；读不动就当空（反正那种目录判出来也不会是 archive）。 */
function entryCountOf(dir) {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────── 判定

/**
 * 判一个候选路径是什么（只读，不写任何东西）。
 *   archive 三个特征文件齐 → 带 counts
 *   empty   目录不存在，或存在但一个条目都没有
 *   partial 存在、不空、但缺特征文件 → missing 列全（「不空又认不出」，绝不在这里写）
 *   missing 路径给得不合法（空 / 不是字符串）→ root 为 null
 * 路径指向一个文件（不是目录）也按 partial 报：它不是档案，同样一个字都不写。
 * @returns { ok, kind, root, missing, counts, note? }
 */
function inspectPath(candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return { ok: true, kind: 'missing', root: null, missing: [], counts: null, reason: 'path-required' };
  }
  const root = path.resolve(expandHome(candidate.trim()));
  const stat = statOf(root);
  const missing = CHARACTER_FILES.filter((rel) => !exists(path.join(root, rel)));
  if (!stat) return { ok: true, kind: 'empty', root, missing, counts: null, note: '这个目录还不存在（铺底会把它建出来）' };
  if (!stat.isDirectory()) return { ok: true, kind: 'partial', root, missing, counts: null, note: '这个路径是个文件，不是目录' };
  if (missing.length === 0) return { ok: true, kind: 'archive', root, missing: [], counts: countsOf(root) };
  if (entryCountOf(root) === 0) return { ok: true, kind: 'empty', root, missing, counts: null };
  return { ok: true, kind: 'partial', root, missing, counts: null };
}

// ─────────────────────────────────────────────────────────────── 认领

/**
 * 认领一个位置：只有判定成 archive 才写面板状态文件（写在插件自己的 json 里，不碰档案）。
 *
 * 这道写盘刻意**不接面板写入开关**：那个开关管的是「改使用者的档案」，而这里只改插件自己的
 * memory-panel.json；更何况配置默认 readOnly:true，接上去等于新装的机器根本没法选位置。
 * 但 confirm 必须原样等于 path —— 防手滑那一道不减。
 *
 * @param path 候选目录（原样比对 confirm 用它，不用解析后的绝对路径）
 * @param confirm 必须原样等于 path
 * @param device 设备标签（可空，空就沿用状态文件里原有的）
 * @param file 状态文件路径（自检用）
 */
function adoptRoot({ path: candidate, confirm, device = null, file = panelStateFile() } = {}) {
  const report = inspectPath(candidate);
  if (report.kind !== 'archive') {
    return {
      ok: false,
      reason: 'not-archive',
      kind: report.kind,
      root: report.root,
      missing: report.missing,
      counts: report.counts,
      hint: '只有三个特征文件齐全的目录才能认领；认不出就不写、不猜。',
    };
  }
  if (String(confirm ?? '') !== String(candidate)) {
    return { ok: false, reason: 'confirm-mismatch', kind: report.kind, root: report.root, expected: candidate, hint: '确认框里必须原样打出这个路径。' };
  }
  // 2026-09-28 安全修复：认领会把 root 写进面板状态文件，而它决定后续备份 / 删除归档的落点 ——
  // 所以这里也要过一遍路径边界（系统目录 / 盘符根 / 带 .. 的路径一律不认）。
  const unsafe = unsafeTargetPath(String(candidate ?? ''), report.root);
  if (unsafe !== '') {
    return { ok: false, reason: unsafe, kind: report.kind, root: report.root, hint: '系统目录 / 盘符根 / 带 .. 的路径不能当档案根。' };
  }
  const saved = rememberRoot({ root: report.root, device, file });
  if (!saved.ok) {
    return { ok: false, reason: 'state-write-failed', kind: report.kind, root: report.root, error: saved.reason, stateFile: saved.file };
  }
  return {
    ok: true,
    kind: 'archive',
    root: report.root,
    source: 'state',
    counts: report.counts,
    device: saved.device,
    updatedAt: saved.updatedAt,
    stateFile: saved.file,
  };
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  countOf,
  countsOf,
  entryCountOf,
  inspectPath,
  adoptRoot,
};