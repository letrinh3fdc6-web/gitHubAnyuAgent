const { setTimeout: delay } = require('node:timers/promises')
const { assertCommerceAccess } = require('./commerce-access.cjs')

// 适配原采集器使用的 Page 接口；脚本只能在浏览器沙箱中读取和操作页面。
function electronPage(webContents, allowedUrl, signal) {
  function check() {
    if (signal?.aborted || webContents.isDestroyed()) throw new Error('采集已取消或浏览器已关闭')
    if (!allowedUrl(webContents.getURL())) throw new Error(`采集浏览器已离开淘宝/天猫页面（当前地址：${webContents.getURL() || '未知'}），请重新运行技能`)
  }
  async function evaluate(fn, argument) {
    check()
    await assertCommerceAccess(webContents)
    check()
    return webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${fn})(${JSON.stringify(argument) ?? 'undefined'})` }], true)
  }
  async function movePointer(x, y) {
    check()
    if (![x, y].every(Number.isFinite)) throw new Error('浏览器坐标无效')
    const bounds = await evaluate(() => ({ width: innerWidth, height: innerHeight }))
    const clamp = (value, limit) => Math.max(2, Math.min(Math.max(2, limit - 3), Math.round(value)))
    const target = { x: clamp(x, bounds.width), y: clamp(y, bounds.height) }
    // 仅移动到已定位的内容区域，不增加无目标轨迹或点击。
    check()
    webContents.sendInputEvent({ type: 'mouseMove', ...target })
    await delay(100, undefined, { signal })
    return target
  }
  function locator(selector, text, index = null) {
    const query = { selector, text, index }
    async function operate(action, fn) {
      if (action === 'all') {
        check()
        await assertCommerceAccess(webContents)
        check()
        return webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${fn})([...document.querySelectorAll(${JSON.stringify(selector)})])` }], true)
      }
      return evaluate(({ query, action, source }) => {
        const nodes = [...document.querySelectorAll(query.selector || 'body *')].filter((node) => {
          if (query.text == null) return true
          return (node.textContent || '').trim() === query.text && ![...node.children].some((child) => (child.textContent || '').trim() === query.text)
        })
        if (action === 'count') return nodes.length
        if (action === 'visible') {
          const node = nodes[query.index ?? 0]
          if (!node) return false
          const box = node.getBoundingClientRect(), style = getComputedStyle(node)
          return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
        }
        const node = nodes[query.index ?? 0]
        if (!node) throw new Error('页面元素不存在')
        if (action === 'text') return node.innerText || ''
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden') throw new Error('页面元素不可见')
        if (action === 'scroll') node.scrollIntoView({ block: 'center' })
        if (action === 'click') node.scrollIntoView({ block: 'center' })
        return true
      }, { query, action, source: fn ? String(fn) : '' })
    }
    return {
      innerText: () => operate('text'), count: () => operate('count'), isVisible: () => operate('visible'),
      nth: (i) => locator(selector, text, i), evaluateAll: (fn) => operate('all', fn),
      scrollIntoViewIfNeeded: () => operate('scroll'), async click() {
        await operate('click')
        const point = await evaluate(({ query }) => {
          const nodes = [...document.querySelectorAll(query.selector || 'body *')].filter((node) => {
            if (query.text == null) return true
            return (node.textContent || '').trim() === query.text && ![...node.children].some((child) => (child.textContent || '').trim() === query.text)
          })
          const node = nodes[query.index ?? 0], box = node?.getBoundingClientRect()
          if (!box || !box.width || !box.height) return null
          const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2
          const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2
          const hit = document.elementFromPoint(x, y)
          return hit && (hit === node || node.contains(hit)) ? { x, y } : null
        }, { query })
        if (!point) throw new Error('页面元素不存在')
        const target = await movePointer(point.x, point.y)
        await delay(120, undefined, { signal })
        await assertCommerceAccess(webContents)
        check()
        const stillVisible = await evaluate(({ x, y, query }) => {
          const nodes = [...document.querySelectorAll(query.selector || 'body *')].filter((node) => {
            if (query.text == null) return true
            return (node.textContent || '').trim() === query.text && ![...node.children].some((child) => (child.textContent || '').trim() === query.text)
          })
          const node = nodes[query.index ?? 0], hit = document.elementFromPoint(x, y)
          return Boolean(node && hit && (hit === node || node.contains(hit)))
        }, { ...target, query })
        if (!stillVisible) throw new Error('页面元素已变化，请重新定位')
        webContents.sendInputEvent({ type: 'mouseDown', ...target, button: 'left', clickCount: 1 })
        try { await delay(50, undefined, { signal }) }
        finally { if (!webContents.isDestroyed()) webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 }) }
        return true
      }
    }
  }
  return {
    url: () => webContents.getURL(), evaluate,
    setDefaultTimeout() {}, locator: (selector) => locator(selector),
    getByText: (text) => locator(null, text),
    async goto(url) {
      if (!allowedUrl(url)) throw new Error('采集仅允许淘宝/天猫页面')
      if (signal?.aborted || webContents.isDestroyed()) throw new Error('采集已取消')
      await assertCommerceAccess(webContents)
      // Electron 的 loadURL 会在站点重定向或页面再次导航时抛出 ERR_ABORTED；
      // 只需等待目标页面的 DOM 就绪，不能把加载中的重定向误判为采集失败。
      if (webContents.getURL() === url && !webContents.isLoadingMainFrame()) return
      await new Promise((resolve, reject) => {
        let settled = false
        const cleanup = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          webContents.off('dom-ready', ready)
          webContents.off('did-fail-load', failed)
          webContents.off('destroyed', abort)
        }
        const finish = (error) => {
          if (settled) return
          settled = true; cleanup()
          if (error) reject(error); else resolve()
        }
        const abort = () => finish(new Error('采集已取消或浏览器已关闭'))
        const ready = () => {
          if (allowedUrl(webContents.getURL())) finish()
        }
        const failed = (_, code, description, _validatedUrl, isMainFrame) => {
          if (isMainFrame !== false && code !== -3) finish(new Error(description || '商品页面加载失败'))
        }
        const timer = setTimeout(() => finish(new Error('商品页面加载超时，请确认网络后重试')), 90000)
        signal?.addEventListener('abort', abort, { once: true })
        webContents.on('dom-ready', ready)
        webContents.on('did-fail-load', failed)
        webContents.on('destroyed', abort)
        if (webContents.getURL() === url && !webContents.isLoadingMainFrame()) ready()
        else if (webContents.getURL() !== url) {
          void webContents.loadURL(url).catch((error) => {
            if (!/ERR_ABORTED|\(-3\)/i.test(String(error?.message || error))) finish(error)
          })
        }
      })
      check()
    },
    mouse: { move: movePointer, async wheelAt(x, y, delta) {
      check()
      // 在商品区发送真实滚轮事件，触发站点的 wheel/scroll 和懒加载监听。
      const point = await evaluate(({ x, y }) => ({ x: Math.max(1, Math.min(innerWidth - 2, Math.round(x))), y: Math.max(1, Math.min(innerHeight - 2, Math.round(y))) }), { x, y })
      const target = await movePointer(point.x, point.y)
      await delay(150, undefined, { signal })
      await assertCommerceAccess(webContents)
      check()
      const amount = Math.max(-600, Math.min(600, Number(delta) || 0))
      webContents.sendInputEvent({ type: 'mouseWheel', ...target, deltaX: 0, deltaY: -amount, canScroll: true })
      await delay(250, undefined, { signal })
    }, async wheel(_x, y) {
      const point = await evaluate(() => ({ x: innerWidth * 0.6, y: innerHeight * 0.6 }))
      await this.wheelAt(point.x, point.y, y)
    } },
    keyboard: { async press(key) {
      check()
      await assertCommerceAccess(webContents)
      if (key !== 'Escape') throw new Error('不支持的采集按键')
      webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    } }
  }
}

module.exports = { electronPage }
