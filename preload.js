const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  fetchSystem: () => ipcRenderer.invoke('fetch-system'),
  fetchWeather: () => ipcRenderer.invoke('fetch-weather'),
  fetchMarkets: () => ipcRenderer.invoke('fetch-markets'),
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

  finances: {
    getState:     ()        => ipcRenderer.invoke('finances:get-state'),
    getHistory:   ()        => ipcRenderer.invoke('finances:get-history'),
    saveManual:   (payload) => ipcRenderer.invoke('finances:save-manual', payload),
    clearAccount: (id)      => ipcRenderer.invoke('finances:clear-account', id),
    clearAll:     ()        => ipcRenderer.invoke('finances:clear-all'),
    setHidden:    (hidden)  => ipcRenderer.invoke('finances:set-hidden', hidden),
    listExpenses: ()        => ipcRenderer.invoke('finances:list-expenses'),
    addExpense:   (payload) => ipcRenderer.invoke('finances:add-expense', payload),
    updateExpense:(payload) => ipcRenderer.invoke('finances:update-expense', payload),
    deleteExpense:(id)      => ipcRenderer.invoke('finances:delete-expense', id),
  },

  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  minimize: () => ipcRenderer.send('window-minimize'),
  close: () => ipcRenderer.send('window-close'),
  resizeContent: (height) => ipcRenderer.send('resize-content', height),
});
