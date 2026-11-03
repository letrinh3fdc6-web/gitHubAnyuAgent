'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { finished } = require('node:stream/promises')
const archiver = require('archiver')
const { hashFile } = require('../runtime-cache.cjs')

async function inventory(directory, relative = '', files = {}) {
  for (const entry of (await fs.promises.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new Error(`Runtime bundle cannot contain symlinks: ${name}`)
    if (entry.isDirectory()) await inventory(directory, name, files)
    else files[name] = { bytes: (await fs.promises.stat(path.join(directory, name))).size, sha256: await hashFile(path.join(directory, name)) }
  }
  return files
}

async function bundle(source, output, executable, version) {
  const files = await inventory(source)
  if (!files[executable]) throw new Error(`Runtime executable missing: ${executable}`)
  const id = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')
  const archiveName = `${id}.anyu-runtime`
  const destination = path.join(output, archiveName)
  const zip = archiver('zip', { zlib: { level: 6 }, statConcurrency: 1 })
  const stream = fs.createWriteStream(destination)
  const done = finished(stream)
  zip.on('error', error => stream.destroy(error))
  zip.pipe(stream)
  for (const name of Object.keys(files)) zip.file(path.join(source, name), { name, date: new Date('2000-01-01T00:00:00Z'), mode: 0o100755 })
  await zip.finalize()
  await done
  return { id, version, archive: archiveName, executable, files, bytes: fs.statSync(destination).size, sha256: await hashFile(destination) }
}

module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return
  require('./installer-template.cjs')(context.targets)
  const resources = path.join(context.appOutDir, 'resources')
  const output = path.join(resources, 'runtime-bundles')
  await fs.promises.mkdir(output, { recursive: true })
  const arch = context.arch === 3 ? 'arm64' : 'x64'
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  const codex = path.join(resources, `app.asar.unpacked/node_modules/@openai/codex-win32-${arch}/vendor`)
  const pi = path.join(resources, 'pi-runtime')
  const catalog = { version: 1, components: {
    codex: await bundle(codex, output, `${triple}/bin/codex.exe`, context.packager.info.metadata.dependencies['@openai/codex']),
    pi: await bundle(pi, output, 'pi.exe', JSON.parse(fs.readFileSync(path.join(pi, 'package.json'), 'utf8')).version),
  } }
  await fs.promises.writeFile(path.join(output, 'catalog.json'), JSON.stringify(catalog, null, 2))
  // These are disposable builder outputs, never the source or installed runtimes.
  for (const directory of [codex, pi]) {
    if (!directory.startsWith(path.resolve(context.appOutDir) + path.sep)) throw new Error('Runtime output escaped build directory')
    await fs.promises.rm(directory, { recursive: true })
  }
}
module.exports.inventory = inventory
module.exports.bundle = bundle
