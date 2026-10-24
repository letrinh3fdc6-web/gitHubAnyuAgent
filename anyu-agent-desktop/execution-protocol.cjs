const MAX_FRAME_BYTES = 2 * 1024 * 1024
const CHUNK_BYTES = 48 * 1024
const WORKER_FLAG = '--anyu-execution-worker'

function send(socket, message, callback) {
  if (!socket || socket.destroyed) {
    callback?.(new Error('管理员执行进程已断开'))
    return false
  }
  return socket.write(`${JSON.stringify(message)}\n`, callback)
}

function receive(socket, onMessage, onError) {
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    let end
    try {
      while ((end = buffer.indexOf('\n')) !== -1) {
        if (end > MAX_FRAME_BYTES) throw new Error('执行进程消息超过限制')
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        onMessage(JSON.parse(line))
      }
      if (buffer.length > MAX_FRAME_BYTES) throw new Error('执行进程消息超过限制')
    } catch (error) { onError(error); socket.destroy() }
  })
}

module.exports = { send, receive, CHUNK_BYTES, WORKER_FLAG }
