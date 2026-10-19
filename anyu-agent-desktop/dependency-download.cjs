const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const http = require('node:http')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

function checkedUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('依赖下载必须使用 HTTPS')
  if (url.username || url.password) throw new Error('依赖地址不得包含账号密码')
  return url
}

function responseFor(value, headers = {}, timeoutMs = 30000, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = checkedUrl(value)
    const request = (url.protocol === 'https:' ? https : http).get(url, { headers: { 'User-Agent': 'AnyuAgent dependencies', ...headers } }, (response) => {
      clearTimeout(timer)
      response.setTimeout(timeoutMs, () => response.destroy(new Error('依赖下载流超时')))
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume()
        if (redirects >= 5 || !response.headers.location) return reject(new Error('下载重定向次数过多'))
        const target = new URL(response.headers.location, url)
        if (url.protocol === 'https:' && target.protocol !== 'https:') return reject(new Error('拒绝降级到 HTTP'))
        resolve(responseFor(target, headers, timeoutMs, redirects + 1))
      } else resolve(response)
    })
    const timer = setTimeout(() => request.destroy(new Error('依赖请求超时')), timeoutMs)
    request.once('close', () => clearTimeout(timer))
    request.once('error', reject)
  })
}

async function fetchText(url, timeoutMs = 8000) {
  const response = await responseFor(url, {}, timeoutMs)
  if (response.statusCode !== 200) { response.resume(); throw new Error(`HTTP ${response.statusCode}`) }
  const chunks = []; let bytes = 0
  for await (const chunk of response) {
    bytes += chunk.length
    if (bytes > 2 * 1024 * 1024) { response.destroy(); throw new Error('依赖清单过大') }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function downloadWithResume(url, destination, expectedHash, report = () => {}, dependency = '', options = {}) {
  if (!/^[a-f\d]{64}$/i.test(expectedHash || '')) throw new Error('依赖包必须声明 SHA-256')
  const expected = expectedHash.toLowerCase()
  await fs.promises.mkdir(path.dirname(destination), { recursive: true })
  if (fs.existsSync(destination) && await sha256File(destination) === expected) return destination
  // 未验证数据始终保存在 .part，校验通过后才成为可执行安装包。
  const partial = `${destination}.part`
  if (fs.existsSync(destination) && !fs.existsSync(partial)) await fs.promises.rename(destination, partial)
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    let offset = fs.existsSync(partial) ? (await fs.promises.stat(partial)).size : 0
    let response
    try {
      response = await responseFor(url, offset ? { Range: `bytes=${offset}-`, 'Accept-Encoding': 'identity' } : { 'Accept-Encoding': 'identity' }, options.timeoutMs || 30000)
      if (response.statusCode === 416) {
        response.resume()
        if (fs.existsSync(partial) && await sha256File(partial) === expected) { await fs.promises.rename(partial, destination); return destination }
        await fs.promises.rm(partial, { force: true })
        throw new Error('断点已失效，重新下载')
      }
      if (![200, 206].includes(response.statusCode)) { response.resume(); throw new Error(`HTTP ${response.statusCode}`) }
      if (response.statusCode === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '')
        if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[3]) <= Number(range[2])) {
          response.destroy(); await fs.promises.rm(partial, { force: true }); throw new Error('服务器返回的续传范围无效')
        }
      } else offset = 0
      const total = offset + Number(response.headers['content-length'] || 0)
      const maxBytes = options.maxBytes || 512 * 1024 * 1024
      if (total > maxBytes) { response.destroy(); throw new Error('依赖包超过大小限制') }
      let received = offset; let lastProgress = 0
      const notify = () => {
        try { report({ phase: 'dependency-downloading', dependency, percent: total > 0 ? Math.min(89, 10 + Math.floor(79 * received / total)) : 10, indeterminate: !total, receivedBytes: received, totalBytes: total, message: `${dependency} 已下载 ${(received / 1048576).toFixed(1)} MB` }) } catch {}
      }
      const progress = new Transform({ transform(chunk, encoding, done) {
        received += chunk.length
        if (received > maxBytes) return done(new Error('依赖包超过大小限制'))
        if (Date.now() - lastProgress >= 750) { lastProgress = Date.now(); notify() }
        done(null, chunk)
      } })
      await pipeline(response, progress, fs.createWriteStream(partial, { flags: offset ? 'a' : 'w' }))
      notify()
      if (total && received !== total) throw new Error('下载不完整')
      if (await sha256File(partial) !== expected) {
        await fs.promises.rm(partial, { force: true })
        throw new Error(`${dependency} SHA-256 校验失败`)
      }
      await fs.promises.rename(partial, destination)
      return destination
    } catch (error) {
      response?.destroy()
      lastError = error
      try { report({ phase: 'dependency-retrying', dependency, percent: 10, message: `${dependency}：${error.message}，尝试 ${attempt + 1}/3` }) } catch {}
    }
  }
  throw lastError
}

module.exports = { fetchText, sha256File, downloadWithResume }
