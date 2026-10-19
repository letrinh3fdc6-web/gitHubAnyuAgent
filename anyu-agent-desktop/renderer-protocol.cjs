const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const RENDERER_ORIGIN = 'anyu-app://desktop'
const RENDERER_SCHEME = 'anyu-app'

// Serve the packaged website and its API from one origin. This preserves normal
// browser auth, multipart uploads, binary downloads and cancellation without
// relaxing Chromium's web security or the backend's CORS configuration.
function createRendererHandler({ rendererFile, apiBase, readAsset, fetchApi }) {
  const root = fs.realpathSync(path.dirname(rendererFile))
  const insideRoot = file => {
    const relative = path.relative(root, file)
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }

  return async request => {
    try {
      const url = new URL(request.url)
      if (url.origin !== RENDERER_ORIGIN && `${url.protocol}//${url.host}` !== RENDERER_ORIGIN) {
        return new Response('Unknown application host', { status: 403 })
      }
      const pathname = decodeURIComponent(url.pathname)
      if (/^\/(?:api|v1|v1beta|setup)(?:\/|$)/.test(pathname)) {
        const headers = new Headers(request.headers)
        for (const name of ['host', 'origin', 'referer', 'connection', 'content-length']) headers.delete(name)
        const response = await fetchApi(`${apiBase}${url.pathname}${url.search}`, {
          method: request.method,
          headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer()),
          signal: request.signal,
          redirect: 'manual'
        })
        const responseHeaders = new Headers(response.headers)
        // Node fetch already decompresses the response body.
        for (const name of ['content-encoding', 'content-length', 'connection', 'transfer-encoding']) responseHeaders.delete(name)
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders })
      }

      if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
      // Backslashes and encoded drive paths must never escape the renderer.
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.includes(':')) return new Response('Forbidden', { status: 403 })
      let file = path.resolve(root, `.${pathname}`)
      if (!insideRoot(file)) return new Response('Forbidden', { status: 403 })
      // History-mode routes reload through the SPA shell; missing assets stay 404.
      if (!path.extname(file) && (!fs.existsSync(file) || fs.statSync(file).isDirectory())) file = rendererFile
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response('Not found', { status: 404 })
      file = fs.realpathSync(file)
      if (!insideRoot(file)) return new Response('Forbidden', { status: 403 })
      return await readAsset(pathToFileURL(file).href, { method: request.method, headers: request.headers })
    } catch (error) {
      console.error('[renderer-protocol]', error?.message || error)
      return Response.json({ code: -1, message: 'Desktop resource request failed' }, { status: 502 })
    }
  }
}

module.exports = { RENDERER_ORIGIN, RENDERER_SCHEME, createRendererHandler }
