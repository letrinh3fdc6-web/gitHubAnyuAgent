const path = require('node:path')

function allowedBrowserUrl(value) {
  try {
    const url = new URL(String(value || ''))
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return false
    return true
  } catch { return false }
}

function workspaceFile(root, requested) {
  // 先做词法边界检查，调用方还需对真实路径重复检查符号链接。
  const candidate = path.resolve(root, requested)
  const relative = path.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('文件不在当前工作区内')
  return candidate
}

module.exports = { allowedBrowserUrl, workspaceFile }
