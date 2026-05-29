const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  fetchSystem: () => ipcRenderer.invoke('fetch-system'),
  fetchWeather: () => ipcRenderer.invoke('fetch-weather'),
  fetchAIUsage: () => ipcRenderer.invoke('fetch-ai-usage'),
  runSpeedtest: () => ipcRenderer.invoke('run-speedtest'),
  getSpeedtestHistory: () => ipcRenderer.invoke('get-speedtest-history'),
  resetSpeedtestHistory: () => ipcRenderer.invoke('reset-speedtest-history'),
  onSpeedtestProgress: (cb) => ipcRenderer.on('speedtest-progress', (_e, p) => cb(p)),

  getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
  saveApiKeys: (keys) => ipcRenderer.invoke('save-api-keys', keys),

  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

  sendUsage:       (data) => ipcRenderer.send('usage-updated',        data),
  sendCodexUsage:  (data) => ipcRenderer.send('codex-usage-updated',  data),
  sendElevenUsage: (data) => ipcRenderer.send('eleven-usage-updated', data),
  onRefresh:       (cb)   => ipcRenderer.on('trigger-refresh', cb),

  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  resizeContent: (height) => ipcRenderer.send('resize-content', height),
});
