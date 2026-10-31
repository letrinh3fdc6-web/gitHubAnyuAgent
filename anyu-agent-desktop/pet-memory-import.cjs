'use strict'

const fs = require('node:fs')
const readline = require('node:readline')

// Import the existing append-only session logs without loading them into the UI or rerunning models.
async function importPetMemory(manager, memory, owned, epoch) {
  await manager.sessions.flushLogs()
  const groups = new Map()
  for (const [sessionId, entry] of Object.entries(owned)) {
    const match = sessionId.match(/^pet:([^:]+):link:([^:]+)$/)
    if (match) {
      const peers = groups.get(match[2]) || new Set(); peers.add(entry.id); groups.set(match[2], peers)
      const namedPeer = [...memory.characters.values()].find(pet => entry.systemPrompt?.includes(`对话伙伴是${pet.name}。`))
      if (namedPeer) peers.add(namedPeer.id)
    }
  }
  for (const [sessionId, entry] of Object.entries(owned)) {
    if (memory.closed || manager.ownerEpoch !== epoch) return
    if (!memory.characters.has(entry.id)) continue
    const match = sessionId.match(/^pet:([^:]+):link:([^:]+)$/)
    const peers = match ? [...(groups.get(match[2]) || [])] : [entry.id]
    const files = [manager.sessions.logFile(sessionId) + '.1', manager.sessions.logFile(sessionId)]
    const fingerprint = files.map(file => { try { const stat = fs.statSync(file); return `${stat.size}:${stat.mtimeMs}` } catch { return '' } }).join('|')
    if (peers.every(id => memory.imported(id, sessionId, fingerprint))) continue
    const batch = []
    let topic = '', input = '', attachmentId = ''
    const flush = () => {
      if (memory.closed || manager.ownerEpoch !== epoch) return
      for (const id of peers) memory.append(id, batch.map(item => ({ ...item, peer: match ? peers.find(peer => peer !== id) || '' : '' })))
      batch.length = 0
    }
    for (const file of files) {
      if (!fs.existsSync(file)) continue
      const stream = fs.createReadStream(file, { encoding: 'utf8' }), lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
      try {
        for await (const line of lines) {
          if (memory.closed || manager.ownerEpoch !== epoch) return
          let event
          try { event = JSON.parse(line).event } catch { continue }
          if (!event?.runId) continue
          if (event.type === 'run.started') {
            input = event.input || ''; attachmentId = event.imageAttachmentId
            topic = match ? input.match(/^主人给的话题：([\s\S]*?)\n(?:最近的连线对话：|请向)/)?.[1] || input.match(/^主人给的话题：([^\n]*)/)?.[1] || '' : ''
            if (!match) batch.push({ key: `${event.runId}:user`, conversation: sessionId, kind: 'personal', speaker: 'user', text: manager.attachmentContext(attachmentId).message ?? input, topic: '', at: event.at })
          } else if (event.type === 'run.finished' && event.status === 'completed' && event.text?.trim()) {
            batch.push({ key: `${event.runId}:assistant`, conversation: match ? `link:${match[2]}` : sessionId, kind: match ? 'link' : 'personal', speaker: entry.id, text: event.text, topic, at: event.at })
          }
          if (batch.length >= 100) { flush(); await new Promise(resolve => setImmediate(resolve)) }
        }
      } finally { lines.close(); stream.destroy() }
    }
    flush()
    for (const id of peers) memory.markImported(id, sessionId, fingerprint)
    await new Promise(resolve => setImmediate(resolve))
  }
}

module.exports = { importPetMemory }
