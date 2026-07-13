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
    getHistoryFull: ()      => ipcRenderer.invoke('finances:get-history-full'),
    saveManual:   (payload) => ipcRenderer.invoke('finances:save-manual', payload),
    clearAccount: (id)      => ipcRenderer.invoke('finances:clear-account', id),
    clearAll:     ()        => ipcRenderer.invoke('finances:clear-all'),
    saveProjection:  (payload) => ipcRenderer.invoke('finances:save-projection', payload),
    clearProjection: (id)      => ipcRenderer.invoke('finances:clear-projection', id),
    saveDescription: (payload) => ipcRenderer.invoke('finances:save-description', payload),
    setHidden:    (hidden)  => ipcRenderer.invoke('finances:set-hidden', hidden),
    recordFx:     (ym, rate)=> ipcRenderer.invoke('finances:record-fx', { ym, rate }),
    mongoStatus:  ()        => ipcRenderer.invoke('finances:mongo-status'),
    syncDb:       ()        => ipcRenderer.invoke('finances:sync'),
    listExpenses: ()        => ipcRenderer.invoke('finances:list-expenses'),
    addExpense:   (payload) => ipcRenderer.invoke('finances:add-expense', payload),
    updateExpense:(payload) => ipcRenderer.invoke('finances:update-expense', payload),
    deleteExpense:(id)      => ipcRenderer.invoke('finances:delete-expense', id),
  },

  yify: {
    check:       ()       => ipcRenderer.invoke('yify:check'),
    list:        (params) => ipcRenderer.invoke('yify:list', params),
    details:     (id)     => ipcRenderer.invoke('yify:details', id),
    suggestions: (id)     => ipcRenderer.invoke('yify:suggestions', id),
  },

  stream: {
    start: (magnet) => ipcRenderer.invoke('stream:start', magnet),
    stop:  (hash)   => ipcRenderer.invoke('stream:stop', hash),
    stats: (hash)   => ipcRenderer.invoke('stream:stats', hash),
  },

  subs: {
    search:   (params) => ipcRenderer.invoke('subs:search', params),
    fetch:    (params) => ipcRenderer.invoke('subs:fetch', params),
    download: (params) => ipcRenderer.invoke('subs:download', params),
  },

  favs: {
    ids:    ()      => ipcRenderer.invoke('favs:ids'),
    list:   ()      => ipcRenderer.invoke('favs:list'),
    add:    (movie) => ipcRenderer.invoke('favs:add', movie),
    remove: (id)    => ipcRenderer.invoke('favs:remove', id),
    folders:      ()                => ipcRenderer.invoke('favs:folders'),
    createFolder: (name, parentId)  => ipcRenderer.invoke('favs:folder-create', { name, parentId }),
    renameFolder: (id, name)        => ipcRenderer.invoke('favs:folder-rename', { id, name }),
    deleteFolder: (id)           => ipcRenderer.invoke('favs:folder-delete', id),
    move:         (movieId, folderId) => ipcRenderer.invoke('favs:move', { movieId, folderId }),
  },

  eztv: {
    check:       ()       => ipcRenderer.invoke('eztv:check'),
    list:        (params) => ipcRenderer.invoke('eztv:list', params),
    shows:       (params) => ipcRenderer.invoke('eztv:shows', params),
    searchShows: (query)  => ipcRenderer.invoke('eztv:search-shows', query),
  },

  sfavs: {
    ids:    ()        => ipcRenderer.invoke('sfavs:ids'),
    list:   ()        => ipcRenderer.invoke('sfavs:list'),
    add:    (torrent) => ipcRenderer.invoke('sfavs:add', torrent),
    remove: (id)      => ipcRenderer.invoke('sfavs:remove', id),
  },

  tvmaze: {
    upcoming: () => ipcRenderer.invoke('tvmaze:upcoming'),
  },

  tmdb: {
    tv: (imdbNum) => ipcRenderer.invoke('tmdb:tv', imdbNum),
  },

  reddit: {
    posts: (params) => ipcRenderer.invoke('reddit:posts', params),
  },

  news: {
    posts: (params) => ipcRenderer.invoke('news:posts', params),
  },

  holidays: {
    next: () => ipcRenderer.invoke('holidays:next'),
  },

  games: {
    deals: (params) => ipcRenderer.invoke('games:deals', params),
  },

  github: {
    overview: () => ipcRenderer.invoke('github:overview'),
  },

  stocks: {
    quotes:     ()        => ipcRenderer.invoke('stocks:quotes'),
    setSymbols: (symbols) => ipcRenderer.invoke('stocks:set-symbols', symbols),
  },

  apiStatus: {
    defs:  ()    => ipcRenderer.invoke('api-status:defs'),
    check: (ids) => ipcRenderer.invoke('api-status:check', ids),
  },

  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  resizeContent: (height) => ipcRenderer.send('resize-content', height),
  onWindowMaximized: (cb) => ipcRenderer.on('window-maximized', (_e, isMax) => cb(!!isMax)),
});
