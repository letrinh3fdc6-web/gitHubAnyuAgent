'use strict'

const $ = id => document.getElementById(id)
const call = (action, payload = {}) => window.pet.call(action, payload)
let character, mode, stage, busy = false, images = [], currentAssistant = null, approval = null
let activeAudio = null, speechGeneration = 0, bubbleTimer, drag = null, lastDragAt = 0, interactive = true
let currentRun = '', lastSequence = 0, initialized = false, bufferedEvents = [], lastAssistant = null, retrying = false, oldestSeq = 0
let linkView = null, linkMessageIds = new Set(), speechDone = null
let activeTurn = null, pendingSubmission = null
let composer = null
let nativeShape = false, nativeShapeKey = '', shapePending = false, lastPointer = null
const icons = () => window.lucide.createIcons({ attrs: { width: 16, height: 16, 'stroke-width': 1.7 } })
function iconButton(name, label) {
  const button = document.createElement('button')
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label)
  const icon = document.createElement('i'); icon.dataset.lucide = name; button.append(icon)
  return button
}
function renderText(node, text) {
  node.text = String(text || '')
  const fragment = window.DOMPurify.sanitize(window.marked.parse(node.text, { breaks: true, async: false }), { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'video', 'audio'], FORBID_ATTR: ['style', 'id', 'name'] })
  for (const image of fragment.querySelectorAll('img')) {
    if (/^data:image\/(png|jpeg|webp|gif);base64,/.test(image.getAttribute('src') || '')) image.onclick = () => openImage(image.src)
    else { const link = document.createElement('a'); link.textContent = image.alt || '查看图片'; link.href = image.getAttribute('src') || ''; image.replaceWith(link) }
  }
  for (const link of fragment.querySelectorAll('a')) link.onclick = event => {
    event.preventDefault()
    const target = link.getAttribute('href') || ''
    if (/^https?:\/\//i.test(target)) void call('open-url', { url: target }).catch(showError)
    else status('请在主窗口打开这个文件')
  }
  node.content.replaceChildren(fragment)
  node.content.classList.add('rendered')
}

function status(text = '', error = false) { $('status').textContent = text; $('status').classList.toggle('error', error) }
function bubble(text, duration = 4500) {
  $('bubble').textContent = String(text || '').slice(0, 120)
  $('bubble').hidden = !text
  clearTimeout(bubbleTimer)
  if (text) bubbleTimer = setTimeout(() => { $('bubble').hidden = true }, duration)
}
function showError(error) {
  const text = String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  if (mode === 'actor') bubble(text, 6500)
  else status(text, true)
}
function setBusy(value) {
  busy = Boolean(value)
  $('send').hidden = busy
  $('stop').hidden = !busy
  if (stage) stage.busy = busy
}
function silence() {
  const done = speechDone; speechDone = null; done?.()
  speechGeneration++
  if (activeAudio) { activeAudio.pause(); activeAudio.src = ''; activeAudio = null }
  speechSynthesis.cancel()
  stage?.speaking(false)
}
async function playSpeech(result, volume = character?.config.volume ?? .7, onEnded) {
  silence()
  const generation = speechGeneration
  let finished = false
  const finish = () => { if (finished) return; finished = true; if (speechDone === finish) speechDone = null; if (generation === speechGeneration) stage?.speaking(false); onEnded?.() }
  speechDone = finish
  // Also reject legacy system-fallback events from an older, still-running host.
  if (!result?.text || result.mode !== 'natural' || !result.audio) { finish(); return }
  try {
    const audio = new Audio(result.audio)
    activeAudio = audio
    audio.volume = Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : .7))
    audio.onplay = () => { if (generation === speechGeneration) stage?.speaking(true) }
    audio.onended = audio.onerror = finish
    await audio.play()
  } catch { finish() }
}
let audioContext, lastChimeAt = -Infinity
function chime(motion) {
  if (!character?.config.sounds || stage?.isSpeaking || performance.now() - lastChimeAt < 600) return
  lastChimeAt = performance.now()
  try {
    audioContext ||= new AudioContext()
    void audioContext.resume()
    const notes = motion === 'snack' ? [523, 659, 784] : motion === 'pat' ? [659, 880] : [587, 740]
    notes.forEach((frequency, index) => {
      const start = audioContext.currentTime + index * .07
      const oscillator = audioContext.createOscillator(), gain = audioContext.createGain()
      oscillator.type = 'sine'; oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(.035 * character.config.volume, start + .012); gain.gain.exponentialRampToValueAtTime(.0001, start + .2)
      oscillator.connect(gain); gain.connect(audioContext.destination); oscillator.start(start); oscillator.stop(start + .22)
    })
  } catch { /* audio can be unavailable in remote desktop sessions */ }
}
function openImage(src) {
  $('full-image').src = src
  $('download-image').href = src
  $('image-viewer').showModal()
}
function ensureTurn() {
  if (activeTurn) return activeTurn
  $('messages').querySelector('.empty')?.remove()
  const wrapper = document.createElement('section'); wrapper.className = 'assistant-turn'
  const header = document.createElement('div'); header.className = 'turn-header'
  const avatar = document.createElement('img'); avatar.src = character.preview; avatar.alt = ''
  const name = document.createElement('strong'); name.textContent = character.name
  const progress = document.createElement('span'); progress.className = 'turn-progress'
  header.append(avatar, name, progress)
  const body = document.createElement('div'); body.className = 'turn-parts'
  wrapper.append(header, body); $('messages').append(wrapper)
  activeTurn = { wrapper, body, progress, tools: new Map(), thinking: null }
  setTurnStatus('正在回复', 'running')
  return activeTurn
}
function setTurnStatus(text, state = 'running') {
  if (!activeTurn) return
  activeTurn.progress.textContent = text
  activeTurn.wrapper.dataset.state = state
}
function renderThinking(text, append = false) {
  if (!text || mode !== 'chat') return
  const turn = ensureTurn()
  if (!turn.thinking) {
    const details = document.createElement('details'); details.className = 'turn-thinking'
    const summary = document.createElement('summary'); summary.textContent = '思考过程'
    const content = document.createElement('div')
    details.append(summary, content); turn.body.append(details); turn.thinking = content
  }
  turn.thinking.textContent = append ? turn.thinking.textContent + text : text
}
function toolText(value) { return (typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2)).slice(0, 16000) }
function renderTool(activity) {
  if (mode !== 'chat') return
  const turn = ensureTurn()
  let item = turn.tools.get(activity.id)
  if (!item) {
    const details = document.createElement('details'); details.className = 'turn-tool'
    const summary = document.createElement('summary'), indicator = document.createElement('span'), name = document.createElement('code'), preview = document.createElement('span')
    indicator.className = 'tool-indicator'; name.textContent = activity.name || '任务'; preview.className = 'tool-preview'
    summary.append(indicator, name, preview)
    const input = document.createElement('pre'), output = document.createElement('pre')
    input.className = 'tool-input'; output.className = 'tool-output'
    details.append(summary, input, output); turn.body.append(details)
    item = { details, preview, input, output }; turn.tools.set(activity.id, item)
  }
  item.details.dataset.state = activity.status || 'running'
  if (activity.input !== undefined) {
    item.input.textContent = toolText(activity.input)
    const args = activity.input || {}
    item.preview.textContent = toolText(args.command || args.path || args.url || args.query || args).replace(/\s+/g, ' ')
    item.preview.title = item.input.textContent
  }
  if (activity.output !== undefined) item.output.textContent = toolText(activity.output)
  item.output.hidden = !item.output.textContent
}
function showPreparing(request) {
  if (mode !== 'chat') { setBusy(true); bubble('收到，我来看看。'); return }
  if (pendingSubmission?.requestId === request.requestId) return
  const node = addMessage('user', request.message, request.attachments || [], request.references || [])
  pendingSubmission = { ...request, node }
  ensureTurn(); setTurnStatus('正在准备', 'running'); setBusy(true); status('')
}
function failPreparing(requestId, error, cancelled = false) {
  if (mode === 'chat' && pendingSubmission?.requestId === requestId) {
    pendingSubmission.node.wrapper.classList.toggle('error', !cancelled)
    const note = document.createElement('small'); note.className = 'send-result'
    note.textContent = cancelled ? '已停止发送' : '发送失败，可编辑后重试'
    pendingSubmission.node.wrapper.append(note); pendingSubmission = null
    setTurnStatus(cancelled ? '已停止' : '未能发送', cancelled ? 'cancelled' : 'failed')
  }
  setBusy(false); status(cancelled ? '已停止' : error, !cancelled)
}
function addMessage(role, text = '', attachments = [], references = []) {
  $('messages').querySelector('.empty')?.remove()
  if (role === 'user') activeTurn = null
  const wrapper = document.createElement('article')
  wrapper.className = `message ${role}`
  for (const attachment of attachments) {
    const image = document.createElement('img')
    image.src = attachment.data_url || `data:${attachment.mimeType};base64,${attachment.data}`
    image.alt = '参考图片'; image.onclick = () => openImage(image.src)
    wrapper.append(image)
  }
  const content = document.createElement('div'); content.className = 'text'
  const node = { wrapper, content, text: String(text) }
  if (role === 'assistant') renderText(node, text)
  else content.textContent = text
  wrapper.append(content)
  if (references.length) {
    const list = document.createElement('div'); list.className = 'message-references'
    for (const item of references) {
      const chip = document.createElement('span'); chip.className = 'reference-chip'; chip.title = item.path
      const icon = document.createElement('i'); icon.dataset.lucide = item.kind === 'folder' ? 'folder' : 'file'
      const label = document.createElement('span'); label.textContent = item.name
      chip.append(icon, label); list.append(chip)
    }
    wrapper.append(list)
  }
  const actions = document.createElement('div'); actions.className = 'tools'
  const copy = iconButton('copy', '复制')
  copy.onclick = () => { void navigator.clipboard.writeText(node.text).catch(showError) }
  actions.append(copy)
  if (role === 'user') {
    const edit = iconButton('pencil', '编辑')
    edit.onclick = () => { $('message').value = node.text; images = attachments.map(item => ({ ...item })); composer?.restore(references); renderAttachments(); $('message').focus(); composer?.updateMention() }
    actions.append(edit)
  }
  wrapper.append(actions)
  if (role === 'assistant' && !linkView) ensureTurn().body.append(wrapper)
  else $('messages').append(wrapper)
  icons(); scrollEnd()
  return node
}
function scrollEnd() { requestAnimationFrame(() => { $('messages').scrollTop = $('messages').scrollHeight }) }
function emptyState() {
  const empty = document.createElement('div'); empty.className = 'empty'
  const image = document.createElement('img'); image.src = character.preview; image.alt = character.name
  const text = document.createElement('span'); text.textContent = `我是${character.name}，今天想一起做什么？`
  empty.append(image, text); $('messages').append(empty)
}
function renderSnapshot(snapshot, prepend = false) {
  const previousTurn = activeTurn
  const existing = prepend ? [...$('messages').children] : []
  const oldHeight = $('messages').scrollHeight, oldScroll = $('messages').scrollTop
  $('messages').replaceChildren()
  if (!prepend) { currentAssistant = null; lastAssistant = null; activeTurn = null; pendingSubmission = null; currentRun = snapshot.activeRunId || ''; retrying = false }
  for (const message of snapshot.messages || []) {
    if (!['user', 'assistant'].includes(message.role)) continue
    let node
    if (message.role === 'user') node = addMessage('user', message.content || '', message.attachments || [], message.references || [])
    else {
      activeTurn = null; ensureTurn(); renderThinking(message.thinking)
      const activities = new Map((message.activities || []).map(item => [item.id, item]))
      for (const part of message.parts || []) {
        if (part.kind === 'text' && part.content) node = addMessage('assistant', part.content)
        else if (part.kind === 'tool' && activities.has(part.id)) { renderTool(activities.get(part.id)); activities.delete(part.id) }
      }
      if (!node && message.content) node = addMessage('assistant', message.content)
      for (const activity of activities.values()) renderTool(activity)
      setTurnStatus(message.isStreaming ? '正在回复' : message.isError ? '未完成' : '已完成', message.isStreaming ? 'running' : message.isError ? 'failed' : 'completed')
    }
    if (message.isError && node) node.wrapper.classList.add('error')
    if (!prepend && message.role === 'assistant') { lastAssistant = node; if (message.isStreaming) { currentAssistant = node; retrying = Boolean(message.retrying) } }
  }
  if (prepend) { activeTurn = previousTurn; $('messages').append(...existing); requestAnimationFrame(() => { $('messages').scrollTop = oldScroll + $('messages').scrollHeight - oldHeight }) }
  if (!$('messages').children.length) emptyState()
  oldestSeq = snapshot.oldestSeq || 0; $('load-history').hidden = !snapshot.hasMore
  if (!prepend) {
    if (snapshot.pending) showPreparing(snapshot.pending)
    setBusy(snapshot.busy)
    lastSequence = Math.max(lastSequence, snapshot.nextSeq || 0)
    $('approval').hidden = !snapshot.approval
    if (snapshot.approval) renderApproval(snapshot.approval)
  }
}
async function addFiles(files) {
  for (const file of files) {
    if (images.length >= 6) { status('每条消息最多添加 6 张图片', true); break }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 10 * 1024 * 1024) { status('支持 PNG、JPEG、WebP、GIF，单张不超过 10 MB', true); continue }
    let data, mimeType = file.type
    if (file.size > 1400000) {
      const bitmap = await createImageBitmap(file)
      try {
        const canvas = document.createElement('canvas'), scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        data = canvas.toDataURL('image/jpeg', .8); mimeType = 'image/jpeg'
      } finally { bitmap.close() }
    } else data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file) })
    if (data.length > 2 * 1024 * 1024) { status('图片压缩后仍过大，请缩小图片后重试', true); continue }
    images.push({ mimeType, data: data.slice(data.indexOf(',') + 1) })
  }
  renderAttachments()
}
function renderAttachments() {
  $('attachments').replaceChildren()
  images.forEach((image, index) => {
    const wrap = document.createElement('span'), thumbnail = document.createElement('img'), remove = iconButton('x', '移除图片')
    thumbnail.src = `data:${image.mimeType};base64,${image.data}`; thumbnail.alt = '待发送图片'
    remove.onclick = () => { images.splice(index, 1); renderAttachments() }
    wrap.append(thumbnail, remove); $('attachments').append(wrap)
  })
  $('count').textContent = images.length ? `${images.length}/6 张图片` : ''
  icons()
}
function renderApproval(request) {
  approval = request
  $('approval').hidden = false
  $('approval-text').textContent = [request.title, request.message].filter(Boolean).join('\n')
  $('approval').querySelector('.approval-value')?.remove()
  if (request.method !== 'confirm') {
    const field = document.createElement(request.method === 'select' ? 'select' : request.method === 'editor' ? 'textarea' : 'input')
    field.className = 'approval-value'; field.setAttribute('aria-label', request.title || '回答')
    if (request.method === 'select') for (const item of request.options || []) { const option = document.createElement('option'); option.value = typeof item === 'string' ? item : item.value || item.label || item.name || ''; option.textContent = typeof item === 'string' ? item : item.label || item.name || item.value || ''; field.append(option) }
    else { field.placeholder = request.placeholder || ''; field.value = typeof request.defaultValue === 'string' ? request.defaultValue : '' }
    $('approval-text').after(field)
    $('approve').textContent = '提交'
  } else $('approve').textContent = '允许一次'
}
function agentEvent(event) {
  if (event.seq && event.seq <= lastSequence) return
  lastSequence = Math.max(lastSequence, event.seq || 0)
  if (event.type === 'run.started') {
    currentRun = event.runId || ''
    currentAssistant = null; lastAssistant = null; retrying = false
    setBusy(true); status('')
    if (mode === 'actor') { stage?.play('think'); bubble('收到，我来看看。') }
    else {
      if (pendingSubmission && event.requestId === pendingSubmission.requestId) pendingSubmission = null
      else addMessage('user', event.input || '', event.attachments || [], event.references || [])
      ensureTurn(); setTurnStatus('正在回复')
    }
  }
  if (event.runId && currentRun && event.runId !== currentRun) return
  if (event.type === 'message.started' && mode === 'chat') {
    if ((event.replace || retrying) && lastAssistant) lastAssistant.wrapper.remove()
    currentAssistant = addMessage('assistant'); lastAssistant = currentAssistant; retrying = false
  } else if (event.type === 'message.delta') {
    if (mode === 'chat') {
      currentAssistant ||= addMessage('assistant')
      currentAssistant.text += event.delta || ''
      currentAssistant.content.classList.remove('rendered')
      currentAssistant.content.textContent = currentAssistant.text
      lastAssistant = currentAssistant
      scrollEnd()
    }
    setTurnStatus('正在回复')
  } else if (event.type === 'message.completed') {
    if (mode === 'chat') {
      currentAssistant ||= addMessage('assistant')
      renderText(currentAssistant, event.content ?? event.text ?? currentAssistant.text)
      if (event.isError || event.errorMessage) currentAssistant.wrapper.classList.add('error')
      lastAssistant = currentAssistant
      currentAssistant = null
      scrollEnd()
    }
  } else if (event.type === 'tool.started') {
    stage?.play('working'); setTurnStatus('正在执行')
    renderTool({ id: event.toolCallId, name: event.toolName, input: event.args, status: 'running' })
  } else if (event.type === 'tool.updated' || event.type === 'tool.completed') {
    renderTool({ id: event.toolCallId, name: event.toolName, output: event.output, status: event.type === 'tool.updated' ? 'running' : event.isError ? 'failed' : 'completed' })
    if (event.type === 'tool.completed') setTurnStatus('正在回复')
  } else if (event.type === 'approval.requested') {
    stage?.play('wait'); bubble('有一步需要确认，点我看看。', 15000)
    if (mode === 'chat') renderApproval(event.request)
  } else if (event.type === 'approval.resolved') { approval = null; $('approval').hidden = true }
  else if (event.type === 'run.retrying') { retrying = true; stage?.play('retry'); setTurnStatus('正在重新连接') }
  else if (event.type === 'thinking.started' || event.type === 'thinking.delta') {
    if (mode === 'chat') { ensureTurn(); renderThinking(event.delta, true); setTurnStatus('正在思考') }
    if (event.type === 'thinking.started') stage?.play('think')
  }
  else if (event.type === 'run.finished') {
    setBusy(false)
    if (mode === 'chat' && currentAssistant) renderText(currentAssistant, currentAssistant.text)
    if (mode === 'chat' && !lastAssistant && event.text) lastAssistant = addMessage('assistant', event.text)
    setTurnStatus(event.status === 'completed' ? '已完成' : event.status === 'cancelled' ? '已停止' : '未完成', event.status)
    if (event.status !== 'completed') for (const item of activeTurn?.tools.values() || []) if (item.details.dataset.state === 'running') item.details.dataset.state = 'cancelled'
    $('approval').hidden = true; approval = null
    if (event.status === 'completed') { stage?.play('done'); bubble(event.text || '完成啦，点我查看结果。', 7000); status('') }
    else if (event.status === 'cancelled') { stage?.play('breathe'); status('已停止'); bubble('已停下来。') }
    else { stage?.play('comfort'); status(event.error || '请求未完成，可以重试', true); bubble(event.error || '这次没有完成，点我查看原因。', 7000) }
  }
}
function receive(event) {
  if (!initialized) { bufferedEvents.push(event); return }
  if (event.id && event.id !== character.id) return
  if (event.type === 'state') {
    const next = event.state.characters.find(item => item.id === character.id)
    if (next) { character.config = next.config; $('model-name').textContent = next.config.model?.id || '尚未选择模型'; if (next.config.speech === 'off') silence() }
  } else if (event.type === 'preparing') showPreparing(event.request)
  else if (event.type === 'prepare-failed') failPreparing(event.requestId, event.error, event.cancelled)
  else if (event.type === 'memory-error') showError(event.error)
  else if (event.type === 'link-state') renderLink(event.link)
  else if (event.type === 'link-menu' && mode === 'chat') void openLinkDialog()
  else if (event.type === 'agent' && (!linkView || (mode === 'actor' && linkView.status === 'closed'))) agentEvent(event.event)
  else if (event.type === 'motion' && mode === 'actor') { stage?.play(event.motion); chime(event.motion) }
  else if (event.type === 'drag-release' && mode === 'actor') finishDrag(event.cursor ? { screenX: event.cursor.x, screenY: event.cursor.y } : null, !event.cursor)
  else if (event.type === 'pointer-probe' && mode === 'actor') {
    const target = document.elementFromPoint(event.x, event.y)
    updateHitTest({ target, clientX: event.x, clientY: event.y, screenX: event.cursor.x, screenY: event.cursor.y }, true)
  }
  else if (event.type === 'pointer-outside' && mode === 'actor' && !drag) { interactive = false; hoveringBody = false; lastBodyHit = null; lastPointer = null }
  else if (event.type === 'speech' && mode === 'actor') {
    if (event.linkId && (linkView?.id !== event.linkId || linkView.status === 'closed')) return
    void playSpeech(event.audio, event.volume, event.speechId ? () => { void call('speech-ended', { linkId: event.linkId, speechId: event.speechId }).catch(() => {}) } : undefined)
  }
  else if (event.type === 'silence') silence()
  else if (event.type === 'reset') { restorePersonalChat(); currentRun = ''; lastSequence = 0; if (mode === 'chat') renderSnapshot({ messages: [], busy: false }); silence() }
}
window.pet.onEvent(receive)

function renderLink(link) {
  if (!link) return
  const changed = linkView?.id !== link.id, active = link.status !== 'closed'
  linkView = link
  const name = id => link.characters.find(pet => pet.id === id)?.name || id
  const progress = active ? `${name(link.speaker)}${link.status === 'speaking' ? '正在说话' : link.status === 'waiting' ? '准备接话' : '正在回复'} · ${link.turns} 次发言` : link.error || '连线已结束'
  $('actor-link-state').hidden = !active
  $('actor-link-state').querySelector('span').textContent = `与${name(link.participants.find(id => id !== character.id))}连线中`
  if (stage) stage.busy = active && link.speaker === character.id && link.status === 'thinking'
  if (mode !== 'chat') {
    if (link.messages.length && link.messages.at(-1).speaker === character.id && !linkMessageIds.has(link.messages.at(-1).id)) bubble(link.messages.at(-1).text, 9000)
    linkMessageIds = new Set(link.messages.map(message => message.id))
    if (!active) stage?.speaking(false)
    return
  }
  if (changed) { $('messages').replaceChildren(); linkMessageIds.clear() }
  $('link-bar').hidden = false; $('composer').hidden = true; $('attachments').hidden = true; $('references').hidden = true; $('approval').hidden = true; $('load-history').hidden = true
  $('link-title').textContent = link.characters.map(pet => pet.name).join(' ↔ ')
  $('link-title').title = link.topic
  $('link-progress').textContent = progress
  $('disconnect-link').hidden = !active; $('return-chat').hidden = active
  document.querySelector('[data-action="new-chat"]').hidden = active
  for (const message of link.messages) {
    if (linkMessageIds.has(message.id)) continue
    const node = addMessage('assistant', message.text)
    node.wrapper.classList.add('link-message'); node.wrapper.dataset.linkMessage = message.id
    const label = document.createElement('strong'); label.className = 'link-speaker'; label.textContent = name(message.speaker); node.wrapper.prepend(label)
    linkMessageIds.add(message.id)
  }
  const retained = new Set(link.messages.map(message => message.id))
  for (const element of $('messages').querySelectorAll('[data-link-message]')) if (!retained.has(element.dataset.linkMessage)) { element.remove(); linkMessageIds.delete(element.dataset.linkMessage) }
  status(link.error || '', Boolean(link.error))
}
async function openLinkDialog() {
  try {
    const options = await call('link-options')
    if (options.link && options.link.status !== 'closed') { renderLink(options.link); return }
    $('link-peer').replaceChildren()
    for (const peer of options.peers) { const option = document.createElement('option'); option.value = peer.id; option.disabled = !peer.available; option.textContent = `${peer.name} · ${peer.model || '未选模型'}${peer.available ? '' : '（暂不可连线）'}`; $('link-peer').append(option) }
    const first = options.peers.find(peer => peer.available)
    if (first) $('link-peer').value = first.id
    $('start-link').disabled = !first
    $('link-error').textContent = first ? '' : '暂无可连线的伙伴，请先启用另一位伙伴并选择模型。'
    if (!$('link-dialog').open) $('link-dialog').showModal()
  } catch (error) { showError(error) }
}
async function disconnectLink() { try { await call('link-disconnect') } catch (error) { showError(error) } }
function restorePersonalChat() {
  linkView = null; linkMessageIds.clear()
  $('link-bar').hidden = true; $('composer').hidden = false; $('attachments').hidden = false; $('references').hidden = false
  document.querySelector('[data-action="new-chat"]').hidden = false
}
$('disconnect-link').onclick = $('actor-link-state').onclick = disconnectLink
$('close-link-dialog').onclick = () => $('link-dialog').close()
$('return-chat').onclick = async () => {
  try { const snapshot = await call('link-dismiss'); restorePersonalChat(); renderSnapshot(snapshot); status('') } catch (error) { showError(error) }
}
$('link-form').onsubmit = async event => {
  event.preventDefault(); $('start-link').disabled = true; $('link-error').textContent = ''
  try { const link = await call('link-connect', { peerId: $('link-peer').value, topic: $('link-topic').value }); $('link-dialog').close(); renderLink(link) }
  catch (error) { $('link-error').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
  finally { $('start-link').disabled = false }
}

document.addEventListener('click', event => {
  const button = event.target.closest('[data-action], [data-motion]')
  if (!button) return
  if (button.dataset.motion) { void call('interact', { motion: button.dataset.motion }).catch(showError); return }
  const action = button.dataset.action
  if (action === 'link-open' && mode === 'chat') { void openLinkDialog(); return }
  if (action === 'actions') { $('action-menu').hidden = !$('action-menu').hidden; return }
  if (action === 'new-chat') { void call('new-chat').then(renderSnapshot).catch(showError); return }
  void call(action).catch(showError)
})
$('play-motion').onclick = () => { void call('interact', { motion: $('motion-picker').value }).catch(showError) }
$('composer').onsubmit = async event => {
  event.preventDefault()
  if (busy) return
  const message = $('message').value.trim(), attachments = images.slice()
  const references = (composer?.references || []).map(item => ({ ...item }))
  if (!message && !attachments.length && !references.length) return
  const requestId = crypto.randomUUID()
  showPreparing({ requestId, message, attachments, references })
  $('message').value = ''
  images = []; renderAttachments(); composer?.clear()
  try {
    await call('prompt', { requestId, message, images: attachments, references })
  } catch (error) { if (pendingSubmission?.requestId === requestId) failPreparing(requestId, String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
}
$('message').onkeydown = event => { if (composer?.keydown(event)) return; if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit() } }
$('message').onpaste = event => {
  const files = [...event.clipboardData.items].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean)
  if (files.length) { event.preventDefault(); void addFiles(files).catch(showError) }
}
$('chat').ondragover = event => event.preventDefault()
$('chat').ondrop = event => {
  event.preventDefault()
  void composer?.drop([...event.dataTransfer.items]).catch(showError)
  void addFiles([...event.dataTransfer.files].filter(file => file.type.startsWith('image/'))).catch(showError)
}
$('files').onchange = event => { void addFiles([...event.target.files]).catch(showError); event.target.value = '' }
$('load-history').onclick = async () => {
  $('load-history').disabled = true
  try { renderSnapshot(await call('snapshot', { beforeSeq: oldestSeq }), true) } catch (error) { showError(error) }
  finally { $('load-history').disabled = false }
}
$('stop').onclick = () => { silence(); void call('abort').catch(showError) }
$('close-image').onclick = () => $('image-viewer').close()
for (const [id, decision] of [['approve', 'allow'], ['reject', 'deny']]) $(id).onclick = async () => {
  if (!approval) return
  try { await call('approve', { requestId: approval.requestId, decision, value: $('approval').querySelector('.approval-value')?.value }); $('approval').hidden = true; approval = null } catch (error) { showError(error) }
}
const canvas = $('stage')
let hoveringBody = false, lastBodyHit = null
function recentBodyHit(event) {
  return lastBodyHit && performance.now() - lastBodyHit.at < 350 && Math.hypot(event.screenX - lastBodyHit.x, event.screenY - lastBodyHit.y) < 18
}
function hoverBody(event) {
  const rect = canvas.getBoundingClientRect()
  const inside = event.target === canvas && stage?.hit(event.clientX - rect.left, event.clientY - rect.top)
  if (inside) lastBodyHit = { x: event.screenX, y: event.screenY, at: performance.now() }
  if (inside && !hoveringBody && !drag) stage?.interact('hover')
  hoveringBody = Boolean(inside)
  return inside
}
function updateNativeShape() {
  if (!nativeShape || !stage?.ready || drag || shapePending) return
  const regions = stage.hitRegions()
  for (const id of ['pet-tools', 'bubble', 'action-menu', 'actor-link-state']) {
    const node = $(id)
    if (node.hidden) continue
    const rect = node.getBoundingClientRect()
    if (rect.width && rect.height) regions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  }
  // Keep the grabbed point usable when a hover animation moves the body away.
  if (lastPointer && lastBodyHit && Math.hypot(lastPointer.screenX - lastBodyHit.x, lastPointer.screenY - lastBodyHit.y) < 18) {
    regions.push({ x: lastPointer.clientX - 18, y: lastPointer.clientY - 18, width: 36, height: 36 })
  }
  const key = JSON.stringify(regions)
  if (key === nativeShapeKey) return
  shapePending = true
  void call('hit-regions', { regions }).then(result => { if (result?.applied !== false) nativeShapeKey = key }).catch(showError).finally(() => { shapePending = false })
}
async function startDrag(event) {
  const handle = event.currentTarget !== canvas, rect = canvas.getBoundingClientRect()
  if (event.button !== 0 || !stage || (!handle && !nativeShape && !interactive && !stage.hit(event.clientX - rect.left, event.clientY - rect.top) && !recentBodyHit(event))) return
  event.preventDefault()
  if (drag) finishDrag(null, true)
  const current = { x: event.screenX, y: event.screenY, pointerId: event.pointerId, moved: false, handle }
  drag = current
  stage.dragging = true
  interactive = true
  try {
    // Let queued shape updates finish and lock the host before capturing the pointer.
    await call('drag-start', { cursor: { x: current.x, y: current.y } })
    if (drag !== current) return
    canvas.setPointerCapture(current.pointerId)
  } catch (error) {
    if (drag !== current) return
    finishDrag(null, true)
    if (error?.name !== 'NotFoundError') showError(error)
  }
}
function moveDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return
  if (!(event.buttons & 1)) { finishDrag(event, true); return }
  if (Math.hypot(event.screenX - drag.x, event.screenY - drag.y) > 4) drag.moved = true
  if (drag.moved && performance.now() - lastDragAt > 16) { lastDragAt = performance.now(); void call('drag', { cursor: { x: event.screenX, y: event.screenY } }).catch(showError) }
}
function finishDrag(event, cancelled = false) {
  if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return
  const { moved, handle, pointerId } = drag; drag = null; stage.dragging = false
  nativeShapeKey = ''
  try { if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId) } catch { /* pointer may already have left the native window */ }
  void call('drag-end', { cursor: cancelled ? undefined : { x: event.screenX, y: event.screenY } }).catch(showError)
  if (!cancelled && !moved && !handle) { stage?.interact('click'); void call('chat').catch(showError) }
}
canvas.onpointerdown = $('drag-handle').onpointerdown = $('bubble').onpointerdown = startDrag
document.addEventListener('pointermove', moveDrag, true)
document.addEventListener('pointerup', event => { if (event.button === 0) finishDrag(event) }, true)
document.addEventListener('pointercancel', event => finishDrag(event, true), true)
canvas.onlostpointercapture = event => finishDrag(event, true)
window.addEventListener('blur', event => finishDrag(event, true))
canvas.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); stage?.interact('click'); void call('chat').catch(showError) } }
canvas.oncontextmenu = event => { event.preventDefault(); $('action-menu').hidden = !$('action-menu').hidden }
function updateHitTest(event, probe = false) {
  if (mode !== 'actor') return
  lastPointer = event
  const onBody = hoverBody(event)
  const next = Boolean(drag || event.target?.closest('button,select,#pet-tools,#bubble,#action-menu') || onBody || (event.target === canvas && recentBodyHit(event)))
  if (probe || next !== interactive) { interactive = next; if (!nativeShape) void call('hit-test', { interactive }).catch(() => {}) }
}
document.addEventListener('mousemove', event => updateHitTest(event))
document.addEventListener('mouseleave', () => { hoveringBody = false })
window.addEventListener('beforeunload', () => { silence(); stage?.destroy(); void audioContext?.close() })

icons()
void call('bootstrap').then(data => {
  character = data.character; mode = data.mode; nativeShape = Boolean(data.nativeShape)
  document.title = `${character.name} · AnyuAgent`
  $(mode).hidden = false
  $('name').textContent = character.name
  $('model-name').textContent = character.config.model?.id || '在设置中选择模型'
  $('portrait').src = character.preview
  if (mode === 'actor') {
    stage = new window.AnyuPetStage(canvas, character.atlas, { onError: showError, onInteraction: track => chime(track.id), onFrame: updateNativeShape })
    for (const category of ['表情', '动作']) {
      const group = document.createElement('optgroup'); group.label = category
      for (const item of window.AnyuPetBehaviors.all.filter(item => item.category === category)) { const option = document.createElement('option'); option.value = item.id; option.textContent = item.name; group.append(option) }
      $('motion-picker').append(group)
    }
  } else { composer = new window.AnyuPetComposer({ call, icons, showError }); new window.AnyuPetMemoryView({ call, icons, name: character.name }); renderSnapshot(data.snapshot) }
  setBusy(data.snapshot.busy)
  if (data.link) renderLink(data.link)
  initialized = true
  for (const event of bufferedEvents) receive(event)
  bufferedEvents = []
  void call('ready').catch(showError)
}).catch(showError)
