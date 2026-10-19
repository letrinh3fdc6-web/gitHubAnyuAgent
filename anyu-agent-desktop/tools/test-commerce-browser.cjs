const assert = require('node:assert/strict')
const vm = require('node:vm')
const {
  searchUrl,
  isSupportedCommerceUrl,
  isSafeCommerceReadUrl,
  redactedText,
  readVisiblePage,
  pageSnapshot,
  runCommerceAction
} = require('../commerce-browser.cjs')

async function main() {
  assert.equal(searchUrl('taobao', '保温杯'), 'https://s.taobao.com/search?q=%E4%BF%9D%E6%B8%A9%E6%9D%AF')
  assert.equal(searchUrl('jd', 'type c'), 'https://search.jd.com/Search?keyword=type%20c&enc=utf-8')
  assert.throws(() => searchUrl('unknown', 'x'), /不支持/)
  assert.throws(() => searchUrl('tmall', '  '), /搜索词/)
  assert.equal(isSupportedCommerceUrl('https://item.jd.com/10001.html'), true)
  assert.equal(isSupportedCommerceUrl('https://jd.com.attacker.test/item'), false)
  assert.equal(isSupportedCommerceUrl('http://s.taobao.com/search?q=x'), false)
  assert.equal(isSupportedCommerceUrl('https://user:pass@tmall.com/item'), false)
  assert.equal(isSafeCommerceReadUrl('https://item.taobao.com/item.htm?id=1'), true)
  assert.equal(isSafeCommerceReadUrl('https://buyer.taobao.com/cart'), false)
  assert.equal(isSafeCommerceReadUrl('https://passport.taobao.com/login'), false)
  assert.match(redactedText('联系 test@example.com 或 13800138000'), /邮箱已隐藏/)
  assert.match(redactedText('联系 test@example.com 或 13800138000'), /手机号已隐藏/)

  const anchor = (text, url, visible = true) => ({
    innerText: text,
    href: url,
    getAttribute: () => text,
    getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: visible ? 20 : 0 })
  })
  const htmlContext = {
    document: {
      title: '搜索结果',
      body: { innerText: '商品标题 ¥29.90 联系 seller@example.com 13800138000' },
      querySelectorAll: () => [
        anchor('商品标题 ￥29.90', 'https://item.taobao.com/item.htm?id=1'),
        anchor('隐藏候选商品', 'https://item.taobao.com/item.htm?id=2', false),
        anchor('个人中心入口', 'https://buyer.taobao.com/cart')
      ]
    },
    location: { href: 'https://s.taobao.com/search?q=item' },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' })
  }
  const visiblePage = vm.runInNewContext(`(${readVisiblePage.toString()})()`, htmlContext)
  assert.equal(visiblePage.links.length, 2, 'page extraction returns only visible DOM links; policy filtering is applied in main process')
  assert.match(visiblePage.text, /¥29\.90/)

  let currentUrl = 'https://s.taobao.com/search?q=item'
  let pageData = { title: '商品搜索', url: currentUrl, text: '商品甲 ¥29.90 联系 seller@example.com 13800138000', links: [
    { text: '商品甲 ¥29.90', url: 'https://item.taobao.com/item.htm?id=1' },
    { text: '购物车', url: 'https://buyer.taobao.com/cart' }
  ] }
  const scripts = []
  const inputs = []
  const webContents = {
    getURL: () => currentUrl,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    executeJavaScriptInIsolatedWorld: async (_world, entries) => {
      scripts.push(entries[0].code)
      if (entries[0].code.includes('width: innerWidth')) return { width: 800, height: 600 }
      if (entries[0].code.includes('Math.max(1, Math.min(innerWidth')) return { x: 460, y: 360 }
      if (entries[0].code.includes('x: innerWidth * 0.58')) return { x: 460, y: 360 }
      return pageData
    },
    sendInputEvent: (event) => inputs.push(event)
  }
  const login = await pageSnapshot({ getURL: () => 'https://passport.taobao.com/login' })
  assert.equal(login.status, 'LOGIN_REQUIRED')
  assert.equal(login.links.length, 0)
  const blocked = await pageSnapshot({ getURL: () => 'https://buyer.taobao.com/cart' })
  assert.equal(blocked.status, 'READ_BLOCKED')
  const snapshot = await pageSnapshot(webContents)
  assert.equal(snapshot.status, 'OK')
  assert.equal(snapshot.links.length, 1)
  assert.match(snapshot.text, /邮箱已隐藏/)
  assert.match(snapshot.text, /手机号已隐藏/)

  const opened = []
  const result = await runCommerceAction({ action: 'search', platform: 'tmall', keyword: '咖啡机' }, {
    getWebContents: () => webContents,
    openUrl: async (url) => { opened.push(url); currentUrl = url; pageData = { ...pageData, url } }
  })
  assert.equal(opened[0], 'https://list.tmall.com/search_product.htm?q=%E5%92%96%E5%95%A1%E6%9C%BA')
  assert.equal(result.url, opened[0])
  const product = await runCommerceAction({ action: 'open_result', index: 0 }, {
    getWebContents: () => webContents,
    openUrl: async (url) => { opened.push(url); currentUrl = url; pageData = { ...pageData, url, title: '商品详情' } }
  })
  assert.equal(opened[1], 'https://item.taobao.com/item.htm?id=1')
  assert.equal(product.title, '商品详情')
  await runCommerceAction({ action: 'scroll', direction: 'down' }, { getWebContents: () => webContents, openUrl: async () => {} })
  assert(inputs.some((event) => event.type === 'mouseWheel'), '淘宝页面滚动必须经过真实滚轮')
  await assert.rejects(runCommerceAction({ action: 'scroll', direction: 'sideways' }, { getWebContents: () => webContents, openUrl: async () => {} }), /方向无效/)
  await assert.rejects(runCommerceAction({ action: 'click' }, { getWebContents: () => webContents, openUrl: async () => {} }), /不支持/)
  assert.ok(scripts.every((code) => !code.includes('seller@example.com')), 'page scripts never embed returned page content')
  const restrictedText = '因访问行为存在异常，使用爬虫工具不当获取平台商业信息，系统将限制账号访问功能。'
  pageData = { ...pageData, text: restrictedText }
  const beforeBlocked = inputs.length
  const restricted = await runCommerceAction({ action: 'scroll', direction: 'down' }, { getWebContents: () => webContents, openUrl: async () => {} })
  assert.equal(restricted.status, 'PLATFORM_RESTRICTED')
  assert.equal(restricted.links.length, 0)
  assert.equal(inputs.length, beforeBlocked)
  const beforeNavigation = opened.length
  const retry = await runCommerceAction({ action: 'search', platform: 'taobao', keyword: '测试' }, {
    getWebContents: () => webContents, openUrl: async (url) => opened.push(url)
  })
  assert.equal(retry.status, 'PLATFORM_RESTRICTED')
  assert.equal(opened.length, beforeNavigation)
  console.log('commerce browser policy and page workflow: passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
