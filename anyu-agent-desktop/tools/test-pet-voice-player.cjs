'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { PetVoice } = require('../pet-voice.cjs')
const { CHARACTERS, resolveConfig } = require('../pet-catalog.cjs')

const source = fs.readFileSync(path.join(__dirname, '../pets/pet.js'), 'utf8')
const playerSource = source.slice(source.indexOf('function silence() {'), source.indexOf('let audioContext, lastChimeAt'))
const mp3 = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0]), Buffer.alloc(512)])
function player(play = async () => {}) {
  const audio = [], system = [], speaking = []
  const ctx = vm.createContext({
    Audio: class {
      constructor() { audio.push(this); this.paused = false }
      play() { return play() }
      pause() { this.paused = true }
    },
    speechSynthesis: { cancel() {}, speak(value) { system.push(value) } },
    SpeechSynthesisUtterance: class {},
    stage: { speaking: value => speaking.push(value) },
    character: { config: { volume: .7 } },
  })
  vm.runInContext(`let activeAudio = null, speechGeneration = 0, speechDone = null; ${playerSource}`, ctx)
  return { ctx, audio, system, speaking }
}

test('legacy system fallback and missing audio finish silently without changing voice', async () => {
  const h = player(); let completed = 0
  for (const result of [{ mode: 'system', text: 'old host fallback' }, { mode: 'natural', text: 'no audio' }, { mode: 'off', text: 'network error' }]) {
    await h.ctx.playSpeech(result, .7, () => completed++)
  }
  assert.equal(completed, 3); assert.equal(h.audio.length, 0); assert.equal(h.system.length, 0)
})

test('play failure and decoder errors acknowledge exactly once without system synthesis', async () => {
  const h = player(async () => { throw new Error('audio device unavailable') }); let completed = 0
  await h.ctx.playSpeech({ mode: 'natural', text: 'hello', audio: 'mp3' }, .7, () => completed++)
  h.audio[0].onerror(); h.audio[0].onended()
  assert.equal(completed, 1); assert.equal(h.system.length, 0)
})

test('playback guard can replace the function without interrupting the current audio', async () => {
  const h = player(); let completed = 0
  await h.ctx.playSpeech({ mode: 'natural', text: 'hello', audio: 'mp3' }, .7, () => completed++)
  const original = h.audio[0]
  vm.runInContext(`playSpeech = (${source.slice(source.indexOf('async function playSpeech('), source.indexOf('let audioContext, lastChimeAt')).trim()})`, h.ctx)
  assert.equal(completed, 0); assert.equal(original.paused, false)
  original.onended()
  assert.equal(completed, 1)
})

test('stale play events cannot change the next turn and cancelled speech finishes once', async () => {
  let release
  const h = player(() => new Promise(resolve => { release = resolve })); let completed = 0
  const pending = h.ctx.playSpeech({ mode: 'natural', text: 'old', audio: 'mp3' }, .7, () => completed++)
  h.ctx.silence(); h.audio[0].onplay(); release(); await pending; h.audio[0].onended()
  assert.equal(h.speaking.includes(true), false); assert.equal(completed, 1)
})

test('synthesis retries the same snapshot and repairs bad cache without emitting system audio', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'anyu-voice-test-'))
  t.after(() => fsp.rm(directory, { recursive: true, force: true }))
  const calls = [], config = resolveConfig(CHARACTERS[0])
  const voice = new PetVoice(directory, async (_text, file, captured) => {
    calls.push({ voice: captured.voice, rate: captured.rate, pitch: captured.pitch })
    if (calls.length === 1) throw new Error('temporary network failure')
    await fsp.writeFile(file, mp3)
  })
  const pending = voice.speak('same voice', config)
  config.voice = 'zh-CN-YunxiaNeural'
  const result = await pending
  assert.equal(result.mode, 'natural'); assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0].voice, 'zh-CN-XiaoyiNeural')
  const cache = (await fsp.readdir(directory)).find(name => name.endsWith('.mp3'))
  await fsp.writeFile(path.join(directory, cache), 'bad bytes')
  await voice.speak('same voice', resolveConfig(CHARACTERS[0]))
  assert.equal(calls.length, 3)
  assert.equal((await fsp.readdir(directory)).some(name => name.includes('.tmp.')), false)
  let failures = 0
  voice.synthesize = async () => { failures++; throw new Error('offline') }
  assert.equal((await voice.speak('unavailable', config)).mode, 'off')
  assert.equal(failures, 2)
})

test('old system preference upgrades without changing the selected voice or model', () => {
  const saved = { speech: 'system', voice: 'zh-CN-YunxiaNeural', rate: 8, pitch: -4, model: { id: 'model' } }
  const resolved = resolveConfig(CHARACTERS[0], saved)
  assert.equal(resolved.speech, 'natural')
  for (const key of ['voice', 'rate', 'pitch', 'model']) assert.deepEqual(resolved[key], saved[key])
  assert.equal(saved.speech, 'system')
})
