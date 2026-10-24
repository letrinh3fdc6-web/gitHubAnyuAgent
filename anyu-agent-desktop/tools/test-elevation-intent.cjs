const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  ELEVATION_INTENT_FILE,
  ELEVATION_INTENT_TTL_MS,
  ELEVATION_ENV_FLAG,
  normalizePermissionMode,
  writeIntent,
  readIntent,
  clearIntent,
  isElevatedLaunch
} = require('../elevation-intent.cjs')

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anyu-elevation-'))

async function main() {
  try {
    // 权限模式归一化：只认三种模式，其余一律视为"只提权、不改模式"
    assert.strictEqual(normalizePermissionMode('full'), 'full')
    assert.strictEqual(normalizePermissionMode('CONFIRM'), 'confirm')
    assert.strictEqual(normalizePermissionMode('auto'), 'auto')
    assert.strictEqual(normalizePermissionMode(''), null)
    assert.strictEqual(normalizePermissionMode(undefined), null)
    assert.strictEqual(normalizePermissionMode('danger-full-access'), null)
    console.log('elevation intent permission mode normalization: passed')

    // 未写入时读取必须是 null，代表"没有提权意图"
    assert.strictEqual(readIntent(workDir), null)
    console.log('elevation intent missing file: passed')

    // 完整访问意图可以同步落盘并被读回
    const written = writeIntent(workDir, 'full', 1_000_000)
    assert.strictEqual(written.permissionMode, 'full')
    assert.strictEqual(readIntent(workDir, 1_000_001).permissionMode, 'full')
    // 文件必须真的落在磁盘上：重启后的新进程只能靠它恢复状态
    assert.ok(fs.existsSync(path.join(workDir, ELEVATION_INTENT_FILE)), '提权意图必须同步落盘')
    console.log('elevation intent full access round trip: passed')

    // 只提权、不改权限模式
    writeIntent(workDir, '', 1_000_000)
    assert.strictEqual(readIntent(workDir, 1_000_001).permissionMode, null, '未指定模式时应记为不改权限')
    console.log('elevation intent elevate only: passed')

    // 过期意图失效，避免很久以后把用户改过的模式又改回完整访问
    writeIntent(workDir, 'full', 1_000_000)
    assert.strictEqual(readIntent(workDir, 1_000_000 + ELEVATION_INTENT_TTL_MS + 1), null, '过期意图必须失效')
    assert.strictEqual(readIntent(workDir, 1_000_000 + ELEVATION_INTENT_TTL_MS - 1).permissionMode, 'full')
    console.log('elevation intent expiry: passed')

    // 损坏内容不能让应用崩，只能当作没有意图
    fs.writeFileSync(path.join(workDir, ELEVATION_INTENT_FILE), 'not-json')
    assert.strictEqual(readIntent(workDir), null)
    fs.writeFileSync(path.join(workDir, ELEVATION_INTENT_FILE), JSON.stringify({ permissionMode: 'full' }))
    assert.strictEqual(readIntent(workDir), null, '缺少 createdAt 的记录必须被拒绝')
    fs.writeFileSync(path.join(workDir, ELEVATION_INTENT_FILE), JSON.stringify(['full']))
    assert.strictEqual(readIntent(workDir), null, '非对象记录必须被拒绝')
    console.log('elevation intent corrupted file: passed')

    // 清除之后不得再读回，否则下次启动会凭空套用完整访问
    writeIntent(workDir, 'full', 1_000_000)
    assert.strictEqual(clearIntent(workDir), true)
    assert.strictEqual(readIntent(workDir, 1_000_001), null)
    assert.strictEqual(clearIntent(workDir), true, '重复清除必须幂等')
    console.log('elevation intent clear: passed')

    // 环境标记只说明"被提权流程拉起"，不代表已拿到管理员权限
    assert.strictEqual(isElevatedLaunch({ [ELEVATION_ENV_FLAG]: '1' }), true)
    assert.strictEqual(isElevatedLaunch({ [ELEVATION_ENV_FLAG]: 'true' }), false)
    assert.strictEqual(isElevatedLaunch({}), false)
    assert.strictEqual(isElevatedLaunch(undefined), false)
    console.log('elevation launch flag: passed')

    // 没有用户数据目录时必须显式报错，而不是写到当前工作目录
    assert.throws(() => writeIntent('', 'full'), /缺少用户数据目录/)
    assert.throws(() => readIntent(''), /缺少用户数据目录/)
    console.log('elevation intent requires user data dir: passed')

    // Renderer state and UAC behavior are covered by test-permission-no-restart
    // and test-vue-permission, using the canonical execution-host API.
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
