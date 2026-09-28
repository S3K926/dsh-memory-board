/**
 * lib/selftest.js —— 模块层自检（node index.js --selftest 走的那一大段，约 390 行）。
 *
 * 为什么从 index.js 里拆出来：它占了主文件五分之一，而且它是「测试」，跟插件的运行时
 * 代码混在一起最难读。拆出来之后它照样是模块层的东西——index.js 在模块层就调
 * runSelftest，cordis 不调 apply 也照样能跑（这是原版第一版栽过的坑，注释一起搬过来）。
 *
 * 触发那三行留在 index.js；自检自己建临时档案、自己清理，一个字节都不写真实档案。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ARCHIVE_DIR, ARCHIVE_SUBDIRS, CHARACTER_FILES, DIARY_FIELDS, DIARY_FILE, GROWTH_FILE, PLACEHOLDER_MARK, ROUTE_PATHS, STATE_FILE, STREAM_FILE, SYNC_SCRIPTS, TEMPLATE_FILES } from './constants.js';
import { exists, normalize, readText, splitLines, statOf, toCrlf } from './util.js';
import { diaryEntries, diaryMeta, diarySummary, entryText, growthSummary, readStream, searchStream, sectionRaw, sectionsOf, stateMeta } from './parse.js';
import { detectRoot, fingerprint, resolveRoot } from './fs-guards.js';
import { appendDiaryEntry, appendGrowthLine, deleteDiaryEntry, deleteStateSection, editStateSection } from './writes.js';
import { initArchiveRoot } from './scaffold.js';
import { scriptPathOf, syncArgv } from './sync.js';
import { archiveInfo } from './overview.js';
import { adoptRoot, inspectPath } from './locate.js';
import { panelStateFile, readPanelState, writePanelState } from './panel-state.js';
import { createRouter, createRuntime } from './router.js';

// ─────────────────────────────────────────────────────────────── 自检（必须在模块层！）

/** 造一份自检用的假档案：3 条日记（4 段 + 5 段两种标题）、2 个状态节、3 行记录、4 条事件流。 */
function makeFakeArchive(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const dir of ARCHIVE_SUBDIRS) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const diary = [
    '# 日记（自检用假档案）',
    '',
    '## 元信息',
    '',
    '| 字段 | 值 |',
    '|---|---|',
    '| owner_character | 自检 |',
    '| diary_version | 3.0 |',
    '| last_diary_seq | 3 |',
    '| total_count | 3 |',
    '',
    '## 日记',
    '',
    '### #1 ｜ 2026-01-01 ｜ 09:00 ｜ full',
    '',
    '**event_description**',
    '第一条的正文。',
    '',
    '**user_mood**',
    '平静',
    '',
    '**mood_tags**',
    '平静、开工',
    '',
    '**notes**',
    '第一条笔记',
    '',
    '**lively_details**',
    '- 细节甲',
    '',
    '**mood_tail**',
    '先这样 (・ω・)',
    '',
    '---',
    '',
    '### #2 ｜ 2026-01-02 ｜ 10:30 ｜ 【测试机】 ｜ full',
    '',
    '**event_description**',
    '第二条的正文，带设备标签。',
    '',
    '**user_mood**',
    '还行',
    '',
    '**mood_tags**',
    '还行',
    '',
    '**notes**',
    '第二条笔记',
    '',
    '**lively_details**',
    '- 细节乙',
    '',
    '**mood_tail**',
    '继续 (・ω・)',
    '',
    '---',
    '',
    '### #3 ｜ 2026-01-03 ｜ 11:45 ｜ 【测试机】 ｜ full',
    '',
    '**event_description**',
    '第三条的正文。',
    '',
    '**user_mood**',
    '开心',
    '',
    '**mood_tags**',
    '开心',
    '',
    '**notes**',
    '第三条笔记',
    '',
    '**lively_details**',
    '- 细节丙',
    '',
    '**mood_tail**',
    '收工 (・ω・)',
    '',
  ].join('\r\n');
  const state = [
    '# 状态（自检用假档案）',
    '',
    '```yaml',
    'last_updated: 2026-01-03 11:45',
    'diary_count: 4',
    'mood_base: 平静',
    'unfinished:',
    '  - 甲：还没弄完',
    '  - 乙：也还没弄完',
    '```',
    '',
    '## 【测试机】2026-01-03 11:45 · 第二节（最新在前）',
    '',
    '- 第二节的第一条',
    '- 第二节的第二条',
    '',
    '## 【测试机】2026-01-01 09:00 · 第一节',
    '',
    '- 第一节的第一条',
    '',
  ].join('\r\n');
  const growth = ['# 生长记录（自检用假档案）', '', '2026-01-01 09:00 | 【测试机】 | 第一行记录', '2026-01-02 10:30 | 【测试机】 | 第二行记录', '2026-01-03 11:45 | 【测试机】 | 第三行记录', ''].join('\r\n');
  const stream = [
    { id: 'diary-#1', ts: '2026-01-01 09:00', kind: 'diary', source: 'dsha', topic: '第一条', content: '第一条的正文。用户开工。', kw: ['开工'], importance: 3, ref: '日记.md#1', schema: 'growth-memory/1' },
    { id: 'diary-#2', ts: '2026-01-02 10:30', kind: 'diary', source: 'app', topic: '第二条', content: '第二条的正文。用户还在。', kw: ['继续'], importance: 3, ref: '日记.md#2', schema: 'growth-memory/1' },
    { id: 'growth-abcdef0123456789', ts: '2026-01-03 11:45', kind: 'growth', source: 'system', topic: '第三行记录', content: '第三行记录', kw: [], importance: 2, ref: '生长记录.md', schema: 'growth-memory/1' },
    { id: 'diary-#3', ts: '2026-01-03 11:45', kind: 'diary', source: 'dsha', topic: '第三条', content: '第三条的正文。用户收工。', kw: ['收工'], importance: 4, ref: '日记.md#3', schema: 'growth-memory/1' },
  ]
    .map((entry) => JSON.stringify(entry))
    .join('\r\n')
    .concat('\r\n');

  fs.writeFileSync(path.join(root, '身份.md'), toCrlf('# 身份（自检用假档案）\n\n占位。\n'), 'utf8');
  fs.writeFileSync(path.join(root, DIARY_FILE), diary, 'utf8');
  fs.writeFileSync(path.join(root, STATE_FILE), state, 'utf8');
  fs.writeFileSync(path.join(root, GROWTH_FILE), growth, 'utf8');
  fs.writeFileSync(path.join(root, STREAM_FILE), stream, 'utf8');
  return root;
}

function makeSelftestBase() {
  try {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-panel-selftest-'));
  } catch {
    const fallback = path.join(process.cwd(), '.dsh-memory-panel-selftest');
    fs.mkdirSync(fallback, { recursive: true });
    return fs.mkdtempSync(path.join(fallback, 'run-'));
  }
}

/** 只读跑一份真档案，把解析出来的数字摊开（不写一个字节）。 */
function reportArchive(root, emit) {
  const info = archiveInfo(root);
  emit(`  [只读] ${root}`);
  emit(`    日记：${info.diary.count} 条  ${info.diary.first}~${info.diary.last}  连续=${info.diary.contiguous}  元信息 last_diary_seq=${info.diary.meta.lastDiarySeq} total_count=${info.diary.meta.totalCount} diary_version=${info.diary.meta.diaryVersion}`);
  emit(`    状态：${info.state.sections} 节  last_updated=${info.state.lastUpdated}  unfinished=${info.state.unfinished} 条`);
  emit(`    生长记录：非空 ${info.growth.lines} 行 / 记录行 ${info.growth.records} 行`);
  emit(`    事件流：${info.stream.count} 条  最后一条 ${info.stream.last}`);
}

function runSelftest(realRootArg) {
  const lines = [];
  const results = [];
  const emit = (text) => lines.push(text);
  const check = (name, pass, detail) => {
    results.push({ name, pass: Boolean(pass) });
    emit(`  [${pass ? 'OK  ' : 'FAIL'}] ${name}${detail === undefined ? '' : ` —— ${detail}`}`);
  };

  const base = makeSelftestBase();
  const archive = path.join(base, '假档案');
  makeFakeArchive(archive);
  const diaryFile = path.join(archive, DIARY_FILE);
  const stateFile = path.join(archive, STATE_FILE);
  const growthFile = path.join(archive, GROWTH_FILE);
  const streamFile = path.join(archive, STREAM_FILE);
  const streamPrint = fingerprint(streamFile);

  emit('=== dsh-memory-panel 自检（模块层，独立于 cordis）===');
  emit(`临时档案：${archive}`);
  emit(`Node ${process.version} / ${process.platform}`);

  emit('');
  emit('── 1. 只读解析 ──');
  const diaryText = readText(diaryFile);
  const summary = diarySummary(diaryText);
  check('日记条数 = 3', summary.count === 3, `实际 ${summary.count}`);
  check('序号连续（1,2,3）', summary.contiguous && summary.first === 1 && summary.last === 3, `实际 ${summary.first}~${summary.last}`);
  check('元信息 3 / 3 / 3.0', summary.meta.lastDiarySeq === 3 && summary.meta.totalCount === 3 && summary.meta.diaryVersion === '3.0', JSON.stringify(summary.meta));

  const entries = diaryEntries(diaryText);
  check('两种标题形状各归各位（4 段 / 5 段）', entries[0].device === '' && entries[0].format === 'full' && entries[1].device === '【测试机】' && entries[1].format === 'full', `#1 device="${entries[0].device}" format="${entries[0].format}" / #2 device="${entries[1].device}" format="${entries[1].format}"`);
  check('六字段齐全', DIARY_FIELDS.every((name) => typeof entries[0].fields[name] === 'string' && entries[0].fields[name] !== ''), Object.keys(entries[0].fields).join(','));

  const sections = sectionsOf(readText(stateFile));
  const state = stateMeta(readText(stateFile));
  check('状态节数 = 2', sections.length === 2, `实际 ${sections.length}（${sections.map((section) => section.title).join(' / ')}）`);
  check('状态 yaml 四字段读得到', state.hasUnfinished === true && state.lastUpdated === '2026-01-03 11:45' && state.diaryCount === 4 && state.moodBase === '平静', `unfinished=${state.unfinished.length} 条`);

  const growth = growthSummary(readText(growthFile));
  check('生长记录：非空 4 行 / 记录 3 行', growth.records === 3 && growth.lines === 4, `非空 ${growth.lines} / 记录 ${growth.records}`);

  const stream = readStream(readText(streamFile));
  check('事件流条数 = 4', stream.length === 4, `实际 ${stream.length}`);

  const full = entryText(diaryText, entries[2]);
  check('取正文完整（标题 + 六段 + 收尾）', full.startsWith('### #3 ｜ 2026-01-03 ｜ 11:45 ｜ 【测试机】 ｜ full') && full.includes('细节丙') && full.endsWith('收工 (・ω・)'), `${full.length} 字`);
  check('取正文不串到下一条', !full.includes('细节乙') && !full.includes('第二条的正文'));

  check('搜索命中数（"收工" = 1）', searchStream(readText(streamFile), '收工').total === 1, `实际 ${searchStream(readText(streamFile), '收工').total}`);
  check('搜索命中数（"用户" = 3）', searchStream(readText(streamFile), '用户').total === 3, `实际 ${searchStream(readText(streamFile), '用户').total}`);
  check('空格分词全命中（"用户 收工" = 1）', searchStream(readText(streamFile), '用户 收工').total === 1, `实际 ${searchStream(readText(streamFile), '用户 收工').total}`);
  check('搜不到就是 0', searchStream(readText(streamFile), '绝不存在的词').total === 0);

  emit('');
  emit('── 2. 追加日记 + 元信息 + 幂等 + 备份 ──');
  const beforeDiary = readText(diaryFile);
  const appended = appendDiaryEntry({
    root: archive,
    expect: fingerprint(diaryFile),
    entry: { date: '2026-01-04', time: '12:00', device: '【测试机】', event: '自检写入的第四条的正文。', userMood: '还行', moodTags: '自检', notes: '自检笔记', details: '细节丁', moodTail: '收尾 (・ω・)' },
  });
  const afterDiary = readText(diaryFile);
  const afterSummary = diarySummary(afterDiary);
  check('写入成功（changed=true）', appended.ok === true && appended.changed === true, JSON.stringify({ ok: appended.ok, changed: appended.changed, reason: appended.reason, backup: appended.backup }));
  check('序号 +1（3 → 4）', appended.seq === 4, `实际 #${appended.seq}`);
  check('元信息两处跟着 +1（3 → 4）', afterSummary.meta.lastDiarySeq === 4 && afterSummary.meta.totalCount === 4, `last_diary_seq=${afterSummary.meta.lastDiarySeq} total_count=${afterSummary.meta.totalCount}`);
  check('diary_version 按档案规则升位（4 是偶数 → 3.1）', afterSummary.meta.diaryVersion === '3.1', `实际 ${afterSummary.meta.diaryVersion}`);
  check('条目加在最后', diaryEntries(afterDiary).length === 4 && diaryEntries(afterDiary)[3].seq === 4, `共 ${diaryEntries(afterDiary).length} 条`);
  check('新条目六段齐全', DIARY_FIELDS.every((name) => diaryEntries(afterDiary)[3].fields[name] !== undefined), Object.keys(diaryEntries(afterDiary)[3].fields).join(','));
  const originals = new Map(diaryEntries(beforeDiary).map((entry) => [entry.seq, entryText(beforeDiary, entry)]));
  check('既有条目一字未动', diaryEntries(afterDiary).every((entry) => originals.get(entry.seq) === undefined || originals.get(entry.seq) === entryText(afterDiary, entry)));
  const metaStripped = (text) => splitLines(text).filter((line) => !/^\|\s*\*{0,2}(last_diary_seq|total_count|diary_version)\*{0,2}\s*\|/.test(line)).join('\r\n');
  const strippedBefore = metaStripped(beforeDiary);
  const strippedAfter = metaStripped(afterDiary);
  check(
    '剥掉元信息那三行后：改后 = 改前 + 新条目，既有内容一字未动',
    strippedAfter.startsWith(strippedBefore) && strippedAfter.slice(strippedBefore.length).trimStart().startsWith('### #4 ｜ 2026-01-04 ｜ 12:00 ｜ 【测试机】 ｜ full'),
    `新增片段起头：${JSON.stringify(strippedAfter.slice(strippedBefore.length, strippedBefore.length + 60))}`,
  );
  check('CRLF 保持', !/[^\r]\n/.test(afterDiary), /\r\n/.test(afterDiary) ? 'CRLF' : 'LF');

  check('改前备份存在', Boolean(appended.backup) && exists(appended.backup), String(appended.backup));
  check('备份与改前逐字一致', Boolean(appended.backup) && fs.readFileSync(appended.backup, 'utf8') === beforeDiary);
  check('备份落在 归档-旧版本与记录\\写入备份\\', Boolean(appended.backup) && appended.backup.includes(path.join(ARCHIVE_DIR, '写入备份')));

  const again = appendDiaryEntry({
    root: archive,
    expect: fingerprint(diaryFile),
    entry: { date: '2026-01-04', time: '12:00', device: '【测试机】', event: '自检写入的第四条的正文。', userMood: '还行', moodTags: '自检', notes: '自检笔记', details: '细节丁', moodTail: '收尾 (・ω・)' },
  });
  check('幂等：第二次调用不写（no-op）', again.ok === true && again.changed === false && again.reason === 'no-op', JSON.stringify({ ok: again.ok, changed: again.changed, reason: again.reason }));
  check('幂等后文件逐字没变', readText(diaryFile) === afterDiary);

  emit('');
  emit('── 3. 外部改动拒写 ──');
  const stalePrint = fingerprint(diaryFile);
  fs.writeFileSync(diaryFile, `${readText(diaryFile)}### #99 ｜ 2026-01-09 ｜ 00:00 ｜ full\r\n\r\n**event_description**\r\n别的设备刚同步过来的一条。\r\n`, 'utf8');
  const external = readText(diaryFile);
  const rejected = appendDiaryEntry({ root: archive, expect: stalePrint, entry: { date: '2026-01-05', time: '08:00', device: '', event: '不该写进去的一条。', userMood: '', moodTags: '', notes: '', details: '', moodTail: '' } });
  check('指纹变了 → 拒写（stale-fingerprint）', rejected.ok === false && rejected.reason === 'stale-fingerprint', JSON.stringify({ ok: rejected.ok, reason: rejected.reason }));
  check('拒写后文件未动', readText(diaryFile) === external);
  fs.writeFileSync(diaryFile, afterDiary, 'utf8'); // 复原，后面的删除测试用干净数据

  emit('');
  emit('── 4. 状态节编辑只动正文 ──');
  const beforeState = readText(stateFile);
  const sectionsBefore = sectionsOf(beforeState);
  const targetTitle = sectionsBefore[0].title;
  const edit = editStateSection({ root: archive, title: targetTitle, body: '- 换过的正文第一行\n- 换过的正文第二行', expect: fingerprint(stateFile) });
  const afterState = readText(stateFile);
  const sectionsAfter = sectionsOf(afterState);
  check('编辑成功', edit.ok === true && edit.changed === true, JSON.stringify({ ok: edit.ok, reason: edit.reason }));
  check('节数不变', sectionsAfter.length === sectionsBefore.length, `${sectionsBefore.length} → ${sectionsAfter.length}`);
  check('标题行原样保留', splitLines(afterState)[sectionsAfter[0].start] === splitLines(beforeState)[sectionsBefore[0].start], splitLines(afterState)[sectionsAfter[0].start]);
  check('正文换成新的', normalize(sectionsAfter[0].body) === normalize('- 换过的正文第一行\n- 换过的正文第二行'), JSON.stringify(sectionsAfter[0].body));
  check('别的节一字不动', sectionRaw(afterState, sectionsAfter[1]) === sectionRaw(beforeState, sectionsBefore[1]));
  check('yaml 块（含 unfinished）一字不动', afterState.slice(0, sectionsAfter[0].start) === beforeState.slice(0, sectionsBefore[0].start));
  check('状态节 CRLF 保持', !/[^\r]\n/.test(afterState));
  const missingTitle = editStateSection({ root: archive, title: '绝不存在的节', body: 'x', expect: fingerprint(stateFile) });
  check('标题找不到就不写（not-found）', missingTitle.ok === false && missingTitle.reason === 'not-found', JSON.stringify(missingTitle));

  emit('');
  emit('── 5. 真删（三道防线）──');
  const beforeDeleteDiary = readText(diaryFile);
  const beforeDeleteMeta = diaryMeta(beforeDeleteDiary);
  const wrongConfirm = deleteDiaryEntry({ root: archive, seq: 2, confirm: '2', expect: fingerprint(diaryFile) });
  check('确认框没原样打出 #2 → 不放行', wrongConfirm.ok === false && wrongConfirm.reason === 'confirm-mismatch', JSON.stringify(wrongConfirm));
  const deleted = deleteDiaryEntry({ root: archive, seq: 2, confirm: '#2', expect: fingerprint(diaryFile) });
  const afterDeleteDiary = readText(diaryFile);
  const remaining = diaryEntries(afterDeleteDiary);
  check('真删成功', deleted.ok === true && deleted.changed === true, JSON.stringify({ ok: deleted.ok, reason: deleted.reason }));
  check('文件里真的不再有 #2', remaining.every((entry) => entry.seq !== 2), `剩下 ${remaining.map((entry) => `#${entry.seq}`).join(' ')}`);
  check('别的条目一字未动', remaining.every((entry) => {
    const original = diaryEntries(beforeDeleteDiary).find((item) => item.seq === entry.seq);
    return original !== undefined && entryText(beforeDeleteDiary, original) === entryText(afterDeleteDiary, entry);
  }));
  check('刻意不改序号（元信息没动）', diaryMeta(afterDeleteDiary).lastDiarySeq === beforeDeleteMeta.lastDiarySeq && diaryMeta(afterDeleteDiary).totalCount === beforeDeleteMeta.totalCount, `last_diary_seq=${diaryMeta(afterDeleteDiary).lastDiarySeq} total_count=${diaryMeta(afterDeleteDiary).totalCount}`);
  check('删掉的内容进了归档区', exists(deleted.archive) && deleted.archive.includes(path.join(ARCHIVE_DIR, '删除内容')), String(deleted.archive));
  check('归档内容就是被删的那一条', exists(deleted.archive) && fs.readFileSync(deleted.archive, 'utf8').includes('第二条的正文，带设备标签。'));
  check('删前整份备份存在且与改前逐字一致', Boolean(deleted.backup) && fs.readFileSync(deleted.backup, 'utf8') === beforeDeleteDiary, String(deleted.backup));

  const stateBeforeDelete = readText(stateFile);
  const sectionToDelete = sectionsOf(stateBeforeDelete)[1].title;
  const stateDeleted = deleteStateSection({ root: archive, title: sectionToDelete, confirm: sectionToDelete, expect: fingerprint(stateFile) });
  const stateAfterDelete = readText(stateFile);
  check('状态节真删成功', stateDeleted.ok === true && stateDeleted.changed === true, JSON.stringify({ ok: stateDeleted.ok, reason: stateDeleted.reason }));
  check('那个节真的没了（连 ## 标题一起）', sectionsOf(stateAfterDelete).every((section) => section.title !== sectionToDelete), `剩下 ${sectionsOf(stateAfterDelete).map((section) => section.title).join(' / ') || '（无）'}`);
  check('别的节与 unfinished 都在', sectionsOf(stateAfterDelete).length === sectionsOf(stateBeforeDelete).length - 1 && stateMeta(stateAfterDelete).unfinished.length === 2);
  check('节内容进了归档区', exists(stateDeleted.archive) && fs.readFileSync(stateDeleted.archive, 'utf8').includes(sectionToDelete), String(stateDeleted.archive));

  emit('');
  emit('── 6. 生长记录追加 ──');
  const beforeGrowth = readText(growthFile);
  const growthAppend = appendGrowthLine({ root: archive, line: '2026-01-05 09:00 | 【测试机】 | 自检追加的一行', expect: fingerprint(growthFile) });
  const afterGrowth = readText(growthFile);
  check('追加成功', growthAppend.ok === true && growthAppend.changed === true, JSON.stringify({ ok: growthAppend.ok, reason: growthAppend.reason }));
  check('只追加（改前内容是改后的前缀）', afterGrowth.startsWith(beforeGrowth) && growthSummary(afterGrowth).records === 4, `记录行 ${growthSummary(afterGrowth).records}`);
  check('改前备份与改前逐字一致', Boolean(growthAppend.backup) && fs.readFileSync(growthAppend.backup, 'utf8') === beforeGrowth);
  const growthAgain = appendGrowthLine({ root: archive, line: '2026-01-05 09:00 | 【测试机】 | 自检追加的一行', expect: fingerprint(growthFile) });
  check('生长记录也幂等', growthAgain.ok === true && growthAgain.changed === false, JSON.stringify({ ok: growthAgain.ok, reason: growthAgain.reason }));

  emit('');
  emit('── 7. 新设备铺底 ──');
  const fresh = path.join(base, '新设备');
  const init = initArchiveRoot({ root: fresh, device: '【自检机】' });
  check('铺底成功（6 件骨架）', init.ok === true && init.files.length === TEMPLATE_FILES.length, init.ok ? init.files.map((file) => `${file.path}(${file.bytes}B,${file.from})`).join(' ') : JSON.stringify(init));
  check('目录树齐（6 个目录）', ARCHIVE_SUBDIRS.every((dir) => statOf(path.join(fresh, dir))?.isDirectory()), ARCHIVE_SUBDIRS.join(','));
  const freshDiary = readText(path.join(fresh, DIARY_FILE));
  const freshState = readText(path.join(fresh, STATE_FILE));
  check('骨架能被本插件解析器认出来', diaryEntries(freshDiary).length === 0 && diaryMeta(freshDiary).lastDiarySeq === 0 && sectionsOf(freshState).length >= 1 && stateMeta(freshState).hasUnfinished === true, `diaryEntries=${diaryEntries(freshDiary).length} last_diary_seq=${diaryMeta(freshDiary).lastDiarySeq} sections=${sectionsOf(freshState).length} unfinished=${stateMeta(freshState).unfinished.length}`);
  // 2026-09-25 修：这两条只在"用自带/内置骨架"时才该断言。
  // 铺底走的是四级模板优先级，一旦 ~/.dsh/memory-templates（自定义模板，写真人设）优先命中，
  // 铺出来的身份本来就**不该**带【占位】—— 硬断言会误报失败（活环境下 79/81 就是这么来的）。
  const customTemplate = init.files.some((file) => !['bundled', 'builtin', 'bundled-fallback'].includes(file.from));
  if (customTemplate) {
    emit('  （检测到自定义模板：跳过后两条"占位 / 不是谁的记忆"断言 —— 自定义模板本该写真人设）');
  } else {
    check('到处标了【占位】', TEMPLATE_FILES.every((rel) => readText(path.join(fresh, ...rel.split('/'))).includes(PLACEHOLDER_MARK)));
    check('写明了"不是谁的记忆"', freshDiary.includes('不是谁的记忆') && readText(path.join(fresh, '身份.md')).includes('不是谁的记忆'));
  }
  check('设备名替换生效', freshState.includes('【自检机】') && !freshState.includes('【设备】'));
  check('全部 CRLF + 无 BOM', TEMPLATE_FILES.every((rel) => {
    const buffer = fs.readFileSync(path.join(fresh, ...rel.split('/')));
    return buffer[0] !== 0xef && !/[^\r]\n/.test(buffer.toString('utf8'));
  }));
  check('认得出这是档案根', detectRoot(fresh) === path.resolve(fresh), String(detectRoot(fresh)));
  const reinit = initArchiveRoot({ root: fresh, device: '【自检机】' });
  check('已有档案 → 一律拒绝', reinit.ok === false && reinit.reason === 'already-archive', JSON.stringify(reinit));
  const rogue = initArchiveRoot({ root: archive, device: '【自检机】' });
  check('拿已有档案当目标也拒绝', rogue.ok === false && rogue.reason === 'already-archive', JSON.stringify(rogue));
  const noRoot = initArchiveRoot({ device: '【自检机】' });
  check('不给目标目录 → 拒绝（不拿配置根当默认）', noRoot.ok === false && noRoot.reason === 'root-required', JSON.stringify(noRoot));
  const partial = path.join(base, '半截目录');
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, '身份.md'), 'x', 'utf8');
  const partialInit = initArchiveRoot({ root: partial, device: '【自检机】' });
  check('目标里已有同名文件 → 拒绝覆盖', partialInit.ok === false && partialInit.reason === 'file-exists', JSON.stringify(partialInit));

  emit('');
  emit('── 8. 认根与路由表 ──');
  check('detectRoot 认得出档案根', detectRoot(archive) === path.resolve(archive));
  check('detectRoot 认不出就返回 null（不猜）', detectRoot(path.join(base, '没有这个目录')) === null && detectRoot('') === null);
  // 这两条断言显式指向一个不存在的状态文件：它们的意图是「配置 root 生效 / 配错时如实报」，
  // 不能被使用者面板上真选过的位置带偏（认根第一优先级现在是状态文件）。
  const noStateFile = path.join(base, '没有的状态文件.json');
  const resolved = resolveRoot({ root: archive }, { stateFile: noStateFile });
  check('配置 root 优先', resolved.root === path.resolve(archive) && resolved.source === 'config.root', JSON.stringify({ root: resolved.root, source: resolved.source }));
  const unresolved = resolveRoot({ root: path.join(base, '空的') }, { stateFile: noStateFile });
  check('配错 root 时如实报出"试过哪些、各缺什么"', unresolved.tried[0].source === 'config.root' && unresolved.tried[0].ok === false && unresolved.tried[0].missing.length === 3, JSON.stringify(unresolved.tried[0]));
  const routePaths = createRouter(createRuntime({ root: archive })).map((route) => route.path);
  check(`路由表齐全（${ROUTE_PATHS.length} 条）`, ROUTE_PATHS.every((item) => routePaths.includes(item)) && routePaths.length === ROUTE_PATHS.length, `实际 ${routePaths.length} 条`);
  check('白名单只放四个脚本', Object.keys(SYNC_SCRIPTS).join(',') === '合并记忆,合并日记,合并状态,回流包', Object.keys(SYNC_SCRIPTS).join(','));
  check('恢复.py / 备份.py / 自主轮次.py 永不放行', !Object.values(SYNC_SCRIPTS).some((name) => ['恢复.py', '备份.py', '自主轮次.py'].includes(name)));
  check('干跑不带 --apply、真跑才带', syncArgv('x.py', false).join(' ') === 'x.py' && syncArgv('x.py', true).join(' ') === 'x.py --apply', `${syncArgv('x.py', false).join(' ')} / ${syncArgv('x.py', true).join(' ')}`);
  check('不在白名单的脚本连路径都拿不到', scriptPathOf(archive, '恢复') === null && scriptPathOf(archive, '备份') === null && scriptPathOf(archive, '自主轮次') === null);

  emit('');
  emit('── 9. 只读模式（两层闸）──');
  const locked = createRuntime({ root: archive, readOnly: true });
  check('配置只读 → 写开关彻底不可用', locked.writeApi.available() === false && locked.writeApi.set(true).ok === false && locked.writeApi.allowed() === false, JSON.stringify(locked.writeApi.snapshot()));
  const open = createRuntime({ root: archive, readOnly: false });
  check('配置放开时开关默认仍关', open.writeApi.available() === true && open.writeApi.unlocked() === false && open.writeApi.allowed() === false, JSON.stringify(open.writeApi.snapshot()));
  check('打开开关后才允许写', open.writeApi.set(true).ok === true && open.writeApi.allowed() === true, JSON.stringify(open.writeApi.snapshot()));

  emit('');
  emit('── 10. 写操作只落在临时目录 ──');
  check('假档案与铺底目标都在临时目录里', archive.startsWith(base) && fresh.startsWith(base), base);
  check('事件流一个字节都没被写过', fingerprint(streamFile) === streamPrint, `${streamPrint} → ${fingerprint(streamFile)}`);

  emit('');
  emit('── 11. 面板自选位置（where 三态 / adopt 认领 / 认根优先级）──');
  // 全程只用临时目录 + 临时状态文件：既不许碰使用者的真档案，也不许碰 ~/.dsh/memory-panel.json。
  const panelStatePath = path.join(base, 'panel-state.json');
  const probeArchive = makeFakeArchive(path.join(base, '位置判定档案'));
  const emptyDir = path.join(base, '空目录');
  fs.mkdirSync(emptyDir, { recursive: true });
  const notArchive = path.join(base, '不空又不认识');
  fs.mkdirSync(notArchive, { recursive: true });
  fs.writeFileSync(path.join(notArchive, '别人的笔记.md'), toCrlf('这不是档案。\n'), 'utf8');

  check('状态文件默认落在 ~/.dsh/memory-panel.json', panelStateFile() === path.join(os.homedir(), '.dsh', 'memory-panel.json'), panelStateFile());
  check('自检用的状态文件在临时目录里（绝不碰使用者的那一份）', panelStatePath.startsWith(base));
  check('没写过时读状态文件：如实报 absent，不抛', readPanelState(panelStatePath).ok === false && readPanelState(panelStatePath).reason === 'absent', JSON.stringify(readPanelState(panelStatePath)));

  const whereArchive = inspectPath(probeArchive);
  check('where：完整档案 → archive + 四个数字', whereArchive.kind === 'archive' && whereArchive.counts.diary === 3 && whereArchive.counts.sections === 2 && whereArchive.counts.growth === 4 && whereArchive.counts.events === 4, JSON.stringify(whereArchive));
  check('where：archive 的 root 是解析后的绝对路径', whereArchive.root === path.resolve(probeArchive), whereArchive.root);
  check('where：响应形状就是 ok/kind/root/missing/counts', ['ok', 'kind', 'root', 'missing', 'counts'].every((key) => key in whereArchive) && whereArchive.missing.length === 0, Object.keys(whereArchive).join(','));

  const whereEmpty = inspectPath(emptyDir);
  check('where：空目录 → empty（缺哪几个特征文件照样列出来）', whereEmpty.kind === 'empty' && whereEmpty.missing.join(',') === CHARACTER_FILES.join(','), JSON.stringify(whereEmpty));
  const whereGone = inspectPath(path.join(base, '根本没有这个目录'));
  check('where：目录不存在 → empty', whereGone.kind === 'empty' && whereGone.counts === null, JSON.stringify(whereGone));
  const wherePartial = inspectPath(notArchive);
  check('where：不空又认不出 → partial + missing 列全', wherePartial.kind === 'partial' && wherePartial.missing.join(',') === CHARACTER_FILES.join(','), JSON.stringify(wherePartial));
  const whereBad = inspectPath('');
  check('where：路径不合法（空/非字符串）→ missing', whereBad.kind === 'missing' && inspectPath(null).kind === 'missing' && inspectPath('   ').kind === 'missing', JSON.stringify(whereBad));

  const refusedPartial = adoptRoot({ path: notArchive, confirm: notArchive, file: panelStatePath });
  check('adopt：非档案目录一律拒绝（带 kind 与 missing）', refusedPartial.ok === false && refusedPartial.reason === 'not-archive' && refusedPartial.kind === 'partial' && refusedPartial.missing.length === 3, JSON.stringify(refusedPartial));
  const refusedEmpty = adoptRoot({ path: emptyDir, confirm: emptyDir, file: panelStatePath });
  check('adopt：空目录也拒绝', refusedEmpty.ok === false && refusedEmpty.reason === 'not-archive' && refusedEmpty.kind === 'empty', JSON.stringify(refusedEmpty));
  check('两次拒绝之后状态文件仍然没被写出来', readPanelState(panelStatePath).ok === false, JSON.stringify(readPanelState(panelStatePath)));

  const wrongAdoptConfirm = adoptRoot({ path: probeArchive, confirm: '换个没原样打的路径', file: panelStatePath });
  check('adopt：confirm 没原样打出路径 → 不放行', wrongAdoptConfirm.ok === false && wrongAdoptConfirm.reason === 'confirm-mismatch', JSON.stringify(wrongAdoptConfirm));
  check('confirm 不对时同样没写状态文件', readPanelState(panelStatePath).ok === false);

  const adopted = adoptRoot({ path: probeArchive, confirm: probeArchive, device: '【自检机】', file: panelStatePath });
  check('adopt：是档案 → 成功并写进状态文件', adopted.ok === true && adopted.kind === 'archive' && adopted.counts.diary === 3, JSON.stringify(adopted));
  const stateAfter = readPanelState(panelStatePath);
  check('状态文件里 root/device/updatedAt 都对得上', stateAfter.ok === true && stateAfter.root === path.resolve(probeArchive) && stateAfter.device === '【自检机】' && typeof stateAfter.updatedAt === 'string', JSON.stringify(stateAfter));
  check('状态文件也是 UTF-8 无 BOM + CRLF', (() => {
    const buffer = fs.readFileSync(panelStatePath);
    return buffer[0] !== 0xef && !/[^\r]\n/.test(buffer.toString('utf8'));
  })());

  const byState = resolveRoot({ root: archive }, { stateFile: panelStatePath });
  check('优先级：面板状态文件盖过配置 root（第一级就命中）', byState.root === path.resolve(probeArchive) && byState.source === 'state' && byState.origin === 'state' && byState.tried.length === 1 && byState.tried[0].source === 'state', JSON.stringify({ root: byState.root, source: byState.source, origin: byState.origin, tried: byState.tried.map((item) => item.source) }));
  const withoutState = resolveRoot({ root: archive }, { stateFile: noStateFile });
  check('对照组：没有状态文件时配置 root 照旧生效（说明上面那一级真的把它盖住了，不是配置本来就无效）', withoutState.root === path.resolve(archive) && withoutState.source === 'config.root' && withoutState.origin === 'config', JSON.stringify({ root: withoutState.root, source: withoutState.source, origin: withoutState.origin }));
  const savedEnvRoot = process.env.DSH_MEMORY_ROOT;
  process.env.DSH_MEMORY_ROOT = probeArchive;
  const byEnv = resolveRoot({}, { state: { ok: false, root: null } });
  if (savedEnvRoot === undefined) delete process.env.DSH_MEMORY_ROOT;
  else process.env.DSH_MEMORY_ROOT = savedEnvRoot;
  check('优先级：没有状态文件时环境变量照样认（origin=env）', byEnv.origin === 'env' && byEnv.root === path.resolve(probeArchive), JSON.stringify({ root: byEnv.root, source: byEnv.source, origin: byEnv.origin }));
  const staleFile = path.join(base, '过期状态.json');
  writePanelState({ root: notArchive, device: null, file: staleFile });
  const byStale = resolveRoot({ root: archive }, { stateFile: staleFile });
  check('状态文件里的位置认不出时往下一级走，并在 tried 里标 ok=false', byStale.root === path.resolve(archive) && byStale.source === 'config.root' && byStale.tried[0].source === 'state' && byStale.tried[0].ok === false, JSON.stringify({ root: byStale.root, source: byStale.source, tried0: byStale.tried[0] }));

  const routePathsAll = createRouter(createRuntime({ root: archive, panelStateFile: panelStatePath })).map((route) => route.path);
  check('路由表里确实挂上了 where 与 adopt', routePathsAll.includes('/api/memory/where') && routePathsAll.includes('/api/memory/adopt'), `共 ${routePathsAll.length} 条`);

  if (realRootArg) {
    emit('');
    emit('── 12. 附加：只读跑真实档案（不写一个字节）──');
    const realRoot = detectRoot(realRootArg);
    if (!realRoot) emit(`  [跳过] ${realRootArg} 不是档案根（缺特征文件），不猜。`);
    else reportArchive(realRoot, emit);
  }

  const failed = results.filter((item) => !item.pass);
  emit('');
  emit('=== 汇总 ===');
  emit(`通过 ${results.length - failed.length} / ${results.length}`);
  if (failed.length > 0) emit(`失败：${failed.map((item) => item.name).join('；')}`);

  if (process.argv.includes('--keep')) {
    emit(`临时目录保留：${base}`);
  } else {
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* 删不掉临时目录不算自检失败 */
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return failed.length === 0;
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  makeFakeArchive,
  makeSelftestBase,
  reportArchive,
  runSelftest,
};
