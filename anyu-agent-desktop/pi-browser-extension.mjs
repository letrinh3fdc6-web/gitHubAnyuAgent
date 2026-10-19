import http from 'node:http'

export default function (pi) {
  function bridgeRequest(route, payload, signal) {
    const port = Number(process.env.LETA_BROWSER_BRIDGE_PORT)
    const token = process.env.LETA_BROWSER_BRIDGE_TOKEN
    if (!port || !token) throw new Error('桌面浏览器尚未就绪')
    const body = JSON.stringify({ ...payload, cwd: payload.cwd || process.cwd() })
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', timeout: 30000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Leta-Token': token } }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (response.statusCode !== 200) { reject(new Error(text || '桌面请求失败')); return }
          try { resolve(JSON.parse(text)) } catch { resolve(text) }
        })
      })
      request.on('error', reject)
      request.on('timeout', () => request.destroy(new Error('桌面请求超时')))
      signal?.addEventListener('abort', () => request.destroy(new Error('操作已取消')), { once: true })
      request.end(body)
    })
  }

  // 浏览器视图由桌面主进程托管；工具只发送受限的打开请求。
  pi.registerTool({
    name: 'browser_open',
    label: '打开右侧浏览器',
    description: '在 LetaAgent 右侧内置浏览器打开网页 URL，或预览当前工作区中的 HTML、图片、PDF 等文件。需要向用户展示可直接操作或查看的页面时使用。',
    promptSnippet: 'Open a website or workspace result in the right-side browser',
    promptGuidelines: ['Use browser_open to show a completed HTML page or website in the right-side preview when it helps the user inspect the result.'],
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'HTTP(S) page URL; specify either url or path' },
        path: { type: 'string', description: 'Workspace-relative or absolute path of an existing previewable file; specify either path or url' }
      },
      additionalProperties: false
    },
    async execute(_id, params, signal, _update, ctx) {
      const url = String(params.url || '').trim()
      const filePath = String(params.path || '').trim()
      if (Boolean(url) === Boolean(filePath)) throw new Error('必须且只能提供 url 或 path')
      await bridgeRequest('/open', { url, path: filePath, cwd: ctx.cwd }, signal)
      return { content: [{ type: 'text', text: `已在右侧浏览器打开：${url || filePath}` }], details: { url: url || undefined, path: filePath || undefined } }
    }
  })

  pi.registerTool({
    name: 'commerce_search',
    label: '搜索国内电商商品',
    description: '使用 LetaAgent 持久内置浏览器搜索淘宝、天猫、京东、拼多多、抖音、快手、1688 或小红书，并返回当前页面可见商品信息。不会加入购物车或下单。',
    promptSnippet: 'Search domestic ecommerce listings in the right-side browser and return visible product evidence',
    promptGuidelines: ['Use only for user-requested product research. Report visible prices as shown and never infer unavailable stock, coupons, or final checkout prices. Ask the user to handle login or security checks in the right-side browser.'],
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['taobao', 'tmall', 'jd', 'pdd', 'douyin', 'kuaishou', '1688', 'xiaohongshu'] },
        keyword: { type: 'string', minLength: 1, maxLength: 200 }
      },
      required: ['platform', 'keyword'],
      additionalProperties: false
    },
    async execute(_id, params, signal, _update, ctx) {
      const result = await bridgeRequest('/commerce', { action: 'search', platform: params.platform, keyword: params.keyword, cwd: ctx.cwd }, signal)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result }
    }
  })

  pi.registerTool({
    name: 'commerce_page',
    label: '读取商品页面',
    description: '读取当前支持的国内电商搜索/商品页、向下滚动或打开搜索结果序号。仅读取可见页面文字和商品链接，不读取 Cookie、密码或支付信息，不可加入购物车或下单。',
    promptSnippet: 'Inspect the current ecommerce search or product page, scroll, or open a visible result by index',
    promptGuidelines: ['Call snapshot after commerce_search and after each navigation. Only open a product result whose visible title matches the user request. If login or a security challenge appears, stop automation and let the user finish it in the right-side browser.'],
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['snapshot', 'scroll', 'open_result'] },
        direction: { type: 'string', enum: ['up', 'down'] },
        index: { type: 'integer', minimum: 0, maximum: 59 }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute(_id, params, signal, _update, ctx) {
      const result = await bridgeRequest('/commerce', { ...params, cwd: ctx.cwd }, signal)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result }
    }
  })

  pi.registerTool({
    name: 'commerce_save_files',
    label: '保存电商分析结果',
    description: '将技能生成的报告、CSV、JSON 或 HTML 保存到当前工作区根目录；文件名和大小由 LetaAgent 主进程校验。',
    promptSnippet: 'Save final ecommerce analysis deliverables in the current workspace',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 105 },
              content: { type: 'string' }
            },
            required: ['name', 'content'],
            additionalProperties: false
          }
        }
      },
      required: ['files'],
      additionalProperties: false
    },
    async execute(_id, params, signal, _update, ctx) {
      const result = await bridgeRequest('/artifacts', { files: params.files, cwd: ctx.cwd }, signal)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], details: result }
    }
  })
}
