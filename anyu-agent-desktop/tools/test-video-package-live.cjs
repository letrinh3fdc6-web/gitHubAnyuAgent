const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const http = require('node:http')
const {createReadStream} = require('node:fs')
const {VideoStudio} = require('../video-studio.cjs')

test('frozen runtime downloads into a clean user directory, renders and transcribes with portable dependencies', {timeout: 600000}, async t => {
  const repository = path.resolve(__dirname, '../../../..')
  const output = process.env.ANYU_VIDEO_TEST_OUTPUT || path.join(repository, 'outputs/anyu-video-studio-internal')
  const build = process.env.ANYU_VIDEO_PACKAGE_DIR || path.join(repository, 'outputs/anyu-video-studio-internal/build')
  const manifest = JSON.parse(await fs.readFile(path.join(build, 'skill-package/ANYU_RUNTIME.json'), 'utf8'))
  const runtime = path.basename(manifest.platforms['win32-x64'].path)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu完整安装 '))
  const requests = [], progress = []
  const server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url, 'http://127.0.0.1').pathname)
    if (![runtime, 'anyu-video-studio-whisper-tiny-internal.zip'].includes(name)) { res.writeHead(404); res.end(); return }
    requests.push(name)
    const file = path.join(build, name), size = (await fs.stat(file)).size
    res.writeHead(200, {'Content-Length': size}); createReadStream(file).pipe(res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const skills = {root: path.join(directory, 'skills')}
  await fs.mkdir(path.join(skills.root, 'anyu-video-studio'), {recursive: true})
  await fs.copyFile(path.join(repository, 'skills/anyu-video-studio/SKILL.md'), path.join(skills.root, 'anyu-video-studio/SKILL.md'))
  await fs.writeFile(path.join(skills.root, 'anyu-video-studio/ANYU_RUNTIME.json'), JSON.stringify(manifest))
  let editorUrl
  const video = new VideoStudio({userData: directory, skills, version: '1.0.82', apiBase: () => `http://127.0.0.1:${server.address().port}`, progress: state => { if (progress.at(-1) !== state.status) progress.push(state.status) }, openEditor: async url => {editorUrl = url}})
  try {
    await video.prepare(); assert.equal(video.status().status, 'ready')
    await video.prepareModel(); assert.equal(video.status().transcriptionReady, true)
    const task = {owner: 'internal-package', sessionId: 'package-session', id: 'package-run', model: 'current-session-model', settings: {policy: {network: true}}}
    const project = await video.dispatch(task, {action: 'create', name: '便携包验收', files: [path.join(output, 'premium-verified.mp4')]})
    await video.dispatch(task, {action: 'plan', projectId: project.id, plan: {width: 320, height: 180, fps: 24, shots: [{mediaId: project.media[0].id, sourceStart: 0.2, duration: 1.2}]}})
    const wait = async job => {
      for (let i = 0; i < 240; i++) {
        const result = await video.dispatch(task, {action: 'status', projectId: project.id, jobId: job.id})
        if (result.status === 'completed') return result
        if (result.status === 'failed') throw new Error(result.message)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      throw new Error('Portable job timed out')
    }
    const rendered = await wait(await video.dispatch(task, {action: 'render', projectId: project.id, requestId: 'portable-render'}))
    assert.equal(rendered.hasAudio, true)
    await fs.copyFile(rendered.output, path.join(output, 'portable-verified.mp4'))
    const offlineTask = {...task, settings: {policy: {network: false}}}
    const recognized = await wait(await video.dispatch(offlineTask, {action: 'transcribe', projectId: project.id, requestId: 'portable-asr', request: {mediaId: project.media[0].id, language: 'zh'}}))
    assert.ok(recognized.result.transcript.text.length >= 4)
    await assert.rejects(video.dispatch(offlineTask, {action: 'narrate', projectId: project.id, request: {text: 'Not sent', voice: 'zh-CN-XiaoxiaoNeural', rate: 0}}), /disabled/)
    const narration = await wait(await video.dispatch({...task, settings: {policy: {network: true}}}, {action: 'narrate', projectId: project.id, requestId: 'portable-voice', request: {text: '每个故事，都值得被认真听见。', voice: 'zh-CN-XiaoxiaoNeural', rate: 0}}))
    assert.equal(narration.result.audio.voice, 'zh-CN-XiaoxiaoNeural')
    const archive = await video.dispatch(task, {action: 'export', projectId: project.id})
    const imported = await video.dispatch({...task, sessionId: 'other-session'}, {action: 'import', file: archive.file})
    await assert.rejects(video.dispatch(task, {action: 'inspect', projectId: imported.id}), /another conversation/)
    await video.dispatch(task, {action: 'editor', projectId: project.id}); assert.match(editorUrl, /^http:\/\/127\.0\.0\.1:/)
    const report = {ok: true, createdAt: new Date().toISOString(), platform: process.platform, host: process.versions.electron || 'node', node: process.version, runtimeSha256: manifest.platforms['win32-x64'].sha256, runtimeBytes: manifest.platforms['win32-x64'].size, progress, requests, rendered: {duration: rendered.duration, hasAudio: rendered.hasAudio}, transcript: recognized.result.transcript.text, importedProject: Boolean(imported.id), dependencies: 'portable runtime; no system Python/FFmpeg/browser overrides'}
    await fs.writeFile(path.join(output, 'portable-verification.json'), JSON.stringify(report, null, 2))
    t.diagnostic(JSON.stringify(report))
  } finally {
    await video.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    await fs.rm(directory, {recursive: true, force: true, maxRetries: 5, retryDelay: 500})
  }
})
