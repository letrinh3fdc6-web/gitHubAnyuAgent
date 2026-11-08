'use strict'

// Independent keys run concurrently; failures never poison the next operation.
class KeyedSerialQueue {
  constructor() {
    this.tails = new Map()
    this.draining = null
  }

  run(key, operation) {
    if (this.draining) return Promise.reject(new Error('Runtime is stopping'))
    const previous = this.tails.get(key) || Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => {}, () => {}).finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    this.tails.set(key, tail)
    return result
  }

  drain(operation) {
    if (this.draining) return this.draining
    this.draining = Promise.all([...this.tails.values()]).then(operation).finally(() => {
      this.draining = null
    })
    return this.draining
  }
}

// Spawn only establishes the transport. The caller must still await its RPC handshake.
function waitForSpawn(child, { timeoutMs = 12000, detail = () => '' } = {}) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer)
      child.off('spawn', onSpawn)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onSpawn = () => finish()
    const onError = error => finish(error)
    const onExit = (code, signal) => finish(new Error(`Runtime exited during startup (${code ?? signal ?? 'unknown'})${detail()}`))
    const timer = setTimeout(() => finish(new Error(`Runtime startup timed out${detail()}`)), timeoutMs)
    child.once('spawn', onSpawn)
    child.once('error', onError)
    child.once('exit', onExit)
    if (child.exitCode !== null || child.signalCode) onExit(child.exitCode, child.signalCode)
    else if (child.pid) onSpawn()
  })
}

// Preparation (for example shared runtime extraction) may finish in the
// background, but a cancelled caller must never continue to spawn a process.
function withStartupCancellation(operation, signal) {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Runtime startup cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(operation).then(value => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) onAbort()
      else resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    if (signal.aborted) onAbort()
  })
}

module.exports = { KeyedSerialQueue, waitForSpawn, withStartupCancellation }
