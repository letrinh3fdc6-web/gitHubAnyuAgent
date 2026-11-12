// One resolution budget for the canvas and every full-screen render target.
export function stageRenderScale(width, height, pixelRatio = 1) {
  return Math.min(Math.max(1, pixelRatio), 1.5, Math.sqrt(2_000_000 / Math.max(1, width * height)))
}

export function reportStageProgress(progress, phase) {
  if (!Number.isFinite(progress) || !document.body) return
  const previous = Number(document.body.dataset.anyuLoadingProgress) || 0
  const percentage = Math.max(0, Math.min(98, Math.round(progress)))
  if (percentage < previous) return
  document.body.dataset.anyuLoadingProgress = String(percentage)
  document.body.dataset.anyuLoadingPhase = phase
}

export async function prepareStagePasses(renderer, processes, computation) {
  const target = renderer.getRenderTarget()
  let sliceStarted = performance.now()
  // Cached shaders need no extra frame each; yield once the preparation uses
  // half a frame so the startup animation can keep painting on slower devices.
  const yieldIfBusy = async () => {
    if (performance.now() - sliceStarted < 8) return
    await new Promise(requestAnimationFrame)
    sliceStarted = performance.now()
  }
  try {
    for (const process of processes) {
      for (const pass of process.passes) {
        process.quad.material = pass
        renderer.setRenderTarget(pass.renderTarget)
        await renderer.compileAsync(process.scene, process.camera)
        await yieldIfBusy()
      }
    }
    for (const material of computation.materials) {
      computation.mesh.material = material
      renderer.setRenderTarget(computation.tempDataLinear.buffer)
      await renderer.compileAsync(computation.scene, computation.camera)
      await yieldIfBusy()
    }
  } finally {
    renderer.setRenderTarget(target)
  }
}

// Share GSAP's clock instead of running a second, uncapped render loop.
export function startStageLoop(ticker, render, dispose, onReady = () => {}) {
  let stopped = false
  let ready = false
  let renderedFrames = 0
  const tick = seconds => {
    if (stopped || document.hidden) return
    try {
      render(seconds * 1000)
      // Warm up uploads and buffers without requiring a minimum device frame rate.
      if (!ready) {
        renderedFrames += 1
        if (renderedFrames >= 4) {
          ready = true
          onReady()
        }
      }
    } catch (error) {
      stop()
      window.dispatchEvent(new Event('anyu:stage-error'))
      console.error('ANYU scene rendering failed', error)
    }
  }
  const syncVisibility = () => {
    ticker.remove(tick)
    renderedFrames = 0
    if (stopped || document.hidden) ticker.sleep()
    else {
      ticker.add(tick)
      ticker.wake()
    }
  }
  const onPageHide = event => {
    if (event.persisted) ticker.sleep()
    else stop()
  }
  function stop() {
    if (stopped) return
    stopped = true
    ticker.remove(tick)
    ticker.sleep()
    document.removeEventListener('visibilitychange', syncVisibility)
    window.removeEventListener('pagehide', onPageHide)
    window.removeEventListener('pageshow', syncVisibility)
    window.removeEventListener('anyu:stage-error', stop)
    window.removeEventListener('anyu:stage-dispose', stop)
    dispose()
  }
  ticker.fps(60)
  document.addEventListener('visibilitychange', syncVisibility)
  window.addEventListener('pagehide', onPageHide)
  window.addEventListener('pageshow', syncVisibility)
  window.addEventListener('anyu:stage-error', stop)
  window.addEventListener('anyu:stage-dispose', stop)
  syncVisibility()
  return stop
}
