const nextFrame = () => new Promise(requestAnimationFrame)
const notify = (type) => window.parent.postMessage({ type }, window.location.origin)
const reportFailure = () => notify('anyu:stage-error')
window.addEventListener('anyu:stage-error', reportFailure)
document.addEventListener('webglcontextlost', reportFailure, true)
const readyObserver = new MutationObserver(() => {
  if (document.body.dataset.gl_loading_end !== 'true') return
  readyObserver.disconnect()
  notify('anyu:stage-ready')
})
readyObserver.observe(document.body, { attributes: true, attributeFilter: ['data-gl_loading_end'] })

const hasStableViewport = () => {
  const container = document.querySelector('#gl-canvas')
  const rect = container?.getBoundingClientRect()
  return document.documentElement.clientWidth > 1 &&
    document.documentElement.clientHeight > 1 &&
    Boolean(rect && rect.width > 1 && rect.height > 1)
}

// WebGL render targets must not be allocated while the iframe has a zero-sized layout.
try {
  while (!hasStableViewport()) await nextFrame()
  await nextFrame()
  await import('../_astro/index.astro_astro_type_script_index_0_lang.Cu0uHvXK.js?v=d3eebe9af35a')
} catch (error) {
  readyObserver.disconnect()
  reportFailure()
  console.error('ANYU scene could not start', error)
}
