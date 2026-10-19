// 诊断：切换模型时界面为什么会「卡死转圈」。
//
// 在离屏窗口里跑真实的 renderer/app.js + styles.css，只把 window.anyu 换成
// 可控夹具（tools/fixtures/mock-anyu-preload.cjs），于是可以精确测量：
//   1. 一次整壳重建（renderApp）要多久
//   2. Pi 启动失败时切模型会不会把状态卡在 switching
//   3. Pi 往 stderr 刷 error 时，界面会不会被连续全量重渲染拖死
//
// 用法：node_modules/.bin/electron tools/diagnose-model-switch.cjs
const fs = require('fs')
const os = require('os')
const path = require('path')
const { app, BrowserWindow } = require('electron')

// 独立 userData：诊断实例绝不能读写用户正在用的 localStorage / 更新状态。
app.setPath('userData', path.join(os.tmpdir(), `leta-diagnose-${process.pid}`))

const desktopDir = path.join(__dirname, '..')
const preloadPath = path.join(__dirname, 'fixtures', 'mock-anyu-preload.cjs')
const MODE = process.env.MOCK_PI_MODE || 'fail'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 在页面里装的探针。
//
// 注意不能用 requestAnimationFrame 量「卡不卡」：离屏窗口是不可见窗口，
// Chromium 会把 rAF 降到 <1fps，量出来的全是伪影。这里改用主线程延迟探针——
// 连续排队 setTimeout(0)，如果主线程被同步渲染占住，回调延迟就会飙起来。
const PROBE = `(() => {
  if (window.__probe) return
  const host = document.getElementById('app')
  const probe = window.__probe = { rebuilds: 0, stamps: [] }
  new MutationObserver((records) => {
    // 整壳重建 = #app 的直接子节点被整体换掉
    for (const record of records) {
      if (record.target === host && record.addedNodes.length) { probe.rebuilds += 1; probe.stamps.push(performance.now()) }
    }
  }).observe(host, { childList: true })
})()`

// 主线程延迟探针：返回一批 setTimeout(0) 的实际等待毫秒数。
const LAG_PROBE = `(async () => {
  const lags = []
  for (let i = 0; i < 24; i += 1) {
    const t0 = performance.now()
    await new Promise((resolve) => setTimeout(resolve, 0))
    lags.push(performance.now() - t0)
  }
  return lags
})()`

async function evaluate(win, script) {
  return win.webContents.executeJavaScript(script)
}

function snapshot(win, label) {
  return evaluate(win, `(() => {
    const probe = window.__probe || { rebuilds: 0, stamps: [] }
    return {
      label: ${JSON.stringify(label)},
      rebuilds: probe.rebuilds,
      switching: Boolean(document.querySelector('#model-picker')?.disabled),
      busyText: document.querySelector('#busy')?.textContent || '',
      alert: (document.querySelector('.app-alert')?.textContent || '').slice(0, 120),
      modelLabel: document.querySelector('#model-picker strong')?.textContent || '',
      thinkingPill: (() => { const p = document.querySelector('#thinking-picker'); return p ? { text: p.textContent.trim(), disabled: p.disabled } : null })()
    }
  })()`)
}

function resetProbe(win) {
  return evaluate(win, `(() => { const p = window.__probe; if (!p) return; p.rebuilds = 0; p.stamps = [] })()`)
}

function summarizeLag(lags) {
  const sorted = [...lags].sort((a, b) => b - a)
  return { max: sorted[0] || 0, median: sorted[Math.floor(sorted.length / 2)] || 0 }
}

async function main() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, sandbox: false, backgroundThrottling: false }
  })
  const problems = []
  const consoleErrors = []
  win.webContents.on('console-message', (event) => {
    if ((event?.level ?? 0) >= 3) consoleErrors.push(String(event?.message || ''))
  })

  console.log(`Pi 模式：${MODE}\n`)
  await win.loadFile(path.join(desktopDir, 'renderer', 'index.html'))
  await evaluate(win, PROBE)

  // ── 等待应用进入主界面 ──
  const deadline = Date.now() + 15000
  let ready = false
  while (Date.now() < deadline) {
    ready = await evaluate(win, `Boolean(document.querySelector('#model-picker'))`)
    if (ready) break
    await sleep(150)
  }
  if (!ready) {
    console.error('应用未能在 15 秒内渲染出输入栏')
    console.error(consoleErrors.slice(0, 5).join('\n'))
    win.destroy()
    app.exit(1)
    return
  }
  const boot = await evaluate(win, `({
    modelCount: document.querySelectorAll('#model-menu [data-model-id]').length,
    topModelCount: document.querySelector('.model-count')?.textContent || '',
    mockModels: window.__mock?.modelCount || 0,
    groupLabel: document.querySelector('#group-picker')?.textContent?.trim() || ''
  })`)
  console.log(`启动完成：目录 ${boot.mockModels} 个模型，顶栏显示「${boot.topModelCount}」，当前分组「${boot.groupLabel}」`)
  if (!boot.mockModels) problems.push('夹具未注入模型目录')

  // ── 场景 1：基准 —— 单次整壳重建要多久 ──
  const domScale = await evaluate(win, `({
    nodes: document.querySelectorAll('*').length,
    sessions: document.querySelectorAll('.session').length,
    messages: document.querySelectorAll('.message').length
  })`)
  await resetProbe(win)
  const baseline = await evaluate(win, `(async () => {
    // 每次点完让出一轮宏任务，确保量到的是"一次独立的整壳重建"。
    const samples = []
    for (let i = 0; i < 8; i += 1) {
      const before = window.__probe.rebuilds
      const t0 = performance.now()
      document.querySelector('#new-chat').click()
      await new Promise((r) => setTimeout(r, 0))
      samples.push({ ms: performance.now() - t0, rebuilds: window.__probe.rebuilds - before })
      await new Promise((r) => setTimeout(r, 30))
    }
    return samples
  })()`)
  const rebuildSamples = baseline.filter((item) => item.rebuilds > 0).map((item) => item.ms).sort((a, b) => a - b)
  const perRender = rebuildSamples.length ? rebuildSamples[Math.floor(rebuildSamples.length / 2)] : 0
  console.log(`\n[1] 基准渲染：DOM ${domScale.nodes} 节点 · 会话 ${domScale.sessions} · 消息 ${domScale.messages}`)
  console.log(`    单次整壳重建 中位 ${perRender.toFixed(1)}ms｜最快 ${(rebuildSamples[0] || 0).toFixed(1)}ms｜最慢 ${(rebuildSamples[rebuildSamples.length - 1] || 0).toFixed(1)}ms（样本 ${rebuildSamples.length}）`)
  if (perRender > 60) problems.push(`单次整壳重建 ${perRender.toFixed(0)}ms，远超人眼可接受的一帧（16ms）`)

  // ── 场景 2：stderr 风暴 —— 界面会不会被拖死 ──
  // 真实场景：Pi 启动失败时 stderr 会连续吐 error，渲染层每条都改 state.error 并重渲染。
  await resetProbe(win)
  const storm = await evaluate(win, `(async () => {
    const t0 = performance.now()
    const lags = []
    // 一边持续投喂 error 行，一边用 setTimeout 探主线程还有没有响应。
    const feed = (async () => {
      for (let round = 0; round < 40; round += 1) {
        for (let i = 0; i < 25; i += 1) window.__mock.emitStderr('Error: Failed to load extension attempt ' + round + '-' + i)
        await new Promise((r) => setTimeout(r, 25))
      }
    })()
    for (let i = 0; i < 24; i += 1) {
      const s = performance.now()
      await new Promise((r) => setTimeout(r, 0))
      lags.push(performance.now() - s)
    }
    await feed
    return { elapsed: performance.now() - t0, rebuilds: window.__probe.rebuilds, lags }
  })()`)
  const stormLag = summarizeLag(storm.lags)
  console.log(`[2] stderr 风暴：1000 行 error / ${Math.round(storm.elapsed)}ms → ${storm.rebuilds} 次整壳重建｜主线程延迟 中位 ${stormLag.median.toFixed(0)}ms 峰值 ${stormLag.max.toFixed(0)}ms`)
  if (storm.rebuilds > 15) problems.push(`stderr 期间发生 ${storm.rebuilds} 次全量重建（没有任何节流/去重）`)
  if (stormLag.max > 300) problems.push(`stderr 期间主线程最长阻塞 ${stormLag.max.toFixed(0)}ms`)

  // ── 场景 3：切到国产模型 ──
  await resetProbe(win)
  const switchResult = await evaluate(win, `(async () => {
    const picker = document.querySelector('#model-picker')
    if (!picker) return { error: '没有模型选择器' }
    picker.click()
    // 菜单是异步重建出来的（scheduleAppRender 走 rAF），必须轮询等待。
    let options = []
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 100))
      options = [...document.querySelectorAll('.model-menu [data-model-id]')]
      if (options.length) break
    }
    // 优先挑一个"自动权限档位与当前不同"的模型：只有当档位变化时
    // activateModel 才会走 startAgent 重启 Pi，那才是用户说的"切模型就卡"的路径。
    // minimax 不在 modelPermissionMode 的自动放行名单里（full → confirm）。
    const target = options.find((node) => /minimax/i.test(node.dataset.modelId))
      || options.find((node) => /qwen|glm|kimi|doubao/i.test(node.dataset.modelId))
      || options[1] || options[0]
    if (!target) return { error: '没有可切换的模型', options: options.length, total: window.__mock.modelCount }
    const chosen = target.dataset.modelId
    const beforeRebuilds = window.__probe.rebuilds
    const t0 = performance.now()
    target.click()
    // 等 switching 落地（最多 10 秒），期间穿插主线程延迟探针。
    const lags = []
    let waited = 0
    while (waited < 10000) {
      const s = performance.now()
      await new Promise((r) => setTimeout(r, 50)); waited += 50
      lags.push(performance.now() - s - 50)
      if (!document.querySelector('#model-picker')?.disabled) break
    }
    return {
      chosen, elapsed: performance.now() - t0, waited,
      rebuilds: window.__probe.rebuilds - beforeRebuilds, lags,
      stillSwitching: Boolean(document.querySelector('#model-picker')?.disabled),
      modelLabel: document.querySelector('#model-picker strong')?.textContent || '',
      thinkingPill: (() => { const p = document.querySelector('#thinking-picker'); return p ? { text: p.textContent.trim(), disabled: p.disabled } : null })(),
      alert: (document.querySelector('.app-alert')?.textContent || '').slice(0, 100)
    }
  })()`)
  if (switchResult.error) {
    problems.push(switchResult.error)
    console.log(`[3] 切换模型：${switchResult.error}`)
  } else {
    const switchLag = summarizeLag(switchResult.lags.map((value) => Math.max(0, value)))
    console.log(`\n[3] 切换模型 → ${switchResult.chosen}`)
    console.log(`   耗时 ${Math.round(switchResult.elapsed)}ms（其中等待 ${switchResult.waited}ms）｜整壳重建 ${switchResult.rebuilds} 次｜主线程延迟 中位 ${switchLag.median.toFixed(0)}ms 峰值 ${switchLag.max.toFixed(0)}ms`)
    console.log(`   选择器仍为禁用=${switchResult.stillSwitching}｜标签「${switchResult.modelLabel}」｜强度 pill ${JSON.stringify(switchResult.thinkingPill)}`)
    if (switchResult.alert) console.log(`   错误条：${switchResult.alert}`)
    if (switchResult.stillSwitching) problems.push('切换后模型选择器仍处于禁用状态（switching 未复位）')
    if (switchLag.max > 300) problems.push(`切换期间主线程最长阻塞 ${switchLag.max.toFixed(0)}ms`)
  }

  const final = await snapshot(win, 'after-switch')
  console.log(`\n[4] 终态：累计重建 ${final.rebuilds} 次｜busy「${final.busyText}」｜强度 pill ${JSON.stringify(final.thinkingPill)}`)
  if (consoleErrors.length) console.log(`\n渲染层报错 ${consoleErrors.length} 条，前 3 条：\n${consoleErrors.slice(0, 3).join('\n')}`)

  console.log(`\n结论：${problems.length ? `发现 ${problems.length} 个问题\n - ${problems.join('\n - ')}` : '未发现异常'}`)
  win.destroy()
  // 诊断实例的 userData 落在系统临时目录，清理失败不影响结论。
  try { fs.rmSync(app.getPath('userData'), { recursive: true, force: true }) } catch {}
  app.exit(problems.length ? 1 : 0)
}

app.whenReady().then(main).catch((error) => {
  console.error(error)
  app.exit(1)
})
