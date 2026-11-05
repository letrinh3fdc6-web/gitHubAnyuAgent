'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const archiver = require('archiver')
const { _electron } = require(process.env.ANYU_PLAYWRIGHT_MODULE || 'C:/Users/Administrator/AppData/Local/Temp/tokenrouter-source-recovery-browser-20261018/node_modules/playwright')

const output = path.resolve(process.env.ANYU_SMOKE_OUTPUT || path.join(os.tmpdir(), 'anyu-packaged-creative'))
fs.mkdirSync(output, { recursive: true })
const root = fs.mkdtempSync(path.join(output, 'creative-fixture-'))
const cwd = path.join(root, 'workspace')
fs.mkdirSync(cwd)
const script = '\u5b89\u5b89\uff1a\u6211\u4eec\u51fa\u53d1\u5427\u3002\n\u5979\u63a8\u5f00\u95e8\uff0c\u770b\u89c1\u9ece\u660e\u3002'
const report = { platform: process.platform, arch: process.arch, checks: [], passed: false }

async function word(file) {
  const stream = fs.createWriteStream(file), archive = archiver('zip')
  const done = new Promise((resolve, reject) => { stream.once('close', resolve); stream.once('error', reject); archive.once('error', reject) })
  archive.pipe(stream)
  archive.append(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${script.split('\n').map(line => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`, { name: 'word/document.xml' })
  await archive.finalize(); await done
}

async function until(operation, label) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await operation()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}

async function main() {
  assert.ok(process.env.ANYU_SMOKE_EXECUTABLE, 'Set ANYU_SMOKE_EXECUTABLE to the packaged app')
  await word(path.join(cwd, 'script.docx'))
  const env = { ...process.env, ANYU_USER_DATA_DIR: path.join(root, 'profile') }
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ANYU_RENDERER_URL', 'ANYU_API_BASE', 'ANYU_ALLOW_LOCAL_API_BASE']) delete env[name]
  let app
  try {
    app = await _electron.launch({ executablePath: process.env.ANYU_SMOKE_EXECUTABLE, args: process.platform === 'win32' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [], env, timeout: 60000 })
    const page = await app.firstWindow()
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.setPosition(-10000, -10000)
      window.webContents.setBackgroundThrottling(false)
    })
    await page.waitForFunction(() => Boolean(window.anyu?.skillsCapabilities && window.anyu?.browserOpenArtifact))
    assert.ok((await page.evaluate(() => window.anyu.skillsCapabilities())).includes('creative_studio'))
    report.host = await app.evaluate(async ({ app }, { cwd, root, source }) => {
      if (!app.isPackaged || !app.getAppPath().endsWith('app.asar')) throw new Error('Expected a real packaged ASAR application')
      const load = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'))
      const { CreativeStudio } = load('./creative-studio.cjs')
      const fs = process.getBuiltinModule('node:fs/promises'), path = process.getBuiltinModule('node:path')
      const assert = process.getBuiltinModule('node:assert/strict')
      const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMSEAAAAASUVORK5CYII=', 'base64')
      const task = { owner: 'packaged-test', cwd, sessionId: 'packaged-creative', settings: { policy: { network: true, workspaceOnly: true, blockedTools: [] } } }
      const records = new Map(), references = []
      let completed = false
      const options = {
        userData: path.join(root, 'host'), getOwner: () => task.owner, installed: () => true, pollInterval: 10,
        catalog: async () => [{ id: 1, name: 'Fixture', platform: 'openai', status: 'active', allow_image_generation: true, models: [{ name: 'fixture-image', capability: 'image' }] }],
        create: async (fields, files) => { const record = { id: `fixture-${records.size + 1}`, ...fields }; records.set(record.id, record); references.push(files.length); return record },
        status: async id => ({ ...records.get(id), status: completed ? 'completed' : 'running' }),
        download: async () => image,
      }
      let host = new CreativeStudio(options)
      let project
      try {
        project = await host.dispatch(task, { action: 'create', kind: 'comic', name: 'Packaged storyboard', scriptFile: path.join(cwd, 'script.docx') })
        assert.equal(await fs.readFile(project.scriptFile, 'utf8'), source)
        project = await host.dispatch(task, { action: 'save', projectId: project.projectId, revision: 0, plan: {
          objective: 'Packaged document and media recovery', styleLock: 'Consistent reference identity', items: [
            { id: 'anchor', kind: 'character', title: 'Character anchor', prompt: 'A character reference' },
            { id: 'shot', kind: 'shot', title: 'Opening the door', prompt: 'The same character opens a door', sourceExcerpt: source, dependsOn: ['anchor'], dialogue: [{ speaker: '\u5b89\u5b89', text: '\u6211\u4eec\u51fa\u53d1\u5427\u3002' }], duration: 5 },
          ],
        } })
        const input = { action: 'generate', projectId: project.projectId, revision: 1, groupId: 1, model: 'fixture-image' }
        await host.dispatch(task, input)
        const deadline = Date.now() + 5000
        while (!records.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        await host.dispatch(task, { action: 'cancel', projectId: project.projectId })
        assert.equal(records.size, 1)
        await host.close()
        completed = true
        host = new CreativeStudio(options)
        await host.dispatch(task, input)
        await host.jobs.get(project.projectId)?.promise
        const result = await host.dispatch(task, { action: 'status', projectId: project.projectId })
        assert.ok(result.items.every(item => item.status === 'completed'), JSON.stringify(result.items))
        await host.dispatch(task, input)
        await host.jobs.get(project.projectId)?.promise
        assert.equal(records.size, 2, 'Recovery/completed reads must not create duplicate remote tasks')
        assert.deepEqual(references, [0, 1], 'Dependent shot must attach the completed anchor')
        assert.equal((await host.dispatch(task, { action: 'list' })).projects.length, 1)
        return { version: app.getVersion(), asar: true, directory: result.directory, submissions: records.size, items: result.items.length, wordCharacters: source.length }
      } finally { await host.close() }
    }, { cwd, root, source: script })
    report.checks.push('packaged preload capability', 'Chinese Word worker inside the real ASAR', 'revisioned comic plan and source dialogue', 'cancellation and host restart without duplicate generation', 'anchor reference attached to dependent shot', 'completed local project restoration')

    await page.evaluate(async directory => {
      await window.anyu.browserOpenArtifact({ path: directory + '/index.html', cwd: directory })
      await window.anyu.browserSetBounds({ x: 320, y: 90, width: 850, height: 650 })
    }, report.host.directory)
    await until(() => app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const view = window.contentView.children.find(child => child.webContents && child.webContents !== window.webContents)
      return view?.webContents.executeJavaScript('document.images.length === 2 && [...document.images].every(image => image.complete && image.naturalWidth === 1)').catch(() => false)
    }), 'local contact sheet resources')
    const destination = path.join(root, 'downloaded.csv')
    await app.evaluate(({ BrowserWindow }, destination) => {
      const window = BrowserWindow.getAllWindows()[0]
      const view = window.contentView.children.find(child => child.webContents && child.webContents !== window.webContents)
      globalThis.__creativePackagedDownload = 'waiting'
      view.webContents.session.once('will-download', (_, item) => {
        item.setSavePath(destination)
        item.once('done', (_, state) => { globalThis.__creativePackagedDownload = state })
      })
    }, destination)
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      const view = window.contentView.children.find(child => child.webContents && child.webContents !== window.webContents)
      await view.webContents.executeJavaScript('document.querySelector("nav a[download]").click()', true)
    })
    await until(() => app.evaluate(() => globalThis.__creativePackagedDownload === 'completed'), 'original CSV download')
    assert.ok(fs.readFileSync(destination).equals(fs.readFileSync(path.join(report.host.directory, 'storyboard.csv'))))
    report.checks.push('packaged result viewer loads local images', 'download retains original CSV bytes')
    report.passed = true
  } finally {
    if (app) {
      const child = app.process(); let timer
      await Promise.race([app.close(), new Promise(resolve => { timer = setTimeout(() => { child.kill(); resolve() }, 10000) })]).finally(() => clearTimeout(timer))
    }
  }
}

main().catch(error => { report.failure = error.stack || String(error); process.exitCode = 1 }).finally(() => {
  fs.writeFileSync(path.join(output, `${process.platform}-${process.arch}-creative-smoke.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
})
