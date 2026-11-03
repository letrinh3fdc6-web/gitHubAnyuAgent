'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { TaskStorage } = require('../task-storage.cjs')

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-task-storage-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const store = new TaskStorage(directory)
  await store.load()
  return store
}

test('coalesces pending saves into one durable snapshot containing every task', async t => {
  const store = await fixture(t)
  const open = t.mock.method(fs, 'open')
  const saves = []
  for (let index = 0; index < 12; index++) {
    store.state.tasks[index] = { input: `task ${index}` }
    saves.push(store.save())
  }
  assert.ok(saves.every(save => save === saves[0]))
  await Promise.all(saves)
  assert.equal(open.mock.callCount(), 1)
  const restored = await new TaskStorage(store.directory).load()
  assert.deepEqual(restored, store.state)
  assert.equal(Object.keys(restored.tasks).length, 12)
})

test('changes during IO require a following durable write and cannot resolve early', async t => {
  const store = await fixture(t)
  const rename = fs.rename
  let reachedRename, releaseRename
  const reached = new Promise(resolve => { reachedRename = resolve })
  const release = new Promise(resolve => { releaseRename = resolve })
  let writes = 0
  t.mock.method(fs, 'rename', async (...args) => {
    if (++writes === 1) { reachedRename(); await release }
    return rename(...args)
  })
  store.state.tasks.first = { status: 'running' }
  const first = store.save()
  await reached
  store.state.tasks.first.status = 'completed'
  store.state.tasks.second = { status: 'running' }
  const second = store.save()
  const third = store.save()
  assert.notEqual(first, second)
  assert.equal(second, third)
  let resolved = false
  second.then(() => { resolved = true })
  await Promise.resolve()
  assert.equal(resolved, false)
  releaseRename()
  await Promise.all([first, second, store.queue])
  assert.equal(writes, 2)
  assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')), store.state)
})

test('failed atomic writes reject all waiting callers, preserve disk and allow recovery', async t => {
  const store = await fixture(t)
  store.state.tasks.saved = { status: 'completed' }
  await store.save()
  const previous = await fs.readFile(store.file, 'utf8')
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('simulated disk failure') })
  store.state.tasks.next = { status: 'running' }
  const first = store.save()
  const second = store.save()
  const results = await Promise.allSettled([first, second])
  assert.ok(results.every(result => result.status === 'rejected' && /disk failure/.test(result.reason.message)))
  assert.equal(await fs.readFile(store.file, 'utf8'), previous)
  assert.deepEqual(await fs.readdir(store.directory), ['state.json'])
  rename.mock.restore()
  await store.save()
  assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')), store.state)
})

test('serialization failure does not poison later saves or shutdown draining', async t => {
  const store = await fixture(t)
  store.state.tasks.circular = store.state
  await assert.rejects(store.save(), /circular/i)
  delete store.state.tasks.circular
  store.state.tasks.recovered = { status: 'completed' }
  await store.save()
  await store.queue
  assert.deepEqual(await new TaskStorage(store.directory).load(), store.state)
})
