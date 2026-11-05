const fs = require('node:fs')
const fsp = fs.promises
const path = require('node:path')
const { createHash } = require('node:crypto')
const archiver = require('archiver')

const source = path.resolve(__dirname, '../../../anyuagent-video-studio')
const skillSource = path.resolve(__dirname, '../../../../skills/anyu-video-studio')
const arg = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : '' }
const stage = path.resolve(arg('--stage') || path.join(source, '.internal-build/win32-x64'))
const platform = `${process.platform}-${process.arch}`
const sum = async file => { const hash = createHash('sha256'); for await (const part of fs.createReadStream(file)) hash.update(part); return hash.digest('hex') }
async function zip(directory, destination, names) {
  await new Promise((resolve, reject) => {
    const archive = archiver('zip', {zlib: {level: 6}}), stream = fs.createWriteStream(`${destination}.part`)
    stream.once('close', resolve); stream.once('error', reject); archive.once('error', reject); archive.pipe(stream)
    if (names) { for (const name of names) archive.file(path.join(directory, name), {name}) }
    else archive.directory(directory, false)
    void archive.finalize().catch(reject)
  })
  await fsp.rename(`${destination}.part`, destination)
}
async function build() {
  if (arg('--prepare')) {
    if (fs.existsSync(stage)) throw new Error('Choose a new empty staging directory')
    await fsp.mkdir(stage, {recursive: true})
    await fsp.cp(path.join(source, 'runtime'), path.join(stage, 'runtime'), {recursive: true})
    for (const item of ['src', 'demosrc', 'proj-stub', 'i18n', 'scripts', 'dist', 'package.json', 'package-lock.json', 'card-ids.json', 'card-catalog.json']) await fsp.cp(path.join(source, 'editor', item), path.join(stage, 'editor', item), {recursive: true, dereference: true})
    const modules = path.join(source, 'editor/node_modules')
    await fsp.cp(modules, path.join(stage, 'editor/node_modules'), {recursive: true, dereference: true, filter: file => !['.cache', '.vite', '.bin'].includes(path.basename(file))})
    const bin = arg('--ffmpeg-bin')
    if (!bin) throw new Error('--ffmpeg-bin is required for an internal portable build')
    await fsp.mkdir(path.join(stage, 'bin'))
    for (const file of await fsp.readdir(bin)) if (/^(ffmpeg|ffprobe)\.exe$|\.dll$/.test(file)) await fsp.copyFile(path.join(bin, file), path.join(stage, 'bin', file))
    const ffmpegLicense = path.resolve(bin, '..', 'LICENSE')
    if (fs.existsSync(ffmpegLicense)) await fsp.copyFile(ffmpegLicense, path.join(stage, 'bin/FFMPEG-LICENSE'))
    const browser = arg('--browser-bin'), python = arg('--python-directory')
    if (!browser || !python) throw new Error('--browser-bin and --python-directory are required')
    await fsp.access(path.join(python, 'python.exe')); await fsp.access(path.join(browser, 'chrome-headless-shell.exe'))
    await fsp.cp(python, path.join(stage, 'python'), {recursive: true, dereference: true})
    await fsp.cp(browser, path.join(stage, 'browser'), {recursive: true, dereference: true})
    for (const name of ['SHOTCRAFT-LICENSE', 'THIRD-PARTY-NOTICES.md']) await fsp.copyFile(path.join(source, name), path.join(stage, name))
    console.log(JSON.stringify({stage, status: 'staged', next: 'Run portable health and smoke tests, then --archive yes'}))
  }
  if (arg('--archive')) {
    const outputDirectory = path.resolve(arg('--output-directory') || path.dirname(stage))
    await fsp.mkdir(outputDirectory, {recursive: true})
    await fsp.access(path.join(stage, 'python/python.exe'))
    let unpackedSize = 0
    const inventory = []
    const walk = async current => { for (const item of await fsp.readdir(current, {withFileTypes: true})) {
      const file = path.join(current, item.name), relative = path.relative(stage, file).split(path.sep).join('/')
      if (item.isSymbolicLink()) throw new Error(`Runtime contains a link: ${relative}`)
      if (item.isDirectory()) await walk(file)
      else { const stat = await fsp.stat(file); unpackedSize += stat.size; inventory.push({path: relative, size: stat.size}) }
    } }; await walk(stage)
    const destination = path.join(outputDirectory, `anyu-video-studio-0.1.0-${platform}-internal.zip`)
    await zip(stage, destination)
    const sha256 = await sum(destination), size = (await fsp.stat(destination)).size
    const manifest = {schema: 1, id: 'anyu-video-studio', version: '0.1.0', minClientVersion: '1.0.82', channel: 'internal', platforms: {[platform]: {path: `/downloads/anyu-video-studio/0.1.0/${path.basename(destination)}`, sha256, size, unpackedSize}}}
    const modelDirectory = arg('--model-directory')
    if (modelDirectory) {
      const modelZip = path.join(outputDirectory, 'anyu-video-studio-whisper-tiny-internal.zip')
      let modelBytes = 0
      const names = ['model.bin', 'config.json', 'tokenizer.json', 'vocabulary.txt', 'README.md', 'LICENSE', 'source.json']
      for (const name of names) modelBytes += (await fsp.stat(path.join(modelDirectory, name))).size
      await zip(modelDirectory, modelZip, names)
      manifest.models = {whisperTiny: {path: `/downloads/anyu-video-studio/0.1.0/${path.basename(modelZip)}`, sha256: await sum(modelZip), size: (await fsp.stat(modelZip)).size, unpackedSize: modelBytes}}
    }
    await fsp.writeFile(`${destination}.manifest.json`, JSON.stringify(manifest, null, 2))
    const skill = path.join(outputDirectory, 'skill-package')
    if (fs.existsSync(skill)) throw new Error('Skill staging directory already exists')
    await fsp.cp(skillSource, skill, {recursive: true}); await fsp.writeFile(path.join(skill, 'ANYU_RUNTIME.json'), JSON.stringify(manifest, null, 2))
    await zip(skill, path.join(outputDirectory, 'anyu-video-studio-0.1.0-skill-internal.zip'))
    await fsp.writeFile(`${destination}.inventory.json`, JSON.stringify({createdAt: new Date().toISOString(), platform, size, unpackedSize, sha256, files: inventory}, null, 2))
    console.log(JSON.stringify({destination, sha256, size, unpackedSize, files: inventory.length, channel: 'internal'}))
  }
}
build().catch(error => { console.error(error.message); process.exitCode = 1 })
