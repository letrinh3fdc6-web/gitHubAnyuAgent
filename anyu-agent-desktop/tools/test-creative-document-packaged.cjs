'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { createRequire, isBuiltin } = require('node:module')
const asar = require('@electron/asar')
const archiver = require('archiver')

async function copyDependency(name, destination, from = require) {
  if (isBuiltin(name)) return
  let directory = path.dirname(from.resolve(name))
  while (true) {
    const file = path.join(directory, 'package.json')
    const metadata = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => null)
    if (metadata?.name === name) {
      const target = path.join(destination, name)
      try { await fs.access(target); return } catch {}
      await fs.cp(directory, target, { recursive: true, dereference: true, filter: file => !['node_modules', '.git'].includes(path.basename(file)) })
      const localRequire = createRequire(file)
      for (const dependency of Object.keys(metadata.dependencies || {})) await copyDependency(dependency, destination, localRequire)
      return
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`Cannot locate package ${name}`)
    directory = parent
  }
}

async function docx(file) {
  const output = require('node:fs').createWriteStream(file), archive = archiver('zip')
  const complete = new Promise((resolve, reject) => { output.once('close', resolve); output.once('error', reject); archive.once('error', reject) })
  archive.pipe(output)
  archive.append('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>安安：保留这句中文原台词。</w:t></w:r></w:p></w:body></w:document>', { name: 'word/document.xml' })
  await archive.finalize(); await complete
}

function pdf() {
  const stream = 'BT /F1 18 Tf 72 720 Td (Packaged PDF dialogue.) Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let output = '%PDF-1.4\n'; const offsets = []
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(output)
  return output + `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
}

test('document workers resolve packaged ASAR dependencies on both unpack layouts', { timeout: 90000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-document-asar-'))
  try {
    const stage = path.join(root, 'source'); await fs.mkdir(stage)
    await fs.copyFile(path.join(__dirname, '../creative-document.cjs'), path.join(stage, 'creative-document.cjs'))
    for (const name of ['unpdf', 'unzipper', '@xmldom/xmldom']) await copyDependency(name, path.join(stage, 'node_modules'))
    const script = path.join(root, 'script.txt'), word = path.join(root, 'script.docx'), document = path.join(root, 'script.pdf')
    await fs.writeFile(script, '安安：保留这句中文原台词。'); await docx(word); await fs.writeFile(document, pdf())
    const runner = path.join(root, 'run.cjs')
    await fs.writeFile(runner, `const { readCreativeDocument } = require(process.argv[2]); (async () => { for (const file of process.argv.slice(3)) { const result = await readCreativeDocument(file); console.log(JSON.stringify(result)); } })().catch(error => { console.error(error.stack); process.exitCode = 1; });`)
    for (const layout of ['windows', 'mac']) {
      const metadata = JSON.parse(await fs.readFile(path.join(__dirname, '../package.json'), 'utf8'))
      const unpack = layout === 'mac' ? metadata.build.mac.asarUnpack : metadata.build.asarUnpack
      assert.ok(unpack.includes('creative-document.cjs'), `${layout}: document worker must be physically available`)
      const archive = path.join(root, layout, 'app.asar'); await fs.mkdir(path.dirname(archive))
      await asar.createPackageWithOptions(stage, archive, { unpack: layout === 'mac' ? '{creative-document.cjs,node_modules/**/*}' : 'creative-document.cjs' })
      const output = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [runner, path.join(archive, 'creative-document.cjs'), script, word, document], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
        let stdout = '', stderr = ''
        const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged document smoke timed out')) }, 35000)
        child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('exit', code => { clearTimeout(timer); code ? reject(new Error(`${layout} (${code}): ${stderr || stdout}`)) : resolve(stdout) })
      })
      const results = output.split(/\r?\n/).filter(line => line.startsWith('{')).map(JSON.parse)
      assert.equal(results.length, 3, `${layout}: every supported dependency must execute in a worker`)
      assert.match(results[0].text, /保留这句中文原台词/)
      assert.match(results[1].text, /保留这句中文原台词/)
      assert.match(results[2].text, /Packaged PDF dialogue/)
    }
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }) }
})
