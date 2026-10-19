const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PluginManager, RETIRED_PLUGIN_IDS } = require('../plugin-manager.cjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leta-retired-plugin-test-'))
const appRoot = path.resolve(__dirname, '..')

async function main() {
  try {
    const userData = path.join(root, 'user-data')
    const pluginRoot = path.join(userData, 'plugins')
    const packageRoot = path.join(pluginRoot, 'packages')
    fs.mkdirSync(packageRoot, { recursive: true })
    const plugins = {}
    for (const id of RETIRED_PLUGIN_IDS) {
      const installedPath = path.join(packageRoot, id, '1.0.0')
      fs.mkdirSync(installedPath, { recursive: true })
      fs.writeFileSync(path.join(installedPath, 'SKILL.md'), '# retired')
      plugins[id] = { id, version: '1.0.0', installedPath }
    }
    fs.writeFileSync(path.join(pluginRoot, 'registry.json'), JSON.stringify({ version: 1, plugins }))

    const manager = new PluginManager(userData)
    for (const id of RETIRED_PLUGIN_IDS) {
      assert.equal(manager.get(id), null, `${id} must be removed from the user registry`)
      assert.equal(fs.existsSync(path.join(manager.packagePath, id)), false, `${id} package files must be deleted`)
      assert.equal(fs.existsSync(path.join(appRoot, 'dist', 'skills', `${id}-1.0.0.anyu-plugin.zip`)), false, `${id} must not be packaged`)
    }
    console.log('retired plugin migration removes installed files and registry entries: passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
