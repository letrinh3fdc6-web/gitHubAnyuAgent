const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PluginManager } = require('../plugin-manager.cjs')

function writePlugin(root, version, skillPath = 'skills/hello') {
  const skillFile = path.basename(skillPath).toLowerCase() === 'skill.md'
    ? path.join(root, skillPath)
    : path.join(root, skillPath, 'SKILL.md')
  fs.mkdirSync(path.dirname(skillFile), { recursive: true })
  fs.writeFileSync(path.join(root, 'anyu-plugin.json'), JSON.stringify({
    id: 'plugin-manager-test', version, name: 'plugin-manager-test',
    displayName: 'Plugin Manager Test', description: 'local regression fixture',
    skills: [{ name: 'hello', path: skillPath }]
  }))
  fs.writeFileSync(skillFile, '# hello')
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-plugin-manager-test-'))
  try {
    const manager = new PluginManager(path.join(root, 'data'))
    const v1 = path.join(root, 'v1'); writePlugin(v1, '1.0.0')
    const v2 = path.join(root, 'v2'); writePlugin(v2, '1.1.0', 'skills/hello/SKILL.md')

    const first = await manager.install(v1, { source: 'local' })
    assert.deepStrictEqual(manager.runtimeSkillPaths(root).map((item) => path.basename(item)), ['hello'])
    const second = await manager.install(v2, { source: 'local' })
    assert.strictEqual(second.version, '1.1.0')
    assert.strictEqual(manager.state().installed[0].versions.length, 2)

    const rolled = manager.rollback('plugin-manager-test', '1.0.0')
    assert.strictEqual(rolled.version, '1.0.0')
    assert.strictEqual(manager.runtimeSkillPaths(root).length, 1)

    const published = await manager.preparePublish(rolled.installedPath, { publisherName: 'Regression Tester', visibility: 'private' })
    assert.strictEqual(published.manifest.publisher.name, 'Regression Tester')
    assert.ok(published.bytes > 0)
    assert.strictEqual(published.sha256.length, 64)
    fs.rmSync(published.filePath, { force: true })

    const invalid = path.join(root, 'invalid'); fs.mkdirSync(invalid, { recursive: true })
    writePlugin(invalid, '1.0.0', 'skills/missing')
    fs.rmSync(path.join(invalid, 'skills', 'missing'), { recursive: true, force: true })
    await assert.rejects(() => manager.scanPackage(invalid), /SKILL\.md/)
    assert.ok(first.installedPath)
    manager.setEnabled(first.id, false)
    assert.strictEqual(manager.runtimeSkillPaths(root).length, 0)
    manager.setEnabled(first.id, true)
    assert.strictEqual(manager.runtimeSkillPaths(root).length, 1)
    // 卸载需要清理所有版本，而不是只清理注册表保留的回滚版本。
    const stale = path.join(manager.packagePath, first.id, '0.1.0')
    fs.mkdirSync(stale, { recursive: true })
    fs.writeFileSync(path.join(stale, 'old.txt'), 'old package')
    manager.uninstall(first.id)
    assert.strictEqual(manager.state().installed.length, 0)
    assert.strictEqual(manager.runtimeSkillPaths(root).length, 0)
    assert.ok(!fs.existsSync(path.join(manager.packagePath, first.id)))
    assert.strictEqual(new PluginManager(path.join(root, 'data')).state().installed.length, 0)
    console.log('plugin-manager tests passed')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1 })
