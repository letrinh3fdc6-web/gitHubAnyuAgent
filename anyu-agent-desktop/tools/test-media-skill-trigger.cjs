const fs = require('fs')
const vm = require('vm')

const source = fs.readFileSync(require.resolve('../renderer/app.js'), 'utf8')
const start = source.indexOf('  function mediaSkillForPrompt(')
const end = source.indexOf('  function mediaPrompt(', start)
if (start < 0 || end < 0) throw new Error('media skill function not found')

const context = { state: { skillEnabled: { image: true, video: true } } }
vm.runInNewContext(`${source.slice(start, end)}; this.mediaSkillForPrompt = mediaSkillForPrompt`, context)

const cases = [
  ['@生图 画一只猫', 'image'],
  ['@image draw a cat', 'image'],
  ['@生图', 'image'],
  // 中文没有空格：@ 出现在句子中间（前面是汉字）必须同样触发。
  ['电商鞋子高级感@生图', 'image'],
  ['帮我@生图一张白底图', 'image'],
  ['@生图，画一只猫', 'image'],
  ['@生图https://example.com/a.png 风格参考', 'image'],
  ['@生视频 做一个广告', 'video'],
  ['@视频 做一个广告', 'video'],
  ['@video make an ad', 'video'],
  ['产品图@视频宣传一下', 'video'],
  // 普通对话（没有 @ 标记）依旧不触发。
  ['生成一张图片', ''],
  ['帮我制作一个视频', ''],
  ['请分析这个视频', ''],
  ['请画一张图片', ''],
  // 邮箱/域名里紧贴的字母数字不算技能标记。
  ['发我邮件 user@imageshop.com', ''],
  ['看下 user@image.com', ''],
  ['@生图帮我把背景改成夜晚', 'image']
]

for (const [prompt, expected] of cases) {
  const actual = context.mediaSkillForPrompt(prompt)
  if (actual !== expected) throw new Error(`${JSON.stringify(prompt)} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

context.state.skillEnabled.image = false
if (context.mediaSkillForPrompt('@生图 画一只猫') !== '') throw new Error('disabled image skill should not trigger')
context.state.skillEnabled.video = false
if (context.mediaSkillForPrompt('@生视频 做一个广告') !== '') throw new Error('disabled video skill should not trigger')

console.log('media skill trigger gating: passed')
