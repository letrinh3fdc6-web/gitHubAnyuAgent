const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')

const renderer = fs.readFileSync('renderer/app.js', 'utf8')
const rendererStart = renderer.indexOf('  function modelCapabilities(')
const rendererEnd = renderer.indexOf('  function balanceValue(', rendererStart)
if (rendererStart < 0 || rendererEnd < 0) throw new Error('前端模型能力函数不存在')
const rendererContext = {}
vm.runInNewContext(`${renderer.slice(rendererStart, rendererEnd)}; this.modelCapabilities = modelCapabilities`, rendererContext)
assert.equal(rendererContext.modelCapabilities({ supports_vision: true }).supportsImages, true)
assert.equal(rendererContext.modelCapabilities({ capabilities: { supportsVision: true } }).supportsImages, true)
assert.equal(rendererContext.modelCapabilities({ supports_vision: false, input: ['image'] }).supportsImages, false)

const main = fs.readFileSync('main.cjs', 'utf8')
const mainStart = main.indexOf('function modelInputCapabilities(')
const mainEnd = main.indexOf('function modelPermissionMode(', mainStart)
if (mainStart < 0 || mainEnd < 0) throw new Error('主进程模型能力函数不存在')
const mainContext = {}
vm.runInNewContext(`${main.slice(mainStart, mainEnd)}; this.modelInputCapabilities = modelInputCapabilities`, mainContext)
assert.ok(mainContext.modelInputCapabilities({ supportsVision: true }, 'vendor-vision', 'openai-completions').includes('image'))
assert.ok(!mainContext.modelInputCapabilities({ supports_vision: false, input: ['image'] }, 'vendor-vision', 'openai-completions').includes('image'))
console.log('vision capability aliases: passed')
