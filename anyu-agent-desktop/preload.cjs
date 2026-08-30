const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('anyu', {
  authState: () => ipcRenderer.invoke('auth:state'),
  login: (body) => ipcRenderer.invoke('auth:login', body),
  login2fa: (body) => ipcRenderer.invoke('auth:login2fa', body),
  logout: () => ipcRenderer.invoke('auth:logout'),
  request: (route, options) => ipcRenderer.invoke('api:request', route, options || {}),
  skillsGroups: () => ipcRenderer.invoke('anyu:skills-groups'),
  imageCreate: (payload) => ipcRenderer.invoke('anyu:image-create', payload || {}),
  imageTask: (taskId) => ipcRenderer.invoke('anyu:image-task', taskId),
  imageDownload: (taskId, index = 0) => ipcRenderer.invoke('anyu:image-download', taskId, index),
  videoCreate: (payload) => ipcRenderer.invoke('anyu:video-create', payload || {}),
  videoTask: (taskId) => ipcRenderer.invoke('anyu:video-task', taskId),
  videoDownload: (taskId) => ipcRenderer.invoke('anyu:video-download', taskId),
  piKeyModels: (keyId) => ipcRenderer.invoke('pi:key-models', keyId),
  piSaveAttachments: (payload) => ipcRenderer.invoke('pi:save-attachments', payload || {}),
  piAttachments: (sessionPath) => ipcRenderer.invoke('pi:attachments', sessionPath || ''),
  piMaterializeSession: (payload) => ipcRenderer.invoke('pi:materialize-session', payload || {}),
  piSaveMedia: (payload) => ipcRenderer.invoke('pi:save-media', payload || {}),
  piMedia: (sessionPath) => ipcRenderer.invoke('pi:media', sessionPath || ''),
  piSessionAction: (payload) => ipcRenderer.invoke('pi:session-action', payload || {}),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadAndInstallUpdate: () => ipcRenderer.invoke('update:download-install'),
  onUpdateProgress: (listener) => {
    const handler = (_, event) => listener(event)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },
  piStart: (options) => ipcRenderer.invoke('pi:start', options || {}),
  piStop: () => ipcRenderer.invoke('pi:stop'),
  piCommand: (command) => ipcRenderer.invoke('pi:command', command),
  piListSessions: () => ipcRenderer.invoke('pi:list-sessions'),
  piUiResponse: (response) => ipcRenderer.invoke('pi:ui-response', response),
  chooseDirectory: () => ipcRenderer.invoke('app:choose-directory'),
  onPiEvent: (listener) => {
    const handler = (_, event) => listener(event)
    ipcRenderer.on('pi:event', handler)
    return () => ipcRenderer.removeListener('pi:event', handler)
  },
  onPiStderr: (listener) => {
    const handler = (_, message) => listener(message)
    ipcRenderer.on('pi:stderr', handler)
    return () => ipcRenderer.removeListener('pi:stderr', handler)
  },
  onPiExit: (listener) => {
    const handler = (_, info) => listener(info)
    ipcRenderer.on('pi:exit', handler)
    return () => ipcRenderer.removeListener('pi:exit', handler)
  }
})
