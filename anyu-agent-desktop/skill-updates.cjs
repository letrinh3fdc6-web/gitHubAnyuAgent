'use strict'

const path = require('node:path')
const store = require('./skill-store.cjs')
const { compareVersions } = require('./updater.cjs')

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const deferred = () => Object.assign(new Error('等待当前任务结束后继续同步技能'), { code: 'SKILL_UPDATE_DEFERRED' })

// @project-doc docs/interfaces/anyuagent_skill_store.md#automatic-updates
class SkillUpdater {
  constructor({ manager, catalog, download, owner, isBusy, locks = new Set(), emit = () => {}, retryMs = 60000, idleMs = 5000 }) {
    Object.assign(this, { manager, catalog, download, owner, isBusy, locks, emit, retryMs, idleMs })
    this.state = { status: 'idle', message: '', updated: [], failed: [] }
    this.operation = null
    this.commit = null
    this.timer = null
    this.disposed = false
  }

  setState(status, values = {}) {
    this.state = { ...this.state, status, ...values }
    this.emit({ ...this.state, updated: [...this.state.updated], failed: [...this.state.failed] })
    return this.state
  }

  schedule(ms = 2000) {
    if (this.disposed || this.operation) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.sync() }, ms)
    this.timer.unref?.()
  }

  dispose() { this.disposed = true; clearTimeout(this.timer) }
  async waitForCommit() { while (this.commit) await this.commit }

  sync() {
    if (this.operation) return this.operation
    clearTimeout(this.timer)
    this.operation = this.perform().catch(error => this.setState(error.code === 'SKILL_UPDATE_DEFERRED' ? 'waiting' : 'error', {
      message: error.code === 'SKILL_UPDATE_DEFERRED' ? '任务结束或登录后自动继续同步技能' : '技能同步暂未完成，已保留原版本，将自动重试。',
    })).finally(() => {
      this.operation = null
      if (this.state.status === 'waiting') this.schedule(this.idleMs)
      else if (this.state.status === 'error') this.schedule(this.retryMs)
    })
    return this.operation
  }

  async perform() {
    const owner = this.owner()
    if (!owner || this.disposed) return this.setState('idle', { message: '', updated: [], failed: [] })
    const assertAvailable = () => {
      if (this.disposed || this.owner() !== owner || this.isBusy()) throw deferred()
    }
    if (this.isBusy() || this.locks.size) return this.setState('waiting', { message: '任务结束后自动同步技能' })
    this.setState('checking', { message: '正在检查已安装技能…', updated: [], failed: [] })
    const installed = this.manager.list().filter(skill => store.idPattern.test(skill.id) && /^[a-f0-9]{64}$/.test(skill.storeSha256 || ''))
    if (!installed.length) return this.setState('ready', { message: '技能已是最新版本' })
    const catalog = await this.catalog()
    assertAvailable()
    if (!Array.isArray(catalog?.skills)) throw new Error('Invalid skill catalog')
    const available = new Map(catalog.skills.map(skill => [skill.id, skill]))
    let waiting = false
    for (const original of installed) {
      const local = this.manager.list().find(item => item.id === original.id)
      if (!local?.storeSha256) continue
      const skill = available.get(local.id)
      // Unpublished/local-only skills and locally newer versions remain untouched.
      if (!skill || skill.sha256 === local.storeSha256) continue
      if (!/^[a-f0-9]{64}$/.test(skill.sha256 || '') || !versionPattern.test(skill.version || '') || !versionPattern.test(local.storeVersion || '')) {
        this.state.failed.push(local.id)
        continue
      }
      if (compareVersions(skill.version, local.storeVersion) < 0) continue
      if (this.owner() !== owner || this.disposed) { waiting = true; break }
      if (this.isBusy() || this.locks.size) { waiting = true; break }
      this.locks.add(local.id)
      try {
        const revision = store.localRevision(path.join(this.manager.root, local.id))
        this.setState('updating', { message: `正在更新技能：${skill.name || skill.id}` })
        const { bytes } = await this.download(skill)
        assertAvailable()
        let release
        this.commit = new Promise(resolve => { release = resolve })
        try {
          await store.installPackage(this.manager, skill, bytes, revision, { beforeCommit: assertAvailable })
        } finally { this.commit = null; release() }
        this.state.updated.push(local.id)
        this.setState('updating')
      } catch (error) {
        if (error.code === 'SKILL_UPDATE_DEFERRED') waiting = true
        else this.state.failed.push(local.id)
      } finally { this.locks.delete(local.id) }
      if (waiting) break
    }
    if (this.owner() !== owner) return this.setState('waiting', { message: '登录后自动继续同步技能', updated: [], failed: [] })
    if (this.state.failed.length) return this.setState('error', { message: '部分技能未同步，已保留原版本，将自动重试。' })
    if (waiting) return this.setState('waiting', { message: '任务结束后自动继续同步技能' })
    return this.setState('ready', { message: this.state.updated.length ? `已自动更新 ${this.state.updated.length} 个技能` : '技能已是最新版本' })
  }
}

module.exports = { SkillUpdater }
