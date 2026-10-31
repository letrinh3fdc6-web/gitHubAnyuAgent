(function (root) {
  'use strict'
  const effects = { heart: '♡', spark: '✦', star: '✧', music: '♪', flower: '✿', sleep: 'z', question: '?', surprise: '!', confetti: '▪', drop: '·', puff: '○', idea: '!', book: '▤', pencil: '✎', keyboard: '⌨', search: '⌕', palette: '◉', cup: '☕', cookie: '●', water: '◊', gear: '⚙', check: '✓', moon: '☾' }
  class PetStage {
    constructor(canvas, asset, options = {}) {
      this.canvas = canvas
      this.ctx = canvas.getContext('2d')
      this.options = options
      this.random = options.random || Math.random
      this.remaining = []
      this.lastHoverAt = -Infinity
      this.motionPhase = this.random() * Math.PI * 2
      this.image = new Image()
      this.image.onload = () => { this.prepareHitMask(); this.ready = true; this.playRandom() }
      this.image.onerror = () => options.onError?.('角色资源未能加载')
      this.image.src = asset
      this.started = performance.now()
      this.lastTick = 0
      this.drawCost = 0
      this.activeUntil = 0
      this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      this.loop = this.loop.bind(this)
      this.frame = requestAnimationFrame(this.loop)
      this.idleAt = 0
    }
    play(id) {
      const track = root.AnyuPetBehaviors.all.find(item => item.id === id)
      if (!track) return null
      this.track = track
      this.started = performance.now()
      this.idleAt = this.started + track.duration + (this.reduced ? 1800 : 250 + this.random() * 650)
      this.remaining = this.remaining.filter(item => item.id !== id)
      return track
    }
    playRandom() {
      // Shuffle all behaviors once per cycle so every pose can appear without back-to-back repeats.
      if (!this.remaining.length) {
        this.remaining = [...root.AnyuPetBehaviors.all]
        for (let i = this.remaining.length - 1; i > 0; i--) {
          const j = Math.floor(this.random() * (i + 1))
          ;[this.remaining[i], this.remaining[j]] = [this.remaining[j], this.remaining[i]]
        }
        if (this.remaining.at(-1)?.id === this.track?.id && this.remaining.length > 1) {
          const last = this.remaining.length - 1
          ;[this.remaining[0], this.remaining[last]] = [this.remaining[last], this.remaining[0]]
        }
      }
      return this.play(this.remaining.pop().id)
    }
    interact(kind) {
      if (!this.ready) return null
      const now = performance.now()
      if (kind === 'hover' && now - this.lastHoverAt < 2200) return null
      this.lastHoverAt = now
      this.activeUntil = now + 3000
      const track = this.playRandom()
      this.options.onInteraction?.(track, kind)
      return track
    }
    speaking(value) { this.isSpeaking = value }
    prepareHitMask() {
      // Read alpha once from a small separate surface; keep the animated canvas GPU-backed.
      try {
        const mask = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(320, 576) : document.createElement('canvas')
        mask.width = 320; mask.height = 576
        const context = mask.getContext('2d', { willReadFrequently: true })
        context.drawImage(this.image, 0, 0, 320, 576)
        this.hitMask = context.getImageData(0, 0, 320, 576).data
        // Twelve horizontal strips per pose preserve the silhouette without frame readbacks.
        this.poseRegions = Array.from({ length: 30 }, (_, pose) => {
          const strips = []
          for (let top = 0; top < 96; top += 8) {
            let left = 64, right = -1
            for (let y = top; y < top + 8; y++) for (let x = 0; x < 64; x++) {
              if (this.hitMask[(((Math.floor(pose / 5) * 96 + y) * 320) + (pose % 5) * 64 + x) * 4 + 3] > 0) { left = Math.min(left, x); right = Math.max(right, x) }
            }
            if (right >= left) strips.push({ left: left / 64 - .5, right: (right + 1) / 64 - .5, top: top / 96 - .5, bottom: (top + 8) / 96 - .5 })
          }
          return strips
        })
      } catch { this.hitMask = null }
    }
    loop(now) {
      this.frame = requestAnimationFrame(this.loop)
      const active = this.dragging || this.isSpeaking || now < this.activeUntil
      const fps = this.reduced ? 10 : this.drawCost > 8 ? 15 : active ? 30 : 20
      if (!this.ready || now - this.lastTick < 1000 / fps) return
      this.lastTick = now
      if (now > this.idleAt && !this.isSpeaking && !this.dragging) {
        if (this.busy) {
          const choices = ['think', 'working', 'read', 'listen', 'check'].filter(id => id !== this.track?.id)
          this.play(choices[Math.floor(this.random() * choices.length)])
        } else this.playRandom()
      }
      const started = performance.now()
      this.draw(now)
      this.drawCost = this.drawCost * .9 + (performance.now() - started) * .1
    }
    draw(now) {
      const canvas = this.canvas, ctx = this.ctx
      const width = canvas.clientWidth, height = canvas.clientHeight
      const dpr = Math.min(devicePixelRatio || 1, 2)
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) { canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr) }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const track = this.track || root.AnyuPetBehaviors.actions[0]
      const phase = this.reduced ? 0 : Math.min(1, (now - this.started) / track.duration)
      let index = track.frames.findIndex(frame => frame[0] >= phase)
      if (index < 1) index = 1
      const a = track.frames[index - 1], b = track.frames[index]
      const raw = Math.max(0, Math.min(1, (phase - a[0]) / Math.max(.001, b[0] - a[0])))
      const mix = raw * raw * (3 - 2 * raw)
      const values = a.map((value, i) => i === 6 ? value : value + (b[i] - value) * mix)
      const pose = this.dragging && this.hitTransform ? this.hitTransform.pose : this.isSpeaking ? 29 : values[6]
      const cellW = this.image.width / 5, cellH = this.image.height / 6
      const renderH = height * .78, renderW = renderH * cellW / cellH
      const breathe = this.reduced ? 0 : Math.sin(now / 530 + this.motionPhase)
      const bob = this.reduced ? 0 : this.isSpeaking ? Math.sin(now / 145) * 1.2 : breathe * 1.4
      ctx.save()
      const transform = this.dragging && this.hitTransform ? this.hitTransform : { x: width / 2 + values[1] * width / 280, y: height * .51 + values[2] * height / 330 + bob,
        angle: values[3] * Math.PI / 180, sx: values[4] * (1 + breathe * .004), sy: values[5] * (1 + breathe * .009), renderW, renderH, pose }
      this.hitTransform = transform
      ctx.translate(transform.x, transform.y)
      ctx.rotate(transform.angle)
      ctx.scale(transform.sx, transform.sy)
      ctx.drawImage(this.image, (pose % 5) * cellW, Math.floor(pose / 5) * cellH, cellW, cellH, -renderW / 2, -renderH / 2, renderW, renderH)
      ctx.restore()
      if (track.effect && phase < 1 && !this.reduced) {
        const symbol = effects[track.effect] || '✦'
        const colors = ['#e68e9f', '#dfb460', '#76b5a4', '#9c98c7']
        for (let i = 0; i < 7; i++) {
          const t = (phase * 1.5 + i / 7) % 1
          const angle = i * 2.4
          ctx.globalAlpha = Math.sin(t * Math.PI) * .8
          ctx.fillStyle = colors[i % colors.length]
          ctx.font = `${12 + i % 3 * 4}px sans-serif`
          ctx.fillText(symbol, width / 2 + Math.cos(angle) * (25 + t * 65), height * .5 - t * 110 + Math.sin(angle) * 24)
        }
        ctx.globalAlpha = 1
      }
      this.options.onFrame?.()
    }
    hitRegions() {
      const t = this.hitTransform
      if (!t) return []
      const strips = this.poseRegions?.[t.pose] || [{ left: -.5, right: .5, top: -.5, bottom: .5 }]
      const c = Math.cos(t.angle), s = Math.sin(t.angle)
      const regions = strips.map(rect => {
        const points = [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]].map(([u, v]) => {
          const x = u * t.renderW * t.sx, y = v * t.renderH * t.sy
          return { x: t.x + x * c - y * s, y: t.y + x * s + y * c }
        })
        const xs = points.map(point => point.x), ys = points.map(point => point.y)
        const x = Math.floor(Math.min(...xs) - 6), y = Math.floor(Math.min(...ys) - 6)
        return { x, y, width: Math.ceil(Math.max(...xs) + 6) - x, height: Math.ceil(Math.max(...ys) + 6) - y }
      })
      if (this.track?.effect && !this.reduced) regions.push({ x: this.canvas.clientWidth / 2 - 100, y: this.canvas.clientHeight * .5 - 150, width: 200, height: 190 })
      return regions
    }
    hit(x, y) {
      const t = this.hitTransform
      if (!t || !t.sx || !t.sy) return false
      const dx = x - t.x, dy = y - t.y, c = Math.cos(t.angle), s = Math.sin(t.angle)
      const u = (dx * c + dy * s) / t.sx / t.renderW + .5
      const v = (-dx * s + dy * c) / t.sy / t.renderH + .5
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return false
      if (!this.hitMask) return true
      const px = (t.pose % 5) * 64 + Math.floor(u * 64), py = Math.floor(t.pose / 5) * 96 + Math.floor(v * 96)
      return this.hitMask[(py * 320 + px) * 4 + 3] > 25
    }
    destroy() { cancelAnimationFrame(this.frame); this.image.onload = null }
  }
  root.AnyuPetStage = PetStage
})(window)
