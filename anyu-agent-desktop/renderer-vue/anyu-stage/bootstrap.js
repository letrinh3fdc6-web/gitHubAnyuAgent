const nextFrame = () => new Promise(requestAnimationFrame)
const hasStableViewport = () => {
  const container = document.querySelector('#gl-canvas')
  const rect = container?.getBoundingClientRect()
  return document.documentElement.clientWidth > 1 &&
    document.documentElement.clientHeight > 1 &&
    Boolean(rect && rect.width > 1 && rect.height > 1)
}

// WebGL render targets must not be allocated while the iframe has a zero-sized layout.
while (!hasStableViewport()) await nextFrame()
await nextFrame()
await import('../_astro/index.astro_astro_type_script_index_0_lang.Cu0uHvXK.js?v=28a468504e35')
