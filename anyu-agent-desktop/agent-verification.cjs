'use strict'

const fs = require('node:fs/promises')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { safePath } = require('./workspace-checkpoints.cjs')
const { digest } = require('./task-storage.cjs')
const execute = promisify(execFile)

function validateChecks(checks) {
  if (!Array.isArray(checks) || checks.length > 20) throw new Error('At most 20 acceptance checks are allowed')
  return checks.map(check => {
    if (!check || !['file', 'json', 'command'].includes(check.kind)) throw new Error('Invalid acceptance check')
    if (check.kind === 'command') {
      if (typeof check.command !== 'string' || !check.command.trim() || check.command.length > 512 || !Array.isArray(check.args) || check.args.length > 40 || check.args.some(arg => typeof arg !== 'string' || arg.length > 4096)) throw new Error('Command and argument array required')
      return { kind: 'command', command: check.command, args: check.args, timeoutMs: Math.min(120000, Math.max(1000, Number(check.timeoutMs) || 30000)) }
    }
    if (typeof check.path !== 'string' || !check.path || check.path.length > 1024) throw new Error('Artifact path required')
    if (check.sha256 && !/^[a-f0-9]{64}$/.test(check.sha256)) throw new Error('Invalid SHA256')
    return { kind: check.kind, path: check.path, nonempty: check.nonempty !== false, sha256: check.sha256 || '', requiredKeys: Array.isArray(check.requiredKeys) ? check.requiredKeys.map(String).slice(0, 40) : [] }
  })
}

async function verify(cwd, checks, env = process.env) {
  const results = []
  for (const check of validateChecks(checks)) {
    const start = Date.now()
    try {
      if (check.kind === 'command') {
        const { stdout, stderr } = await execute(check.command, check.args, { cwd, env, timeout: check.timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, shell: false })
        results.push({ ...check, ok: true, code: 0, evidence: `${stdout}\n${stderr}`.slice(-12000), durationMs: Date.now() - start })
      } else {
        const data = await fs.readFile(await safePath(cwd, check.path))
        if (check.nonempty && !data.length) throw new Error('Artifact is empty')
        if (check.sha256 && digest(data) !== check.sha256) throw new Error('Artifact hash mismatch')
        if (check.kind === 'json') {
          const value = JSON.parse(data.toString('utf8'))
          for (const key of check.requiredKeys) if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new Error(`Missing JSON field: ${key}`)
        }
        results.push({ ...check, ok: true, bytes: data.length, sha256: digest(data), durationMs: Date.now() - start })
      }
    } catch (error) {
      results.push({ ...check, ok: false, code: error.code || 'VALIDATION_FAILED', evidence: String(error.stderr || error.message).slice(-12000), durationMs: Date.now() - start })
    }
  }
  return results
}

module.exports = { validateChecks, verify }
