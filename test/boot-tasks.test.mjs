/**
 * 跨重启续跑（搬进 memory-board 之后）的离线测。
 * 只测"能离线讲清"的部分：队列读写、注入条件、注入形状、消费即清、启动后入队也能读到。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  BOOT_TASK_PREFIX,
  COMPACTION_PREFIX,
  COMPACTION_SOURCE,
  compactionPatch,
  noteCompaction,
  BOOT_TASK_SOURCE,
  bootTaskPatch,
  primeBootTasks,
  readBootTasks,
  stateDirPath,
  writeBootTasks,
} from '../lib/boot-tasks.js'

const ok = { kind: 'continue', messages: [] }

function tmp() {
  return mkdtempSync(join(tmpdir(), 'boot-tasks-'))
}

test('队列读写：写进去能读出来，写空＝清空', () => {
  const dir = tmp()
  try {
    assert.equal(writeBootTasks(dir, ['a', 'b']), true)
    assert.deepEqual(readBootTasks(dir), ['a', 'b'])
    writeBootTasks(dir, [])
    assert.deepEqual(readBootTasks(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读不到的目录/坏文件 → 空队列，不抛', () => {
  assert.deepEqual(readBootTasks('/nonexistent-dir-for-test'), [])
  const dir = tmp()
  try {
    writeBootTasks(dir, ['x'])
    // 写坏它
    writeBootTasks(dir, ['y'])
    assert.deepEqual(readBootTasks(join(dir, 'nope')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非第一发不动手（step ≠ 1）', () => {
  const dir = tmp()
  try {
    writeBootTasks(dir, ['任务一'])
    primeBootTasks(dir)
    assert.equal(bootTaskPatch({ step: 2 }, ok, dir), ok)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('空队列不注入', () => {
  const dir = tmp()
  try {
    writeBootTasks(dir, [])
    primeBootTasks(dir)
    assert.equal(bootTaskPatch({ step: 1 }, ok, dir), ok)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('有队列 → 注入一条【续跑任务】，形状对、消费即清', () => {
  const dir = tmp()
  try {
    writeBootTasks(dir, ['把 A 干完', '再看 B'])
    primeBootTasks(dir)
    const out = bootTaskPatch({ step: 1 }, ok, dir)
    assert.equal(out.messages.length, 1)
    const msg = out.messages[0]
    assert.equal(msg.role, 'user')
    assert.deepEqual(msg.source, BOOT_TASK_SOURCE)
    assert.equal(msg.source.kind, 'boot-tasks')
    const text = msg.content[0].text
    assert.ok(text.includes(BOOT_TASK_PREFIX))
    assert.ok(text.includes('把 A 干完') && text.includes('再看 B'))
    // 消费即清：文件被删、下一发不再注入
    assert.deepEqual(readBootTasks(dir), [])
    assert.equal(bootTaskPatch({ step: 1 }, ok, dir), ok)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('启动后才入队 → 内存空时顺手再读一次文件（2026-10-17 真机修的那条）', () => {
  const dir = tmp()
  try {
    writeBootTasks(dir, []) // 启动时是空的
    primeBootTasks(dir)
    writeBootTasks(dir, ['启动后才入队的活']) // 启动之后才写
    const out = bootTaskPatch({ step: 1 }, ok, dir)
    assert.equal(out.messages.length, 1)
    assert.ok(out.messages[0].content[0].text.includes('启动后才入队的活'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reject/缺失的 decision 原样放行', () => {
  const dir = tmp()
  try {
    writeBootTasks(dir, ['x'])
    primeBootTasks(dir)
    const reject = { kind: 'reject', messages: [] }
    assert.equal(bootTaskPatch({ step: 1 }, reject, dir), reject)
    assert.equal(bootTaskPatch({ step: 1 }, null, dir), null)
    assert.equal(bootTaskPatch({ step: 1 }, undefined, dir), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('状态目录可用环境变量覆盖', () => {
  const dir = tmp()
  const old = process.env.DSH_MEMORY_BOARD_STATE_DIR
  try {
    process.env.DSH_MEMORY_BOARD_STATE_DIR = dir
    assert.equal(stateDirPath(), dir)
  } finally {
    if (old === undefined) delete process.env.DSH_MEMORY_BOARD_STATE_DIR
    else process.env.DSH_MEMORY_BOARD_STATE_DIR = old
    rmSync(dir, { recursive: true, force: true })
  }
})


test('压缩提醒：记一次 → 下一轮注入一次 → 消费即清', () => {
  noteCompaction({ turn: 42 })
  const out = compactionPatch({ step: 1 }, ok)
  assert.equal(out.messages.length, 1)
  const msg = out.messages[0]
  assert.equal(msg.role, 'user')
  assert.deepEqual(msg.source, COMPACTION_SOURCE)
  assert.ok(msg.content[0].text.includes(COMPACTION_PREFIX))
  assert.ok(msg.content[0].text.includes('turn 42'))
  // 消费即清：第二次不再注入
  assert.equal(compactionPatch({ step: 1 }, ok), ok)
})

test('压缩提醒：非第一发 / 没压缩过 都不注入', () => {
  noteCompaction({ turn: 1 })
  assert.equal(compactionPatch({ step: 2 }, ok), ok)
  compactionPatch({ step: 1 }, ok) // 清掉
  assert.equal(compactionPatch({ step: 1 }, ok), ok)
})
