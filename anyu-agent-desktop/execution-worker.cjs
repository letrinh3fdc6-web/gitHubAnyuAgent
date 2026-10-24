const net = require('node:net')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')
const { send, receive, CHUNK_BYTES, WORKER_FLAG } = require('./execution-protocol.cjs')

function probeAdministrator() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { windowsHide: true, encoding: 'utf8', timeout: 10000 }, (error, result) => {
      if (error) reject(error)
      else resolve(result.trim().toLowerCase() === 'true')
    })
  })
}

function killTree(child) {
  return new Promise(resolve => {
    if (!child?.pid) return resolve()
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, () => {
      try { child.kill('SIGKILL') } catch {}
      resolve()
    })
  })
}

// The worker has no renderer, login state, shell RPC, or network listener.
async function runExecutionWorker(app, { isAdministrator = probeAdministrator, args = process.argv } = {}) {
  const flag = args.indexOf(WORKER_FLAG)
  const [endpoint, token, executable] = args.slice(flag + 1, flag + 4)
  if (process.platform !== 'win32' || !/^\\\\\.\\pipe\\anyu-exec-[a-f0-9]{48}$/.test(endpoint || '') || !/^[a-f0-9]{64}$/.test(token || '') || !path.isAbsolute(executable || '')) throw new Error('Invalid execution worker launch')
  await app.whenReady()
  const administrator = await isAdministrator()
  const children = new Map()
  let authorized = false
  let closing = false
  const socket = net.connect(endpoint)
  const timer = setTimeout(() => socket.destroy(), 15000)
  const shutdown = async () => {
    if (closing) return
    closing = true
    clearTimeout(timer)
    await Promise.all([...children.values()].map(killTree))
    app.exit(0)
  }
  socket.on('connect', () => send(socket, { type: 'hello', version: 1, token, pid: process.pid, administrator }))
  socket.on('error', () => { void shutdown() })
  socket.on('close', () => { void shutdown() })
  app.on('before-quit', event => { if (!closing) { event.preventDefault(); socket.destroy(); void shutdown() } })
  receive(socket, message => {
    if (message.type === 'authorize' && administrator) { authorized = true; clearTimeout(timer); return }
    if (!authorized || closing) throw new Error('Execution worker not authorized')
    if (message.type === 'shutdown') { socket.destroy(); void shutdown(); return }
    const id = String(message.id || '')
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid execution id')
    if (message.type === 'spawn') {
      if (children.has(id) || children.size >= 16 || !Array.isArray(message.args) || !message.args.every(arg => typeof arg === 'string') || !path.isAbsolute(message.cwd || '') || !message.env || typeof message.env !== 'object') throw new Error('Invalid execution request')
      let child
      try {
        child = spawn(executable, message.args, { cwd: message.cwd, env: message.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      } catch (error) { send(socket, { type: 'error', id, message: error.message }); return }
      children.set(id, child)
      child.once('spawn', () => send(socket, { type: 'spawned', id, pid: child.pid }))
      child.on('error', error => send(socket, { type: 'error', id, message: error.message }))
      child.stdin.on('error', error => { if (!closing) send(socket, { type: 'error', id, message: error.message }) })
      for (const stream of ['stdout', 'stderr']) child[stream].on('data', chunk => {
        for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
          if (!send(socket, { type: stream, id, data: chunk.subarray(offset, offset + CHUNK_BYTES).toString('base64') })) {
            child[stream].pause()
            socket.once('drain', () => child[stream].resume())
          }
        }
      })
      // close follows the final stdout/stderr chunk; exit can precede those chunks.
      child.once('close', (code, signal) => { children.delete(id); send(socket, { type: 'exit', id, code, signal }) })
      return
    }
    const child = children.get(id)
    if (!child) return
    if (message.type === 'stdin') child.stdin.write(Buffer.from(message.data || '', 'base64'))
    else if (message.type === 'end') child.stdin.end()
    else if (message.type === 'kill') void killTree(child)
    else throw new Error('Unknown execution request')
  }, () => { void shutdown() })
}

module.exports = { runExecutionWorker, probeAdministrator }
