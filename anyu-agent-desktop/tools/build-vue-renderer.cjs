const { spawnSync } = require('node:child_process')
const path = require('node:path')

const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..')
const frontendDirectory = path.join(repositoryRoot, 'frontend')
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const environment = { ...process.env, ANYU_ELECTRON_RENDERER_BUILD: '1' }

function run(args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

try {
  run(['--dir', frontendDirectory, 'exec', 'vue-tsc', '--noEmit'])
  run(['--dir', frontendDirectory, 'exec', 'vite', 'build'])
} catch (error) {
  console.error('Unable to start the frontend build:', error.message)
  process.exit(1)
}
