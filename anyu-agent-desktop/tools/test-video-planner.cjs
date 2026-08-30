const fs = require('fs')
const vm = require('vm')
const source = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8')
const start = source.indexOf('  function modelField(')
const end = source.indexOf('  function skillActivityLabel(')
if (start < 0 || end < 0) throw new Error('planner functions not found')
const context = {}
vm.runInNewContext(`${source.slice(start, end)}; this.planVideoRequest = planVideoRequest;`, context)
const plan = context.planVideoRequest
const ref = (name) => ({ name, data: 'AQ==', mimeType: 'image/png' })
const seedance = { name: 'Seedance-2.0', display_name: 'Seedance 2.0', duration_min: 4, duration_max: 15, resolutions: ['480p', '720p', '1080p', '4K'], aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], max_reference_images: 9, supports_first_last: true }
const grok = { name: 'grok-video-1.5', display_name: 'Grok Video 1.5', duration_min: 1, duration_max: 15, resolutions: ['1080p'], aspect_ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], max_reference_images: 1, uses_grok_fields: true }
const cases = [
  ['semantic vertical + high quality', plan('请做一个10秒竖屏短视频，最高画质', seedance, [ref('one')]), { duration: 10, resolution: '4K', aspectRatio: '9:16', referenceMode: 'first_image', field: 'first_image' }],
  ['Chinese duration', plan('请做一个五秒竖屏短视频', seedance, []), { duration: 5, resolution: '480p', aspectRatio: '9:16', referenceMode: 'none', field: undefined }],
  ['two references auto first/last', plan('电影感横屏转场', seedance, [ref('first'), ref('last')]), { duration: 5, resolution: '480p', aspectRatio: '16:9', referenceMode: 'first_last', field: 'first_image' }],
  ['grok protocol', plan('方形 1080p', grok, [ref('one')]), { duration: 5, resolution: '1080p', aspectRatio: '1:1', referenceMode: 'reference_image', field: 'reference_image' }]
]
for (const [name, actual, expected] of cases) {
  for (const key of ['duration', 'resolution', 'aspectRatio', 'referenceMode']) if (actual[key] !== expected[key]) throw new Error(`${name}: ${key} expected ${expected[key]}, got ${actual[key]}`)
  if (actual.files[0]?.field !== expected.field) throw new Error(`${name}: field expected ${expected.field}, got ${actual.files[0]?.field}`)
}
console.log(`video planner: ${cases.length} cases passed`)
