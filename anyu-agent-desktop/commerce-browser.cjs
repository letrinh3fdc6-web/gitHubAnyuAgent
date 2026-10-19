const { electronPage } = require('./electron-page.cjs')
const { isRestrictedNotice, rememberRestriction, RESTRICTED_MESSAGE, assertCommerceAccess } = require('./commerce-access.cjs')

const PLATFORM_SEARCH = Object.freeze({
  taobao: (keyword) => `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`,
  tmall: (keyword) => `https://list.tmall.com/search_product.htm?q=${encodeURIComponent(keyword)}`,
  jd: (keyword) => `https://search.jd.com/Search?keyword=${encodeURIComponent(keyword)}&enc=utf-8`,
  pdd: (keyword) => `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(keyword)}`,
  douyin: (keyword) => `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=general`,
  kuaishou: (keyword) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(keyword)}`,
  '1688': (keyword) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}`,
  xiaohongshu: (keyword) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_search_result_notes`
})

const PLATFORM_HOSTS = Object.freeze({
  taobao: ['taobao.com'],
  tmall: ['tmall.com'],
  jd: ['jd.com'],
  pdd: ['yangkeduo.com', 'pinduoduo.com'],
  douyin: ['douyin.com'],
  kuaishou: ['kuaishou.com'],
  '1688': ['1688.com'],
  xiaohongshu: ['xiaohongshu.com']
})

const SENSITIVE_PATH = /(?:^|\/)(?:login|signin|sign-in|cart|order|orders|pay|checkout|buyer|account|member|my)(?:\/|$)/i
const CHALLENGE_PATH = /(?:captcha|challenge|verify|verification|punish|identity_verify)/i

function blockedPageResult(url, title = '') {
  let parsed = null
  try { parsed = new URL(url) } catch {}
  const hostname = String(parsed?.hostname || '').toLowerCase()
  const pathname = String(parsed?.pathname || '')
  const challenge = CHALLENGE_PATH.test(`${pathname}${parsed?.search || ''}`)
  const login = /(?:^|\.)(?:login|passport)\./i.test(hostname) || /(?:^|\/)(?:login|signin|sign-in)(?:\/|$)/i.test(pathname)
  const status = challenge ? 'CHALLENGE_REQUIRED' : login ? 'LOGIN_REQUIRED' : 'READ_BLOCKED'
  const message = challenge
    ? '平台要求人工完成安全验证，请在右侧浏览器完成后重新读取。'
    : login
      ? '平台要求登录，请在右侧浏览器登录后重新读取。'
      : '当前页面属于账号、购物车、订单或支付区域，自动读取已阻止。请返回公开搜索或商品详情页。'
  return { status, url, title: redactedText(title, 300), message, links: [] }
}

function searchUrl(platform, keyword) {
  const builder = PLATFORM_SEARCH[String(platform || '').trim()]
  const value = String(keyword || '').trim()
  if (!builder) throw new Error('暂不支持该电商平台')
  if (!value || value.length > 200) throw new Error('搜索词必须为 1-200 个字符')
  return builder(value)
}

function isSupportedCommerceUrl(value) {
  let url
  try { url = new URL(String(value || '')) } catch { return false }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  return Object.values(PLATFORM_HOSTS).flat().some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
}

function isSafeCommerceReadUrl(value) {
  if (!isSupportedCommerceUrl(value)) return false
  const url = new URL(value)
  return !SENSITIVE_PATH.test(url.pathname) && !CHALLENGE_PATH.test(`${url.pathname}${url.search}`)
}

function redactedText(value, maxLength = 16000) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已隐藏]')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
}

function readVisiblePage() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }
  const clean = (value, limit) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit)
  return {
    title: clean(document.title, 300),
    url: location.href,
    text: document.body?.innerText || '',
    links: [...document.querySelectorAll('a[href]')]
      .filter((anchor) => visible(anchor))
      .map((anchor) => ({ text: clean(anchor.innerText || anchor.getAttribute('aria-label'), 180), url: anchor.href }))
      .filter((item) => item.text.length >= 5)
      .slice(0, 120)
  }
}

async function waitForPage(webContents, timeoutMs = 14000) {
  if (!webContents.isLoadingMainFrame()) return
  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      webContents.off('did-stop-loading', finish)
      resolve()
    }
    const timer = setTimeout(finish, timeoutMs)
    webContents.once('did-stop-loading', finish)
  })
}

async function pageSnapshot(webContents) {
  const url = webContents.getURL()
  if (!isSupportedCommerceUrl(url)) throw new Error('当前页面不属于支持的国内电商平台')
  if (!isSafeCommerceReadUrl(url)) return blockedPageResult(url)
  try { await assertCommerceAccess(webContents) }
  catch (error) {
    if (error.code === 'PLATFORM_RESTRICTED') return { status: error.code, url, message: error.message, links: [] }
    throw error
  }
  const page = await webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${readVisiblePage.toString()})()` }], true)
  const pageUrl = String(page?.url || url)
  if (!isSafeCommerceReadUrl(pageUrl)) return blockedPageResult(pageUrl, page?.title)
  const pageText = redactedText(page?.text)
  if (isRestrictedNotice(pageText)) {
    rememberRestriction(webContents, pageText)
    return { status: 'PLATFORM_RESTRICTED', url: pageUrl, title: redactedText(page?.title, 300), message: RESTRICTED_MESSAGE, links: [] }
  }
  const visibleGateText = pageText.slice(0, 1800)
  if (/安全验证|滑动验证|拖动滑块|访问验证|请完成验证/i.test(visibleGateText)) {
    return { status: 'CHALLENGE_REQUIRED', url: pageUrl, title: redactedText(page?.title, 300), message: '页面显示安全验证，请在右侧浏览器完成人工操作后重新读取。', links: [] }
  }
  if (/扫码登录|密码登录|手机验证码/i.test(visibleGateText)) {
    return { status: 'LOGIN_REQUIRED', url: pageUrl, title: redactedText(page?.title, 300), message: '页面显示登录提示，请在右侧浏览器完成人工登录后重新读取。', links: [] }
  }
  const links = []
  for (const candidate of Array.isArray(page?.links) ? page.links : []) {
    if (!isSafeCommerceReadUrl(candidate?.url)) continue
    const text = redactedText(candidate?.text, 180)
    if (!text) continue
    if (links.some((link) => link.url === candidate.url)) continue
    links.push({ index: links.length, text, url: candidate.url })
    if (links.length >= 60) break
  }
  return {
    status: 'OK',
    url: pageUrl,
    title: redactedText(page?.title, 300),
    text: pageText,
    links
  }
}

async function runCommerceAction(payload = {}, dependencies = {}) {
  const action = String(payload.action || '').trim()
  const getWebContents = dependencies.getWebContents
  const openUrl = dependencies.openUrl
  if (typeof getWebContents !== 'function' || typeof openUrl !== 'function') throw new Error('电商浏览器尚未就绪')
  if (action === 'search') {
    const url = searchUrl(payload.platform, payload.keyword)
    const webContents = getWebContents()
    const current = await pageSnapshotIfRestricted(webContents)
    if (current) return current
    await openUrl(url)
    await waitForPage(webContents)
    return pageSnapshot(webContents)
  }
  const webContents = getWebContents()
  if (action === 'snapshot') return pageSnapshot(webContents)
  if (action === 'scroll') {
    if (!isSafeCommerceReadUrl(webContents.getURL())) throw new Error('请先打开支持的商品搜索或详情页')
    const direction = String(payload.direction || 'down')
    if (!['up', 'down'].includes(direction)) throw new Error('滚动方向无效')
    const current = await pageSnapshot(webContents)
    if (current.status !== 'OK') return current
    const hostname = new URL(webContents.getURL()).hostname.toLowerCase()
    if (/(?:^|\.)(?:taobao|tmall)\.com$/.test(hostname)) {
      const page = electronPage(webContents, isSafeCommerceReadUrl)
      const point = await page.evaluate(() => ({ x: innerWidth * 0.58, y: innerHeight * 0.62 }))
      await page.mouse.wheelAt(point.x, point.y, direction === 'down' ? 320 : -320)
      await new Promise((resolve) => setTimeout(resolve, 650))
    } else {
      await webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `window.scrollBy({ top: ${direction === 'down' ? 720 : -720}, behavior: 'smooth' })` }], true)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return pageSnapshot(webContents)
  }
  if (action === 'open_result') {
    const snapshot = await pageSnapshot(webContents)
    if (snapshot.status !== 'OK') return snapshot
    const index = Number(payload.index)
    if (!Number.isInteger(index) || index < 0 || index >= snapshot.links.length) throw new Error('商品链接序号无效，请重新读取当前页面')
    const url = snapshot.links[index].url
    if (!isSafeCommerceReadUrl(url)) throw new Error('该链接不支持自动打开')
    await openUrl(url)
    await waitForPage(webContents)
    return pageSnapshot(webContents)
  }
  throw new Error('不支持的电商浏览器操作')
}

async function pageSnapshotIfRestricted(webContents) {
  try { await assertCommerceAccess(webContents); return null }
  catch (error) {
    if (error.code !== 'PLATFORM_RESTRICTED') throw error
    return { status: error.code, url: webContents.getURL(), message: error.message, links: [] }
  }
}

module.exports = {
  PLATFORM_HOSTS,
  searchUrl,
  isSupportedCommerceUrl,
  isSafeCommerceReadUrl,
  redactedText,
  readVisiblePage,
  pageSnapshot,
  runCommerceAction
}
