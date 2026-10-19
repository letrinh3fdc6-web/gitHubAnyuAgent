const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const {
  ELEVATION_INTENT_FILE,
  ELEVATION_INTENT_TTL_MS,
  ELEVATION_ENV_FLAG,
  normalizePermissionMode,
  writeIntent,
  readIntent,
  clearIntent,
  isElevatedLaunch
} = require('../elevation-intent.cjs')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-elevation-'))

// ── 渲染层：用真实源码切片跑一遍，确认真实行为而不是只看字符串存在 ──
const appSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')

function createRendererHarness(intent, elevationResult = { restarted: true, state: {} }) {
  const store = new Map()
  const callsList = []
  const sandbox = {
    state: {
      permissionMode: 'auto', activePermissionMode: null, elevationNotice: '', error: '',
      loading: false, sessionPath: 's.jsonl',
      systemAccess: { platform: 'win32', administrator: false }
    },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => { store.set(key, String(value)) }
    },
    window: {
      anyu: {
        elevationIntent: async () => intent,
        acknowledgeElevation: async () => { callsList.push('ack'); return { ok: true } },
        requestSystemElevation: async (payload) => { callsList.push(`elevate:${JSON.stringify(payload)}`); return elevationResult },
        openSystemPrivacySettings: async () => { callsList.push('privacy') }
      }
    },
    renderApp: () => { callsList.push('render') },
    startAgent: async () => { callsList.push('startAgent') },
    refreshSystemAccess: async () => { callsList.push('refreshSystem') },
    console
  }
  vm.runInNewContext(rendererSource, sandbox)
  return { sandbox, store, calls: callsList }
}

let rendererSource = ''

async function main() {
  try {
    // 权限模式归一化：只认三种模式，其余一律视为"只提权、不改模式"
    assert.strictEqual(normalizePermissionMode('full'), 'full')
    assert.strictEqual(normalizePermissionMode('CONFIRM'), 'confirm')
    assert.strictEqual(normalizePermissionMode('auto'), 'auto')
    assert.strictEqual(normalizePermissionMode(''), null)
    assert.strictEqual(normalizePermissionMode(undefined), null)
    assert.strictEqual(normalizePermissionMode('danger-full-access'), null)
    console.log('elevation intent permission mode normalization: passed')

    // 未写入时读取必须是 null，代表"没有提权意图"
    assert.strictEqual(readIntent(workDir), null)
    console.log('elevation intent missing file: passed')

    // 完整访问意图可以同步落盘并被读回
    const written = writeIntent(workDir, 'full', 1_000_000)
    assert.strictEqual(written.permissionMode, 'full')
    assert.strictEqual(readIntent(workDir, 1_000_001).permissionMode, 'full')
    // 文件必须真的落在磁盘上：重启后的新进程只能靠它恢复状态
    assert.ok(fs.existsSync(path.join(workDir, ELEVATION_INTENT_FILE)), '提权意图必须同步落盘')
    console.log('elevation intent full access round trip: passed')

    // 只提权、不改权限模式
    writeIntent(workDir, '', 1_000_000)
    assert.strictEqual(readIntent(workDir, 1_000_001).permissionMode, null, '未指定模式时应记为不改权限')
    console.log('elevation intent elevate only: passed')

    // 过期意图失效，避免很久以后把用户改过的模式又改回完整访问
    writeIntent(workDir, 'full', 1_000_000)
    assert.strictEqual(readIntent(workDir, 1_000_000 + ELEVATION_INTENT_TTL_MS + 1), null, '过期意图必须失效')
    assert.strictEqual(readIntent(workDir, 1_000_000 + ELEVATION_INTENT_TTL_MS - 1).permissionMode, 'full')
    console.log('elevation intent expiry: passed')

    // 损坏内容不能让应用崩，只能当作没有意图
    fs.writeFileSync(path.join(workDir, ELEVATION_INTENT_FILE), 'not-json')
    assert.strictEqual(readIntent(workDir), null)
    fs.writeFileSync(path.join(workDir, ELEVATION_INTENT_FILE), JSON.stringify({ permissionMode: 'full' }))
    assert.strictEqual(readIntent(workDir), null, '缺少 createdAt 的记录必须被拒绝')
    fs.writeFileSync(path.join(workDir, ELEVATION_INTENT_FILE), JSON.stringify(['full']))
    assert.strictEqual(readIntent(workDir), null, '非对象记录必须被拒绝')
    console.log('elevation intent corrupted file: passed')

    // 清除之后不得再读回，否则下次启动会凭空套用完整访问
    writeIntent(workDir, 'full', 1_000_000)
    assert.strictEqual(clearIntent(workDir), true)
    assert.strictEqual(readIntent(workDir, 1_000_001), null)
    assert.strictEqual(clearIntent(workDir), true, '重复清除必须幂等')
    console.log('elevation intent clear: passed')

    // 环境标记只说明"被提权流程拉起"，不代表已拿到管理员权限
    assert.strictEqual(isElevatedLaunch({ [ELEVATION_ENV_FLAG]: '1' }), true)
    assert.strictEqual(isElevatedLaunch({ [ELEVATION_ENV_FLAG]: 'true' }), false)
    assert.strictEqual(isElevatedLaunch({}), false)
    assert.strictEqual(isElevatedLaunch(undefined), false)
    console.log('elevation launch flag: passed')

    // 没有用户数据目录时必须显式报错，而不是写到当前工作目录
    assert.throws(() => writeIntent('', 'full'), /缺少用户数据目录/)
    assert.throws(() => readIntent(''), /缺少用户数据目录/)
    console.log('elevation intent requires user data dir: passed')

    // 切片真实的渲染层源码（applyElevationIntent / confirmElevationIntent / choosePermissionMode）
    const start = appSource.indexOf('async function applyElevationIntent()')
    const end = appSource.indexOf('const THINKING_LEVELS')
    assert.ok(start > 0 && end > start, '未能在 renderer/app.js 中定位提权相关函数')
    rendererSource = appSource.slice(start, end)
    assert.ok(rendererSource.includes('async function choosePermissionMode(mode)'), '切片应包含权限模式切换函数')

    // 提权重启后必须直接恢复完整访问，用户不需要再手动点一次
    {
      const harness = createRendererHarness({ pending: true, permissionMode: 'full', elevated: true, launchedElevated: true })
      const intent = await harness.sandbox.applyElevationIntent()
      assert.strictEqual(intent.pending, true)
      assert.strictEqual(harness.sandbox.state.permissionMode, 'full', '重启后必须自动恢复完整访问')
      assert.strictEqual(harness.store.get('anyu.permissionMode'), 'full')
      assert.strictEqual(harness.store.get('anyu.permissionMode.userSelected'), '1')
      assert.ok(/管理员/.test(harness.sandbox.state.elevationNotice), '应提示已获得管理员权限')
      assert.ok(!harness.calls.includes('ack'), '拉到意图时不应立刻确认，要等权限真正落地')
      console.log('renderer elevation intent restores full access: passed')
    }

    // 提权重启了但系统没给权限，提示必须说清楚，不能让用户以为已提权
    {
      const harness = createRendererHarness({ pending: true, permissionMode: 'full', elevated: false, launchedElevated: true })
      await harness.sandbox.applyElevationIntent()
      assert.strictEqual(harness.sandbox.state.permissionMode, 'full')
      assert.ok(/未授予管理员权限/.test(harness.sandbox.state.elevationNotice), '必须区分"没提权"和"提权失败"')
      console.log('renderer elevation denied notice: passed')
    }

    // 没有待处理意图时不得改动任何状态
    {
      const harness = createRendererHarness({ pending: false, permissionMode: null })
      const intent = await harness.sandbox.applyElevationIntent()
      assert.strictEqual(intent, null)
      assert.strictEqual(harness.sandbox.state.permissionMode, 'auto')
      assert.strictEqual(harness.sandbox.state.elevationNotice, '')
      console.log('renderer elevation no pending intent: passed')
    }

    // 点击完整访问（即使当前非管理员）：只重启 Pi 子进程，绝不触发提权也不重启应用
    {
      const harness = createRendererHarness(null, { restarted: true, state: { platform: 'win32', administrator: false } })
      await harness.sandbox.choosePermissionMode('full')
      assert.ok(!harness.calls.some((call) => call.startsWith('elevate:')), '切完整访问不应触发系统提权')
      assert.ok(harness.calls.includes('startAgent'), '切完整访问应直接重启 Pi 子进程')
      assert.ok(harness.calls.includes('render'), '应刷新界面')
      console.log('renderer full access does not restart app: passed')
    }

    // 权限模式已在进程内落地：直接启动 Pi 并在成功后确认意图
    {
      const harness = createRendererHarness(null, { restarted: false, state: { platform: 'win32', administrator: true } })
      await harness.sandbox.choosePermissionMode('full')
      assert.ok(harness.calls.includes('startAgent'), '切完整访问应直接启动 Pi')
      assert.ok(harness.calls.includes('ack'), '权限落地后必须确认并清除提权意图')
      console.log('renderer elevation confirms intent after start: passed')
    }

    // 用户主动改成非完整访问：立刻撤销兜底意图，避免下次启动被改回完整访问
    {
      const harness = createRendererHarness({ pending: true, permissionMode: 'full' })
      await harness.sandbox.choosePermissionMode('confirm')
      assert.ok(harness.calls.includes('ack'), '选择非完整访问时必须撤销待生效的提权意图')
      assert.strictEqual(harness.store.get('anyu.permissionMode'), 'confirm')
      assert.strictEqual(harness.sandbox.state.elevationNotice, '')
      console.log('renderer elevation cancels intent on other mode: passed')
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
