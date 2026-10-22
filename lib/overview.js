/**
 * lib/overview.js —— 只读概览：把一份档案算成面板要的那一个对象（archiveInfo）。
 *
 * 为什么从 index.js 里拆出来：它是「解析层 + 缓存读 + 指纹」三者的汇合点，既不属于
 * 纯解析（它要读盘），也不属于写盘。单列一份文件后，改概览字段既碰不到写盘守卫，
 * 也碰不到路由。
 */

import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, DIARY_FILE, GROWTH_FILE, STATE_FILE, STREAM_FILE } from './constants.js';
import { excerpt, mtimeOf, readCached, sizeOf } from './util.js';
import { diaryEntries, diaryMeta, growthSummary, isContiguous, readStream, sectionsOf, stateMeta } from './parse.js';
import { fingerprint } from './fs-guards.js';

/** 写入备份目录的规模 —— 没有保留策略，所以要让面板看得见（2026-10-21）。 */
function backupInfo(root) {
  const dir = path.join(root, BACKUP_DIR);
  let bytes = 0;
  let files = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        bytes += fs.statSync(path.join(dir, name)).size;
        files += 1;
      } catch {
        /* 单个文件读不到不影响总数 */
      }
    }
  } catch {
    /* 目录不存在 = 还没备份过 */
  }
  const limit = 200 * 1024 * 1024;
  return { bytes, files, warn: bytes > limit, limit };
}

// ─────────────────────────────────────────────────────────────── 概览

function archiveInfo(root) {
  const diaryFile = path.join(root, DIARY_FILE);
  const diaryText = readCached(diaryFile) ?? '';
  const entries = diaryEntries(diaryText);

  const stateFile = path.join(root, STATE_FILE);
  const stateText = readCached(stateFile) ?? '';
  const state = stateMeta(stateText);

  const growthFile = path.join(root, GROWTH_FILE);
  const growth = growthSummary(readCached(growthFile) ?? '');

  const streamFile = path.join(root, STREAM_FILE);
  const stream = readStream(readCached(streamFile) ?? '');

  return {
    root,
    generatedAt: new Date().toISOString(),
    backup: backupInfo(root),
    diary: {
      count: entries.length,
      first: entries.length ? entries[0].seq : null,
      last: entries.length ? entries[entries.length - 1].seq : null,
      contiguous: isContiguous(entries),
      meta: diaryMeta(diaryText),
      bytes: sizeOf(diaryFile),
      mtime: mtimeOf(diaryFile),
      fingerprint: fingerprint(diaryFile),
    },
    state: {
      sections: sectionsOf(stateText).length,
      lastUpdated: state.lastUpdated,
      diaryCount: state.diaryCount,
      moodBase: state.moodBase,
      unfinished: state.unfinished.length,
      bytes: sizeOf(stateFile),
      mtime: mtimeOf(stateFile),
      fingerprint: fingerprint(stateFile),
    },
    growth: {
      lines: growth.lines,
      records: growth.records,
      last: growth.entries.length ? excerpt(growth.entries[growth.entries.length - 1], 160) : null,
      bytes: sizeOf(growthFile),
      mtime: mtimeOf(growthFile),
      fingerprint: fingerprint(growthFile),
    },
    stream: {
      count: stream.length,
      last: stream.length ? stream[stream.length - 1].ts ?? null : null,
      bytes: sizeOf(streamFile),
      mtime: mtimeOf(streamFile),
    },
  };
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  archiveInfo,
};
