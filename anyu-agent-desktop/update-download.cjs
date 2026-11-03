'use strict'
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { gunzipSync } = require('node:zlib')
const { hashFile } = require('./runtime-cache.cjs')

async function sameOriginFetch(fetcher, address, options) {
  const origin = new URL(address).origin
  let url = address
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url, { ...options, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const target = new URL(response.headers.get('location'), url)
      await response.body?.cancel()
      if (target.origin !== origin) throw new Error('Update redirected outside its source')
      url = target.href
      continue
    }
    if (response.url && new URL(response.url).origin !== origin) { await response.body?.cancel(); throw new Error('Update response is outside its source') }
    return response
  }
  throw new Error('Too many update redirects')
}

function parseBlockMap(buffer, bytes) {
  const map = JSON.parse(gunzipSync(buffer, { maxOutputLength: 64 * 1024 * 1024 }))
  const file = map.files?.[0]
  if (!['1', '2'].includes(map.version) || map.files?.length !== 1 || file?.offset !== 0 || !Array.isArray(file.sizes) || !Array.isArray(file.checksums) || file.sizes.length !== file.checksums.length || file.sizes.length > 200000 || file.sizes.some(size => !Number.isSafeInteger(size) || size <= 0) || file.checksums.some(sum => typeof sum !== 'string' || sum.length > 128) || file.sizes.reduce((sum, size) => sum + size, 0) !== bytes) throw new Error('Invalid update block map')
  return map
}

async function fetchBlockMap(fetcher, artifact, signal) {
  const metadata = artifact.blockMap
  if (!metadata || metadata.bytes > 8 * 1024 * 1024) throw new Error('Block map unavailable')
  const response = await sameOriginFetch(fetcher, metadata.url, { signal })
  if (!response.ok || !response.body) throw new Error(`Block map HTTP ${response.status}`)
  const chunks = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > metadata.bytes) throw new Error('Block map too large')
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  if (bytes !== metadata.bytes || crypto.createHash('sha256').update(buffer).digest('hex') !== metadata.sha256) throw new Error('Block map verification failed')
  parseBlockMap(buffer, artifact.bytes)
  return buffer
}

function coalesceDownloads(operations, maxGap = 128 * 1024) {
  const result = []
  let offset = 0
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index]
    const length = operation.end - operation.start
    if (operation.kind === 0) { result.push(operation); offset += length; continue }
    const merged = { kind: 1, start: offset, end: offset + length }
    offset += length
    // Download short unchanged gaps once instead of paying an HTTP round trip per fragment.
    while (index + 1 < operations.length) {
      let next = index + 1, gap = 0
      while (next < operations.length && operations[next].kind === 0) {
        gap += operations[next].end - operations[next].start
        if (gap > maxGap) break
        next++
      }
      if (gap > maxGap || next >= operations.length) break
      offset += gap + operations[next].end - operations[next].start
      merged.end = offset
      index = next
    }
    result.push(merged)
  }
  return result
}

async function differentialDownload({ artifact, base, baseFile, baseMapFile, target, newMap, fetcher, signal, progress = () => {}, log = () => {} }) {
  if (!base?.blockMap || (await fs.promises.stat(baseFile)).size !== base.bytes || await hashFile(baseFile) !== base.sha256) throw new Error('Differential base is unavailable or damaged')
  const oldBuffer = await fs.promises.readFile(baseMapFile)
  if (oldBuffer.length !== base.blockMap.bytes || crypto.createHash('sha256').update(oldBuffer).digest('hex') !== base.blockMap.sha256) throw new Error('Differential base map is damaged')
  const oldMap = parseBlockMap(oldBuffer, base.bytes), nextMap = parseBlockMap(newMap, artifact.bytes)
  if (oldMap.version !== nextMap.version) throw new Error('Block map versions differ')
  const { computeOperations, OperationKind } = require('electron-updater/out/differentialDownloader/downloadPlanBuilder')
  const operations = coalesceDownloads(computeOperations(oldMap, nextMap, { info: log, warn: log }))
  const downloadBytes = operations.filter(op => op.kind === OperationKind.DOWNLOAD).reduce((sum, op) => sum + op.end - op.start, 0)
  if (downloadBytes > artifact.bytes * 0.8 || operations.filter(op => op.kind === OperationKind.DOWNLOAD).length > 256) throw new Error('Full download is more efficient for this update')
  const output = await fs.promises.open(target, 'w', 0o700)
  let loaded = 0, networkBytes = 0
  try {
    for (const operation of operations) {
      signal.throwIfAborted()
      const { start, end, kind } = operation
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > (kind === OperationKind.COPY ? base.bytes : artifact.bytes)) throw new Error('Invalid differential range')
      let input
      if (kind === OperationKind.COPY) input = fs.createReadStream(baseFile, { start, end: end - 1 })
      else {
        const response = await sameOriginFetch(fetcher, artifact.url, { signal, headers: { Range: `bytes=${start}-${end - 1}`, 'Accept-Encoding': 'identity' } })
        if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end - 1}/${artifact.bytes}` || !response.body) { await response.body?.cancel(); throw new Error('Update server does not support exact byte ranges') }
        input = response.body
      }
      let received = 0
      for await (const chunk of input) {
        signal.throwIfAborted()
        received += chunk.length
        if (received > end - start) throw new Error('Differential range exceeded its size')
        await output.writeFile(chunk)
        loaded += chunk.length
        if (kind !== OperationKind.COPY) networkBytes += chunk.length
        progress({ loaded, total: artifact.bytes, networkBytes, downloadBytes, differential: true, percent: Math.floor(loaded / artifact.bytes * 100) })
      }
      if (received !== end - start) throw new Error('Incomplete differential range')
    }
    if (loaded !== artifact.bytes) throw new Error('Incomplete differential package')
    await output.sync()
  } finally { await output.close() }
  if (await hashFile(target) !== artifact.sha256) throw new Error('Differential package verification failed')
  log(`Differential download verified: network=${networkBytes}, reused=${loaded - networkBytes}`)
}

function cacheFiles(root, sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256 || '')) throw new Error('Invalid update cache identity')
  const directory = path.join(root, sha256)
  return { directory, installer: path.join(directory, 'AnyuAgent-Setup.exe'), map: path.join(directory, 'package.blockmap') }
}

module.exports = { sameOriginFetch, parseBlockMap, fetchBlockMap, differentialDownload, cacheFiles, coalesceDownloads }
