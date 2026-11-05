'use strict'

const crypto = require('node:crypto')

const ID = /^[a-z][a-z0-9-]{0,47}$/
const KINDS = new Set(['product', 'detail', 'card', 'character', 'scene', 'prop', 'shot'])
const text = (value, max, label, required = false) => {
  if (value !== undefined && typeof value !== 'string') throw new Error(`${label}必须是文字`)
  const result = String(value || '').trim()
  if (result.length > max || result.includes('\0') || required && !result) throw new Error(`${label}为空或过长`)
  return result
}
const list = (value, max, convert, label) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}数量无效`)
  return value.map(convert)
}
const normalized = value => String(value).replace(/\s+/gu, '')
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

function checkedPlan(input, project) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('创作计划必须是对象')
  const references = new Set(project.references.map(item => item.id))
  const source = normalized(project.script || '')
  const plan = {
    objective: text(input.objective, 2000, '创作目标', true),
    audience: text(input.audience, 600, '目标受众'),
    platform: text(input.platform, 100, '目标平台'),
    styleLock: text(input.styleLock, 6000, '统一视觉约束', true),
    constraints: text(input.constraints, 3000, '禁止项'),
    claims: list(input.claims, 50, item => {
      if (!item || !['verified', 'pending'].includes(item.status)) throw new Error('商品证据状态无效')
      const claim = { text: text(item.text, 500, '商品表述', true), evidence: text(item.evidence, 1000, '证据来源'), status: item.status }
      if (claim.status === 'verified' && !claim.evidence) throw new Error('已核实的商品表述必须填写证据来源')
      return claim
    }, '商品证据'),
    items: list(input.items, 100, item => {
      if (!item || !ID.test(item.id) || !KINDS.has(item.kind)) throw new Error('分镜或图片标识、类型无效')
      const result = {
        id: item.id, kind: item.kind, title: text(item.title, 120, '图片标题', true),
        purpose: text(item.purpose, 1000, '镜头或图片作用'),
        prompt: text(item.prompt, 16000, '生图提示词', true),
        negativePrompt: text(item.negativePrompt, 2000, '图片禁止项'),
        referenceIds: list(item.referenceIds, 12, id => { if (!references.has(id)) throw new Error(`参考图不存在：${id}`); return id }, '参考图'),
        dependsOn: list(item.dependsOn, 8, id => { if (!ID.test(id)) throw new Error('依赖图片标识无效'); return id }, '依赖图'),
        sourceExcerpt: text(item.sourceExcerpt, 6000, '剧本原文'),
        creativeAddition: item.creativeAddition === true,
        dialogue: list(item.dialogue, 30, line => ({ speaker: text(line?.speaker, 80, '说话人', true), text: text(line?.text, 2000, '原台词', true) }), '台词'),
        sound: text(item.sound, 1200, '声音'), camera: text(item.camera, 500, '景别与运镜'),
        onImageText: list(item.onImageText, 12, value => text(value, 240, '图中文字', true), '图中文字'),
        size: text(item.size, 40, '尺寸') || 'auto', quality: item.quality || 'auto',
      }
      if (!['auto', 'low', 'medium', 'high'].includes(result.quality) || !/^(auto|[0-9]{3,5}x[0-9]{3,5}|[0-9]{1,2}:[0-9]{1,2}|[124]K)$/i.test(result.size)) throw new Error('图片尺寸或质量无效')
      if (item.duration !== undefined) {
        if (!Number.isFinite(item.duration) || item.duration < 0.2 || item.duration > 120) throw new Error('镜头时长必须为 0.2 至 120 秒')
        result.duration = item.duration
      }
      if (project.kind === 'comic' && result.kind === 'shot') {
        if (!result.creativeAddition && (!result.sourceExcerpt || !source.includes(normalized(result.sourceExcerpt)))) throw new Error(`镜头 ${result.id} 缺少可核对的剧本原文；创作补充请明确标记`)
        for (const line of result.dialogue) if (!source.includes(normalized(line.text))) throw new Error(`镜头 ${result.id} 的台词不在原剧本中，请保留原台词`)
      }
      return result
    }, '图片与分镜'),
  }
  if (!plan.items.length) throw new Error('计划至少包含一张图片或一个分镜')
  const byID = new Map(plan.items.map(item => [item.id, item]))
  if (byID.size !== plan.items.length) throw new Error('分镜或图片标识重复')
  const visited = new Set(), visiting = new Set()
  function visit(id) {
    if (visiting.has(id)) throw new Error('图片参考依赖形成循环')
    if (visited.has(id)) return
    const item = byID.get(id)
    if (!item) throw new Error(`依赖图片不存在：${id}`)
    visiting.add(id)
    for (const dependency of item.dependsOn) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const id of byID.keys()) visit(id)
  if (Buffer.byteLength(JSON.stringify(plan)) > 256000) throw new Error('计划过大，请按章节拆分')
  return plan
}

function itemFingerprint(plan, item, cache = new Map()) {
  if (cache.has(item.id)) return cache.get(item.id)
  const dependencies = item.dependsOn.map(id => {
    const dependency = plan.items.find(candidate => candidate.id === id)
    if (!dependency) throw new Error('图片依赖不存在')
    return itemFingerprint(plan, dependency, cache)
  })
  const fingerprint = hash({ styleLock: plan.styleLock, constraints: plan.constraints, item, dependencies })
  cache.set(item.id, fingerprint)
  return fingerprint
}

function generationPrompt(plan, item) {
  return [
    item.prompt,
    `统一视觉约束：${plan.styleLock}`,
    plan.constraints && `全局禁止项：${plan.constraints}`,
    item.negativePrompt && `当前图片禁止项：${item.negativePrompt}`,
    item.onImageText.length ? `只允许以下已经确认的图中文字，逐字保留：${item.onImageText.join('；')}` : '不要添加未要求的文字、Logo、水印或虚构认证。',
    item.referenceIds.length || item.dependsOn.length ? '严格保留所附参考图中的商品结构、角色身份及对应的外观特征；不得混淆角色或改变商品。' : '',
  ].filter(Boolean).join('\n\n')
}

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const markdown = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
function csv(value) {
  let string = String(value ?? '')
  if (/^[\s\u0000-\u0020]*[=+\-@]/u.test(string)) string = `'${string}`
  return `"${string.replace(/"/g, '""')}"`
}

function projectExports(project) {
  const plan = project.plan
  if (!plan) throw new Error('请先保存创作计划')
  const headers = ['序号', '标识', '名称', '用途', '景别与运镜', '原文', '台词', '声音', '时长秒', '生图提示词', '状态', '图片']
  const rows = plan.items.map((item, index) => {
    const output = project.outputs[item.id]
    return [index + 1, item.id, item.title, item.purpose, item.camera, item.sourceExcerpt, item.dialogue.map(line => `${line.speaker}：${line.text}`).join('\n'), item.sound, item.duration || '', generationPrompt(plan, item), output?.status || 'planned', output?.file || '']
  })
  const csvText = '\ufeff' + [headers, ...rows].map(row => row.map(csv).join(',')).join('\r\n') + '\r\n'
  const md = [
    `# ${project.name}`, '', plan.objective, '', `目标平台：${plan.platform || '未指定'}`, '',
    '## 统一视觉约束', '', plan.styleLock, '', '## 分镜与图片计划', '',
    '| 序号 | 标识 | 名称 | 景别与运镜 | 原文与台词 | 时长 | 状态 |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...plan.items.map((item, index) => `| ${index + 1} | ${item.id} | ${markdown(item.title)} | ${markdown(item.camera)} | ${markdown([item.sourceExcerpt, ...item.dialogue.map(line => `${line.speaker}：${line.text}`)].join('\n'))} | ${item.duration || ''} | ${project.outputs[item.id]?.status || 'planned'} |`),
    '', '## 商品证据', '', ...plan.claims.map(claim => `- ${claim.text}；${claim.status === 'verified' ? '已核实' : '待确认'}；${claim.evidence || '未提供证据'}`),
    '', '## 文件', '', ...plan.items.map(item => `- ${item.id}: ${project.outputs[item.id]?.file || '尚未生成'}`), '',
  ].join('\n')
  const articles = plan.items.map((item, index) => {
    const output = project.outputs[item.id]
    const safeFile = output?.file && /^images\/[a-z][a-z0-9-]*-\d+\.(png|jpg|webp|gif)$/.test(output.file) ? output.file : ''
    return `<article><div class="image">${safeFile ? `<a href="${escapeHTML(safeFile)}" download><img src="${escapeHTML(safeFile)}" alt="${escapeHTML(item.title)}" loading="lazy"></a>` : `<span>${escapeHTML(output?.status || '尚未生成')}</span>`}</div><div class="copy"><h2><span>${index + 1}</span>${escapeHTML(item.title)}</h2><p>${escapeHTML(item.purpose)}</p>${item.camera ? `<p>${escapeHTML(item.camera)}${item.duration ? ` · ${item.duration}s` : ''}</p>` : ''}${item.dialogue.map(line => `<blockquote><strong>${escapeHTML(line.speaker)}</strong> ${escapeHTML(line.text)}</blockquote>`).join('')}<details><summary>提示词与原文</summary><pre>${escapeHTML(generationPrompt(plan, item))}</pre>${item.sourceExcerpt ? `<pre>${escapeHTML(item.sourceExcerpt)}</pre>` : ''}</details>${output?.error ? `<p class="error">${escapeHTML(output.error)}</p>` : ''}</div></article>`
  }).join('\n')
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' file:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHTML(project.name)}</title><style>*{box-sizing:border-box}body{margin:0;background:#f7f8f9;color:#252a31;font:14px/1.7 system-ui,sans-serif;letter-spacing:0}header,main,footer{max-width:1360px;margin:auto;padding:28px}header{border-bottom:1px solid #dfe3e7}h1{font-size:28px;margin:0 0 8px}header p{max-width:900px;margin:0;color:#616973}nav{display:flex;gap:20px;margin-top:14px}a{color:#147969}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:22px}article{min-width:0;background:#fff;border:1px solid #dfe3e7;border-radius:6px;overflow:hidden}.image{aspect-ratio:4/3;background:#eef1f3;display:grid;place-items:center;color:#7a838e}.image a{display:block;width:100%;height:100%;min-height:0}.image img{display:block;width:100%;height:100%;object-fit:contain}.copy{padding:16px}h2{font-size:16px;margin:0 0 6px;overflow-wrap:anywhere}h2 span{display:inline-block;color:#157968;font-size:12px;margin-right:8px}p,blockquote{margin:8px 0;overflow-wrap:anywhere}blockquote{padding-left:10px;border-left:2px solid #d5dedc;color:#4a5661}summary{cursor:pointer;color:#5c6976}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.8 system-ui}.error{color:#aa3e4a}footer{color:#7c858f;font-size:12px}@media print{header,main,footer{padding:12px}main{grid-template-columns:repeat(2,1fr)}article{break-inside:avoid}details{display:none}}</style></head><body><header><h1>${escapeHTML(project.name)}</h1><p>${escapeHTML(plan.objective)}</p><nav><a href="storyboard.csv?download=1" download>下载表格</a><a href="creative-plan.json?download=1" download>下载计划</a><a href="README.md?download=1" download>制作说明</a></nav></header><main>${articles}</main><footer>AnyuAgent · ${escapeHTML(project.updatedAt)} · 计划修订 ${project.revision}</footer></body></html>`
  const publicProject = { schema: 1, id: project.id, name: project.name, kind: project.kind, revision: project.revision, brief: project.brief, plan, references: project.references.map(({ originalPath, ...reference }) => reference), outputs: project.outputs, updatedAt: project.updatedAt }
  return { 'index.html': html, 'README.md': md, 'storyboard.csv': csvText, 'creative-plan.json': JSON.stringify(publicProject, null, 2) + '\n' }
}

module.exports = { checkedPlan, itemFingerprint, generationPrompt, projectExports, ID }
