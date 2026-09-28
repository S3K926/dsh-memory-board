/**
 * lib/writes.js —— 具体写操作：追加日记 / 追加生长记录、改状态节正文、真删日记条目 / 状态节。
 *
 * 为什么从 index.js 里拆出来：这些是「业务写动作」，全部必须经由 fs-guards 的
 * writeWithGuards 落盘。把它们与写盘内核分开放，是为了让「谁在写、写什么」和
 * 「怎么写才安全」各占一份文件。渲染、内容指纹、幂等判据都随条目操作一起搬过来。
 *
 * 三道防线（备份 / 删除内容留底 / confirm 原样打名字）一个字都没动。
 */

import path from 'node:path';
import { DIARY_FIELDS, DIARY_FILE, GROWTH_FILE, STATE_FILE } from './constants.js';
import { collapseTailBlank, eolOf, exists, joinLines, normalize, readText, splitLines, trimTrailingBlank } from './util.js';
import { diaryEntries, diaryMeta, entryText, sectionRaw, sectionSignature, sectionsOf } from './parse.js';
import { archiveDeleted, writeWithGuards } from './fs-guards.js';

// ─────────────────────────────────────────────────────────────── 具体写操作

/** 往生长记录末尾追加一行（行首带日期；续行不属于记录行）。 */
function appendGrowthLine({ root, line, expect }) {
  const text = String(line ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (text === '') return { ok: false, reason: 'empty-line' };
  const file = path.join(root, GROWTH_FILE);
  const result = writeWithGuards({
    file,
    root,
    expect,
    transform(before) {
      if (splitLines(before).some((item) => item.trim() === text)) return null; // 幂等：同一行不写第二遍
      const eol = eolOf(before);
      const sep = before.endsWith('\n') ? '' : eol;
      return `${before}${sep}${text}${eol}`;
    },
    verify(next) {
      return splitLines(next).filter((item) => item.trim() === text).length === 1;
    },
  });
  return { ...result, line: text };
}

/** lively_details 的每行都要带短横线；渲染与判重共用这一份。 */
function detailLines(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith('-') ? line : `- ${line}`));
}

const PENDING_FIELD = {
  event_description: (entry) => entry.event,
  user_mood: (entry) => entry.userMood,
  mood_tags: (entry) => entry.moodTags,
  notes: (entry) => entry.notes,
  lively_details: (entry) => detailLines(entry.details).join('\n'),
  mood_tail: (entry) => entry.moodTail,
};

/**
 * 一条日记的"内容指纹"：六字段归一化后拼起来。
 * 幂等靠它，不靠序号——序号是"下一条"的编号，同一个请求第二次来时序号已经往前走了，
 * 拿序号判重等于永远判不出重复。
 */
function entrySignature(entry) {
  const values = entry.fields
    ? DIARY_FIELDS.map((name) => entry.fields[name])
    : DIARY_FIELDS.map((name) => PENDING_FIELD[name](entry));
  return values.map((value) => normalize(value)).join('\u0000');
}

/**
 * 日记条目的日期 / 时间 / 设备：**替使用者兜住形状**（2026-09-27 使用者第一次点表单验收后加的）。
 * 由来：日期格填了 `ddd` 就被原样写进标题、设备格空着标题就少一段 —— 用户没填不该变成
 * "档案里形状不对"。日期/时间**只收固定格式、不对就拒**（不悄悄改成今天：使用者填错时想知道自己填错了）；
 * 设备**空着才补默认**，win32 上补 `【PC】`（手机侧若要补 其他设备，得那台自己的宿主来定，别照搬）。
 */
function normalizeDiaryEntry(entry) {
  const date = String(entry.date ?? '').trim();
  const time = String(entry.time ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: 'bad-date', hint: `日期要写 YYYY-MM-DD（收到「${date || '空'}」）；留空＝用今天（表单会替你填）。` };
  }
  const dateCheck = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dateCheck.getTime()) || dateCheck.toISOString().slice(0, 10) !== date) {
    return { error: 'bad-date', hint: `日期不是真实存在的一天：${date}` };
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    return { error: 'bad-time', hint: `时间要写 HH:MM（收到「${time || '空'}」）；留空＝用现在（表单会替你填）。` };
  }
  const [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59) return { error: 'bad-time', hint: `时间超出范围：${time}` };
  const given = String(entry.device ?? '').trim().replace(/^[【\[]|[】\]]$/g, '').trim();
  const device = given ? `【${given}】` : process.platform === 'win32' ? '【PC】' : '';
  return { entry: { ...entry, date, time, device } };
}

/** 渲染一条六段式日记（标题按档案既有形状：5 段带设备、4 段不带）。开头的空行属于标题的分隔，写在这里。 */
function renderDiaryBlock(entry, eol = '\r\n') {
  const head = entry.device
    ? `### #${entry.seq} ｜ ${entry.date} ｜ ${entry.time} ｜ ${entry.device} ｜ full`
    : `### #${entry.seq} ｜ ${entry.date} ｜ ${entry.time} ｜ full`;
  const block = [
    '',
    head,
    '',
    '**event_description**',
    String(entry.event ?? ''),
    '',
    '**user_mood**',
    String(entry.userMood ?? ''),
    '',
    '**mood_tags**',
    String(entry.moodTags ?? ''),
    '',
    '**notes**',
    String(entry.notes ?? ''),
    '',
    '**lively_details**',
    ...detailLines(entry.details),
    '',
    '**mood_tail**',
    String(entry.moodTail ?? ''),
  ];
  return `${block.join(eol)}${eol}${eol}`;
}

/** 元信息里改一格，保留原来的加粗装饰。找不到就报错停手，绝不猜着改。 */
function replaceTableValue(text, name, value) {
  const re = new RegExp(`^(\\|[ \\t]*(?:\\*\\*)?${name}(?:\\*\\*)?[ \\t]*\\|[ \\t]*)(.*?)([ \\t]*\\|[ \\t]*)$`, 'm');
  if (!re.test(text)) throw new Error(`元信息里找不到字段：${name}`);
  return text.replace(re, (whole, head, old, tail) => {
    const bold = old.includes('**') || head.includes('**');
    return `${head}${bold ? `**${value}**` : value}${tail}`;
  });
}

/**
 * `diary_version` 的第二位**只在总篇数为 2 的倍数时 +1**（奇数篇不动）。
 * 这条规则写在档案自己的日记.md 里，是按使用者定的规矩办，不是凭直觉升版本。
 */
function bumpDiaryVersion(version, count) {
  if (typeof version !== 'string' || version.trim() === '') return version;
  const parts = version.split('.');
  if (parts.length < 2) return version;
  if (count % 2 !== 0) return version;
  const second = Number(parts[1]);
  if (!Number.isFinite(second)) return version;
  parts[1] = String(second + 1);
  return parts.join('.');
}

/** 元信息两处数字跟着 +1；日记版本按上面那条规则走。 */
function bumpDiaryMeta(text, newCount) {
  const meta = diaryMeta(text);
  let out = replaceTableValue(text, 'last_diary_seq', String(newCount));
  out = replaceTableValue(out, 'total_count', String(newCount));
  const nextVersion = bumpDiaryVersion(meta.diaryVersion, newCount);
  if (nextVersion && nextVersion !== meta.diaryVersion) out = replaceTableValue(out, 'diary_version', nextVersion);
  return { text: out, version: nextVersion };
}

/**
 * 追加一条日记：条目接在末尾（序号升序、旧的在前），元信息两处 +1。
 * 既有条目一个字都不动——包括重复调用时那条刚落盘的自己。
 */
function appendDiaryEntry({ root, entry, expect }) {
  const file = path.join(root, DIARY_FILE);
  if (!exists(file)) return { ok: false, reason: 'missing-file', file };
  const shaped = normalizeDiaryEntry(entry);
  if (shaped.error) return { ok: false, reason: shaped.error, hint: shaped.hint };
  const clean = shaped.entry;
  const before = readText(file);
  const meta = diaryMeta(before);
  const seq = (meta.lastDiarySeq ?? 0) + 1;
  const eol = eolOf(before);
  const block = renderDiaryBlock({ ...clean, seq }, eol);
  const signature = entrySignature(clean);
  const beforeEntries = diaryEntries(before);
  const result = writeWithGuards({
    file,
    root,
    expect,
    transform(text) {
      const existing = diaryEntries(text);
      // 幂等：同一条内容不写第二遍；序号被占也不硬塞。
      if (existing.some((item) => entrySignature(item) === signature || item.seq === seq)) return null;
      const bumped = bumpDiaryMeta(text, seq);
      // block 自带前导空行；这里只补"正文末尾恰好一个换行"，多的不补、少的不吞
      const sep = bumped.text.endsWith('\n') ? '' : eol;
      return `${bumped.text}${sep}${block}`;
    },
    verify(next) {
      const after = diaryEntries(next);
      if (after.length !== beforeEntries.length + 1) return false;
      if (after.filter((item) => item.seq === seq).length !== 1) return false;
      if (after[after.length - 1].seq !== seq) return false; // 必须加在最后
      const originals = new Map(beforeEntries.map((item) => [item.seq, entryText(before, item)]));
      return after.every((item) => item.seq === seq || originals.get(item.seq) === entryText(next, item));
    },
  });
  return {
    ...result,
    seq,
    title: block.split(eol)[0],
    version: bumpDiaryVersion(meta.diaryVersion ?? meta.version, seq),
  };
}

function replaceSectionBody(text, section, body) {
  const lines = splitLines(text);
  const head = lines.slice(0, section.start);
  const tail = lines.slice(section.end);
  const bodyLines = trimTrailingBlank(String(body ?? '').split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, '')));
  return joinLines([...head, lines[section.start], '', ...bodyLines, '', ...tail], eolOf(text));
}

/**
 * 改状态节的**正文**：标题行原样保留、别的节一字不动。
 * 刻意不做"改标题"——改名等于同一节变两个，那是另一类操作（改名 / 合并）。
 */
function editStateSection({ root, title, body, expect }) {
  const file = path.join(root, STATE_FILE);
  if (!exists(file)) return { ok: false, reason: 'missing-file', file };
  const before = readText(file);
  const located = sectionsOf(before).filter((section) => section.title === title);
  if (located.length === 0) return { ok: false, reason: 'not-found', title };
  if (located.length > 1) return { ok: false, reason: 'ambiguous', title, count: located.length };
  const result = writeWithGuards({
    file,
    root,
    expect,
    transform(text) {
      const hit = sectionsOf(text).filter((section) => section.title === title);
      if (hit.length === 0) throw new Error(`找不到状态节：${title}`);
      if (hit.length > 1) throw new Error(`状态节标题不唯一：${title}`);
      return replaceSectionBody(text, hit[0], body);
    },
    verify(next, original) {
      const sectionsBefore = sectionsOf(original);
      const sectionsAfter = sectionsOf(next);
      if (sectionsAfter.length !== sectionsBefore.length) return false;
      if (sectionsAfter.filter((section) => section.title === title).length !== 1) return false;
      const index = sectionsAfter.findIndex((section) => section.title === title);
      const nextLines = splitLines(next);
      const originalLines = splitLines(original);
      if (nextLines[sectionsAfter[index].start] !== originalLines[sectionsBefore[index].start]) return false; // 标题行逐字不变
      for (let i = 0; i < sectionsAfter.length; i += 1) {
        if (i === index) continue;
        if (sectionSignature(next, sectionsAfter[i]) !== sectionSignature(original, sectionsBefore[i])) return false; // 别的节一字不动
      }
      return normalize(sectionsAfter[index].body) === normalize(body);
    },
  });
  return { ...result, title };
}

/**
 * 真删一条日记（文件里真的不再有它）。
 * 三道防线：①删前备份整份文件（走同一套 writeWithGuards）；②删掉的内容存进删除内容区；
 * ③confirm 必须**原样打出序号**（`#44`）才放行。
 * **刻意不改序号**：日记是流水账，留洞比改号更轻。
 */
function deleteDiaryEntry({ root, seq, confirm, expect }) {
  const file = path.join(root, DIARY_FILE);
  if (!exists(file)) return { ok: false, reason: 'missing-file', file };
  const before = readText(file);
  const entry = diaryEntries(before).find((item) => item.seq === seq);
  if (!entry) return { ok: false, reason: 'not-found', seq };
  if (String(confirm ?? '').trim() !== `#${seq}`) return { ok: false, reason: 'confirm-mismatch', expected: `#${seq}` };
  const removed = entryText(before, entry);
  const archived = archiveDeleted(root, `日记-${seq}`, removed);
  const result = writeWithGuards({
    file,
    root,
    expect,
    transform(text) {
      const lines = splitLines(text);
      const hit = diaryEntries(text).find((item) => item.seq === seq);
      if (!hit) return null; // 幂等：已经没了
      let stop = hit.end;
      while (stop > hit.start && lines[stop - 1].trim() === '') stop -= 1; // 条目之间的空行留着
      lines.splice(hit.start, stop - hit.start);
      return joinLines(collapseTailBlank(lines), eolOf(text));
    },
    verify(next, original) {
      const after = diaryEntries(next);
      if (after.some((item) => item.seq === seq)) return false;
      const kept = new Map(after.map((item) => [item.seq, entryText(next, item)]));
      return diaryEntries(original).every((item) => item.seq === seq || kept.get(item.seq) === entryText(original, item));
    },
  });
  return { ...result, seq, removedChars: removed.length, archive: archived };
}

/** 真删一个状态节（连 `## 标题` 一起删）；confirm 必须原样打出节标题。 */
function deleteStateSection({ root, title, confirm, expect }) {
  const file = path.join(root, STATE_FILE);
  if (!exists(file)) return { ok: false, reason: 'missing-file', file };
  const before = readText(file);
  const located = sectionsOf(before).filter((section) => section.title === title);
  if (located.length === 0) return { ok: false, reason: 'not-found', title };
  if (located.length > 1) return { ok: false, reason: 'ambiguous', title, count: located.length };
  if (String(confirm ?? '') !== title) return { ok: false, reason: 'confirm-mismatch', expected: title };
  const removed = sectionRaw(before, located[0]);
  const archived = archiveDeleted(root, `状态节-${title}`, removed);
  const result = writeWithGuards({
    file,
    root,
    expect,
    transform(text) {
      const lines = splitLines(text);
      const hit = sectionsOf(text).filter((section) => section.title === title);
      if (hit.length === 0) return null; // 幂等
      if (hit.length > 1) throw new Error(`状态节标题不唯一：${title}`);
      let stop = hit[0].end;
      while (stop > hit[0].start && lines[stop - 1].trim() === '') stop -= 1;
      lines.splice(hit[0].start, stop - hit[0].start);
      return joinLines(collapseTailBlank(lines), eolOf(text));
    },
    verify(next, original) {
      const after = sectionsOf(next);
      if (after.some((section) => section.title === title)) return false;
      const kept = new Map(after.map((section) => [section.title, sectionSignature(next, section)]));
      return sectionsOf(original).every((section) => section.title === title || kept.get(section.title) === sectionSignature(original, section));
    },
  });
  return { ...result, title, removedChars: removed.length, archive: archived };
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  appendGrowthLine,
  detailLines,
  entrySignature,
  renderDiaryBlock,
  replaceTableValue,
  bumpDiaryVersion,
  bumpDiaryMeta,
  appendDiaryEntry,
  replaceSectionBody,
  editStateSection,
  deleteDiaryEntry,
  deleteStateSection,
};
