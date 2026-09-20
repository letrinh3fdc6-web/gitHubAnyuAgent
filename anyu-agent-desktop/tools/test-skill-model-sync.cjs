const fs = require('fs')
const vm = require('vm')

const source = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8')
const mainSource = fs.readFileSync(require.resolve('../main.cjs'), 'utf8')
const start = source.indexOf('  function keyCapabilityGroupIds(')
const end = source.indexOf('  function pluginList(')
if (start < 0 || end < 0) throw new Error('skill catalog functions not found')

const state = {
  selectedKey: 1,
  keys: [{ id: 1, image_group_ids: [10, 11, 12], video_group_ids: [20, 21, 22] }],
  skillConfigs: {
    image: { groupId: 11, model: 'stale-image' },
    video: { groupId: 21, model: 'stale-video' }
  },
  skillGroups: [
    { id: 10, name: 'live images', status: 'active', allow_image_generation: true, models: [{ name: 'live-image', capability: 'image' }, { name: 'chat-only', capability: 'text' }] },
    { id: 11, name: 'empty images', status: 'active', allow_image_generation: true, platform: 'openai', models: [] },
    { id: 12, name: 'shared images', status: 'active', allow_image_generation: true, data_sharing_enabled: true, models: [{ name: 'shared-image', capability: 'image' }] },
    { id: 20, name: 'live videos', status: 'active', models: [{ name: 'live-video', capability: 'video' }] },
    { id: 21, name: 'empty videos', status: 'active', platform: 'grok', models: [] },
    { id: 22, name: 'inactive videos', status: 'disabled', models: [{ name: 'inactive-video', capability: 'video' }] }
  ]
}
const context = { state, selectedKey: () => state.keys.find((key) => Number(key.id) === state.selectedKey) }
vm.runInNewContext(`${source.slice(start, end)}; this.availableSkillGroups = availableSkillGroups; this.skillModels = skillModels; this.ensureSkillSelection = ensureSkillSelection;`, context)

const equal = (actual, expected, label) => {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${label}: expected ${right}, got ${left}`)
}

equal([...context.availableSkillGroups('image')].map((group) => group.id), [10], 'image groups')
equal([...context.availableSkillGroups('video')].map((group) => group.id), [20], 'video groups')
equal([...context.skillModels('image')].map((model) => model.name), ['live-image'], 'image models')
equal([...context.skillModels('video')].map((model) => model.name), ['live-video'], 'video models')

context.ensureSkillSelection()
equal(state.skillConfigs.image, { groupId: 10, model: 'live-image' }, 'image selection')
equal(state.skillConfigs.video, { groupId: 20, model: 'live-video' }, 'video selection')

state.skillGroups = []
context.ensureSkillSelection()
equal(state.skillConfigs.image, { groupId: 0, model: '' }, 'empty image selection')
equal(state.skillConfigs.video, { groupId: 0, model: '' }, 'empty video selection')

const selectionStart = mainSource.indexOf('function requiredMediaSelection(')
const selectionEnd = mainSource.indexOf('\napp.whenReady()', selectionStart)
if (selectionStart < 0 || selectionEnd < 0) throw new Error('main-process media selection validator not found')
const selectionContext = {}
vm.runInNewContext(`${mainSource.slice(selectionStart, selectionEnd)}; this.requiredMediaSelection = requiredMediaSelection;`, selectionContext)
equal(selectionContext.requiredMediaSelection({ groupId: '20', model: ' live-video ' }, 'video'), { groupId: 20, model: 'live-video' }, 'validated media selection')
for (const payload of [{ groupId: 0, model: 'live-video' }, { groupId: 20, model: '' }]) {
  let rejected = false
  try { selectionContext.requiredMediaSelection(payload, 'video') } catch { rejected = true }
  if (!rejected) throw new Error(`invalid media selection was accepted: ${JSON.stringify(payload)}`)
}

console.log('skill model sync: dynamic image/video catalog cases passed')
