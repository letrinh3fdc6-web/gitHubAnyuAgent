const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const archiver = require('archiver')
const { readCreativeDocument } = require('../creative-document.cjs')

async function zip(file, entries) {
  const output = require('node:fs').createWriteStream(file), archive = archiver('zip')
  const done = new Promise((resolve, reject) => { output.once('close', resolve); output.once('error', reject); archive.once('error', reject) })
  archive.pipe(output)
  for (const [name, content] of Object.entries(entries)) archive.append(content, { name })
  await archive.finalize(); await done
}

function pdf(text) {
  const stream = text ? `BT /F1 18 Tf 72 720 Td (${text}) Tj ET` : ''
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let output = '%PDF-1.4\n', offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return output
}

function chinesePDF(text) {
  const characters = [...new Set(text)]
  const hex = value => value.charCodeAt(0).toString(16).padStart(4, '0')
  const mapping = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /ChineseTest def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange ${characters.length} beginbfchar ${characters.map(value => `<${hex(value)}> <${hex(value)}>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`
  const stream = `BT /F1 18 Tf 72 720 Td <${[...text].map(hex).join('')}> Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
    `<< /Length ${Buffer.byteLength(mapping)} >>\nstream\n${mapping}\nendstream`,
  ]
  let output = '%PDF-1.4\n'; const offsets = []
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(output)
  return output + `xref\n0 8\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
}

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anyu-script-document-'))
  try { await run(root) } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
}

test('imports UTF-8 and UTF-16 text without losing Chinese dialogue', async () => fixture(async root => {
  for (const [name, data] of [['script.md', Buffer.from('# 第一集\n安安：我们出发吧。\r\n她推开门。')], ['script.txt', Buffer.concat([Buffer.from([255, 254]), Buffer.from('安安：我们出发吧。', 'utf16le')])]]) {
    const file = path.join(root, name); await fs.writeFile(file, data)
    const result = await readCreativeDocument(file)
    assert.ok(result.text.includes('安安：我们出发吧。'))
    assert.ok(!result.text.includes('\r'))
  }
}))

test('imports real DOCX paragraphs, tabs, line breaks and accepted revisions with structured XML parsing', async () => fixture(async root => {
  const file = path.join(root, 'script.docx')
  await zip(file, { 'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一集 &amp; 序章</w:t></w:r></w:p><w:p><w:r><w:t>安安：</w:t><w:tab/><w:t>我们出发吧。</w:t><w:br/><w:t>她推开门。</w:t></w:r><w:del><w:r><w:delText>已删除的台词</w:delText></w:r></w:del><w:ins><w:r><w:t>晨光涌入。</w:t></w:r></w:ins></w:p></w:body></w:document>' })
  const result = await readCreativeDocument(file)
  assert.equal(result.format, 'docx')
  assert.match(result.text, /第一集 & 序章\n安安：\t我们出发吧。\n她推开门。晨光涌入。/)
  assert.ok(!result.text.includes('已删除'))
}))

test('extracts a real PDF in a worker and reports empty scanned-style PDFs honestly', async () => fixture(async root => {
  const file = path.join(root, 'script.pdf'); await fs.writeFile(file, pdf('Scene 1: The journey begins.'))
  const result = await readCreativeDocument(file)
  assert.equal(result.pages, 1); assert.match(result.text, /The journey begins/)
  const empty = path.join(root, 'scan.pdf'); await fs.writeFile(empty, pdf(''))
  await assert.rejects(readCreativeDocument(empty), /扫描版 PDF|没有可读取的文字/)
}))

test('extracts Chinese dialogue with a PDF Unicode map and imports legacy Chinese text encodings', async () => fixture(async root => {
  const sentence = '安安：我们明天去看看。'
  const file = path.join(root, '中文剧本.pdf'); await fs.writeFile(file, chinesePDF(sentence))
  const result = await readCreativeDocument(file)
  assert.equal(result.pages, 1)
  assert.equal(result.text.replace(/\s/g, ''), sentence)
  const legacy = path.join(root, 'gb18030.txt'); await fs.writeFile(legacy, Buffer.from('b0b2b0b2', 'hex'))
  const decoded = await readCreativeDocument(legacy)
  assert.equal(decoded.encoding, 'gb18030'); assert.equal(decoded.text, '安安')
  const bigEndian = path.join(root, 'utf16be.txt')
  const bytes = Buffer.from(sentence, 'utf16le'); bytes.swap16()
  await fs.writeFile(bigEndian, Buffer.concat([Buffer.from([0xfe, 0xff]), bytes]))
  assert.equal((await readCreativeDocument(bigEndian)).text, sentence)
}))

test('aborting an active worker does not poison the next import', async () => fixture(async root => {
  const file = path.join(root, 'script.pdf'); await fs.writeFile(file, chinesePDF('安安：我们明天去看看。'))
  const abort = new AbortController()
  const pending = readCreativeDocument(file, { signal: abort.signal })
  setTimeout(() => abort.abort(), 5)
  await assert.rejects(pending, /取消/)
  assert.match((await readCreativeDocument(file)).text, /明天去看看/)
}))

test('rejects invalid formats, malformed XML, external entities and cancelled imports', async () => fixture(async root => {
  const binary = path.join(root, 'script.exe'); await fs.writeFile(binary, 'text')
  await assert.rejects(readCreativeDocument(binary), /TXT/)
  const external = path.join(root, 'external.docx')
  await zip(external, { 'word/document.xml': '<!DOCTYPE document [<!ENTITY leak SYSTEM "file:///etc/passwd">]><document>&leak;</document>' })
  await assert.rejects(readCreativeDocument(external), /XML|实体/)
  const invalid = path.join(root, 'invalid.docx'); await zip(invalid, { 'word/document.xml': '<unclosed>' })
  await assert.rejects(readCreativeDocument(invalid), /XML/)
  const file = path.join(root, 'script.txt'); await fs.writeFile(file, 'not empty')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(readCreativeDocument(file, { signal: abort.signal }), /取消/)
}))
