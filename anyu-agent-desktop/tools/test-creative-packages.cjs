const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { packageCreativeSkills } = require('./package-creative-skills.cjs')
const { SkillManager } = require('../skill-manager.cjs')
const { decodePackage, installPackage, localRevision } = require('../skill-store.cjs')
const { CREATIVE_SKILL_IDS } = require('../creative-studio.cjs')

test('six self-contained licensed skill packages are reproducible and install with human-readable names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-creative-packages-'))
  try {
    const first = await packageCreativeSkills(), second = await packageCreativeSkills()
    assert.deepEqual(first.manifest, second.manifest)
    assert.deepEqual(first.packages.map(skill => skill.id).sort(), [...CREATIVE_SKILL_IDS].sort())
    const manager = new SkillManager(root)
    for (const skill of first.packages) {
      const entries = await decodePackage(skill.bytes)
      const files = new Map(entries.map(entry => [entry.name, entry.bytes]))
      assert.ok(files.has('THIRD_PARTY_NOTICES.md')); assert.ok(files.has('provenance.json'))
      const experience = JSON.parse(files.get('anyu-skill.json'))
      assert.equal(experience.schema_version, 1); assert.deepEqual(experience.required_tools, ['creative_studio'])
      assert.ok(experience.steps.length >= 4); assert.ok(experience.examples.length >= 3)
      const provenance = JSON.parse(files.get('provenance.json'))
      assert.equal(provenance.version, skill.version)
      assert.equal(skill.filename, `${skill.id}-${skill.version}.zip`)
      for (const source of provenance.sources) {
        assert.match(source.commit, /^[a-f0-9]{40}$/)
        assert.match(files.get(`licenses/${source.license_file}`).toString('utf8'), /Permission is hereby granted/)
      }
      const actualHash = createHash('sha256').update(skill.bytes).digest('hex')
      assert.equal(skill.sha256, actualHash)
      const installed = await installPackage(manager, skill, skill.bytes, '')
      assert.equal(installed.name, skill.name); assert.equal(installed.storeSha256, skill.sha256)
      assert.ok(manager.list().some(item => item.id === skill.id && item.name === skill.name))
      await fs.writeFile(path.join(installed.path, 'ANYU_TRAINING.md'), 'Preserve my custom product rules.')
      await installPackage(manager, skill, skill.bytes, localRevision(installed.path))
      assert.equal(await fs.readFile(path.join(installed.path, 'ANYU_TRAINING.md'), 'utf8'), 'Preserve my custom product rules.')
      for (const [name, data] of files) {
        if (!name.endsWith('.md')) continue
        const text = data.toString('utf8')
        assert.ok(!text.includes('GPTIMAGE_API_KEY'), `${skill.id}: inherited external credential setup`)
        assert.ok(!text.includes('tryallapi.com'), `${skill.id}: inherited external commercial endpoint`)
        assert.ok(!text.includes('npx -y'), `${skill.id}: inherited remote execution bootstrap`)
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
})
