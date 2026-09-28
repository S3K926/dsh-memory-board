// dsh-memory-board 客户端半 · 离线自测：设置页照旧 + 指令菜单里的「日记」。
//
// 跑法：node --test test/client-quick-word.test.mjs
//
// 守的是什么（这半块的历史教训：客户端炸一次＝整页打不开）：
//   ① 加载仍是"惰性工厂 + 预打包形式"，plugin id 严格等于包名；
//   ② 设置页「本地记忆」照旧注册（别为了加指令把老的搞坏）；
//   ③ 「日记」注册成 action 指令，点下去发的是**纯文本词**（不是 `/日记`，Host 靠整行关键词认词）；
//   ④ 服务没到齐、会话没挂上输入框、发送抛错 —— 三种情况都不许把页面带崩。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const CLIENT = new URL('../client.js', import.meta.url)

/** 假的 react：factory 顶层只是取几个钩子、定义组件（含 `extends React.Component`），不渲染，因此空实现足够。 */
class ComponentStub {
  constructor(props) {
    this.props = props
  }
  setState() {}
  render() {
    return null
  }
}
const reactStub = new Proxy(
  {},
  {
    get(target, key) {
      if (key === 'createElement') return () => ({ type: 'stub' })
      if (key === 'Component' || key === 'PureComponent') return ComponentStub
      return () => {}
    },
  },
)

/** 把 client.js 当页面脚本加载一遍，拿回它的 exports。 */
async function loadClient() {
  const code = await readFile(CLIENT, 'utf8')
  let captured
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(cfg) {
          captured = cfg
        },
      },
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'dsh-memory-board/client.js' })
  assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load(...)')
  assert.equal(captured.id, 'dsh-memory-board')
  return captured.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error('未预期的 require：' + name)
  })
}

function makeCtx({ inputActions, resolve, injectRuns = true } = {}) {
  const registered = []
  const slotRegistrations = []
  const scope = {
    commandUi: {
      register(contribution) {
        registered.push(contribution)
        return () => {}
      },
    },
    uiSession: {
      resolve(sessionId) {
        if (resolve !== undefined) return resolve(sessionId)
        return { props: { inputActions } }
      },
    },
    effect(fn) {
      return fn()
    },
  }
  const seenInjections = []
  const ctx = {
    slots: {
      inject(name, cb) {
        cb()
      },
      register(spec) {
        slotRegistrations.push(spec)
        return () => {}
      },
    },
    inject(names, cb) {
      seenInjections.push(Array.from(names))
      if (injectRuns) cb(scope)
    },
  }
  return { ctx, registered, slotRegistrations, seenInjections }
}

test('元信息：惰性工厂形式，id 等于包名，模块级 inject 仍只有 slots', async () => {
  const mod = await loadClient()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(Array.from(mod.inject), ['slots'])
})

test('设置页「本地记忆」照旧注册，同时多四条 action 指令：日记 / 备份 / 收工 / 整理', async () => {
  const mod = await loadClient()
  const { ctx, registered, slotRegistrations, seenInjections } = makeCtx({
    inputActions: { setDraft() {}, submit() {} },
  })
  mod.apply(ctx)

  assert.equal(slotRegistrations.length, 1)
  assert.equal(slotRegistrations[0].id, 'memory')
  assert.equal(slotRegistrations[0].label, '本地记忆')

  assert.deepEqual(seenInjections, [['commandUi', 'uiSession']])
  assert.deepEqual(
    registered.map((c) => c.name),
    ['日记', '备份', '收工', '整理'],
  )
  for (const c of registered) {
    assert.equal(c.ui.kind, 'action')
    assert.equal(c.available({}), true)
    assert.ok(c.description().length > 0)
  }
})

test('点一下：发的是词本身（纯文本，不是 /词）', async () => {
  const mod = await loadClient()
  const calls = []
  const { ctx, registered } = makeCtx({
    inputActions: {
      setDraft(text) {
        calls.push(['setDraft', text])
      },
      submit() {
        calls.push(['submit'])
      },
    },
  })
  mod.apply(ctx)
  for (const c of registered) {
    calls.length = 0
    c.ui.run({ sessionId: 'session-19f7' })
    assert.deepEqual(calls, [
      ['setDraft', c.name],
      ['submit'],
    ])
  }
})

test('服务没到齐（inject 不回调）：apply 不抛、设置页照旧', async () => {
  const mod = await loadClient()
  const { ctx, registered, slotRegistrations } = makeCtx({ injectRuns: false })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(registered.length, 0)
  assert.equal(slotRegistrations.length, 1)
})

test('拿不到输入框 / 发送抛错：都不崩，只留 warning', async () => {
  const mod = await loadClient()
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => warned.push(args.join(' '))
  try {
    const missing = makeCtx({ resolve: () => undefined })
    mod.apply(missing.ctx)
    assert.doesNotThrow(() => missing.registered[0].ui.run({ sessionId: 's1' }))
    assert.doesNotThrow(() => missing.registered[0].ui.run({}))

    const broken = makeCtx({
      inputActions: {
        setDraft() {
          throw new Error('boom')
        },
        submit() {},
      },
    })
    mod.apply(broken.ctx)
    assert.doesNotThrow(() => broken.registered[0].ui.run({ sessionId: 's1' }))
    assert.ok(warned.some((w) => w.includes('boom')))
  } finally {
    console.warn = realWarn
  }
})
