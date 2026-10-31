'use strict'
const fs = require('node:fs/promises')

class AgentEventLog {
  constructor({ onError = () => {}, open = fs.open, delay = 25 } = {}) {
    this.onError = onError
    this.open = open
    this.delay = delay
    this.files = new Map()
  }
  append(file, record, immediate = false) {
    let state = this.files.get(file)
    if (!state) { state = { lines: [], bytes: 0, work: null, writing: null, timer: null, failures: 0 }; this.files.set(file, state) }
    const line = `${JSON.stringify(record)}\n`
    state.lines.push(line)
    state.bytes += Buffer.byteLength(line)
    if (immediate || state.bytes >= 64 * 1024) this.schedule(file, state, 0)
    else if (!state.timer) this.schedule(file, state, this.delay)
  }
  schedule(file, state, delay) {
    if (state.writing) return
    clearTimeout(state.timer)
    state.timer = setTimeout(() => { state.timer = null; void this.flush(file).catch(this.onError) }, delay)
    state.timer.unref?.()
  }
  pending(file) {
    return (this.files.get(file)?.lines || []).map(line => JSON.parse(line))
  }
  flush(file) {
    if (!file) return Promise.all([...this.files.keys()].map(key => this.flush(key)))
    const state = this.files.get(file)
    if (!state) return Promise.resolve()
    clearTimeout(state.timer); state.timer = null
    if (state.writing) return state.writing
    const writing = this.write(file, state)
    state.writing = writing
    return writing
  }
  async write(file, state) {
    try {
      while (state.lines.length) {
        if (!state.work) {
          let bytes = 0, count = 0
          do { bytes += Buffer.byteLength(state.lines[count++]) } while (count < state.lines.length && bytes < 256 * 1024)
          state.work = { buffer: Buffer.from(state.lines.slice(0, count).join('')), offset: 0, count }
        }
        const work = state.work
        const handle = await this.open(file, 'a', 0o600)
        try {
          // Remember partial writes so retry cannot duplicate a JSONL prefix.
          while (work.offset < work.buffer.length) {
            const { bytesWritten } = await handle.write(work.buffer, work.offset, work.buffer.length - work.offset)
            if (!bytesWritten) throw new Error('Event log write made no progress')
            work.offset += bytesWritten
          }
        } finally { await handle.close() }
        state.lines.splice(0, work.count)
        state.bytes -= work.buffer.length
        state.work = null
        state.failures = 0
      }
    } catch (error) {
      state.failures++
      throw error
    } finally {
      state.writing = null
      if (!state.lines.length) this.files.delete(file)
      else this.schedule(file, state, Math.min(30000, 1000 * 2 ** Math.min(state.failures - 1, 5)))
    }
  }
}

module.exports = { AgentEventLog }
