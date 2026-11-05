'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads')

const MAX_FILE = 20 * 1024 * 1024
const MAX_TEXT = 600000
const WORD_NS = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])

function checkedText(text) {
  text = String(text).replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim()
  if (!text || !/\S/u.test(text)) throw new Error('文件没有可读取的文字。扫描版 PDF 请先做文字识别，或粘贴剧本原文。')
  if (text.length > MAX_TEXT) throw new Error('剧本文字超过 60 万字符，请按集拆分后导入。')
  return text
}

async function extract(file) {
  const bytes = await fs.readFile(file)
  if (bytes.length > MAX_FILE) throw new Error('剧本文件最大 20 MB')
  const format = path.extname(file).toLowerCase().slice(1)
  let text, pages = 0, encoding = 'utf-8'
  if (format === 'pdf') {
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF 文件格式无效')
    const { getDocumentProxy } = await import('unpdf')
    const document = await getDocumentProxy(new Uint8Array(bytes), { isEvalSupported: false, useSystemFonts: true })
    try {
      pages = document.numPages
      if (pages > 500) throw new Error('PDF 超过 500 页，请按集拆分后导入')
      const parts = []; let length = 0
      for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
        const page = await document.getPage(pageNumber)
        const content = await page.getTextContent()
        let line = ''
        for (const item of content.items) {
          if (typeof item.str === 'string') line += item.str + (item.hasEOL ? '\n' : ' ')
        }
        length += line.length
        if (length > MAX_TEXT) throw new Error('PDF 文字过长，请按集拆分后导入')
        parts.push(line.trim())
        page.cleanup()
      }
      text = parts.join('\n\n')
    } finally { await document.loadingTask.destroy() }
  } else if (format === 'docx') {
    const unzipper = require('unzipper')
    const archive = await unzipper.Open.buffer(bytes)
    if (archive.files.length > 5000) throw new Error('Word 文件结构过于复杂')
    const entries = archive.files.filter(entry => entry.path === 'word/document.xml')
    if (entries.length !== 1 || entries[0].uncompressedSize > 8 * 1024 * 1024) throw new Error('Word 文档正文无效或过大')
    const parts = []; let length = 0
    for await (const part of entries[0].stream()) {
      length += part.length
      if (length > 8 * 1024 * 1024) throw new Error('Word 文档正文过大')
      parts.push(part)
    }
    const xml = Buffer.concat(parts)
    if (xml.length > 8 * 1024 * 1024) throw new Error('Word 文档正文过大')
    const { DOMParser } = require('@xmldom/xmldom')
    const document = new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(`Word XML 无效：${message}`) } }).parseFromString(xml.toString('utf8'), 'text/xml')
    if (document.doctype) throw new Error('不支持带外部实体的 Word 文档')
    const paragraphs = []
    function content(node) {
      if (WORD_NS.has(node.namespaceURI)) {
        if (node.localName === 't') return node.textContent || ''
        if (['br', 'cr'].includes(node.localName)) return '\n'
        if (node.localName === 'tab') return '\t'
        if (['del', 'moveFrom'].includes(node.localName)) return ''
      }
      return Array.from(node.childNodes || [], content).join('')
    }
    function visit(node) {
      if (WORD_NS.has(node.namespaceURI) && node.localName === 'p') { paragraphs.push(content(node)); return }
      for (const child of Array.from(node.childNodes || [])) visit(child)
    }
    visit(document)
    text = paragraphs.join('\n')
  } else {
    try {
      encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    } catch {
      encoding = 'gb18030'
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    }
    if (/[\x00-\x08\x0e-\x1f]/.test(text)) throw new Error('文本包含无效控制字符，请另存为 UTF-8 文本')
  }
  text = checkedText(text)
  return { text, format, pages, encoding, paragraphs: text.split(/\n+/).filter(line => line.trim()).length, characters: text.length }
}

async function readCreativeDocument(file, options = {}) {
  const target = await fs.realpath(file)
  const stat = await fs.stat(target)
  if (!stat.isFile() || stat.size > MAX_FILE || !['.txt', '.md', '.docx', '.pdf'].includes(path.extname(target).toLowerCase())) throw new Error('剧本支持 20 MB 以内的 TXT、Markdown、Word 和文字版 PDF')
  if (options.signal?.aborted) throw new Error('导入已取消')
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { file: target }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
    let settled = false
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      void worker.terminate()
      error ? reject(error) : resolve(result)
    }
    const abort = () => finish(new Error('导入已取消'))
    const timer = setTimeout(() => finish(new Error('剧本解析超时，请拆分文件或粘贴文本')), 30000)
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.result))
    worker.once('error', error => finish(error))
    worker.once('exit', code => { if (!settled) finish(new Error(`剧本解析进程提前退出 (${code})`)) })
    options.signal?.addEventListener('abort', abort, { once: true })
  })
}

if (!isMainThread) {
  extract(workerData.file).then(result => parentPort.postMessage({ result }), error => parentPort.postMessage({ error: error.message }))
}

module.exports = { readCreativeDocument, checkedText }
