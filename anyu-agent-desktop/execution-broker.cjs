const net = require('node:net')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const { launchElevated } = require('./windows-elevation.cjs')
const { send, receive, CHUNK_BYTES, WORKER_FLAG } = require('./execution-protocol.cjs')

class RemoteChild extends EventEmitter {
  constructor(broker, id) {
    super()
    this.broker = broker
    this.id = id
    this.pid = undefined
    this.exitCode = null
    this.signalCode = null
    this.elevatedExecution = true
    this.stdout = new PassThrough()
    this.stderr = new PassThrough()
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const writeNext = offset => {
          if (offset >= chunk.length) return callback()
          send(broker.socket, { type: 'stdin', id, data: chunk.subarray(offset, offset + CHUNK_BYTES).toString('base64') }, error => error ? callback(error) : writeNext(offset + CHUNK_BYTES))
        }
        writeNext(0)
      },
      final: callback => send(broker.socket, { type: 'end', id }, callback),
    })
    this.stdin.on('error', error => this.emit('error', error))
  }
  kill() {
    if (this.exitCode !== null || this.signalCode) return false
    send(this.broker.socket, { type: 'kill', id: this.id })
    return true
  }
  finish(code, signal) {
    if (this.exitCode !== null || this.signalCode) return
    this.exitCode = code ?? -1
    this.signalCode = signal || null
    this.stdin.destroy()
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', this.exitCode, this.signalCode)
    this.emit('close', this.exitCode, this.signalCode)
  }
}

class ExecutionBroker {
  constructor({ app, executable, launch = launchElevated, timeout = 105000 }) {
    this.app = app
    this.executable = executable
    this.launch = launch
    this.timeout = timeout
    this.children = new Map()
    this.socket = null
    this.server = null
    this.workerPid = null
    this.connecting = null
  }
  state() { return { ready: Boolean(this.socket && !this.socket.destroyed && this.workerPid), pid: this.workerPid } }
  async ensure() {
    if (this.state().ready) return this.state()
    if (this.connecting) return this.connecting
    this.connecting = this.connect().finally(() => { this.connecting = null })
    return this.connecting
  }
  async connect() {
    const endpoint = `\\\\.\\pipe\\anyu-exec-${crypto.randomBytes(24).toString('hex')}`
    const token = crypto.randomBytes(32).toString('hex')
    const executable = this.executable()
    const server = net.createServer()
    this.server = server
    let accepted = null
    const sockets = new Set()
    let timer
    let cancelled = false
    try {
      const ready = new Promise((resolve, reject) => {
        this.cancelConnect = () => { cancelled = true; reject(new Error('管理员执行进程启动已取消')) }
        let launchedPid = null
        let candidate = null
        const verify = () => {
          if (cancelled || !candidate || !launchedPid) return
          if (candidate.hello.pid !== launchedPid || candidate.hello.administrator !== true) {
            reject(Object.assign(new Error('执行进程未获得 Windows 管理员权限。'), { code: 'ELEVATION_NOT_VERIFIED' }))
            return
          }
          accepted = candidate.socket
          this.socket = accepted
          this.workerPid = launchedPid
          send(accepted, { type: 'authorize' })
          resolve(this.state())
        }
        timer = setTimeout(() => reject(Object.assign(new Error('管理员执行进程握手超时，请重试。'), { code: 'WORKER_TIMEOUT' })), this.timeout)
        server.on('error', reject)
        server.on('connection', socket => {
          sockets.add(socket)
          const authTimer = setTimeout(() => socket.destroy(), 10000)
          let authenticated = false
          socket.on('error', error => { if (socket === accepted) this.disconnect(error) })
          socket.on('close', () => {
            clearTimeout(authTimer)
            sockets.delete(socket)
            if (socket === this.socket) this.disconnect(new Error('管理员执行进程已断开，请重新申请权限。'))
            else if (candidate?.socket === socket) reject(new Error('管理员执行进程在握手时退出。'))
          })
          receive(socket, message => {
            if (!authenticated) {
              const supplied = Buffer.from(String(message.token || ''))
              if (candidate || message.type !== 'hello' || message.version !== 1 || supplied.length !== token.length || !crypto.timingSafeEqual(supplied, Buffer.from(token))) { socket.destroy(); return }
              authenticated = true
              clearTimeout(authTimer)
              candidate = { socket, hello: message }
              verify()
            } else if (socket === accepted) this.onMessage(message)
          }, error => { if (socket === accepted) this.disconnect(error) })
        })
        server.listen(endpoint, () => {
          const args = [...(this.app.isPackaged ? [] : [this.app.getAppPath()]), WORKER_FLAG, endpoint, token, executable]
          Promise.resolve().then(() => this.launch(this.app.getPath('exe'), args)).then(pid => { launchedPid = pid; verify() }, reject)
        })
      })
      const state = await ready
      for (const socket of sockets) if (socket !== accepted) socket.destroy()
      server.close()
      return state
    } catch (error) {
      cancelled = true
      for (const socket of sockets) socket.destroy()
      server.close()
      this.disconnect(error)
      throw error
    } finally { clearTimeout(timer); this.cancelConnect = null }
  }
  spawn(args, { cwd, env }) {
    if (!this.state().ready) throw new Error('管理员执行进程未就绪')
    const id = crypto.randomUUID()
    const child = new RemoteChild(this, id)
    this.children.set(id, child)
    send(this.socket, { type: 'spawn', id, args, cwd, env })
    return child
  }
  onMessage(message) {
    const child = this.children.get(message.id)
    if (!child) return
    if (message.type === 'spawned') { child.pid = message.pid; child.emit('spawn') }
    else if (message.type === 'stdout' || message.type === 'stderr') child[message.type].write(Buffer.from(message.data, 'base64'))
    else if (message.type === 'error') { child.emit('error', new Error(message.message)); child.kill() }
    else if (message.type === 'exit') { this.children.delete(message.id); child.finish(message.code, message.signal) }
  }
  disconnect(error) {
    this.workerPid = null
    const socket = this.socket
    this.socket = null
    socket?.destroy()
    for (const child of this.children.values()) {
      child.emit('error', error)
      child.finish(-1, null)
    }
    this.children.clear()
  }
  async close() {
    if (this.connecting) {
      this.cancelConnect?.()
      await this.connecting.catch(() => {})
    }
    const socket = this.socket
    if (!socket || socket.destroyed) return
    await new Promise(resolve => {
      const timer = setTimeout(() => { socket.destroy(); resolve() }, 3500)
      socket.once('close', () => { clearTimeout(timer); resolve() })
      send(socket, { type: 'shutdown' })
    })
    this.disconnect(new Error('管理员执行进程已关闭'))
  }
}

module.exports = { ExecutionBroker }
