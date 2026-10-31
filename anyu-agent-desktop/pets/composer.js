(function (root) {
  'use strict'
  const $ = id => document.getElementById(id)
  class PetComposer {
    constructor({ call, icons, showError }) {
      Object.assign(this, { call, icons, showError })
      this.references = []
      this.skills = []
      this.matches = []
      this.index = 0
      this.mention = null
      this.loading = null
      $('message').addEventListener('input', () => this.updateMention())
      $('message').addEventListener('click', () => this.updateMention())
      $('mention-skill').onclick = () => {
        const field = $('message'), at = field.selectionStart
        const prefix = at && !/\s/.test(field.value[at - 1]) ? ' @' : '@'
        field.setRangeText(prefix, at, field.selectionEnd, 'end'); field.focus(); this.updateMention()
      }
      $('attach').onclick = () => { this.closeSkills(); $('attachment-menu').hidden = !$('attachment-menu').hidden }
      $('attach-image').onclick = () => { $('attachment-menu').hidden = true; $('files').click() }
      for (const kind of ['file', 'folder']) $(`attach-${kind}`).onclick = async () => {
        $('attachment-menu').hidden = true
        try { this.add(await call('choose-references', { kind })) } catch (error) { showError(error) }
      }
      document.addEventListener('pointerdown', event => {
        if (!$('composer').contains(event.target)) { this.closeSkills(); $('attachment-menu').hidden = true }
      })
      $('message').setAttribute('aria-autocomplete', 'list')
    }
    add(references) {
      const key = value => navigator.platform.startsWith('Win') ? value.toLowerCase() : value
      const all = new Map(this.references.map(item => [key(item.path), item]))
      for (const item of references) all.set(key(item.path), item)
      if (all.size > 20) { this.showError('每条消息最多引用 20 个文件或文件夹'); return }
      this.references = [...all.values()]; this.renderReferences()
    }
    restore(references) { this.references = references.map(item => ({ ...item })); this.renderReferences() }
    clear() { this.references = []; this.renderReferences(); this.closeSkills(); $('attachment-menu').hidden = true }
    renderReferences() {
      $('references').replaceChildren()
      for (const item of this.references) {
        const chip = document.createElement('span'); chip.className = 'reference-chip'; chip.title = item.path
        const icon = document.createElement('i'); icon.dataset.lucide = item.kind === 'folder' ? 'folder' : 'file'
        const label = document.createElement('span'); label.textContent = item.name
        const remove = document.createElement('button'); remove.type = 'button'; remove.title = `移除 ${item.name}`; remove.setAttribute('aria-label', remove.title)
        const close = document.createElement('i'); close.dataset.lucide = 'x'; remove.append(close)
        remove.onclick = () => { this.references = this.references.filter(reference => reference !== item); this.renderReferences() }
        chip.append(icon, label, remove); $('references').append(chip)
      }
      this.icons()
    }
    async drop(items) {
      const references = []
      for (const item of items) {
        const file = item.getAsFile(), entry = item.webkitGetAsEntry?.()
        if (!file || file.type.startsWith('image/')) continue
        const path = root.pet.filePath(file)
        if (path) references.push({ path, kind: entry?.isDirectory ? 'folder' : 'file' })
      }
      if (references.length) this.add(await this.call('references', { references }))
    }
    updateMention() {
      const field = $('message'), cursor = field.selectionStart
      const match = field.value.slice(0, cursor).match(/(^|\s)@([\p{L}\p{N}_-]*)$/u)
      if (!match) { this.closeSkills(); return }
      const opening = !this.mention
      this.mention = { start: cursor - match[2].length - 1, end: cursor, query: match[2].toLowerCase() }
      this.index = 0; $('attachment-menu').hidden = true
      if (opening) void this.loadSkills()
      this.renderSkills()
    }
    async loadSkills() {
      if (this.loading) return this.loading
      this.skillError = ''
      this.loading = this.call('skills')
      this.renderSkills()
      try { this.skills = await this.loading } catch (error) { this.skillError = '技能加载失败'; this.showError(error) }
      finally { this.loading = null; this.renderSkills() }
    }
    renderSkills() {
      if (!this.mention) return
      const list = $('skill-menu'), query = this.mention.query
      this.matches = this.skills.filter(skill => [skill.id, skill.name, skill.description].some(text => String(text || '').toLowerCase().includes(query))).slice(0, 30)
      this.index = Math.max(0, Math.min(this.index, this.matches.length - 1))
      list.replaceChildren(); list.hidden = false
      $('message').setAttribute('aria-controls', 'skill-menu'); $('mention-skill').setAttribute('aria-expanded', 'true')
      if (!this.matches.length) {
        const empty = document.createElement('p'); empty.className = 'skill-empty'
        empty.textContent = this.loading ? '正在读取技能…' : this.skillError || (this.skills.length ? '没有匹配的技能' : '尚未安装技能')
        list.append(empty); $('message').removeAttribute('aria-activedescendant')
      }
      this.matches.forEach((skill, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'skill-option'; button.id = `pet-skill-${index}`
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === this.index)); button.title = skill.description || skill.name
        const name = document.createElement('strong'); name.textContent = skill.name || skill.id
        const description = document.createElement('small'); description.textContent = skill.description || `@${skill.id}`
        button.append(name, description)
        button.onpointerdown = event => event.preventDefault()
        button.onclick = () => this.choose(skill)
        list.append(button)
      })
      if (this.matches.length) {
        $('message').setAttribute('aria-activedescendant', `pet-skill-${this.index}`)
        $(`pet-skill-${this.index}`).scrollIntoView({ block: 'nearest' })
      }
    }
    choose(skill) {
      if (!this.mention) return
      const field = $('message')
      field.setRangeText(`@${skill.id} `, this.mention.start, this.mention.end, 'end')
      this.closeSkills(); field.focus()
    }
    closeSkills() {
      this.mention = null; $('skill-menu').hidden = true
      $('message').removeAttribute('aria-activedescendant'); $('message').removeAttribute('aria-controls'); $('mention-skill').setAttribute('aria-expanded', 'false')
    }
    keydown(event) {
      if (event.isComposing || event.keyCode === 229) return true
      if (event.key === 'Escape') { this.closeSkills(); $('attachment-menu').hidden = true; return true }
      if (!this.mention) return false
      if (['ArrowDown', 'ArrowUp'].includes(event.key) && this.matches.length) {
        event.preventDefault(); this.index = (this.index + (event.key === 'ArrowDown' ? 1 : -1) + this.matches.length) % this.matches.length; this.renderSkills(); return true
      }
      if (['Enter', 'Tab'].includes(event.key)) {
        if (this.matches.length) { event.preventDefault(); this.choose(this.matches[this.index]); return true }
        if (this.loading && event.key === 'Enter') { event.preventDefault(); return true }
      }
      return false
    }
  }
  root.AnyuPetComposer = PetComposer
})(window)
