const fs = require('fs')
const path = require('path')
const os = require('os')
const archiver = require('archiver')

const root = path.resolve(__dirname, '..')
const outputRoot = path.join(root, 'dist', 'skills')
const backendAssetRoot = path.resolve(root, '..', '..', '..', 'backend', 'internal', 'skillmarket', 'assets')
const skillIds = ['tmall-public-feedback-analysis', 'ai-image-analysis']

async function packageSkill(id) {
  const source = path.join(root, 'skills', id)
  const manifest = JSON.parse(await fs.promises.readFile(path.join(source, 'anyu-plugin.json'), 'utf8'))
  const outputPath = path.join(outputRoot, `${id}-${manifest.version}.anyu-plugin.zip`)
  await fs.promises.mkdir(outputRoot, { recursive: true })
  // 开发目录只作为发布素材；下载包由服务端持有，桌面安装包不携带技能文件。
  const staging = await fs.promises.mkdtemp(path.join(os.tmpdir(), `leta-skill-${id}-`))
  const packageRoot = path.join(staging, id)
  const packageSkillRoot = path.join(packageRoot, 'skills', id)
  await fs.promises.mkdir(packageSkillRoot, { recursive: true })
  manifest.skills = manifest.skills.map((skill) => ({ ...skill, path: `skills/${id}` }))
  await fs.promises.writeFile(path.join(packageRoot, 'anyu-plugin.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  await fs.promises.copyFile(path.join(source, 'SKILL.md'), path.join(packageSkillRoot, 'SKILL.md'))
  for (const directory of ['scripts', 'prompts', 'styles']) {
    const candidate = path.join(source, directory)
    if (fs.existsSync(candidate)) await fs.promises.cp(candidate, path.join(packageSkillRoot, directory), { recursive: true })
  }
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath, { mode: 0o600 })
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(packageRoot, false)
    archive.finalize().catch(reject)
  }).finally(() => fs.rmSync(staging, { recursive: true, force: true }))
  return outputPath
}

Promise.all(skillIds.map(packageSkill)).then(async (files) => {
  // 在主仓库构建时同步服务端嵌入资源，保持目录摘要与实际下载包一致。
  if (fs.existsSync(backendAssetRoot)) {
    await Promise.all(files.map((file) => fs.promises.copyFile(file, path.join(backendAssetRoot, path.basename(file)))))
  }
  process.stdout.write(`${files.join('\n')}\n`)
}).catch((error) => {
  process.stderr.write(`${error.message || error}\n`)
  process.exitCode = 1
})
