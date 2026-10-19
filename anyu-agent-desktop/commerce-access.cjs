// 同一 WebContents 的限制状态跨技能保留，关闭提示框不能触发自动重试。
const restrictedPages = new WeakMap()
const RESTRICTED_MESSAGE = '平台已提示账号访问受限，已停止自动采集；本次不再自动重试，请在平台安全中心处理后再使用。'

function isRestrictedNotice(text) {
  const compact = String(text || '').replace(/\s+/g, '')
  return /(?:访问行为存在异常|异常访问行为|访问异常)/.test(compact) && /(?:不当获取|爬虫工具|违规浏览器插件|平台商业信息)/.test(compact)
    || /系统将限制.{0,20}访问功能|(?:账户|账号).{0,16}(?:已被限制访问|访问功能已受限)/.test(compact)
}

function pageRestrictionText() {
  const visible = (node) => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node)
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  }
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="modal" i],[class*="dialog" i]')]
    .filter(visible).slice(0, 20).map((node) => String(node.innerText || '').slice(0, 4000)).join('\n')
  const text = String(document.body?.innerText || '')
  return `${dialogs}\n${text.slice(0, 12000)}\n${text.slice(-6000)}`
}

function rememberRestriction(webContents, text) {
  if (isRestrictedNotice(text)) restrictedPages.set(webContents, RESTRICTED_MESSAGE)
  return restrictedPages.get(webContents) || ''
}

async function assertCommerceAccess(webContents) {
  const known = restrictedPages.get(webContents)
  if (known) throw Object.assign(new Error(known), { code: 'PLATFORM_RESTRICTED' })
  let url
  try { url = new URL(webContents.getURL()) } catch { return }
  if (!/(^|\.)(taobao|tmall)\.com$/i.test(url.hostname)) return
  const text = await webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${pageRestrictionText})()` }], true)
  const message = rememberRestriction(webContents, text)
  if (message) throw Object.assign(new Error(message), { code: 'PLATFORM_RESTRICTED' })
}

module.exports = { assertCommerceAccess, isRestrictedNotice, rememberRestriction, pageRestrictionText, RESTRICTED_MESSAGE }
