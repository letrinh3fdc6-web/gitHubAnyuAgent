'use strict'

const { EventEmitter } = require('node:events')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

function codexExecutable(platform = process.platform, arch = process.arch) {
  const triples = {
    'win32-x64': 'x86_64-pc-windows-msvc', 'win32-arm64': 'aarch64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  }
  const triple = triples[`${platform}-${arch}`]
  if (!triple) throw new Error(`Unsupported Codex platform: ${platform}/${arch}`)
  const root = path.dirname(require.resolve(`@openai/codex-${platform}-${arch}/package.json`))
  const executable = path.join(root, 'vendor', triple, 'bin', platform === 'win32' ? 'codex.exe' : 'codex').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  if (!fs.existsSync(executable)) throw new Error('The bundled Codex App Server is missing. Repair the desktop installation.')
  return executable
}

// JSONL transport for the pinned App Server. No credentials or global Codex
// configuration are read: callers supply a dedicated home and environment.
class CodexClient extends EventEmitter {
  constructor({ home, cwd, env = {}, config = {}, executable = codexExecutable(), spawnProcess = spawn }) {
    super()
    this.pending = new Map()
    this.counter = 0
    this.buffer = ''
    this.closed = false
    fs.mkdirSync(home, { recursive: true })
    const args = ['app-server', '--listen', 'stdio://']
    for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${toml(value)}`)
    this.child = spawnProcess(executable, args, { cwd, env: { ...process.env, ...env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.receive(chunk))
    this.child.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString()))
    this.child.stdin.on('error', error => this.fail(error))
    this.child.once('error', error => this.fail(error))
    this.child.once('close', code => { this.fail(new Error(`Codex App Server exited (${code})`)); this.emit('exit', code) })
  }
  async initialize() {
    const result = await this.request('initialize', { clientInfo: { name: 'anyu_agent', title: 'AnyuAgent', version: require('./package.json').version }, capabilities: { experimentalApi: true } })
    this.notify('initialized', {})
    return result
  }
  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Codex App Server is disconnected')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  notify(method, params) { this.send({ method, params }) }
  respond(id, result) { this.send({ id, result }) }
  reject(id, message) { this.send({ id, error: { code: -32603, message } }) }
  request(method, params, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const id = ++this.counter
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)) }, timeout) : null
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  receive(chunk) {
    this.buffer += chunk
    if (this.buffer.length > 64 * 1024 * 1024) { this.fail(new Error('Codex event exceeds transport limit')); this.child.kill(); return }
    let end
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { this.fail(new Error('Invalid Codex JSONL event')); this.child.kill(); return }
      if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message)
      else {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id); clearTimeout(pending.timer)
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Codex RPC failed'), { code: message.error.code, data: message.error.data }))
        else pending.resolve(message.result)
      }
    }
  }
  fail(error) {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    this.emit('disconnect', error)
  }
  async close() {
    this.fail(new Error('Codex runtime stopped'))
    this.child.stdin.end()
    if (this.child.exitCode !== null || this.child.signalCode) return
    await new Promise(resolve => {
      const timer = setTimeout(() => this.child.kill(), 1500)
      const forced = setTimeout(() => { this.child.kill('SIGKILL'); resolve() }, 5000)
      this.child.once('close', () => { clearTimeout(timer); clearTimeout(forced); resolve() })
    })
  }
}

function toml(value) {
  if (value === null || value === undefined) throw new Error('TOML does not support null')
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`
  if (typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
  return JSON.stringify(value)
}

module.exports = { CodexClient, codexExecutable, toml }
