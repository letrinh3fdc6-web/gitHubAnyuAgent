const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const renderer = fs.readFileSync('renderer/app.js', 'utf8')
const mediaStart = renderer.indexOf('  function mediaMimeType(')
const mediaEnd = renderer.indexOf('  function mediaSourceUrl(', mediaStart)
if (mediaStart < 0 || mediaEnd < 0) throw new Error('媒体解析函数不存在')
const mediaContext = { atob: (value) => Buffer.from(value, 'base64').toString('binary') }
vm.runInNewContext(`${renderer.slice(mediaStart, mediaEnd)}; this.mediaDataUrl = mediaDataUrl; this.mediaBase64Data = mediaBase64Data`, mediaContext)

const raw = Buffer.from('image-fixture').toString('base64')
assert.match(mediaContext.mediaDataUrl({ b64_json: raw }), /^data:image\/png;base64,/)
assert.match(mediaContext.mediaDataUrl([{ b64_json: raw }]), /^data:image\/png;base64,/, '数组媒体结果必须被统一解析')
assert.equal(mediaContext.mediaBase64Data({ data: { image_base64: raw } }), raw)
assert.equal(mediaContext.mediaDataUrl({ data_url: `data:image/jpeg;base64,${raw}` }), `data:image/jpeg;base64,${raw}`)
assert.equal(mediaContext.mediaDataUrl({ result: { image_url: 'https://example.test/image.png' } }), 'https://example.test/image.png')

const main = fs.readFileSync('main.cjs', 'utf8')
const recordStart = main.indexOf('function mediaRecordSources(')
const recordEnd = main.indexOf('async function savePiMediaMessages(', recordStart)
if (recordStart < 0 || recordEnd < 0) throw new Error('媒体持久化函数不存在')
const recordContext = { Date, String, Number, Boolean, Array, Map, JSON }
vm.runInNewContext(`${main.slice(recordStart, recordEnd)}; this.mediaMessageRecord = mediaMessageRecord`, recordContext)
const restored = recordContext.mediaMessageRecord({
  id: 'result', role: 'assistant', content: '完成',
  attachments: [
    { id: 'url', kind: 'image', dataUrl: `data:image/png;base64,${raw}` },
    { id: 'b64', kind: 'image', b64_json: raw }
  ]
})
assert.equal(restored.attachments.length, 2)
assert.match(restored.attachments[0].dataUrl, /^data:image\/png;base64,/)
assert.equal(restored.attachments[1].data, raw)

const attachmentStart = renderer.indexOf('  function attachmentDataUrl(')
const attachmentEnd = renderer.indexOf('  function attachmentObjectUrl(', attachmentStart)
if (attachmentStart < 0 || attachmentEnd < 0) throw new Error('附件地址归一化函数不存在')
const attachmentContext = {}
vm.runInNewContext(`${renderer.slice(attachmentStart, attachmentEnd)}; this.attachmentDataUrl = attachmentDataUrl`, attachmentContext)
assert.equal(attachmentContext.attachmentDataUrl({ kind: 'image', mimeType: 'image/jpeg', data: raw }), `data:image/jpeg;base64,${raw}`)
console.log('media result normalization, rendering and persistence: passed')
