/**
 * 跨重启续跑（2026-10-17 从 `dsh-auto-handoff` 搬过来 —— 那个插件退役，这个能力要留着）。
 *
 * 为什么需要它：宿主一停，正在跑的子代理**不会自己接着跑**（它们活在进程里）。
 * 所以「没干完的活」必须落成文件，由重启后接手的我认领；这里只负责在**下一轮的第一发**
 * 把队列端到眼前，接不接由接手的我判断（做过没、还值不值得做）。
 *
 * 数据落 `<状态目录>/boot-tasks.json`（默认 `$DSH_HOME/memory-board/`，可用
 * `DSH_MEMORY_BOARD_STATE_DIR` 覆盖）。
 *
 * ⚠ 2026-10-17 改路径：搬家时图省事用了换会话插件的 `~/.dsh/session-switch/` —— 但那个目录
 * **只有装过换会话插件的人才存在**，别人装 memory-board 就落不了盘。现在归到插件自己的目录，
 * 并在 `primeBootTasks()` 里做一次**旧路径迁移**（旧有新无就搬过来）。
 *
 * 纯函数部分（`bootTaskPatch`）不碰 ctx，方便离线测；文件读写只有两个小函数。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const BOOT_TASK_FILE = 'boot-tasks.json'
export const BOOT_TASK_PREFIX = '【续跑任务】'
/** 注入标记：`role` 是 user，但 `source.kind` **不是** 'user' —— 别让下游把它当成"他真的说话了"。 */
export const BOOT_TASK_SOURCE = { kind: 'boot-tasks', form: 'instructions' }

/** 状态目录：环境变量优先，否则 `~/.dsh/session-switch`。 */
/** Harness 家目录：`$DSH_HOME` 优先，缺省 `~/.dsh`（跟 panel-state.js 一个口径）。 */
function harnessHome() {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(homedir(), '.dsh')
}

/** 状态目录：环境变量优先，否则 `$DSH_HOME/memory-board` —— **插件自己的目录**，不借别人的。 */
export function stateDirPath() {
  const fromEnv = process.env.DSH_MEMORY_BOARD_STATE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(harnessHome(), 'memory-board')
}

/** 读队列；文件不在/坏掉都当空队列（绝不 throw —— 它跑在每一轮的第一发上）。 */
export function readBootTasks(stateDir = stateDirPath()) {
  if (!stateDir) return []
  try {
    const data = JSON.parse(readFileSync(join(stateDir, BOOT_TASK_FILE), 'utf8'))
    return Array.isArray(data?.tasks) ? data.tasks.filter((t) => typeof t === 'string' && t.trim()) : []
  } catch {
    return []
  }
}

/** 写队列（收工前把没干完的活记下来）；传空数组 ＝ 清空（删文件）。 */
export function writeBootTasks(stateDir, tasks) {
  if (!stateDir) return false
  try {
    mkdirSync(stateDir, { recursive: true })
    const list = Array.isArray(tasks) ? tasks.filter((t) => String(t).trim()) : []
    if (list.length === 0) {
      try {
        rmSync(join(stateDir, BOOT_TASK_FILE), { force: true })
      } catch {
        /* 没有就算了 */
      }
      return true
    }
    writeFileSync(
      join(stateDir, BOOT_TASK_FILE),
      `${JSON.stringify({ at: new Date().toISOString(), tasks: list }, null, 2)}\n`,
      'utf8'
    )
    return true
  } catch {
    return false
  }
}

/** 进程内的"待端出"队列：启动时读一次；空了就在 patch 里顺手再读一次（启动后才入队的情况）。 */
let pending = null

/** 启动时调一次（`apply()` 里）。 */
export function primeBootTasks(stateDir = stateDirPath()) {
  pending = readBootTasks(stateDir)
  // 迁移一次：2026-10-17 搬家那版把队列落在 `~/.dsh/session-switch/`（换会话插件的目录）。
  // 别人没装过那个插件，那儿什么都没有；本机若还留着，就搬进 plugins 自己的目录。
  if (pending.length === 0) {
    const legacyDir = join(harnessHome(), 'session-switch')
    const legacyFile = join(legacyDir, BOOT_TASK_FILE)
    const carried = readBootTasks(legacyDir)
    if (carried.length > 0) {
      pending = carried
      writeBootTasks(stateDir, carried)
      try {
        rmSync(legacyFile, { force: true })
      } catch {
        /* 没有就算了 */
      }
    }
  }
  return pending
}

/**
 * 把队列里的活塞进**下一轮的第一发**（跟官方压缩后的补日记提示同一个位置）。
 * @param payload pre-step 的 payload（`step === 1` 才动手）
 * @param decision 下游的决定（原样回传，只在 `messages` 尾巴上加一条）
 */
export function bootTaskPatch(payload, decision, stateDir = stateDirPath()) {
  if (decision === undefined || decision === null || decision.kind === 'reject') return decision
  if (payload?.step !== 1) return decision
  // 设置面板可以关掉续跑（2026-10-17 他点名要的）：关了就直接放行，队列文件原样留着。
  if (!bootTasksEnabled(stateDir)) return decision
  // 队列也可能在**宿主启动之后**才写进来 —— 内存空就顺手再读一次文件（一次 stat+read）。
  if (!Array.isArray(pending) || pending.length === 0) {
    const late = readBootTasks(stateDir)
    if (late.length === 0) return decision
    pending = late
  }
  const tasks = pending
  pending = null
  writeBootTasks(stateDir, [])
  const text = [
    BOOT_TASK_PREFIX + '宿主重启前有活没干完，队列里还有 ' + tasks.length + ' 件：',
    ...tasks.map((t, i) => `${i + 1}) ${t}`),
    '（先判「做过没」再动手；不做了就把队列清空。队列文件：<状态目录>/boot-tasks.json）',
  ].join('\n')
  const list = Array.isArray(decision.messages) ? decision.messages : []
  return {
    ...decision,
    messages: [
      ...list,
      {
        id: `boot-tasks-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: BOOT_TASK_SOURCE,
      },
    ],
  }
}


// ─────────────────────────────────────────── 官方压缩后的「补日记」提醒（2026-10-17 加）
//
// 为什么要它：DSH 官方的上下文压缩会把历史压成摘要 —— **细节会糊**。
// 而这一段的成果（改了什么、为什么改）如果还没落进日记/状态，压完就很难再回想。
// `compaction/start` 触发时压缩**已经开始**，拦不住；所以做法是：**记下这件事，
// 下一轮的第一发提醒补一条日记**。补的时候靠档案 ＋ 会话日志，不靠压缩后的上下文。

export const COMPACTION_PREFIX = '【压缩提醒】'
export const COMPACTION_SOURCE = { kind: 'compaction-reminder', form: 'instructions' }

/** 压缩开始时调（`apply()` 里挂 `session/event`）。 */
export function noteCompaction(info) {
  compactionPending = info ?? { at: new Date().toISOString() }
}

/** 下一轮第一发把「刚压缩过」端出来一次（消费即清）。 */
export function compactionPatch(payload, decision) {
  if (decision === undefined || decision === null || decision.kind === 'reject') return decision
  if (payload?.step !== 1 || !compactionPending) return decision
  const info = compactionPending
  compactionPending = null
  const turn = info.turn === undefined || info.turn === null ? '?' : info.turn
  const text = [
    COMPACTION_PREFIX + `刚才发生过一次官方上下文压缩（turn ${turn}）—— 压缩只留摘要，细节会糊。`,
    '趁档案和会话日志还翻得到，**把这一段的成果补进日记**（六段式）或刷一次状态；已经记过就忽略这条。',
  ].join('\n')
  const list = Array.isArray(decision.messages) ? decision.messages : []
  return {
    ...decision,
    messages: [...list, { id: `compaction-${Date.now()}`, role: 'user', content: [{ type: 'text', text }], source: COMPACTION_SOURCE }],
  }
}

let compactionPending = null


// ─────────────────────────────────────────── 开关（设置面板可关掉续跑）
//
// 落 `<状态目录>/prefs.json`：`{ "bootTasksEnabled": false }`。
// 默认 **开**（读不到/坏文件一律当开）；关掉后 `bootTaskPatch` 直接放行，队列文件原样留着不消费。

export const PREFS_FILE = 'prefs.json'

/** 读开关；读不到/坏文件 → true（默认开）。 */
export function bootTasksEnabled(stateDir = stateDirPath()) {
  try {
    const data = JSON.parse(readFileSync(join(stateDir, PREFS_FILE), 'utf8'))
    return data?.bootTasksEnabled !== false
  } catch {
    return true
  }
}

/** 写开关；返回是否写成功。 */
export function setBootTasksEnabled(enabled, stateDir = stateDirPath()) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(stateDir, PREFS_FILE), `${JSON.stringify({ bootTasksEnabled: enabled === true }, null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}
