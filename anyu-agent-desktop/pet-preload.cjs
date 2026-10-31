const { contextBridge, ipcRenderer, webUtils } = require('electron')
contextBridge.exposeInMainWorld('pet', {
  call: (action, payload = {}) => ipcRenderer.invoke('pet:command', action, payload),
  filePath: file => webUtils.getPathForFile(file),
  onEvent: listener => {
    const handler = (_event, value) => listener(value)
    ipcRenderer.on('pet:event', handler)
    return () => ipcRenderer.removeListener('pet:event', handler)
  },
})
