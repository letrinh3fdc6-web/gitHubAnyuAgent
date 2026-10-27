const fs = require('node:fs')
const path = require('node:path')
const archiver = require('archiver')

// Server-owned seeds retain the complete existing scripts, references and licenses.
async function main() {
  const desktop = path.resolve(__dirname, '..')
  const destination = path.resolve(desktop, '../../../backend/internal/anyuagent/skillstore/assets')
  fs.mkdirSync(destination, { recursive: true })
  for (const id of ['pptx', 'xlsx']) {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(path.join(destination, `${id}.zip`))
      const archive = archiver('zip', { zlib: { level: 9 } })
      out.on('close', resolve); out.on('error', reject); archive.on('error', reject)
      archive.pipe(out)
      archive.directory(path.join(desktop, 'skills', id), false)
      archive.finalize().catch(reject)
    })
  }
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
