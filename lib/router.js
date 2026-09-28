/**
 * lib/router.js —— 20 条 HTTP 路由的组装，外加运行时（createRuntime）与写入开关（createWriteApi）。
 * 多出来的两条是「面板自选位置」：GET /where 只读判定一个候选目录，POST /adopt 认领一个已有档案。
 *
 * 为什么从 index.js 里拆出来：路由是本插件最长的一块「胶水」——它只做参数解析、
 * 三道闸门（配置只读 / 面板写入开关 / confirm=yes）和把结果包成 JSON，业务逻辑
 * 全在被调用的那些函数里。拆出去之后 index.js 只剩装配，路由表也能单独读。
 *
 * 每条路由仍然各自注册（不靠 pathname 分派），这条历史教训连着注释一起搬过来了。
 */

import path from 'node:path';
import { API_PREFIX, DIARY_FIELDS, DIARY_FILE, GROWTH_FILE, STATE_FILE, STREAM_FILE, SYNC_SCRIPTS, SYNC_TIMEOUT_MS } from './constants.js';
import { exists, excerpt, mtimeOf, readCached, sizeOf, toInt } from './util.js';
import { diaryEntries, diarySummary, entryText, readStream, searchStream, sectionsOf, stateMeta } from './parse.js';
import { appendDiaryEntry, appendGrowthLine, deleteDiaryEntry, deleteStateSection, editStateSection } from './writes.js';
import { initArchiveRoot } from './scaffold.js';
import { runSyncScript, syncStatus } from './sync.js';
import { archiveInfo } from './overview.js';
import { fingerprint, resolveRoot } from './fs-guards.js';
import { adoptRoot, inspectPath } from './locate.js';
import { panelStateFile, rememberRoot } from './panel-state.js';

// ─────────────────────────────────────────────────────────────── 路由

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 参数同时认 query 与 JSON body（面板两种都能用，命令行拿 query 更省事）。 */
async function paramsOf(request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) Object.assign(params, body);
    } catch {
      /* 没 body 或 body 不是 JSON：只用 query */
    }
  }
  return params;
}

function createWriteApi(settings) {
  let unlocked = false;
  const available = () => settings.readOnly !== true; // 配置只读 → 开关彻底不可用，连开都不许
  const snapshot = () => ({
    readOnly: settings.readOnly === true,
    available: available(),
    unlocked: unlocked && available(),
    allowed: available() && unlocked,
  });
  return {
    available,
    unlocked: () => snapshot().unlocked,
    allowed: () => snapshot().allowed,
    snapshot,
    set(on) {
      if (!available()) return { ok: false, reason: 'read-only' };
      unlocked = Boolean(on);
      return { ok: true };
    },
  };
}

/**
 * 组装路由。每条路由各自注册（不靠 pathname 分派——历史教训：
 * 两条路径写在同一个 handler 里，等于只有第一条能被服务）。
 */
function createRouter(runtime) {
  const { settings, writeApi, log } = runtime;

  const needRoot = () => {
    const resolved = runtime.resolveRoot();
    if (!resolved.root) {
      return {
        error: json(
          {
            ok: false,
            reason: 'no-archive-root',
            hint: '认不出档案根。请在插件配置里写 root（或设 DSH_MEMORY_ROOT），或在面板上手动填一个目录——本插件不猜。',
            tried: resolved.tried,
          },
          409,
        ),
      };
    }
    return { root: resolved.root, source: resolved.source, origin: resolved.origin };
  };

  /** 写操作三关：配置可写 → 面板开关打开 → confirm=yes。删类操作另要 ack 原样打名字。 */
  const needWrite = (confirm) => {
    if (!writeApi.available()) return json({ ok: false, reason: 'read-only', hint: '配置里 readOnly: true，写操作彻底不可用。' }, 403);
    if (!writeApi.allowed()) return json({ ok: false, reason: 'write-locked', hint: '面板上的写入开关还没打开。' }, 403);
    if (String(confirm ?? '') !== 'yes') return json({ ok: false, reason: 'confirm-required', hint: '写操作都要带 confirm=yes。' }, 400);
    return null;
  };

  const guard = (handler) => async (request) => {
    try {
      return await handler(request);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      log(`路由出错：${message}`);
      return json({ ok: false, reason: 'error', error: message }, 500);
    }
  };

  const answer = (result) => json(result, result.ok ? 200 : 409);

  return [
    {
      path: `${API_PREFIX}/info`,
      methods: ['GET'],
      fetch: guard(async () => {
        const located = needRoot();
        if (located.error) return located.error;
        return json({ ok: true, readOnly: settings.readOnly === true, source: located.source, origin: located.origin, ...archiveInfo(located.root) });
      }),
    },
    {
      path: `${API_PREFIX}/summary`,
      methods: ['GET'],
      fetch: guard(async () => {
        const located = needRoot();
        if (located.error) return located.error;
        return json({ ok: true, readOnly: settings.readOnly === true, ...archiveInfo(located.root) });
      }),
    },
    {
      path: `${API_PREFIX}/health`,
      methods: ['GET'],
      fetch: guard(async () => {
        const resolved = runtime.resolveRoot();
        return json({
          ok: true,
          readOnly: settings.readOnly === true,
          root: resolved.root,
          source: resolved.source,
          origin: resolved.origin,
          tried: resolved.tried,
          write: writeApi.snapshot(),
          files: resolved.root
            ? Object.fromEntries(
                ['身份.md', DIARY_FILE, STATE_FILE, GROWTH_FILE, STREAM_FILE].map((rel) => [
                  rel,
                  { path: path.join(resolved.root, rel), exists: exists(path.join(resolved.root, rel)), bytes: sizeOf(path.join(resolved.root, rel)), mtime: mtimeOf(path.join(resolved.root, rel)) },
                ]),
              )
            : null,
        });
      }),
    },
    {
      path: `${API_PREFIX}/diary`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const file = path.join(located.root, DIARY_FILE);
        const text = readCached(file) ?? '';
        const params = await paramsOf(request);
        const seq = toInt(params.seq);
        if (seq !== null) {
          const entry = diaryEntries(text).find((item) => item.seq === seq);
          if (!entry) return json({ ok: false, reason: 'not-found', seq }, 404);
          const meta = { seq: entry.seq, date: entry.date, time: entry.time, device: entry.device, format: entry.format, chars: entry.text.length, fields: Object.keys(entry.fields) };
          return json({ ok: true, root: located.root, fingerprint: fingerprint(file), entry: meta, text: entryText(text, entry) });
        }
        const entries = diaryEntries(text).map((entry) => ({
          seq: entry.seq,
          date: entry.date,
          time: entry.time,
          device: entry.device,
          format: entry.format,
          chars: entryText(text, entry).length,
          title: entry.title,
        }));
        return json({ ok: true, root: located.root, fingerprint: fingerprint(file), count: entries.length, summary: diarySummary(text), fields: DIARY_FIELDS, entries });
      }),
    },
    {
      path: `${API_PREFIX}/diary/append`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const blocked = needWrite(params.confirm);
        if (blocked) return blocked;
        const result = appendDiaryEntry({
          root: located.root,
          expect: params.fp ?? params.expect,
          entry: {
            date: params.date,
            time: params.time,
            device: params.device,
            event: params.event,
            userMood: params.userMood,
            moodTags: params.moodTags,
            notes: params.notes,
            details: params.details,
            moodTail: params.moodTail,
          },
        });
        // 日期 / 时间形状不对是"用户填错"，回 400 并把 hint 带回去（别混进 409 那类"冲突"里）
        if (!result.ok && (result.reason === 'bad-date' || result.reason === 'bad-time')) return json(result, 400);
        return answer(result);
      }),
    },
    {
      path: `${API_PREFIX}/diary/delete`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const blocked = needWrite(params.confirm);
        if (blocked) return blocked;
        // 确认框里必须原样打出序号（`#44`）——ack 就是那一格。
        return answer(deleteDiaryEntry({ root: located.root, seq: toInt(params.seq), confirm: params.ack, expect: params.fp ?? params.expect }));
      }),
    },
    {
      path: `${API_PREFIX}/state`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const file = path.join(located.root, STATE_FILE);
        const text = readCached(file) ?? '';
        const params = await paramsOf(request);
        const title = params.title;
        if (typeof title === 'string' && title !== '') {
          const hit = sectionsOf(text).filter((section) => section.title === title);
          if (hit.length === 0) return json({ ok: false, reason: 'not-found', title }, 404);
          if (hit.length > 1) return json({ ok: false, reason: 'ambiguous', title, count: hit.length }, 409);
          return json({ ok: true, root: located.root, fingerprint: fingerprint(file), title, text: hit[0].body });
        }
        const sections = sectionsOf(text).map((section) => ({ title: section.title, chars: section.body.length }));
        return json({ ok: true, root: located.root, fingerprint: fingerprint(file), count: sections.length, meta: stateMeta(text), sections });
      }),
    },
    {
      path: `${API_PREFIX}/state/edit`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const blocked = needWrite(params.confirm);
        if (blocked) return blocked;
        return answer(editStateSection({ root: located.root, title: params.title, body: params.body ?? '', expect: params.fp ?? params.expect }));
      }),
    },
    {
      path: `${API_PREFIX}/state/delete`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const blocked = needWrite(params.confirm);
        if (blocked) return blocked;
        // 确认框里必须原样打出节标题——ack 就是那一格。
        return answer(deleteStateSection({ root: located.root, title: params.title, confirm: params.ack, expect: params.fp ?? params.expect }));
      }),
    },
    {
      path: `${API_PREFIX}/events`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const limit = Math.max(1, Math.min(500, toInt(params.limit) ?? 30));
        const entries = readStream(readCached(path.join(located.root, STREAM_FILE)) ?? '');
        return json({
          ok: true,
          root: located.root,
          total: entries.length,
          limit,
          entries: entries.slice(-limit).reverse().map((entry) => ({
            id: entry.id ?? null,
            ts: entry.ts ?? null,
            kind: entry.kind ?? null,
            source: entry.source ?? null,
            topic: entry.topic ?? null,
            ref: entry.ref ?? null,
            excerpt: excerpt(entry.content, 160),
          })),
        });
      }),
    },
    {
      path: `${API_PREFIX}/search`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const query = String(params.q ?? '').trim();
        if (query === '') return json({ ok: true, root: located.root, query, total: 0, hits: [], note: '给个词再搜。' });
        const limit = Math.max(1, Math.min(200, toInt(params.limit) ?? 50));
        const found = searchStream(readCached(path.join(located.root, STREAM_FILE)) ?? '', query, limit);
        return json({
          ok: true,
          root: located.root,
          query,
          scanned: found.scanned,
          terms: found.terms,
          total: found.total,
          hits: found.hits.map((entry) => ({
            id: entry.id ?? null,
            ts: entry.ts ?? null,
            kind: entry.kind ?? null,
            source: entry.source ?? null,
            topic: entry.topic ?? null,
            ref: entry.ref ?? null,
            excerpt: excerpt(entry.content, 200),
          })),
        });
      }),
    },
    {
      path: `${API_PREFIX}/write`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const on = params.on === '1' || params.on === 'true' || params.on === true || params.on === 'on';
        if (on && String(params.confirm ?? '') !== 'yes') return json({ ok: false, reason: 'confirm-required', hint: '打开写入要带 confirm=yes。' }, 400);
        const result = writeApi.set(on);
        if (!result.ok) return json({ ok: false, ...result, ...writeApi.snapshot() }, 403);
        return json({ ok: true, ...writeApi.snapshot() });
      }),
    },
    {
      path: `${API_PREFIX}/write/status`,
      methods: ['GET'],
      fetch: guard(async () => json({ ok: true, ...writeApi.snapshot() })),
    },
    {
      path: `${API_PREFIX}/growth/append`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const blocked = needWrite(params.confirm);
        if (blocked) return blocked;
        return answer(appendGrowthLine({ root: located.root, line: params.line, expect: params.fp ?? params.expect }));
      }),
    },
    {
      path: `${API_PREFIX}/init`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const blocked = needWrite(params.confirm);
        if (blocked) return blocked;
        // 注意：路由**不接收 force** —— "覆盖已有档案"这件事没有按钮。
        const result = initArchiveRoot({ root: params.root, device: params.device, force: false, templatesDir: settings.templatesDir });
        if (result.ok) {
          // 铺完就认它：把刚铺好的目录写进面板状态文件（写失败不炸，只是下次打开面板还得自己选）。
          const saved = rememberRoot({ root: result.root, device: result.device, file: runtime.stateFile() });
          if (saved.ok) log(`铺底成功，位置已记进面板状态文件：${saved.file}`);
          else log(`铺底成功但状态文件没写成（${saved.reason}）：${saved.file}`);
        }
        return answer(result);
      }),
    },
    {
      path: `${API_PREFIX}/sync/status`,
      methods: ['GET'],
      fetch: guard(async () => {
        const located = needRoot();
        if (located.error) return located.error;
        return json({ ok: true, root: located.root, ...syncStatus(located.root) });
      }),
    },
    {
      path: `${API_PREFIX}/sync/dryrun`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const which = String(params.which ?? '');
        if (!Object.prototype.hasOwnProperty.call(SYNC_SCRIPTS, which)) {
          return json({ ok: false, reason: 'not-allowed', which, whitelist: Object.keys(SYNC_SCRIPTS), hint: '恢复.py / 备份.py / 自主轮次.py 永不放行。' }, 403);
        }
        return answer({ root: located.root, ...runSyncScript(located.root, which, { apply: false }) });
      }),
    },
    {
      path: `${API_PREFIX}/sync/merge`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const located = needRoot();
        if (located.error) return located.error;
        const params = await paramsOf(request);
        const which = String(params.which ?? '');
        // 闸①：白名单是硬编码的，不靠调用方自觉
        if (!Object.prototype.hasOwnProperty.call(SYNC_SCRIPTS, which)) {
          return json({ ok: false, reason: 'not-allowed', which, whitelist: Object.keys(SYNC_SCRIPTS), hint: '恢复.py / 备份.py / 自主轮次.py 永不放行。' }, 403);
        }
        // 闸②：写入开关必须开着（并带 confirm=yes）
        const blocked = needWrite(params.confirm);
        if (blocked) return blocked;
        // 闸③：先干跑一次，并把报告一起回带（先看清"会写什么"）
        const dryrun = runSyncScript(located.root, which, { apply: false });
        // 闸④：必须把脚本名原样打进确认框
        if (String(params.ack ?? '') !== which) return json({ ok: false, reason: 'ack-mismatch', expected: which, dryrun }, 400);
        const applied = runSyncScript(located.root, which, { apply: true, timeoutMs: SYNC_TIMEOUT_MS });
        return answer({ root: located.root, which, dryrun, applied });
      }),
    },
    {
      // 面板自选位置①：判一个候选目录是什么（archive / empty / partial / missing）。只读，一个字节都不写。
      path: `${API_PREFIX}/where`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        return json(inspectPath(params.path));
      }),
    },
    {
      // 面板自选位置②：认领一个已有档案。只有判成 archive 才写面板状态文件，且 confirm 必须原样等于 path。
      path: `${API_PREFIX}/adopt`,
      methods: ['GET', 'POST'],
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const result = adoptRoot({ path: params.path, confirm: params.confirm, device: params.device, file: runtime.stateFile() });
        // 2026-09-28：认领会改 root，而 root 决定备份与删除归档的落点 —— 留一行审计。
        if (result.ok) log(`位置被认领：${result.root}（设备 ${result.device ?? '(未定)'}）`);
        else log(`认领被拒：${params.path ?? '(空)'} —— ${result.reason}`);
        // 不是档案 / confirm 没原样打出来 → 400 并把 kind 与 missing 一起回带；状态文件写不动才是 500。
        return json(result, result.ok ? 200 : result.reason === 'state-write-failed' ? 500 : 400);
      }),
    },
  ];
}

function createRuntime(config = {}) {
  const settings = {
    readOnly: config.readOnly !== false, // 默认只读；要写先在配置里显式关掉，再在面板上打开开关
    root: typeof config.root === 'string' ? config.root : undefined,
    device: typeof config.device === 'string' ? config.device : undefined,
    templatesDir: typeof config.templatesDir === 'string' ? config.templatesDir : undefined,
    // 面板状态文件换路径。只为自检（免得碰使用者的 ~/.dsh/memory-panel.json），不是给人配的旋钮。
    panelStateFile: typeof config.panelStateFile === 'string' ? config.panelStateFile : undefined,
  };
  const writeApi = createWriteApi(settings);
  const log = (message) => {
    try {
      console.info(`[memory-panel] ${message}`);
    } catch {
      /* 没有控制台也不影响功能 */
    }
  };
  return {
    settings,
    writeApi,
    log,
    stateFile: () => settings.panelStateFile ?? panelStateFile(),
    resolveRoot: () => resolveRoot(settings, { stateFile: settings.panelStateFile }),
  };
}

// ─────────────────────────────────────────────────────────────── 对外导出

export {
  json,
  paramsOf,
  createWriteApi,
  createRouter,
  createRuntime,
};
