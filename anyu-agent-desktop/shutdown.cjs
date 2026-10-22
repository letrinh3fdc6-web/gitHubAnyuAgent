function installGracefulQuit(app, { stop, beforeStop = () => {}, onError = console.error, timeoutMs = 5000 }) {
  let stopping = false
  let finished = false
  app.on('before-quit', event => {
    if (finished) return
    event.preventDefault()
    if (stopping) return
    stopping = true
    let timer
    const cleanup = Promise.resolve().then(() => {
      beforeStop()
      return stop()
    })
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Desktop shutdown cleanup timed out')), timeoutMs)
    })
    void Promise.race([cleanup, timeout]).catch(onError).finally(() => {
      clearTimeout(timer)
      finished = true
      app.quit()
    })
  })
}

module.exports = { installGracefulQuit }
