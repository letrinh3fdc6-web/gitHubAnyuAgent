'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const http = require('node:http')
const { gzipSync } = require('node:zlib')
const { differentialDownload, sameOriginFetch, parseBlockMap } = require('../update-download.cjs')
const sha = value => crypto.createHash('sha256').update(value).digest('hex')
const map = parts => gzipSync(Buffer.from(JSON.stringify({ version: '2', files: [{ name: 'file', offset: 0, sizes: parts.map(p => p.length), checksums: parts.map(sha) }] })))

async function fixture(t, mode = 'ranges') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-differential-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const parts = mode === 'fragmented' ? Array.from({ length: 600 }, (_, index) => { const part = Buffer.alloc(4096, 1); part.writeUInt32LE(index); return part }) : [Buffer.alloc(4096, 1), Buffer.alloc(4096, 2), Buffer.alloc(4096, 3)]
  const next = mode === 'fragmented' ? parts.map((part, index) => { if (index < 200 || index >= 400 || index % 10 !== 1) return part; const changed = Buffer.from(part); changed[4] = 4; return changed }) : [parts[0], Buffer.alloc(4096, 4), parts[2]]
  const old = Buffer.concat(parts), bytes = Buffer.concat(next), oldMap = map(parts), newMap = map(next)
  const requests = []
  const server = http.createServer((request, response) => {
    requests.push(request.headers.range)
    if (mode === 'no-ranges') { response.writeHead(200); response.end(bytes); return }
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(request.headers.range)
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` })
    response.end(mode === 'corrupt' ? Buffer.alloc(Number(end) - Number(start) + 1) : bytes.subarray(Number(start), Number(end) + 1))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const baseFile = path.join(root, 'old.exe'), baseMapFile = path.join(root, 'old.blockmap'), target = path.join(root, 'new.exe')
  fs.writeFileSync(baseFile, old); fs.writeFileSync(baseMapFile, oldMap)
  return { bytes, requests, target, baseFile, baseMapFile, newMap, fetcher: fetch, signal: AbortSignal.timeout(5000), base: { bytes: old.length, sha256: sha(old), blockMap: { bytes: oldMap.length, sha256: sha(oldMap) } }, artifact: { bytes: bytes.length, sha256: sha(bytes), url: `http://127.0.0.1:${server.address().port}/update.exe` } }
}

test('real HTTP differential reconstruction downloads only changed bytes and verifies the complete package', async t => {
  const f = await fixture(t)
  await differentialDownload(f)
  assert.deepEqual(fs.readFileSync(f.target), f.bytes)
  assert.deepEqual(f.requests, ['bytes=4096-8191'])
})

test('fragmented ranges are coalesced without changing reconstructed bytes', async t => {
  const f = await fixture(t, 'fragmented')
  const { coalesceDownloads } = require('../update-download.cjs')
  assert.deepEqual(coalesceDownloads([{ kind: 0, start: 50, end: 60 }, { kind: 1, start: 10, end: 20 }, { kind: 0, start: 100, end: 105 }, { kind: 1, start: 25, end: 30 }]), [{ kind: 0, start: 50, end: 60 }, { kind: 1, start: 10, end: 30 }])
  await differentialDownload(f)
  assert.deepEqual(fs.readFileSync(f.target), f.bytes)
  assert.equal(f.requests.length, 1)
})
for (const mode of ['no-ranges', 'corrupt']) test(`rejects ${mode} before installation`, async t => {
  const f = await fixture(t, mode)
  await assert.rejects(differentialDownload(f), mode === 'corrupt' ? /verification failed/ : /exact byte ranges/)
})
test('damaged old package is rejected before any network request', async t => {
  const f = await fixture(t)
  fs.writeFileSync(f.baseFile, Buffer.alloc(f.base.bytes))
  await assert.rejects(differentialDownload(f), /base is unavailable or damaged/)
  assert.equal(f.requests.length, 0)
})
test('cancellation stops reconstruction', async t => {
  const f = await fixture(t)
  f.signal = AbortSignal.abort()
  await assert.rejects(differentialDownload(f), { name: 'AbortError' })
  assert.equal(f.requests.length, 0)
})
test('off-source redirect is rejected without following it', async () => {
  let calls = 0
  await assert.rejects(sameOriginFetch(async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://other.test/update' } }) }, 'https://updates.test/update', {}), /outside/)
  assert.equal(calls, 1)
})
test('malformed block map cannot request out-of-bounds data', () => {
  assert.throws(() => parseBlockMap(map([Buffer.alloc(10)]), 11), /Invalid/)
})
