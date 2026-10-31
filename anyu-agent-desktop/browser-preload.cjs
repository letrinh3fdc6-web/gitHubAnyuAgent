'use strict'
const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  let timer, last = ''
  const measure = () => {
    timer = null
    if (document.hidden) return
    const root = document.documentElement, body = document.body
    const dimensions = [root.scrollWidth, root.scrollHeight, root.clientWidth, innerHeight, body?.scrollWidth, body?.scrollHeight].join(':')
    if (dimensions === last) return
    last = dimensions
    ipcRenderer.send('agent-browser:layout-changed')
  }
  const schedule = () => { if (!timer) timer = setTimeout(measure, 150) }
  const observer = new ResizeObserver(schedule)
  const observe = () => {
    observer.observe(document.documentElement)
    if (document.body) observer.observe(document.body)
    schedule()
  }
  window.addEventListener('resize', schedule)
  window.addEventListener('load', schedule, true)
  document.addEventListener('visibilitychange', schedule)
  document.fonts?.addEventListener('loadingdone', schedule)
  window.addEventListener('pagehide', () => { observer.disconnect(); clearTimeout(timer); timer = null })
  window.addEventListener('pageshow', observe)
  observe()
})
