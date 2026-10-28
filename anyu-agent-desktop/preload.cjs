const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('anyu', {
  agentCapabilities: { subagents: true, workbench: true, context: true },
  agentContext: (action, payload) => ipcRenderer.invoke('agent:context', action, payload || {}),
  releaseNotes: (acknowledge) => ipcRenderer.invoke('update:release-notes', acknowledge || ''),
  agentWorkbench: (action, payload) => ipcRenderer.invoke('agent:workbench', action, payload || {}),
  onWorkbenchChanged: listener => {
    const handler = (_, payload) => listener(payload)
    ipcRenderer.on('agent:workbench-changed', handler)
    return () => ipcRenderer.removeListener('agent:workbench-changed', handler)
  },
  systemAccessState: () => ipcRenderer.invoke('system:state'),
  agentPermissionState: () => ipcRenderer.invoke('agent:permission-state'),
  onPermissionChanged: listener => {
    const handler = () => listener()
    ipcRenderer.on('agent:permission-changed', handler)
    return () => ipcRenderer.removeListener('agent:permission-changed', handler)
  },
  setAgentPermissionMode: (mode) => ipcRenderer.invoke('agent:set-permission-mode', mode),
  requestSystemElevation: (payload) => ipcRenderer.invoke('system:request-elevation', payload || {}),
  elevationIntent: () => ipcRenderer.invoke('system:elevation-intent'),
  acknowledgeElevation: () => ipcRenderer.invoke('system:acknowledge-elevation'),
  openSystemPrivacySettings: (section) => ipcRenderer.invoke('system:open-privacy-settings', section),
  authState: () => ipcRenderer.invoke('auth:state'),
  restoreAuth: () => ipcRenderer.invoke('auth:restore'),
  refreshAuth: () => ipcRenderer.invoke('auth:refresh'),
  syncAuth: (payload) => ipcRenderer.invoke('auth:sync', payload || {}),
  login: (body) => ipcRenderer.invoke('auth:login', body),
  login2fa: (body) => ipcRenderer.invoke('auth:login2fa', body),
  register: (body) => ipcRenderer.invoke('auth:register', body),
  sendVerifyCode: (body) => ipcRenderer.invoke('auth:send-verify-code', body),
  forgotPassword: (body) => ipcRenderer.invoke('auth:forgot-password', body),
  resetPassword: (body) => ipcRenderer.invoke('auth:reset-password', body),
  publicSettings: () => ipcRenderer.invoke('auth:public-settings'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  paymentQrDataUrl: (value) => ipcRenderer.invoke('payment:qr-data-url', value),
  paymentOpenBrowser: (payload) => ipcRenderer.invoke('payment:open-browser', payload || {}),

  request: (route, options) => ipcRenderer.invoke('api:request', route, options || {}),
  apiStream: (route, options, onDelta) => new Promise((resolve, reject) => {
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const handler = (_, id, delta) => { if (id === streamId) { try { onDelta?.(String(delta || '')) } catch { /* 吐字回调异常不影响请求 */ } } }
    ipcRenderer.on('api:stream-delta', handler)
    ipcRenderer.invoke('api:stream', streamId, route, options || {}).then((result) => {
      ipcRenderer.removeListener('api:stream-delta', handler)
      if (result?.ok) resolve(String(result.text || ''))
      else reject(new Error(result?.error || '流式请求失败'))
    }).catch((error) => {
      ipcRenderer.removeListener('api:stream-delta', handler)
      reject(error)
    })
  }),
  letaAgentBrowserStatus: () => ipcRenderer.invoke('letaAgent:browser-status'),
  letaAgentBrowserLogin: (payload) => ipcRenderer.invoke('letaAgent:browser-login', payload || {}),
  letaAgentBrowserSnapshot: () => ipcRenderer.invoke('letaAgent:browser-snapshot'),
  letaAgentBrowserInput: (payload) => ipcRenderer.invoke('letaAgent:browser-input', payload || {}),
  letaAgentFeedbackCollect: (payload) => ipcRenderer.invoke('letaAgent:feedback-collect', payload || {}),
  letaAgentShopMonitorCollect: (payload) => ipcRenderer.invoke('letaAgent:shop-monitor-collect', payload || {}),
  letaAgentShopMonitorStatus: (taskId) => ipcRenderer.invoke('letaAgent:feedback-status', taskId),
  letaAgentShopAnalysisStarted: (taskId, options = {}) => ipcRenderer.invoke('letaAgent:shop-analysis-started', taskId, options),
  onLetaAgentShopAnalysisProgress: (listener) => {
    const handler = (_, progress) => listener(progress)
    ipcRenderer.on('letaAgent:shop-analysis-progress', handler)
    return () => ipcRenderer.removeListener('letaAgent:shop-analysis-progress', handler)
  },
  letaAgentFeedbackStatus: (taskId) => ipcRenderer.invoke('letaAgent:feedback-status', taskId),
  letaAgentDetailCollect: (payload) => ipcRenderer.invoke('letaAgent:detail-collect', payload || {}),
  letaAgentDetailStatus: (taskId, options = {}) => ipcRenderer.invoke('letaAgent:detail-status', taskId, options),
  letaAgentFeedbackAnalysisStarted: (taskId, prompt) => ipcRenderer.invoke('letaAgent:feedback-analysis-started', taskId, prompt),
  onLetaAgentFeedbackAnalysisProgress: (listener) => {
    const handler = (_, progress) => listener(progress)
    ipcRenderer.on('letaAgent:feedback-analysis-progress', handler)
    return () => ipcRenderer.removeListener('letaAgent:feedback-analysis-progress', handler)
  },
  letaAgentImageAnalysis: (payload) => ipcRenderer.invoke('letaAgent:image-analysis', payload || {}),
  letaAgentTaskStatus: (taskId) => ipcRenderer.invoke('letaAgent:task-status', taskId),
  letaAgentWriteArtifacts: (payload) => ipcRenderer.invoke('letaAgent:write-artifacts', payload || {}),
  skillsGroups: () => ipcRenderer.invoke('anyu:skills-groups'),
  imageCreate: (payload) => ipcRenderer.invoke('anyu:image-create', payload || {}),
  imageTask: (taskId) => ipcRenderer.invoke('anyu:image-task', taskId),
  imageDownload: (taskId, index = 0) => ipcRenderer.invoke('anyu:image-download', taskId, index),
  videoCreate: (payload) => ipcRenderer.invoke('anyu:video-create', payload || {}),
  videoTask: (taskId) => ipcRenderer.invoke('anyu:video-task', taskId),
  videoDownload: (taskId) => ipcRenderer.invoke('anyu:video-download', taskId),
  autoEditAnalyze: (payload) => ipcRenderer.invoke('anyu:auto-edit-analyze', payload || {}),
  autoEdit: (payload) => ipcRenderer.invoke('anyu:auto-edit', payload || {}),
  onAutoEditProgress: (listener) => {
    const handler = (_, progress) => listener(progress)
    ipcRenderer.on('anyu:auto-edit-progress', handler)
    return () => ipcRenderer.removeListener('anyu:auto-edit-progress', handler)
  },
  piKeyModels: (keyId) => ipcRenderer.invoke('pi:key-models', keyId),
  piSaveAttachments: (payload) => ipcRenderer.invoke('pi:save-attachments', payload || {}),
  piAttachments: (sessionPath) => ipcRenderer.invoke('pi:attachments', sessionPath || ''),
  piCreateSession: (payload) => ipcRenderer.invoke('pi:create-session', payload || {}),
  piMaterializeSession: (payload) => ipcRenderer.invoke('pi:materialize-session', payload || {}),
  piSaveMedia: (payload) => ipcRenderer.invoke('pi:save-media', payload || {}),
  piMedia: (sessionPath) => ipcRenderer.invoke('pi:media', sessionPath || ''),
  piSaveOptimisticMessage: (payload) => ipcRenderer.invoke('pi:save-optimistic-message', payload || {}),
  piOptimisticMessage: (sessionPath) => ipcRenderer.invoke('pi:optimistic-message', sessionPath || ''),
  piClearOptimisticMessage: (sessionPath) => ipcRenderer.invoke('pi:clear-optimistic-message', sessionPath || ''),
  piSessionMessages: (sessionPath) => ipcRenderer.invoke('pi:session-messages', sessionPath || ''),
  piSessionAction: (payload) => ipcRenderer.invoke('pi:session-action', payload || {}),
  piForkSession: (payload) => ipcRenderer.invoke('pi:session-fork', payload || {}),
  appBuildInfo: () => ipcRenderer.invoke('app:build-info'),
  apiBase: () => ipcRenderer.invoke('app:api-base'),
  defaultWorkspace: () => ipcRenderer.invoke('app:default-workspace'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  openFile: (payload) => ipcRenderer.invoke('app:open-file', payload || {}),
  openPath: (payload) => ipcRenderer.invoke('app:open-path', payload || {}),
  inspectArtifacts: (payload) => ipcRenderer.invoke('app:inspect-artifacts', payload || {}),
  browserOpenUrl: (url) => ipcRenderer.invoke('agent-browser:open-url', url),
  browserOpenArtifact: (payload) => ipcRenderer.invoke('agent-browser:open-artifact', payload || {}),
  browserSetBounds: (bounds) => ipcRenderer.send('agent-browser:set-bounds', bounds || null),
  browserClose: () => ipcRenderer.invoke('agent-browser:close'),
  browserReload: () => ipcRenderer.invoke('agent-browser:reload'),
  browserBack: () => ipcRenderer.invoke('agent-browser:back'),
  browserForward: () => ipcRenderer.invoke('agent-browser:forward'),
  browserSetZoomFactor: (factor) => ipcRenderer.invoke('agent-browser:set-zoom-factor', factor),
  browserSetZoomMode: (mode) => ipcRenderer.invoke('agent-browser:set-zoom-mode', mode),
  browserState: () => ipcRenderer.invoke('agent-browser:get-state'),
  onBrowserState: (listener) => {
    const handler = (_, event) => listener(event)
    ipcRenderer.on('agent-browser:state', handler)
    return () => ipcRenderer.removeListener('agent-browser:state', handler)
  },
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  updateState: () => ipcRenderer.invoke('update:state'),
  downloadAndInstallUpdate: () => ipcRenderer.invoke('update:download-install'),
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  setUpdateActivity: (busy) => ipcRenderer.send('update:activity', Boolean(busy)),
  openUpdateInstaller: () => ipcRenderer.invoke('update:open-installer'),
  onUpdateProgress: (listener) => {
    const handler = (_, event) => listener(event)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },
  onPluginProgress: (listener) => {
    const handler = (_, event) => listener(event)
    ipcRenderer.on('plugin:progress', handler)
    return () => ipcRenderer.removeListener('plugin:progress', handler)
  },
  piStart: (options) => ipcRenderer.invoke('pi:start', options || {}),
  piStop: (options) => ipcRenderer.invoke('pi:stop', options || {}),
  piCommand: (command) => ipcRenderer.invoke('pi:command', command),
  piListSessions: () => ipcRenderer.invoke('pi:list-sessions'),
  piUiResponse: (response) => ipcRenderer.invoke('pi:ui-response', response),
  agentStart: (payload) => ipcRenderer.invoke('agent:start', payload || {}),
  agentPrompt: (payload) => ipcRenderer.invoke('agent:prompt', payload || {}),
  agentAbort: (payload) => ipcRenderer.invoke('agent:abort', payload || {}),
  agentApprove: (payload) => ipcRenderer.invoke('agent:approve', payload || {}),
  agentEvents: (payload) => ipcRenderer.invoke('agent:events', payload || {}),
  agentSnapshot: (payload) => ipcRenderer.invoke('agent:snapshot', payload || {}),
  agentSessions: () => ipcRenderer.invoke('agent:sessions'),
  onAgentEvent: (listener) => {
    const handler = (_, payload) => listener(payload)
    ipcRenderer.on('agent:event', handler)
    return () => ipcRenderer.removeListener('agent:event', handler)
  },
  chooseDirectory: () => ipcRenderer.invoke('app:choose-directory'),
  chooseFiles: () => ipcRenderer.invoke('app:choose-files'),
  setWindowWidth: (width) => ipcRenderer.invoke('window:set-width', width),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsStoreInstall: (id) => ipcRenderer.invoke('skills:store-install', id),
  skillsRead: (id) => ipcRenderer.invoke('skills:read', id),
  skillsTrainingRead: (id) => ipcRenderer.invoke('skills:training-read', id),
  skillsTrainingSave: (payload) => ipcRenderer.invoke('skills:training-save', payload),
  skillsInstallLocal: () => ipcRenderer.invoke('skills:install-local'),
  pluginState: () => ipcRenderer.invoke('plugin:state'),
  pluginMarketplace: () => ipcRenderer.invoke('plugin:marketplace'),
  pluginPickPackage: () => ipcRenderer.invoke('plugin:pick-package'),
  pluginScan: (sourcePath) => ipcRenderer.invoke('plugin:scan', sourcePath),
  pluginInstallLocal: (payload) => ipcRenderer.invoke('plugin:install-local', payload || {}),
  pluginInstallMarketplace: (payload) => ipcRenderer.invoke('plugin:install-marketplace', payload || {}),
  pluginPublish: (payload) => ipcRenderer.invoke('plugin:publish', payload || {}),
  pluginSetEnabled: (payload) => ipcRenderer.invoke('plugin:set-enabled', payload || {}),
  pluginUninstall: (id) => ipcRenderer.invoke('plugin:uninstall', id),
  pluginRetryDependencies: (id) => ipcRenderer.invoke('plugin:retry-dependencies', id),
  pluginRollback: (payload) => ipcRenderer.invoke('plugin:rollback', payload || {}),
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
