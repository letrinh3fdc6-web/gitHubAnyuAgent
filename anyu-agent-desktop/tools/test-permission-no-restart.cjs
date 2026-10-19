// 权限切换不重启应用的回归测试。
//
// 锁住的核心行为：把权限切到"完整访问"只重启 Pi 子进程，绝不触发 UAC /
// 重启应用。系统提权是独立的显式操作，只有 requestElevation() 会走那条路。
//
// 用法：node tools/test-permission-no-restart.cjs
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const appSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')

// 从真实源码里切出权限相关的函数，保证测的是线上跑的那份逻辑。
function slice(start, end) {
  const from = appSource.indexOf(start)
  const to = appSource.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`无法定位代码片段：${start}`)
  return appSource.slice(from, to)
}

const RENDERER_SOURCE = [
  slice('  async function applyElevationIntent()', '  const THINKING_LEVELS'),
  `this.__choose = (mode) => choosePermissionMode(mode)
   this.__elevate = () => requestElevation()
   this.__applyIntent = () => applyElevationIntent()`
].join('\n')

/**
 * 建一个渲染层沙箱。所有外部依赖（Pi 启动、提权、持久化）都换成可观测的打桩，
 * 这样"有没有真的去提权"变成可断言的事实。
 */
function createHarness({ platform = 'win32', administrator = false, elevationResult = { ok: true, restarted: true, state: {} } } = {}) {
  const calls = { startAgent: 0, requestElevation: [], acknowledge: 0, renders: 0, refreshAccess: 0, notice: [] }
  const store = new Map()
  const state = {
    loading: false,
    permissionMode: 'auto',
    sessionPath: null,
    elevationNotice: '',
    systemAccess: { platform, administrator, launchedElevated: false }
  }
  const context = {
    console,
    state,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)) }
    },
    startAgent: async () => { calls.startAgent += 1 },
    refreshSystemAccess: async () => { calls.refreshAccess += 1 },
    renderApp: () => { calls.renders += 1 },
    window: {
      anyu: {
        requestSystemElevation: async (payload) => { calls.requestElevation.push(payload); return elevationResult },
        acknowledgeElevation: async () => { calls.acknowledge += 1; return { ok: true } },
        elevationIntent: async () => null
      }
    }
  }
  vm.runInNewContext(RENDERER_SOURCE, context)
  return { context, state, calls, store }
}

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`${name}: passed`)
  } catch (error) {
    console.error(`${name}: FAILED`)
    console.error(error?.message || error)
    process.exitCode = 1
  }
}

async function main() {
  await check('切到完整访问只重启 Pi，不触发提权也不重启应用', async () => {
    const { context, state, calls, store } = createHarness()
    await context.__choose('full')
    assert.strictEqual(calls.requestElevation.length, 0, '切权限时不应该调用提权接口')
    assert.strictEqual(calls.startAgent, 1, '应该重启一次 Pi 子进程')
    assert.strictEqual(state.permissionMode, 'full')
    assert.strictEqual(store.get('anyu.permissionMode'), 'full')
    assert.strictEqual(store.get('anyu.permissionMode.userSelected'), '1')
  })

  await check('非管理员账号切到完整访问同样不触发提权', async () => {
    // 这是本次修复的核心：过去只要不是管理员，切完整访问就会弹 UAC 并重启应用。
    const { context, calls } = createHarness({ platform: 'win32', administrator: false })
    await context.__choose('full')
    assert.strictEqual(calls.requestElevation.length, 0)
    assert.strictEqual(calls.startAgent, 1)
  })

  await check('切到受控访问会撤销遗留的提权意图', async () => {
    const { context, calls } = createHarness()
    await context.__choose('confirm')
    assert.strictEqual(calls.acknowledge >= 1, true, '应撤销提权意图')
    assert.strictEqual(calls.requestElevation.length, 0)
    assert.strictEqual(calls.startAgent, 1)
  })

  await check('任务进行中拒绝切换权限且不重启 Pi', async () => {
    const { context, state, calls } = createHarness()
    state.loading = true
    await context.__choose('full')
    assert.strictEqual(calls.startAgent, 0, '任务中不应重启 Pi')
    assert.strictEqual(calls.requestElevation.length, 0)
    assert.strictEqual(state.permissionMode, 'auto', '权限模式不应被改掉')
  })

  await check('Pi 启动失败时保留提权意图留给主进程兜底', async () => {
    const { context, calls } = createHarness()
    context.startAgent = async () => { throw new Error('Pi 启动失败') }
    await context.__choose('full')
    assert.strictEqual(calls.acknowledge, 0, '启动失败时不能确认意图，否则兜底会丢')
  })

  await check('Pi 启动成功后确认提权意图', async () => {
    const { context, calls } = createHarness()
    await context.__choose('full')
    assert.strictEqual(calls.acknowledge >= 1, true)
  })

  await check('系统提权是独立动作且不顺手改权限模式', async () => {
    const { context, state, calls } = createHarness()
    state.permissionMode = 'confirm'
    await context.__elevate()
    assert.strictEqual(calls.requestElevation.length, 1)
    // 关键：不能传 permissionMode，否则提权会顺带把用户的权限模式改掉。
    // 跨 vm 域的对象原型不同，不能直接 deepStrictEqual，按键判断。
    assert.deepStrictEqual(Object.keys(calls.requestElevation[0]), [], `提权不应携带任何参数，实际：${JSON.stringify(calls.requestElevation[0])}`)
    assert.strictEqual('permissionMode' in calls.requestElevation[0], false)
    assert.strictEqual(state.permissionMode, 'confirm', '提权不应该修改权限模式')
    assert.strictEqual(calls.startAgent, 0, '提权会重启应用，本进程不再启动 Pi')
  })

  await check('提权被 UAC 取消时给出提示且不重启 Pi', async () => {
    const { context, state, calls } = createHarness({ elevationResult: { ok: false, cancelled: true, state: {} } })
    await context.__elevate()
    assert.strictEqual(calls.startAgent, 0)
    assert.ok(String(state.error || '').includes('UAC'), `应提示 UAC 未完成，实际：${state.error}`)
  })

  await check('提权后已具备管理员权限时不再重复提权', async () => {
    const { context, calls } = createHarness({ administrator: true, elevationResult: { ok: true, restarted: false, state: { administrator: true } } })
    await context.__elevate()
    assert.strictEqual(calls.startAgent, 0)
    assert.strictEqual(calls.renders, 1)
  })

  await check('提权重启后按落盘意图恢复完整访问', async () => {
    const { context, state, store } = createHarness()
    context.window.anyu.elevationIntent = async () => ({ pending: true, permissionMode: 'full', elevated: true })
    const intent = await context.__applyIntent()
    assert.strictEqual(intent?.pending, true)
    assert.strictEqual(state.permissionMode, 'full')
    assert.strictEqual(store.get('anyu.permissionMode'), 'full')
    assert.ok(String(state.elevationNotice).includes('完整访问已生效'), `提示文案不对：${state.elevationNotice}`)
  })

  await check('提权流程跑到了但系统没给管理员权限时如实提示', async () => {
    const { context, state } = createHarness()
    context.window.anyu.elevationIntent = async () => ({ pending: true, permissionMode: 'full', elevated: false })
    await context.__applyIntent()
    assert.ok(String(state.elevationNotice).includes('未授予管理员权限'), `提示文案不对：${state.elevationNotice}`)
  })

  await check('只提权不改模式的意图不会强行套用完整访问', async () => {
    const { context, state, store } = createHarness()
    context.window.anyu.elevationIntent = async () => ({ pending: true, permissionMode: null, elevated: true })
    const intent = await context.__applyIntent()
    assert.strictEqual(intent?.pending, true)
    assert.strictEqual(state.permissionMode, 'auto', '只提权时不应改动权限模式')
    assert.strictEqual(store.has('anyu.permissionMode'), false)
  })

  await check('没有待处理意图时不做任何改动', async () => {
    const { context, state } = createHarness()
    const intent = await context.__applyIntent()
    assert.strictEqual(intent, null)
    assert.strictEqual(state.permissionMode, 'auto')
  })

  console.log(`\n${passed} passed${process.exitCode ? ', 有失败' : ''}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
