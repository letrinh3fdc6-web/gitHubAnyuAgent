'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { digest } = require('./task-storage.cjs')

const EXCLUDED = new Set(['.git', 'node_modules', '.local', '.next', '.nuxt', '.venv', 'venv', 'dist', 'build', 'target', '__pycache__', '.cache'])
const SECRET = /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials|.*\.(?:pem|p12|pfx|key))$/i
const inside = (root, file) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) }

async function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes(':')) throw new Error('A relative workspace path is required')
  const canonical = await fs.realpath(root)
  const target = path.resolve(canonical, relative)
  if (!inside(canonical, target) || target === canonical) throw new Error('Path leaves workspace')
  let cursor = canonical
  for (const part of path.relative(canonical, target).split(path.sep)) {
    cursor = path.join(cursor, part)
    try {
      const stat = await fs.lstat(cursor)
      if (stat.isSymbolicLink()) throw new Error('Symbolic links and junctions cannot be restored')
      if (!inside(canonical, await fs.realpath(cursor))) throw new Error('Path leaves workspace')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return target
}

class WorkspaceCheckpoints {
  constructor(directory, limits = {}) {
    this.directory = directory
    this.maxFiles = limits.maxFiles || 10000
    this.maxBytes = limits.maxBytes || 128 * 1024 * 1024
    this.maxFileBytes = limits.maxFileBytes || 8 * 1024 * 1024
  }

  async persist(id, snapshot) {
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Invalid checkpoint ID')
    const directory = path.join(this.directory, 'manifests')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify(snapshot), { mode: 0o600 })
    return { ref: id, cwd: snapshot.cwd, at: snapshot.at, complete: snapshot.complete, skipped: snapshot.skipped.slice(0, 100), bytes: snapshot.bytes }
  }

  async load(snapshot) {
    if (!snapshot?.ref) return snapshot
    if (!/^[\w-]{1,100}$/.test(snapshot.ref)) throw new Error('Invalid checkpoint reference')
    return JSON.parse(await fs.readFile(path.join(this.directory, 'manifests', `${snapshot.ref}.json`), 'utf8'))
  }

  async capture(root) {
    const cwd = await fs.realpath(root)
    const result = { cwd, at: new Date().toISOString(), files: {}, skipped: [], complete: true, bytes: 0 }
    await fs.mkdir(this.directory, { recursive: true })
    let count = 0
    const walk = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (EXCLUDED.has(entry.name)) continue
        const absolute = path.join(directory, entry.name)
        const relative = path.relative(cwd, absolute).split(path.sep).join('/')
        if (count >= this.maxFiles || result.bytes >= this.maxBytes) { result.complete = false; result.skipped.push(relative); continue }
        if (entry.isSymbolicLink() || SECRET.test(entry.name)) { result.skipped.push(relative); continue }
        if (entry.isDirectory()) { await walk(absolute); continue }
        if (!entry.isFile()) continue
        try {
          const stat = await fs.stat(absolute)
          if (++count > this.maxFiles || stat.size > this.maxFileBytes || result.bytes + stat.size > this.maxBytes) {
            result.skipped.push(relative); result.complete = false; continue
          }
          const data = await fs.readFile(await safePath(cwd, relative))
          const hash = digest(data)
          result.bytes += data.length
          result.files[relative] = { hash, bytes: data.length, mode: stat.mode & 0o777 }
          await fs.writeFile(path.join(this.directory, hash), data, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error })
        } catch (error) { result.skipped.push(relative); result.complete = false }
      }
    }
    await walk(cwd)
    return result
  }

  changes(before, after) {
    if (!before || !after) return []
    const skipped = new Set([...(before.skipped || []), ...(after.skipped || [])])
    return [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])].sort().flatMap(file => {
      if ([...skipped].some(skip => file === skip || file.startsWith(`${skip}/`))) return []
      const old = before.files[file], next = after.files[file]
      return old?.hash === next?.hash && old?.mode === next?.mode ? [] : [{ path: file, kind: !old ? 'added' : !next ? 'deleted' : 'modified', before: old || null, after: next || null }]
    })
  }

  async content(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash || '')) throw new Error('Invalid snapshot hash')
    return fs.readFile(path.join(this.directory, hash))
  }

  async preview(change) {
    const text = async value => {
      if (!value) return ''
      const data = await this.content(value.hash)
      return data.includes(0) ? '[binary file]' : data.subarray(0, 65536).toString('utf8')
    }
    return { ...change, beforeText: await text(change.before), afterText: await text(change.after) }
  }

  async apply(root, changes, reverse = false) {
    const plans = []
    for (const change of changes) {
      const file = await safePath(root, change.path)
      const expected = reverse ? change.after : change.before
      const desired = reverse ? change.before : change.after
      let current = null
      try { current = digest(await fs.readFile(file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (current !== (expected?.hash || null)) throw new Error(`File changed since checkpoint: ${change.path}`)
      plans.push({ file, desired, expected, data: desired ? await this.content(desired.hash) : null })
    }
    for (const plan of plans) {
      // Revalidate each destination immediately before writing. Never follow a
      // newly inserted symlink or overwrite edits made since the review.
      await safePath(root, path.relative(root, plan.file))
      let current = null
      try { current = digest(await fs.readFile(plan.file)) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (current !== (plan.expected?.hash || null)) throw new Error(`Concurrent edit: ${path.basename(plan.file)}`)
      if (!plan.desired) await fs.unlink(plan.file)
      else {
        await fs.mkdir(path.dirname(plan.file), { recursive: true })
        await fs.writeFile(plan.file, plan.data, { mode: plan.desired.mode, flag: plan.expected ? 'w' : 'wx' })
      }
    }
    return { ok: true, count: plans.length }
  }

  async isolate(root, destination) {
    const snapshot = await this.capture(root)
    if (!snapshot.complete) throw new Error('Workspace exceeds isolation limits; reduce its scope before parallel execution')
    await fs.mkdir(destination, { recursive: true })
    for (const [relative, file] of Object.entries(snapshot.files)) {
      const target = await safePath(destination, relative)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, await this.content(file.hash), { flag: 'wx', mode: file.mode })
    }
    return snapshot
  }
}

module.exports = { WorkspaceCheckpoints, safePath, inside }
