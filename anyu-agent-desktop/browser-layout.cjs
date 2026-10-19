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

module.exports = { normalizeBrowserBounds }
