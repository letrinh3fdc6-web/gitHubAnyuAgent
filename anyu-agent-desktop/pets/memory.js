(function (root) {
  'use strict'
  const $ = id => document.getElementById(id)
  class PetMemoryView {
    constructor({ call, icons, name }) {
      Object.assign(this, { call, icons, name })
      this.request = 0
      $('open-memory').onclick = () => { $('memory-title').textContent = `${name}的记忆`; $('memory-dialog').showModal(); void this.load(false, true) }
      $('close-memory').onclick = () => $('memory-dialog').close()
      $('memory-search-form').onsubmit = event => { event.preventDefault(); void this.load() }
      $('memory-more').onclick = () => { void this.load(true) }
      $('memory-folder').onclick = async () => {
        try { await call('memory-directory') } catch (error) { this.error(error) }
      }
      $('memory-save').onclick = async () => {
        $('memory-save').disabled = true
        try {
          const notes = await call('memory-save', { text: $('memory-notes').value, revision: this.revision })
          this.revision = notes.revision; $('memory-feedback').textContent = '已保存，下次对话生效'
        } catch (error) { this.error(error) }
        finally { $('memory-save').disabled = false }
      }
    }
    error(error) { $('memory-feedback').textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
    async load(more = false, notes = false) {
      const request = ++this.request
      $('memory-feedback').textContent = '正在读取记忆…'; $('memory-more').disabled = true
      if (notes) $('memory-save').disabled = true
      try {
        const result = await this.call('memory-read', { query: $('memory-query').value, before: more ? this.next : null })
        if (request !== this.request) return
        if (notes) { $('memory-notes').value = result.notes.text; this.revision = result.notes.revision; $('memory-save').disabled = false }
        $('memory-folder').title = result.directory
        $('memory-total').textContent = `${result.total} 条记录`
        if (!more) $('memory-records').replaceChildren()
        for (const entry of result.messages) {
          const details = document.createElement('details'); details.className = 'memory-record'
          const summary = document.createElement('summary')
          const heading = document.createElement('span'); heading.className = 'memory-record-heading'
          const who = document.createElement('strong'); who.textContent = entry.speakerName
          const source = document.createElement('small'); source.textContent = entry.kind === 'link' ? `与${entry.peerName}连线` : '个人聊天'
          const time = document.createElement('time'); time.textContent = new Date(entry.at).toLocaleString(); time.dateTime = entry.at
          heading.append(who, source, time)
          const preview = document.createElement('span'); preview.className = 'memory-preview'; preview.textContent = entry.text.slice(0, 140)
          summary.append(heading, preview)
          const text = document.createElement('div'); text.className = 'memory-text'; text.textContent = entry.text
          details.append(summary, text); $('memory-records').append(details)
        }
        if (!$('memory-records').children.length) {
          const empty = document.createElement('p'); empty.className = 'memory-empty'; empty.textContent = $('memory-query').value ? '没有匹配的记忆' : '暂无对话记录'; $('memory-records').append(empty)
        }
        this.next = result.next; $('memory-more').hidden = !result.next
        $('memory-feedback').textContent = result.warning || ''
      } catch (error) { if (request === this.request) this.error(error) }
      finally { if (request === this.request) $('memory-more').disabled = false }
    }
  }
  root.AnyuPetMemoryView = PetMemoryView
})(window)
