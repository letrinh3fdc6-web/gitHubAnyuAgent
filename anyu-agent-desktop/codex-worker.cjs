'use strict'
const readline = require('node:readline')
const { CodexRuntime } = require('./codex-runtime.cjs')

async function runCodexWorker() {
  let runtime, initializing
  const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await initializing?.catch(() => {})
    await runtime?.close()
    process.exit(0)
  }
  input.on('close', () => { void close() })
  process.on('SIGTERM', () => { void close() })
  process.on('SIGINT', () => { void close() })
  input.on('line', line => {
    void (async () => {
      let command
      try {
        command = JSON.parse(line)
        if (command.type === 'extension_ui_response') { runtime?.respondUi(command); return }
        let data
        if (command.type === 'initialize_runtime') {
          if (runtime) throw new Error('Runtime already initialized')
          runtime = new CodexRuntime(command.options, emit)
          initializing = runtime.initialize()
          data = await initializing
        } else {
          if (!initializing) throw new Error('Runtime is not initialized')
          await initializing
          data = await runtime.command(command)
        }
        emit({ type: 'response', id: command.id, command: command.type, success: true, data })
      } catch (error) { emit({ type: 'response', id: command?.id, command: command?.type, success: false, error: error.message }) }
    })()
  })
}

if (require.main === module) runCodexWorker().catch(error => { console.error(error.message); process.exit(1) })
module.exports = { runCodexWorker }
