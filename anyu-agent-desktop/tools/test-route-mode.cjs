const assert = require('assert')
const fs = require('fs')
const path = require('path')

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8')
const start = source.indexOf('  async function loadRouteData(')
const end = source.indexOf('\n  function keyPlatform(', start)
assert(start >= 0 && end > start, '无法定位 loadRouteData')

function createLoader(state, overrides = {}) {
  const calls = { keys: 0, skills: 0, automatic: 0, key: 0 }
  const localStorage = { values: {}, setItem(name, value) { this.values[name] = value } }
  const dependencies = {
    state,
    loadKeys: async () => { calls.keys++; state.keys = [] },
    loadSkillGroups: async () => { calls.skills++ },
    loadCatalog: async () => { calls.automatic++; return [{ id: 'managed', groupId: 7 }, { id: 'legacy', groupId: 0 }] },
    loadCatalogForKey: async () => { calls.key++; return [{ id: 'explicit-key', groupId: 0 }] },
    localStorage,
    ...overrides
  }
  const factory = new Function(...Object.keys(dependencies), `${source.slice(start, end)}\nreturn loadRouteData`)
  return { loadRouteData: factory(...Object.values(dependencies)), calls, localStorage }
}

async function main() {
  const automaticState = { accessMode: 'auto', keys: [], keysLoaded: false, selectedKey: 0, catalog: [] }
  const automatic = createLoader(automaticState, {
    loadKeys: async () => { throw new Error('自动模式不应读取公开密钥') }
  })
  await automatic.loadRouteData({ refreshPublicKeys: true })
  assert.strictEqual(automatic.calls.keys, 0)
  assert.strictEqual(automatic.calls.automatic, 1)
  assert.deepStrictEqual(automaticState.catalog, [{ id: 'managed', groupId: 7 }])

  const legacyKeyState = { accessMode: 'key', keys: [], keysLoaded: false, selectedKey: 19, catalog: [] }
  const legacyKey = createLoader(legacyKeyState, {
    loadKeys: async () => { throw new Error('固定自动分组后不应读取公开密钥') }
  })
  await legacyKey.loadRouteData({ refreshPublicKeys: true })
  assert.strictEqual(legacyKey.calls.keys, 0)
  assert.strictEqual(legacyKey.calls.key, 0)
  assert.strictEqual(legacyKeyState.accessMode, 'auto')
  assert.strictEqual(legacyKeyState.selectedKey, 0)

  console.log('route mode tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
