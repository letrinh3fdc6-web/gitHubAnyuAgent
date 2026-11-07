'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { Transform } = require('node:stream')
const Parser = require('stream-json/Parser')
const Assembler = require('stream-json/Assembler')

const MAX_MODEL_BYTES = 64 * 1024 * 1024
const MAX_HISTORY_BYTES = 256 * 1024 * 1024
const MAX_PREVIEW_BYTES = 512 * 1024
const MAX_CACHE_BYTES = 16 * 1024 * 1024

function inputError(code, message, status = 413) {
  return Object.assign(new Error(message), { status, code })
}

function tooLarge() {
  return inputError('MODEL_INPUT_TOO_LARGE', '\u5bf9\u8bdd\u5185\u5bb9\u8fc7\u5927\uff0c\u8bf7\u538b\u7f29\u4e0a\u4e0b\u6587\u6216\u5728\u65b0\u5bf9\u8bdd\u4e2d\u7ee7\u7eed\u73b0\u6709\u521b\u4f5c\u9879\u76ee\uff0c\u65e0\u9700\u91cd\u65b0\u751f\u6210\u5df2\u5b8c\u6210\u7684\u56fe\u7247\u3002 Model input exceeds the size limit; compact the conversation or continue the existing project in a new chat.')
}

class ImagePreviews {
  constructor({ resize, cacheBytes = MAX_CACHE_BYTES } = {}) {
    this.resize = resize
    this.cacheLimit = cacheBytes
    this.cache = new Map()
    this.cacheBytes = 0
  }
  clear() { this.cache.clear(); this.cacheBytes = 0 }
  async url(url, signal) {
    signal?.throwIfAborted()
    if (typeof url !== 'string' || !url.startsWith('data:image/') || url.length <= MAX_PREVIEW_BYTES) return { url }
    const comma = url.indexOf(',')
    const header = url.slice(0, comma)
    if (!/^data:image\/[a-z0-9.+-]+;base64$/i.test(header)) return { url }
    const key = crypto.createHash('sha256').update(url).digest('hex')
    if (this.cache.has(key)) {
      const saved = this.cache.get(key)
      this.cache.delete(key); this.cache.set(key, saved)
      return saved
    }
    if (!this.resize) {
      const module = await import(pathToFileURL(path.join(__dirname, 'node_modules/@earendil-works/pi-coding-agent/dist/utils/image-resize.js')).href)
      this.resize = module.resizeImage
    }
    const result = await this.resize(Buffer.from(url.slice(comma + 1), 'base64'), header.slice(5, -7), {
      maxWidth: 2000, maxHeight: 2000, maxBytes: MAX_PREVIEW_BYTES - 128, jpegQuality: 80,
    })
    signal?.throwIfAborted()
    if (!result?.data || !result.mimeType?.startsWith('image/') || result.data.length > MAX_PREVIEW_BYTES - 128) {
      throw inputError('MODEL_IMAGE_PREVIEW_FAILED', '\u56fe\u7247\u9884\u89c8\u5904\u7406\u5931\u8d25\uff0c\u539f\u56fe\u4ecd\u4fdd\u7559\uff1b\u8bf7\u6539\u7528\u7f29\u7565\u56fe\u6216\u5206\u955c\u8054\u7cfb\u8868\u7ee7\u7eed\u3002 Could not prepare a bounded model image preview; the original image is unchanged.')
    }
    const preview = { url: `data:${result.mimeType};base64,${result.data}` }
    if (result.wasResized && (result.width !== result.originalWidth || result.height !== result.originalHeight)) {
      preview.note = `[Current model image preview: ${result.width}x${result.height}; incoming image: ${result.originalWidth}x${result.originalHeight}. Multiply preview coordinates by ${result.originalWidth / result.width} horizontally and ${result.originalHeight / result.height} vertically to map to the incoming image. Original files are unchanged.]`
    }
    const size = Buffer.byteLength(preview.url) + Buffer.byteLength(preview.note || '')
    if (size <= this.cacheLimit) {
      while (this.cache.size && (this.cacheBytes + size > this.cacheLimit || this.cache.size >= 64)) {
        const oldest = this.cache.keys().next().value
        const value = this.cache.get(oldest)
        this.cacheBytes -= Buffer.byteLength(value.url) + Buffer.byteLength(value.note || '')
        this.cache.delete(oldest)
      }
      this.cache.set(key, preview); this.cacheBytes += size
    }
    return preview
  }
  async parts(parts, signal) {
    const content = []
    for (const part of parts) {
      if (part.type !== 'image') { content.push(part); continue }
      const preview = await this.url(`data:${part.mimeType};base64,${part.data}`, signal)
      const comma = preview.url.indexOf(',')
      if (preview.note) content.push({ type: 'text', text: preview.note })
      content.push({ ...part, mimeType: preview.url.slice(5, comma - 7), data: preview.url.slice(comma + 1) })
    }
    return content
  }
}

function isContentPart(assembler) {
  const p = assembler.path
  return p.length === 4 && p[0] === 'input' && Number.isInteger(p[1]) && (p[2] === 'content' || p[2] === 'output') && Number.isInteger(p[3])
}

// Assemble one image at a time so old, oversized engine histories can be sent
// without retaining the entire original JSON body or rewriting engine history.
async function readModelInput(req, previews, signal, { maxHistoryBytes = MAX_HISTORY_BYTES, maxModelBytes = MAX_MODEL_BYTES } = {}) {
  let received = 0, retained = 0
  const limiter = new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length
    callback(received > maxHistoryBytes ? tooLarge() : null, chunk)
  } })
  const parser = new Parser({ streamValues: false })
  const assembler = new Assembler()
  const fail = error => parser.destroy(error)
  const abort = () => fail(signal.reason || new Error('Task cancelled'))
  limiter.on('error', fail)
  req.on('error', fail)
  signal?.addEventListener('abort', abort, { once: true })
  try {
    signal?.throwIfAborted()
    req.pipe(limiter).pipe(parser)
    for await (const token of parser) {
      signal?.throwIfAborted()
      if (token.name === 'endObject' && isContentPart(assembler)) {
        const part = assembler.current
        if (part.type === 'input_image' && typeof part.image_url === 'string') {
          const preview = await previews.url(part.image_url, signal)
          part.image_url = preview.url
          if (preview.note) {
            assembler.stack.at(-2).push({ type: 'input_text', text: preview.note })
            retained += Buffer.byteLength(preview.note)
          }
        }
        if (typeof part.image_url === 'string') retained += Buffer.byteLength(part.image_url)
      }
      if (token.name === 'stringValue' || token.name === 'keyValue') {
        // Defer only the actual image URL field, never text or tool arguments.
        if (!(token.name === 'stringValue' && assembler.key === 'image_url' && isContentPart(assembler))) retained += Buffer.byteLength(token.value)
      }
      if (retained > maxModelBytes) throw tooLarge()
      // Match JSON.parse's own-property semantics for arbitrary user data.
      if (token.name === 'keyValue' && token.value === '__proto__') Object.defineProperty(assembler.current, '__proto__', { value: undefined, writable: true, enumerable: true, configurable: true })
      assembler.consume(token)
      if (assembler.depth > 128) throw inputError('INVALID_MODEL_INPUT', 'Model input nesting is too deep', 400)
    }
    const body = assembler.current
    if (!body || Array.isArray(body) || typeof body !== 'object') throw inputError('INVALID_MODEL_INPUT', 'Model input must be a JSON object', 400)
    if (Buffer.byteLength(JSON.stringify(body)) > maxModelBytes) throw tooLarge()
    return body
  } catch (error) {
    if (!error.status && !signal?.aborted && /^(Parser|The parser)/.test(error.message)) throw inputError('INVALID_MODEL_INPUT', 'Invalid model request JSON', 400)
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    req.removeListener('error', fail)
    req.unpipe(limiter); limiter.unpipe(parser)
    limiter.destroy(); parser.destroy()
    if (!req.destroyed) req.resume()
  }
}

module.exports = { ImagePreviews, readModelInput, MAX_MODEL_BYTES, MAX_HISTORY_BYTES, MAX_PREVIEW_BYTES }
