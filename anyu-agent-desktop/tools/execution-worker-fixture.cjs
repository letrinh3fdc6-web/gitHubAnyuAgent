const { EventEmitter } = require('node:events')
const { runExecutionWorker } = require('../execution-worker.cjs')

const app = new EventEmitter()
app.whenReady = () => Promise.resolve()
app.exit = code => process.exit(code)
runExecutionWorker(app, { isAdministrator: async () => process.env.ANYU_TEST_ADMIN === '1' }).catch(error => {
  console.error(error)
  process.exit(1)
})
