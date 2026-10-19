const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const retired = [
  'ecommerce-review-analyzer',
  'ecommerce-visual-copywriting',
  'china-ecommerce-compare',
  'taobao-product-search',
  'detail-page-studio'
]
const assets = path.resolve(root, '..', '..', '..', 'backend', 'internal', 'skillmarket', 'assets')
const market = fs.readFileSync(path.join(assets, '..', 'market.go'), 'utf8')

for (const id of retired) {
  assert.equal(fs.existsSync(path.join(root, 'skills', id)), false, `${id} source directory must be removed`)
  assert.equal(fs.existsSync(path.join(root, 'dist', 'skills', `${id}-1.0.0.anyu-plugin.zip`)), false, `${id} build package must be removed`)
  assert.equal(fs.existsSync(path.join(assets, `${id}-1.0.0.anyu-plugin.zip`)), false, `${id} backend asset must be removed`)
  assert.equal(market.includes(`ID: "${id}"`), false, `${id} must not be registered in the market`)
}
const oneClickManifest = JSON.parse(fs.readFileSync(path.join(root, 'skills', 'tmall-detail-reference', 'anyu-plugin.json'), 'utf8'))
assert.equal(oneClickManifest.displayName, '一键详情页')
assert.ok(fs.existsSync(path.join(root, 'dist', 'skills', `tmall-detail-reference-${oneClickManifest.version}.anyu-plugin.zip`)))
console.log('retired commerce skills are absent from local and backend package sources: passed')
