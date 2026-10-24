(() => {
  const route = location.pathname.replace(/\/+$/, '') || '/'
  if (!['/', '/home', '/login', '/register', '/forgot-password', '/reset-password'].includes(route)) return
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  for (const [rel, href, as] of [
    ['modulepreload', '/_astro/index.astro_astro_type_script_index_0_lang.Cu0uHvXK.js?v=__ANYU_RUNTIME_VERSION__', 'script'],
    ['preload', '/common/scene.glb', 'fetch'],
  ]) {
    const link = document.createElement('link')
    link.rel = rel
    link.href = href
    link.as = as
    link.crossOrigin = 'anonymous'
    link.fetchPriority = 'low'
    document.head.appendChild(link)
  }
})()
