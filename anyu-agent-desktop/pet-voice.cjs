'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { VOICES } = require('./pet-catalog.cjs')
const OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3'
const SYNTHESIS_TIMEOUT_MS = 15000
const RETRY_DELAY_MS = 350

function usableAudio(bytes) {
  if (!bytes || bytes.length < 128 || bytes.length > 10 * 1024 * 1024) return false
  let offset = 0
  if (bytes.subarray(0, 3).toString() === 'ID3') {
    if ([6, 7, 8, 9].some(i => bytes[i] & 0x80)) return false
    offset = 10 + (bytes[6] << 21 | bytes[7] << 14 | bytes[8] << 7 | bytes[9])
    if (bytes[5] & 0x10) offset += 10
  }
  // Validate a frame header before reusing cached bytes; full decoding stays in the player.
  return offset + 4 < bytes.length && bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0 &&
    (bytes[offset + 1] & 0x18) !== 0x08 && (bytes[offset + 1] & 6) !== 0 &&
    (bytes[offset + 2] >> 4) > 0 && (bytes[offset + 2] >> 4) < 15 && (bytes[offset + 2] & 12) !== 12
}

function spokenText(value) {
  return String(value || '').replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 500)
}

class PetVoice {
  constructor(directory, synthesize) {
    this.directory = directory
    this.synthesize = synthesize || (async (text, file, config) => {
      const { EdgeTTS } = require('node-edge-tts')
      const signed = value => `${value >= 0 ? '+' : ''}${value}`
      const tts = new EdgeTTS({ voice: config.voice, lang: VOICES.find(v => v.id === config.voice)?.language || 'zh-CN', rate: `${signed(config.rate)}%`, pitch: `${signed(config.pitch)}Hz`, volume: '+0%', outputFormat: OUTPUT_FORMAT, timeout: SYNTHESIS_TIMEOUT_MS })
      await tts.ttsPromise(text, file)
    })
    this.pending = new Map()
  }
  async speak(value, config) {
    const text = spokenText(value)
    if (!text || config.speech === 'off') return { text: '', mode: 'off' }
    config = { ...config }
    if (!VOICES.some(voice => voice.id === config.voice)) throw new Error('音色不可用')
    const key = crypto.createHash('sha256').update(JSON.stringify([OUTPUT_FORMAT, text, config.voice, config.rate, config.pitch])).digest('hex')
    if (!this.pending.has(key)) {
      this.pending.set(key, this.render(key, text, config).finally(() => this.pending.delete(key)))
    }
    return this.pending.get(key)
  }
  async render(key, text, config) {
    await fs.mkdir(this.directory, { recursive: true })
    const file = path.join(this.directory, `${key}.mp3`)
    try {
      let bytes = await fs.readFile(file).catch(() => null)
      if (!usableAudio(bytes)) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const temporary = path.join(this.directory, `${key}.${crypto.randomUUID()}.tmp.mp3`)
          try {
            await this.synthesize(text, temporary, config)
            bytes = await fs.readFile(temporary)
            if (!usableAudio(bytes)) throw new Error('语音内容无效')
            await fs.rename(temporary, file)
            break
          } catch (error) {
            if (attempt === 1) throw error
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
          } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
        }
      }
      void this.trim().catch(() => {})
      return { mode: 'natural', text, audio: `data:audio/mpeg;base64,${bytes.toString('base64')}` }
    } catch {
      return { mode: 'off', text, warning: '角色音色暂不可用，本句未朗读，文字和对话继续保留' }
    }
  }
  async trim() {
    const entries = await fs.readdir(this.directory)
    const files = await Promise.all(entries.filter(name => /^[a-f0-9]{64}\.mp3$/.test(name)).map(async name => ({ name, stat: await fs.stat(path.join(this.directory, name)).catch(() => null) })))
    for (const file of files.filter(file => file.stat).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs).slice(64)) await fs.rm(path.join(this.directory, file.name), { force: true })
  }
}

module.exports = { PetVoice, spokenText }
