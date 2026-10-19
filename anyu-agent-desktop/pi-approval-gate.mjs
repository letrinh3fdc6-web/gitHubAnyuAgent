// Tool-level approval gate for AnyuAgent's confirm mode.
//
// pi exposes a `tool_call` extension event before a tool executes. Returning
// `{ block: true }` prevents execution; `ctx.ui.confirm` round-trips through the
// desktop session layer as an `approval.requested` event, so the user sees a
// real Allow/Deny card instead of the tool running silently.

const DANGEROUS_TOOLS = /^(bash|write|edit|apply_patch|str_replace|multi_edit|multiedit|create_file|delete_file|move_file)$/i

function summarize(toolName, input) {
  const value = input && typeof input === 'object' ? input : {}
  if (/^bash$/i.test(toolName)) {
    const command = String(value.command || value.cmd || '').trim()
    return command ? `命令：${command.slice(0, 600)}` : '执行 shell 命令'
  }
  const path = String(value.path || value.file_path || value.filePath || value.file || '').trim()
  if (/^(write|create_file)$/i.test(toolName)) {
    const content = String(value.content || value.text || '')
    return `${path || '工作区文件'}${content ? `（写入 ${content.length} 字符）` : ''}`
  }
  if (/^(edit|apply_patch|str_replace|multi_edit|multiedit)$/i.test(toolName)) {
    return path || '修改工作区文件'
  }
  if (/^(delete_file|move_file)$/i.test(toolName)) {
    return path || '变更工作区文件'
  }
  try {
    return JSON.stringify(value).slice(0, 600)
  } catch {
    return '执行一个有副作用的工具'
  }
}

export default function anyuApprovalGate(pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (String(process.env.ANYU_PERMISSION_MODE || '').toLowerCase() !== 'confirm') return
    const toolName = String(event?.toolName || '')
    if (!DANGEROUS_TOOLS.test(toolName)) return
    const allowed = await ctx.ui.confirm(
      `允许执行 ${toolName}？`,
      summarize(toolName, event?.input),
    )
    if (!allowed) {
      return { block: true, reason: `用户拒绝了 ${toolName} 调用` }
    }
    return undefined
  })
}
