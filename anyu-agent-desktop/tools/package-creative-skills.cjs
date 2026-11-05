'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const archiver = require('archiver')
const { decodePackage, idPattern } = require('../skill-store.cjs')

const repository = path.resolve(__dirname, '../../../..')
const sourceRoot = path.join(repository, 'skills')
const shared = path.join(sourceRoot, 'creative-shared')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

async function archiveFiles(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } })
    const chunks = []
    archive.on('data', chunk => chunks.push(chunk)); archive.once('error', reject)
    archive.once('end', () => resolve(Buffer.concat(chunks)))
    for (const name of Object.keys(files).sort()) archive.append(files[name], { name, date: new Date('2000-01-01T00:00:00Z'), mode: 0o644 })
    archive.finalize().catch(reject)
  })
}

async function packageCreativeSkills(destination) {
  const catalog = JSON.parse(await fs.readFile(path.join(shared, 'catalog.json'), 'utf8'))
  const sources = JSON.parse(await fs.readFile(path.join(shared, 'sources.json'), 'utf8'))
  if (catalog.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(catalog.version)) throw new Error('Invalid creative skill catalog version')
  const records = []
  for (const skill of catalog.skills) {
    if (!idPattern.test(skill.id) || !catalog.categories.some(category => category.id === skill.category_id)) throw new Error('Invalid creative skill or category')
    const selected = skill.sources.map(id => { if (!sources[id]) throw new Error('Unknown provenance entry'); return sources[id] })
    const experience = { schema_version: 1, ...skill.experience, required_tools: ['creative_studio'], sources: selected.map(source => ({ name: source.name, url: `https://github.com/${source.repo}/tree/${source.commit}`, license: source.license })) }
    const files = {
      'SKILL.md': await fs.readFile(path.join(sourceRoot, skill.id, 'SKILL.md')),
      'anyu-skill.json': Buffer.from(JSON.stringify(experience, null, 2) + '\n'),
      'provenance.json': Buffer.from(JSON.stringify({ schema: 1, id: skill.id, version: catalog.version, sources: selected }, null, 2) + '\n'),
      'THIRD_PARTY_NOTICES.md': Buffer.from([
        `# ${skill.name}: source and license notices`, '',
        'This is an AnyuAgent adaptation. Host integration, prompts and output contracts are maintained for the current client. No affiliation with or endorsement by the referenced authors is implied.', '',
        'The production methods adapted from the following MIT projects retain their original notices in licenses/. External API installers, affiliate links, credentials and branded reference images are not redistributed.', '',
        ...selected.map(source => `- ${source.name}: https://github.com/${source.repo}/tree/${source.commit}\n  Adapted methods: ${source.methods}\n  License: licenses/${source.license_file}`), '',
      ].join('\n')),
    }
    for (const reference of skill.references) {
      if (!/^[a-z-]+\.md$/.test(reference)) throw new Error('Invalid shared reference path')
      files[`references/${reference}`] = await fs.readFile(path.join(shared, 'references', reference))
    }
    for (const source of selected) files[`licenses/${source.license_file}`] = await fs.readFile(path.join(shared, 'licenses', source.license_file))
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.endsWith('.md')) continue
      for (const link of bytes.toString('utf8').matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        if (/^https?:/.test(link[1])) continue
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link[1]))
        if (!files[target]) throw new Error(`${skill.id}: broken documentation link ${name} -> ${target}`)
      }
    }
    const bytes = await archiveFiles(files)
    await decodePackage(bytes)
    const filename = `${skill.id}-${catalog.version}.zip`
    const record = { id: skill.id, name: skill.name, description: skill.description, category_id: skill.category_id, sort_order: skill.sort_order, version: catalog.version, sha256: hash(bytes), size: bytes.length, filename, files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) }
    if (destination) { await fs.mkdir(destination, { recursive: true }); await fs.writeFile(path.join(destination, filename), bytes) }
    records.push({ ...record, bytes })
  }
  const manifest = { schema: 1, version: catalog.version, categories: catalog.categories, skills: records.map(({ bytes, ...record }) => record) }
  if (destination) await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { manifest, packages: records }
}

if (require.main === module) {
  const destination = path.resolve(process.argv[2] || path.join(repository, 'outputs/anyu-creative-skills-20261105/packages'))
  packageCreativeSkills(destination).then(({ manifest }) => console.log(JSON.stringify({ destination, skills: manifest.skills.map(({ id, size, sha256 }) => ({ id, size, sha256 })) }, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
}

module.exports = { packageCreativeSkills }
