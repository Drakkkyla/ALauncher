const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  loadConfig: () => ipcRenderer.invoke('load-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  selectGamePath: () => ipcRenderer.invoke('select-game-path'),
  connectToServer: (data) => ipcRenderer.invoke('connect-to-server', data),

 
  onAsiLog: (callback) => ipcRenderer.on('asi-log', (_e, msg) => callback(msg)),
  onAsiDone: (callback) => ipcRenderer.on('asi-done', (_e, result) => callback(result)),


  checkAsiInstalled: (fileNames) => ipcRenderer.invoke('check-asi-installed', fileNames),
  downloadAsi: (data) => ipcRenderer.invoke('download-asi', data),
  removeAsi: (data) => ipcRenderer.invoke('remove-asi', data),
  fetchAsiCatalog: (storeUrl) => ipcRenderer.invoke('fetch-asi-catalog', storeUrl),


  fetchSkinReplacements: (storeUrl) => ipcRenderer.invoke('fetch-skin-replacements', storeUrl),
  downloadSkinReplacement: (data) => ipcRenderer.invoke('download-skin-replacement', data),
  checkSkinReplacementInstalled: (data) => ipcRenderer.invoke('check-skin-replacement-installed', data),


  updateDiscordStatus: (status, data) => ipcRenderer.send('discord-status', { status, data }),


  openExternal: (url) => ipcRenderer.invoke('open-external', url),


  getAppVersion: () => ipcRenderer.invoke('get-app-version'),


  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateApply: () => ipcRenderer.send('update-apply'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_e, info) => callback(info)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (_e, data) => callback(data)),
  onUpdateError: (callback) => ipcRenderer.on('update-error', (_e, msg) => callback(msg)),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_e, data) => callback(data)),
});
