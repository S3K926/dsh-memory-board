/**
 * lib/parse.js —— 纯文本解析：日记条目 / 六字段 / 元信息表格、状态分节、生长记录、事件流、只读搜索。
 *
 * 为什么从 index.js 里拆出来：这一层只吃字符串、吐数据结构，不碰文件系统也不写盘。
 * 单列成模块后，「解析」与「写盘」的边界就是文件边界，改解析不会误伤写盘守卫，
 * 反过来也一样。所有函数与正则逐字搬过来，一个字符都没动。
 */

import { splitLines, eolOf, trimTrailingBlank, toInt } from './util.js';

// ─────────────────────────────────────────────────────────────── 日记解析

/**
 * 日记标题有两种形状，都用全角 ｜ 分隔：
 *   4 段 `### #N ｜ 日期 ｜ 时间 ｜ full`（早期条目）
 *   5 段 `### #N ｜ 日期 ｜ 时间 ｜ 【设备】 ｜ full`（后来加了设备标签）
 * 所以按分隔符切段再认，不用固定段数正则——那样会把【设备】吃进 format。
 */
function parseDiaryTitle(line) {
  const match = /^###[ \t]*#([0-9]+)[ \t]*[｜|][ \t]*(.*)$/.exec(line);
  if (!match) return null;
  const parts = match[2].split(/[｜|]/).map((part) => part.trim());
  const seq = Number(match[1]);
  if (parts.length >= 4) return { seq, date: parts[0], time: parts[1], device: parts[2], format: parts[3] };
  if (parts.length === 3) return { seq, date: parts[0], time: parts[1], device: '', format: parts[2] };
  return null;
}

const FIELD_LINE = /^\*\*([A-Za-z0-9_]+)\*\*[ \t]*$/;
const RULE_LINE = /^---[ \t]*$/;

/** 字段正文到"下一个字段行"或"整行 ---"为止；条目切分不看 ---（不是每条都有）。 */
function fieldsOf(bodyLines) {
  const fields = {};
  let name = null;
  let buffer = [];
  const flush = () => {
    if (name !== null) fields[name] = buffer.join('\n').replace(/\s+$/, '');
  };
  for (const line of bodyLines) {
    const match = FIELD_LINE.exec(line);
    if (match) {
      flush();
      buffer = [];
      name = match[1];
      continue;
    }
    if (RULE_LINE.test(line)) break;
    if (name !== null) buffer.push(line);
  }
  flush();
  return fields;
}

/**
 * 切日记条目。切分一律按标题行——`---` 在日记里只出现三十来处，靠它切会漏。
 * start/end 是**原始行号**，写入时按行号动刀，不做字符串拼接。
 */
function diaryEntries(text) {
  const lines = splitLines(text);
  const eol = eolOf(text);
  const heads = [];
  lines.forEach((line, index) => {
    const meta = parseDiaryTitle(line);
    if (meta) heads.push({ ...meta, start: index });
  });
  return heads.map((head, index) => {
    const end = index + 1 < heads.length ? heads[index + 1].start : lines.length;
    return {
      ...head,
      start: head.start,
      end,
      title: lines[head.start],
      fields: fieldsOf(lines.slice(head.start + 1, end)),
      text: trimTrailingBlank(lines.slice(head.start, end)).join(eol),
    };
  });
}

/** 一条日记的原文（按原始行号取，逐字不动）。 */
function entryText(text, entry) {
  return trimTrailingBlank(splitLines(text).slice(entry.start, entry.end)).join(eolOf(text));
}

/** 元信息是两列表格 `| 字段 | 值 |`；字段名可能是 **包着的**。 */
function diaryMeta(text) {
  const cell = (name) => {
    const re = new RegExp(`^\\|[ \\t]*\\*{0,2}${name}\\*{0,2}[ \\t]*\\|[ \\t]*(.*?)[ \\t]*\\|[ \\t]*$`, 'm');
    const match = re.exec(text);
    return match ? match[1].replace(/\*\*/g, '').trim() : null;
  };
  return {
    lastDiarySeq: toInt(cell('last_diary_seq')),
    totalCount: toInt(cell('total_count')),
    diaryVersion: cell('diary_version'),
    // 面板/脚本读回时习惯叫 `version`（2026-09-25 实测发现：只给 diaryVersion 时，
    // 外部脚本读 `.version` 永远拿到 undefined）。两个名字都给，谁读都不落空。
    version: cell('diary_version'),
    owner: cell('owner_character'),
  };
}

function isContiguous(entries) {
  return entries.every((entry, index) => index === 0 || entry.seq === entries[index - 1].seq + 1);
}

/** 概览：条数 / 序号范围 / 连续性 / 元信息。 */
function diarySummary(text) {
  const entries = diaryEntries(text);
  return {
    count: entries.length,
    first: entries.length ? entries[0].seq : null,
    last: entries.length ? entries[entries.length - 1].seq : null,
    contiguous: isContiguous(entries),
    meta: diaryMeta(text),
  };
}

// ─────────────────────────────────────────────────────────────── 状态 / 生长记录 / 事件流解析

const SECTION_HEAD = /^##[ \t]+(\S.*?)[ \t]*$/;

/**
 * 切状态节。跳过代码围栏与 HTML 注释——状态.md 顶上那段很长的 yaml 块与文件头注释里
 * 出现过看着像标题的行，不跳就会多出假节。
 * @returns [{ index, start, end, title, body }]，index/start 是标题行的原始行号。
 */
function sectionsOf(text) {
  const lines = splitLines(text);
  const eol = eolOf(text);
  const marks = [];
  let fence = false;
  let comment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (fence) {
      if (trimmed.startsWith('```')) fence = false;
      return;
    }
    if (trimmed.startsWith('```')) {
      fence = true;
      return;
    }
    if (comment) {
      if (trimmed.includes('-->')) comment = false;
      return;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) comment = true;
      return;
    }
    const match = SECTION_HEAD.exec(line);
    if (match) marks.push({ index, title: match[1] });
  });
  return marks.map((mark, index) => {
    const end = index + 1 < marks.length ? marks[index + 1].index : lines.length;
    return {
      index: mark.index,
      start: mark.index,
      end,
      title: mark.title,
      body: trimTrailingBlank(lines.slice(mark.index + 1, end)).join(eol),
    };
  });
}

function sectionRaw(text, section) {
  return splitLines(text).slice(section.start, section.end).join(eolOf(text));
}

/**
 * 节的"内容指纹"（标题 + 正文，忽略收尾空行）。
 * 断言"别的节一字不动"时用它：真正的内容变化躲不掉，纯空行增减不误报。
 */
function sectionSignature(text, section) {
  return trimTrailingBlank(splitLines(text).slice(section.start, section.end)).join('\n');
}

/** 顶部 yaml 块的四个顶层字段；unfinished 是块列表，必须由 ``` 收尾（记忆库.py 就靠这个边界）。 */
function stateMeta(text) {
  const block = /```yaml\r?\n([\s\S]*?)\r?\n```/.exec(text);
  const source = block ? block[1] : text;
  const pick = (name) => {
    const match = new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(source);
    return match ? match[1].trim() : null;
  };
  return {
    lastUpdated: pick('last_updated'),
    diaryCount: toInt(pick('diary_count')),
    moodBase: pick('mood_base'),
    unfinished: unfinishedOf(source),
    hasUnfinished: /^unfinished:/m.test(source),
  };
}

function unfinishedOf(source) {
  const start = source.indexOf('unfinished:');
  if (start < 0) return [];
  const tail = source.slice(start);
  const stop = tail.indexOf('\n```');
  const body = stop < 0 ? tail : tail.slice(0, stop);
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('-'))
    .map((line) => line.trim());
}

const GROWTH_LINE = /^\d{4}-\d{2}-\d{2}/;

/** 生长记录一行一条、行首是日期；续行不算新记录，所以两个数都报出来。 */
function growthSummary(text) {
  const lines = splitLines(text).filter((line) => line.trim() !== '');
  const records = lines.map((line) => line.trim()).filter((line) => GROWTH_LINE.test(line));
  return { lines: lines.length, records: records.length, entries: records };
}

/** 事件流一行一条 JSON。坏行跳过而不是炸掉整块面板——旧行不能改，只能容忍。 */
function readStream(text) {
  const out = [];
  for (const line of splitLines(text)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      out.push({ id: '(坏行)', kind: '?', content: trimmed, broken: true, ts: null });
    }
  }
  return out;
}

/**
 * 只读过滤事件流：空格分词、全部命中才算命中。
 * 刻意不调 `生长\记忆.py search` —— 那个命令在索引过期时会重建索引，而
 * `记忆.py context` 更是会往事件流里追加（名字像只读，其实写盘）。
 */
function searchStream(text, query, limit = 50) {
  const terms = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const entries = readStream(text);
  if (terms.length === 0) return { total: 0, hits: [], scanned: entries.length, terms };
  const hits = entries.filter((entry) => {
    const haystack = JSON.stringify(entry).toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return { total: hits.length, hits: hits.slice(0, limit), scanned: entries.length, terms };
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  parseDiaryTitle,
  fieldsOf,
  diaryEntries,
  entryText,
  diaryMeta,
  isContiguous,
  diarySummary,
  sectionsOf,
  sectionRaw,
  sectionSignature,
  stateMeta,
  unfinishedOf,
  growthSummary,
  readStream,
  searchStream,
};
