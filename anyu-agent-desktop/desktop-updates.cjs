const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { artifactFromManifest, compareVersions } = require('./updater.cjs')
const { prepareWindowsUpdate, readMarker, writeMarker, isUpdateWorkerRunning } = require('./windows-update.cjs')
const { sameOriginFetch, fetchBlockMap, differentialDownload, cacheFiles } = require('./update-download.cjs')

class DesktopUpdater {
  constructor({ app, manifestUrl, localOnly = false, emit = () => {}, isBusy = () => false, quit = () => app.quit(), fetch: fetcher = fetch, prepare = prepareWindowsUpdate, platform = process.platform, pollMs = 500 }) {
    Object.assign(this, { app, manifestUrl, localOnly, emit, isBusy, quit, fetcher, prepare, platform, pollMs })
    this.markerPath = path.join(app.getPath('userData'), 'pending-update.json')
    this.state = { status: 'idle', phase: 'idle', message: '' }
    this.operation = null
    this.lastProgressAt = 0
  }

  log(message) {
    try {
      const file = path.join(this.app.getPath('userData'), 'update-download.log')
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, `${file}.previous`)
      fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}\n`)
    } catch {}
  }

  downloadProgress(extra) {
    if (extra.percent !== 100 && Date.now() - this.lastProgressAt < 150) return
    this.lastProgressAt = Date.now()
    this.setState('downloading', extra)
  }

  setState(phase, extra = {}) {
    this.state = { ...this.state, status: phase, phase, ...extra }
    this.emit({ ...this.state })
    return { ...this.state }
  }

  async check(signal) {
    const currentVersion = this.app.getVersion()
    if (this.localOnly) return { ok: true, available: false, currentVersion, latestVersion: currentVersion, localOnly: true }
    const source = new URL(this.manifestUrl)
    source.searchParams.set('_anyu_update', Date.now())
    const timeout = AbortSignal.timeout(30000)
    const response = await this.fetcher(source.href, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { Accept: 'application/json', 'Cache-Control': 'no-cache, no-store' } })
    if (!response.ok) throw new Error(`更新目录不可用 (HTTP ${response.status})`)
    const artifact = artifactFromManifest(await response.json(), currentVersion, source.href)
    if (new URL(artifact.url).origin !== source.origin) throw new Error('更新包地址不属于当前更新源')
    return { ok: true, currentVersion, latestVersion: artifact.version, available: compareVersions(artifact.version, currentVersion) > 0, artifact }
  }

  recover() {
    const pending = readMarker(this.markerPath)
    if (!pending || pending.status === 'completed') return
    if (pending.expectedVersion && compareVersions(this.app.getVersion(), pending.expectedVersion) >= 0) {
      this.setState('updated', { version: this.app.getVersion(), message: `已更新至 v${this.app.getVersion()}` })
    } else if (isUpdateWorkerRunning(pending)) {
      this.setState('installing', { version: pending.expectedVersion, message: '更新仍在安装中，请等待完成。', logPath: pending.logPath || '' })
    } else if (pending.status === 'failed' || ['starting', 'installing', 'restarting'].includes(pending.status)) {
      this.setState('error', { message: pending.error || '上次更新未完成，可以重试。', logPath: pending.logPath || '' })
    } else if (pending.installerPath && fs.existsSync(pending.installerPath)) {
      this.setState('ready', { version: pending.expectedVersion, message: '更新已下载，点击更新即可完成安装并重新启动。' })
    }
  }

  acknowledgeLaunch() {
    const pending = readMarker(this.markerPath)
    if (pending?.status === 'restarting' && compareVersions(this.app.getVersion(), pending.expectedVersion) >= 0) {
      if (pending.artifact) {
        const root = path.join(this.app.getPath('userData'), 'updates')
        const previous = readMarker(path.join(root, 'base.json'))
        writeMarker(path.join(root, 'base.json'), { ...pending.artifact, previousSha256: previous?.sha256 })
        if (/^[a-f0-9]{64}$/.test(previous?.previousSha256 || '') && ![pending.artifact.sha256, previous.sha256].includes(previous.previousSha256)) {
          const expired = cacheFiles(root, previous.previousSha256)
          for (const file of [expired.installer, expired.map]) void fs.promises.rm(file, { force: true }).catch(() => {})
        }
      }
      writeMarker(this.markerPath, { ...pending, status: 'completed', actualVersion: this.app.getVersion(), launchedAt: new Date().toISOString() })
    }
  }

  cancel() {
    if (this.state.phase === 'installing') return false
    this.controller?.abort()
    return true
  }

  install() {
    if (this.operation) return this.operation
    const pending = readMarker(this.markerPath)
    if (isUpdateWorkerRunning(pending)) {
      this.setState('installing', { version: pending.expectedVersion, message: '更新仍在安装中，请等待完成。', logPath: pending.logPath || '' })
      return Promise.resolve({ status: 'installing' })
    }
    if (this.state.phase === 'installing' && pending?.workerPid) this.recover()
    if (this.state.phase === 'installing') return Promise.resolve({ status: 'installing' })
    this.operation = this.performInstall().finally(() => { this.operation = null })
    return this.operation
  }

  async performInstall() {
    this.controller = new AbortController()
    const signal = this.controller.signal
    let installerPath
    let verified = false
    try {
      this.setState('checking', { percent: 0, logPath: '', message: '正在检查更新…' })
      const info = await this.check(signal)
      signal.throwIfAborted()
      if (!info.available) { this.setState('idle'); return { ...info, status: 'latest' } }
      if (this.platform !== 'win32') throw new Error('当前自动安装仅支持 Windows，请从下载页面获取适合此系统的安装包。')
      if (!this.app.isPackaged) throw new Error('开发模式不覆盖安装，请使用已安装的 AnyuAgent 测试自动更新。')
      const { artifact } = info
      this.log(`Update started: ${info.currentVersion} -> ${artifact.version}`)
      const cacheRoot = path.join(this.app.getPath('userData'), 'updates')
      const cache = path.join(cacheRoot, artifact.sha256)
      fs.mkdirSync(cache, { recursive: true })
      installerPath = path.join(cache, 'AnyuAgent-Setup.exe')
      this.setState('verifying', { version: artifact.version, message: '正在校验更新包…' })
      verified = await this.verify(installerPath, artifact)
      if (!verified) {
        const legacyPath = path.join(cacheRoot, `AnyuAgent-update-${artifact.sha256}.exe`)
        if (await this.verify(legacyPath, artifact)) {
          await fs.promises.copyFile(legacyPath, installerPath)
          verified = await this.verify(installerPath, artifact)
        }
      }
      signal.throwIfAborted()
      let newMap
      if (artifact.blockMap) {
        try { newMap = await fetchBlockMap(this.fetcher, artifact, AbortSignal.any([signal, AbortSignal.timeout(30000)])) }
        catch (error) { signal.throwIfAborted(); this.log(`Block map unavailable; using full download: ${error.message}`) }
      }
      if (!verified && newMap) {
        try {
          const base = readMarker(path.join(cacheRoot, 'base.json'))
          const baseFiles = cacheFiles(cacheRoot, base?.sha256)
          this.setState('downloading', { percent: 0, message: '正在下载更新差异…' })
          await differentialDownload({ artifact, base, baseFile: baseFiles.installer, baseMapFile: baseFiles.map, target: installerPath, newMap, fetcher: this.fetcher, signal: AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)]), progress: value => this.downloadProgress(value), log: message => this.log(message) })
          verified = true
        } catch (error) { signal.throwIfAborted(); this.log(`Differential fallback: ${error.message}`) }
      }
      if (!verified) {
        const combined = AbortSignal.any([signal, AbortSignal.timeout(15 * 60 * 1000)])
        this.setState('downloading', { percent: 0, message: '正在下载更新…' })
        const response = await sameOriginFetch(this.fetcher, artifact.url, { signal: combined })
        if (!response.ok || !response.body) throw new Error(`更新包下载失败 (HTTP ${response.status})`)
        if (response.url && new URL(response.url).origin !== new URL(artifact.url).origin) throw new Error('更新下载重定向到了其他更新源')
        const file = await fs.promises.open(installerPath, 'w', 0o700)
        let loaded = 0
        try {
          for await (const chunk of response.body) {
            combined.throwIfAborted()
            const buffer = Buffer.from(chunk)
            loaded += buffer.length
            if (loaded > artifact.bytes) throw new Error('更新包大小超过更新目录记录')
            await file.writeFile(buffer)
            this.downloadProgress({ loaded, total: artifact.bytes, differential: false, percent: Math.floor(loaded / artifact.bytes * 100) })
          }
          await file.sync()
        } finally { await file.close() }
        this.setState('verifying', { percent: 100, message: '正在校验更新包…' })
        verified = await this.verify(installerPath, artifact)
        if (!verified) throw new Error('更新包大小或 SHA-256 校验失败，请重试。')
      }
      if (newMap) await fs.promises.writeFile(path.join(cache, 'package.blockmap'), newMap)
      this.log(`Package verified: ${artifact.bytes} bytes`)
      const pending = { status: 'ready', installerPath, expectedVersion: artifact.version, bytes: artifact.bytes, sha256: artifact.sha256, artifact }
      writeMarker(this.markerPath, pending)
      while (this.isBusy()) {
        this.setState('waiting', { percent: 100, message: '下载完成，等待当前任务结束后自动安装。' })
        await delay(this.pollMs, undefined, { signal })
      }
      signal.throwIfAborted()
      this.setState('preparing', { percent: 100, message: '正在准备安装…' })
      const prepared = await this.prepare({ markerPath: this.markerPath, installerPath, executablePath: this.app.getPath('exe'), version: artifact.version, bytes: artifact.bytes, sha256: artifact.sha256, artifact, userDataPath: this.app.getPath('userData'), signal,
        onProgress: progress => this.setState('preparing', { percent: 100, ...progress }) })
      if (signal.aborted) { writeMarker(this.markerPath, { ...readMarker(this.markerPath), status: 'cancelled' }); signal.throwIfAborted() }
      writeMarker(this.markerPath, { ...readMarker(this.markerPath), status: 'installing' })
      this.setState('installing', { percent: 100, logPath: prepared.logPath, message: '正在安装更新，完成后将自动重新启动。' })
      setTimeout(() => this.quit(), 150)
      return { ...info, status: 'installing' }
    } catch (error) {
      if (installerPath && !verified) { try { fs.rmSync(installerPath, { force: true }) } catch {} }
      if (signal.aborted) { this.setState('idle', { message: '更新已取消。' }); return { status: 'cancelled' } }
      this.setState('error', { logPath: readMarker(this.markerPath)?.logPath || '', message: error.message || '更新失败，请重试。' })
      throw error
    }
  }

  async verify(file, artifact) {
    try {
      if (fs.statSync(file).size !== artifact.bytes) return false
      const hash = crypto.createHash('sha256')
      for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
      return hash.digest('hex') === artifact.sha256.toLowerCase()
    } catch { return false }
  }
}

module.exports = { DesktopUpdater }
