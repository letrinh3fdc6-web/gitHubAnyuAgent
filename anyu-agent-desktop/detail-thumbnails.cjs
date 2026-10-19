const { BrowserWindow } = require('electron')

let previewWindow = null
let previewQueue = Promise.resolve()

async function decodeDetailImage(image) {
  const dataUrl = String(image?.dataUrl || '')
  if (!/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(dataUrl) || dataUrl.length > 17 * 1024 * 1024) return null
  if (!previewWindow || previewWindow.isDestroyed()) {
    // 独立沙箱仅解码本地图片，不访问 CDN、Cookie 或主窗口上下文。
    previewWindow = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'leta-detail-image-decoder' } })
    await previewWindow.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; connect-src \'none\'"><title>Image Decoder</title>'))
  }
  let timer
  try {
    const result = await Promise.race([
      previewWindow.webContents.executeJavaScriptInIsolatedWorld(1002, [{ code: `(${async (source) => {
        const image = new Image()
        image.src = source
        await image.decode()
        const width = image.naturalWidth, height = image.naturalHeight
        if (!width || !height || width * height > 32 * 1024 * 1024) return null
        const encode = (edge, quality) => {
          const scale = Math.min(1, edge / Math.max(width, height))
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(width * scale))
          canvas.height = Math.max(1, Math.round(height * scale))
          const context = canvas.getContext('2d', { alpha: false })
          context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          return canvas.toDataURL('image/jpeg', quality)
        }
        const thumbnailDataUrl = encode(240, 0.65)
        if (thumbnailDataUrl.length > 90000) return null
        const generationDataUrl = /^data:image\/avif;/i.test(source) ? encode(3072, 0.9) : ''
        return { thumbnailDataUrl, width, height, ...(generationDataUrl ? { generationDataUrl } : {}) }
      }})(${JSON.stringify(dataUrl)})` }]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('图片解码超时')), 15000) })
    ])
    return result
  } catch {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy()
    previewWindow = null
    return null
  } finally { clearTimeout(timer) }
}

function detailThumbnail(image) {
  // 多个历史任务恢复也串行解码，防止长图并发产生内存峰值。
  const job = previewQueue.then(() => decodeDetailImage(image), () => decodeDetailImage(image))
  previewQueue = job.catch(() => null)
  return job
}

module.exports = { detailThumbnail }
