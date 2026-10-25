import http from 'node:http'

export default function anyuSubagents(pi) {
  const port = Number(process.env.ANYU_AGENT_BRIDGE_PORT)
  const token = process.env.ANYU_AGENT_BRIDGE_TOKEN
  if (!port || !token) return
  const child = process.env.ANYU_AGENT_ROLE === 'child'
  const readOnly = process.env.ANYU_AGENT_READ_ONLY === '1'
  const readTools = new Set(['read', 'grep', 'find', 'ls', 'runtime_probe'])

  function request(route, payload, signal) {
    const data = JSON.stringify(payload)
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('任务已停止')); return }
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'X-AnYu-Agent-Token': token } }, res => {
        const chunks = []
        let size = 0
        res.on('data', chunk => { size += chunk.length; if (size > 512000) req.destroy(new Error('子任务结果过大')); else chunks.push(chunk) })
        res.on('error', reject)
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            if (res.statusCode !== 200) reject(new Error(result.error || '代理调度失败'))
            else resolve(result)
          } catch (error) { reject(error) }
        })
      })
      const abort = () => req.destroy(new Error('任务已停止'))
      signal?.addEventListener('abort', abort, { once: true })
      req.on('close', () => signal?.removeEventListener('abort', abort))
      req.on('error', reject)
      req.setTimeout(31 * 60000, () => req.destroy(new Error('代理调度超时')))
      req.end(data)
    })
  }

  if (readOnly) pi.on('session_start', async () => { pi.setActiveTools([...readTools]) })
  pi.on('tool_call', async event => {
    if (['delegate_tasks', 'merge_task', 'retry_task'].includes(event.toolName) && !child) return
    if (readOnly && !readTools.has(event.toolName)) return { block: true, reason: '该子代理仅允许读取与分析' }
    try { await request('/acquire', { toolCallId: event.toolCallId, toolName: event.toolName }) }
    catch (error) { return { block: true, reason: error.message } }
  })
  pi.on('tool_result', async event => {
    if (event.toolName === 'delegate_tasks') return
    await request('/release', { toolCallId: event.toolCallId }).catch(() => {})
  })
  if (child) return

  pi.registerTool({
    name: 'delegate_tasks',
    label: '委派子代理任务',
    description: '将独立任务委派给用户选择的子代理。等待全部结果后返回，由主代理验收。read 仅允许读取分析；execute 可按当前授权修改文件、运行命令。按依赖分批，不允许递归委派。',
    parameters: {
      type: 'object', additionalProperties: false, required: ['tasks'],
      properties: { tasks: { type: 'array', minItems: 1, maxItems: 4, items: {
        type: 'object', additionalProperties: false, required: ['workerId', 'title', 'instructions', 'mode'],
        properties: {
          workerId: { type: 'string', description: '用户配置的执行子代理 ID' },
          title: { type: 'string', maxLength: 100 },
          instructions: { type: 'string', maxLength: 12000, description: '独立完整的目标、上下文、文件范围与验收标准' },
          mode: { type: 'string', enum: ['read', 'execute'] },
          key: { type: 'string', description: 'Unique task key within this batch' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'Keys of prerequisite tasks in this batch' },
          isolate: { type: 'boolean', description: 'Default true: execute in a private workspace copy; review and merge changes after success' },
        },
      } } },
    },
    async execute(_id, params, signal, update) {
      const timer = setInterval(() => { update?.({ content: [{ type: 'text', text: '子代理执行中，等待任务结果。' }], details: { pending: true } }) }, 5000)
      try {
        const results = await request('/delegate', { requestId: _id, tasks: params.tasks }, signal)
        return { content: [{ type: 'text', text: JSON.stringify(results) }], details: results }
      } finally { clearInterval(timer) }
    },
  })
  for (const [name, route] of [['merge_task', '/merge'], ['retry_task', '/retry']]) {
    pi.registerTool({ name, label: name === 'merge_task' ? '合入子任务结果' : '重试失败子任务', description: name === 'merge_task' ? 'Merge a completed isolated task after reviewing its result. Rejects concurrent file edits without overwriting them.' : 'Retry one failed subtask, preserving other successful results.', parameters: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } }, async execute(_id, params, signal) { const value = await request(route, params, signal); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value } } })
  }
}
