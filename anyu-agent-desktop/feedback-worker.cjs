const { parentPort, workerData } = require('node:worker_threads')
const { pathToFileURL } = require('node:url')

// 后台线程保留采集器执行状态，页面导航不会销毁采集流程。
let counter = 0
let currentUrl = workerData.url
const pending = new Map()
parentPort.on('message', (message) => {
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.url) currentUrl = message.url
  if (message.error) request.reject(Object.assign(new Error(message.error), { code: message.code }))
  else request.resolve(message.value)
})
function rpc(method, args = []) {
  const id = ++counter
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parentPort.postMessage({ type: 'page', id, method, args })
  })
}
function locator(selector, text, index) {
  const query = { selector, text, index }
  return {
    innerText: () => rpc('locator', [query, 'innerText']),
    count: () => rpc('locator', [query, 'count']),
    isVisible: () => rpc('locator', [query, 'isVisible']),
    nth: (i) => locator(selector, text, i),
    evaluateAll: (fn) => rpc('locator', [query, 'evaluateAll', String(fn)]),
    scrollIntoViewIfNeeded: () => rpc('locator', [query, 'scrollIntoViewIfNeeded']),
    click: () => rpc('locator', [query, 'click'])
  }
}
const page = {
  url: () => currentUrl, setDefaultTimeout() {},
  evaluate: (fn, argument) => rpc('evaluate', [String(fn), argument]),
  goto: (url) => rpc('goto', [url]),
  locator: (selector) => locator(selector), getByText: (text) => locator(null, text),
  mouse: { move: (...args) => rpc('move', args), wheel: (...args) => rpc('wheel', args), wheelAt: (...args) => rpc('wheelAt', args) },
  keyboard: { press: (key) => rpc('press', [key]) }
}
;(async () => {
  const collector = await import(pathToFileURL(workerData.script).href)
  const collect = collector.collectTmallDetail || collector.collectTmallShopProducts || collector.collectTmallPublicFeedback
  const result = await collect(page, workerData.url, {
    ...workerData.options,
    onProgress: (progress) => parentPort.postMessage({ type: 'progress', progress })
  })
  parentPort.postMessage({ type: 'result', result })
})().catch((error) => parentPort.postMessage({ type: 'error', error: error.message, code: error.code }))
