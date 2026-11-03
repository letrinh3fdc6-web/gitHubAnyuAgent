'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { hashFile } = require('../runtime-cache.cjs')

module.exports = async context => {
  const version = context.configuration?.extraMetadata?.version || require('../package.json').version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) throw new Error('Invalid update artifact version')
  for (const file of context.artifactPaths || []) {
    if (!/\.exe$/i.test(file) || !fs.existsSync(`${file}.blockmap`)) continue
    const name = path.basename(file)
    const artifact = { name, version, url: `/downloads/${name}`, bytes: fs.statSync(file).size, sha256: await hashFile(file), blockMap: { url: `/downloads/${name}.blockmap`, bytes: fs.statSync(`${file}.blockmap`).size, sha256: await hashFile(`${file}.blockmap`) } }
    await fs.promises.writeFile(`${file}.update.json`, JSON.stringify({ anyuAgent: artifact }, null, 2))
  }
  return []
}
