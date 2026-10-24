// One resolution budget for the canvas and every full-screen render target.
export function stageRenderScale(width, height, pixelRatio = 1) {
  return Math.min(Math.max(1, pixelRatio), 1.5, Math.sqrt(2_000_000 / Math.max(1, width * height)))
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
  let stableFrames = 0
  let previousFrame = null
  const tick = seconds => {
    try {
      const started = performance.now()
      render(seconds * 1000)
      // First draws can upload textures and allocate GPU buffers after compilation.
      if (!ready) {
        const stable = performance.now() - started < 50 &&
          (previousFrame === null || started - previousFrame < 50)
        stableFrames = stable ? stableFrames + 1 : 0
        previousFrame = started
        if (stableFrames >= 4) {
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
    stableFrames = 0
    previousFrame = null
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
