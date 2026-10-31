function normalizeBrowserBounds(rect, contentBounds) {
  const contentWidth = Math.floor(Number(contentBounds?.width))
  const contentHeight = Math.floor(Number(contentBounds?.height))
  const xValue = Number(rect?.x)
  const yValue = Number(rect?.y)
  const widthValue = Number(rect?.width)
  const heightValue = Number(rect?.height)
  if (![contentWidth, contentHeight, xValue, yValue, widthValue, heightValue].every(Number.isFinite)) return null
  if (contentWidth < 1 || contentHeight < 1 || widthValue <= 0 || heightValue <= 0) return null

  // 将渲染层矩形裁剪到窗口内容区，避免缩放期间越界覆盖其他界面。
  const left = Math.max(0, Math.min(contentWidth, Math.floor(xValue)))
  const top = Math.max(0, Math.min(contentHeight, Math.floor(yValue)))
  const right = Math.max(left, Math.min(contentWidth, Math.ceil(xValue + widthValue)))
  const bottom = Math.max(top, Math.min(contentHeight, Math.ceil(yValue + heightValue)))
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function limitBrowserZoom(bounds, value) {
  const factor = Math.max(0.01, Math.min(2, Number(value) || 1))
  if (factor >= 0.25 || !(bounds?.width > 0 && bounds?.height > 0)) return factor
  // Tiny page zoom must not create an enormous emulated canvas/viewport.
  const minimum = Math.min(0.25, Math.max(bounds.width / 4096, bounds.height / 4096,
    Math.sqrt(bounds.width * bounds.height / (8 * 1024 * 1024))))
  return Math.max(factor, Math.ceil(minimum * 10000) / 10000)
}

function calculateBrowserFitZoom(bounds, content, mode = 'fit-width', currentZoom = 1) {
  const values = [bounds?.width, bounds?.height, content?.width, content?.height, currentZoom].map(Number)
  if (!values.every(value => Number.isFinite(value) && value > 0)) return 1
  const [width, height, contentWidth, contentHeight, zoom] = values
  // Leave space for the vertical scrollbar even on fixed-width desktop pages.
  const viewportWidth = Number(content.viewportWidth) || width / zoom
  const viewportHeight = Number(content.viewportHeight) || height / zoom
  const fitWidth = contentWidth > viewportWidth + 1 ? Math.max(1, width - 16) / (contentWidth * zoom) : 1
  const fitHeight = contentHeight > viewportHeight + 1 ? Math.max(1, height - 2) / (contentHeight * zoom) : 1
  const factor = zoom * Math.min(1, fitWidth, mode === 'fit-page' ? fitHeight : 1)
  return limitBrowserZoom(bounds, Math.max(0.01, Math.min(1, Math.floor((factor + 1e-9) * 10000) / 10000)))
}

module.exports = { normalizeBrowserBounds, calculateBrowserFitZoom, limitBrowserZoom }
