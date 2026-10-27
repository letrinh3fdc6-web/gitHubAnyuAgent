const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { SkillManager } = require('../skill-manager.cjs')

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-skill-training-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manager = new SkillManager(directory)
  const skill = path.join(manager.root, 'test-skill')
  fs.mkdirSync(skill)
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: test-skill\ndescription: Test skill\n---\nOriginal behavior\n')
  return { manager, directory, skill }
}

test('training rules persist independently of the original skill and are included in invocation reads', t => {
  const { manager, directory, skill } = fixture(t)
  const original = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8')
  const general = manager.readTraining()
  assert.match(general.defaultRules, /SKILL\.md/)
  const savedGeneral = manager.saveTraining({ customRules: 'Use real examples', revision: general.revision })
  const local = manager.readTraining('test-skill')
  const savedLocal = manager.saveTraining({ id: 'test-skill', customRules: 'Keep client preferences', revision: local.revision })
  const reopened = new SkillManager(directory)
  assert.equal(reopened.readTraining().customRules, savedGeneral.customRules)
  assert.equal(reopened.readTraining('test-skill').customRules, savedLocal.customRules)
  assert.equal(reopened.read('test-skill').globalCustomRules, 'Use real examples')
  assert.equal(reopened.read('test-skill').customRules, 'Keep client preferences')
  assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), original)
  assert.equal(savedLocal.workspacePath, skill)
})

test('stale saves cannot overwrite edits from a training conversation', t => {
  const { manager } = fixture(t)
  const before = manager.readTraining('test-skill')
  fs.writeFileSync(before.rulesPath, 'Agent updated these rules')
  assert.throws(() => manager.saveTraining({ id: 'test-skill', customRules: 'Outdated editor', revision: before.revision }), /已变更/)
  assert.equal(manager.readTraining('test-skill').customRules, 'Agent updated these rules')
})

test('invalid skill ids, uninstalled skills, oversized and malformed rules are rejected', t => {
  const { manager } = fixture(t)
  for (const id of ['../outside', 'C:\\outside', 'absent']) assert.throws(() => manager.readTraining(id))
  const revision = manager.readTraining().revision
  for (const customRules of [null, 12, 'x'.repeat(4001), 'bad\0rules']) assert.throws(() => manager.saveTraining({ customRules, revision }))
  assert.throws(() => manager.saveTraining({ customRules: 'missing revision' }), /重新读取/)
})

test('a linked skill directory cannot write training rules outside the installed skill root', t => {
  const { manager, directory } = fixture(t)
  const outside = path.join(directory, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'SKILL.md'), 'outside')
  fs.symlinkSync(outside, path.join(manager.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => manager.readTraining('linked'), /安装目录外/)
})

test('empty rules can be saved without changing another skill or losing global preferences', t => {
  const { manager } = fixture(t)
  const general = manager.readTraining()
  manager.saveTraining({ customRules: 'Global preference', revision: general.revision })
  const local = manager.readTraining('test-skill')
  const saved = manager.saveTraining({ id: 'test-skill', customRules: 'Local preference', revision: local.revision })
  manager.saveTraining({ id: 'test-skill', customRules: '', revision: saved.revision })
  assert.equal(manager.read('test-skill').customRules, '')
  assert.equal(manager.read('test-skill').globalCustomRules, 'Global preference')
})
