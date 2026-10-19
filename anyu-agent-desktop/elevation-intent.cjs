const fs = require('fs')
const path = require('path')

// 提权意图落盘文件名。
//
// 为什么必须由主进程写文件：Windows 提权的实现方式是"拉起一个新进程再退出旧进程"，
// 而渲染进程把权限模式写进 localStorage 之后，并无法保证在 app.quit() 之前完成
// LevelDB 落盘。旧实现在 app.quit() 前只留 120ms，一旦提交没赶上，新实例就只看到
// 默认的 auto，表现出来就是"重启了但权限没生效、还得手动再点一次"。
// 因此提权意图必须由主进程同步写文件，作为重启后的唯一权威来源。
const ELEVATION_INTENT_FILE = 'anyu-elevation.json'

// 意图只在一次提权重启的窗口期内有效。避免上一次未被消费的意图在很久以后
// 把用户已经改过的权限模式又强行改回完整访问。
const ELEVATION_INTENT_TTL_MS = 10 * 60 * 1000

// 提权重启时注入的环境变量标记。只说明"本进程是被提权流程拉起的"，
// 不代表已经拿到管理员权限（那必须问系统）。
const ELEVATION_ENV_FLAG = 'ANYU_ELEVATED'

function intentFile(userDataDir) {
  if (!userDataDir) throw new Error('缺少用户数据目录，无法读写提权意图')
  return path.join(userDataDir, ELEVATION_INTENT_FILE)
}

// 归一化权限模式。无法识别时返回 null，语义是"只提权、不改权限模式"。
function normalizePermissionMode(value) {
  const mode = String(value ?? '').toLowerCase()
  return mode === 'full' || mode === 'confirm' || mode === 'auto' ? mode : null
}

// 同步写入提权意图。必须在拉起提权实例之前调用，否则新实例读不到。
function writeIntent(userDataDir, permissionMode, now = Date.now()) {
  const target = intentFile(userDataDir)
  const intent = { permissionMode: normalizePermissionMode(permissionMode), createdAt: Number(now) }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(intent, null, 2), { encoding: 'utf8', mode: 0o600 })
  return intent
}

// 读取提权意图。文件不存在、内容损坏或已过期都返回 null，调用方按"无意图"处理。
function readIntent(userDataDir, now = Date.now()) {
  // 路径解析放在 try 之外：缺少用户数据目录属于调用错误，必须报出来，
  // 不能被"读不到就当作没有意图"吞掉。
  const target = intentFile(userDataDir)
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf8'))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const createdAt = Number(raw.createdAt)
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null
  if (Number(now) - createdAt > ELEVATION_INTENT_TTL_MS) return null
  return { permissionMode: normalizePermissionMode(raw.permissionMode), createdAt }
}

// 清除提权意图。渲染进程确认权限模式已经落地后调用。
function clearIntent(userDataDir) {
  try {
    fs.rmSync(intentFile(userDataDir), { force: true })
    return true
  } catch {
    return false
  }
}

// 是否由本次提权流程拉起（看环境变量，不看权限本身）。
function isElevatedLaunch(env = process.env) {
  return String(env?.[ELEVATION_ENV_FLAG] ?? '') === '1'
}

module.exports = {
  ELEVATION_INTENT_FILE,
  ELEVATION_INTENT_TTL_MS,
  ELEVATION_ENV_FLAG,
  intentFile,
  normalizePermissionMode,
  writeIntent,
  readIntent,
  clearIntent,
  isElevatedLaunch
}
