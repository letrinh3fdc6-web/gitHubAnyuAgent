const assert = require('node:assert/strict')
const vm = require('node:vm')
const { assertCommerceAccess, isRestrictedNotice, pageRestrictionText } = require('../commerce-access.cjs')

async function main() {
  const notice = '访问行为存在异常。使用爬虫工具、违规浏览器插件不当获取平台商业信息，系统将限制账号访问功能。'
  assert.equal(isRestrictedNotice(notice), true)
  assert.equal(isRestrictedNotice('商品介绍：请勿使用爬虫工具。'), false)
  assert.equal(isRestrictedNotice('系统公告：正常访问'), false)
  const node = (text, display = 'block') => ({
    innerText: text,
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    display
  })
  const visible = node('商品标题')
  const hidden = node(notice, 'none')
  const extracted = vm.runInNewContext(`(${pageRestrictionText.toString()})()`, {
    document: { body: { innerText: visible.innerText }, querySelectorAll: () => [hidden] },
    getComputedStyle: (element) => ({ display: element.display, visibility: 'visible' })
  })
  assert.equal(isRestrictedNotice(extracted), false)
  let reads = 0
  const webContents = {
    getURL: () => 'https://shop481715268.taobao.com/category.htm',
    executeJavaScriptInIsolatedWorld: async () => { reads++; return notice }
  }
  await assert.rejects(assertCommerceAccess(webContents), (error) => error.code === 'PLATFORM_RESTRICTED')
  await assert.rejects(assertCommerceAccess(webContents), (error) => error.code === 'PLATFORM_RESTRICTED')
  assert.equal(reads, 1, 'restriction must remain latched without re-reading the page')
  console.log('commerce access: visible notice, false positives and sticky stop passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
