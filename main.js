const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');

const { loadConfig, saveConfig } = require('./config');
const systemStats = require('./systemStats');
const { fetchWeather } = require('./weather');
const { fetchMarkets } = require('./markets');
const { runSpeedtest } = require('./speedtest');
const speedtestHistory = require('./speedtestHistory');
const { readLocalUsage } = require('./localUsage');
const finances = require('./finances');

let win = null;
let tray = null;
let latestUsage = null;
let latestCodex = null;
let latestEleven = null;
let isQuitting = false;
const startHidden = process.argv.includes('--hidden');

// ── Window scaling (corner-drag zoom) ──────────────────────────
// The widget lays out at a fixed CSS width (BASE_WIDTH) and auto-fits its
// height to the content. Dragging a corner scales the *whole* widget while
// keeping proportions: we map the window width to a zoom factor and let an
// enforced aspect ratio carry the height along. The CSS viewport therefore
// always stays BASE_WIDTH wide × content tall, so nothing reflows or scrolls.
const BASE_WIDTH = 820;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.0;
let zoom = 1;
let lastContentHeight = 720; // CSS px (zoom-independent), reported by renderer
let applyingSize = false;    // re-entrancy guard for setContentSize → 'resize'
let zoomSaveTimer = null;
let preMaximize = null;      // saved {cw, ch, px, py, zoom} while fit-to-monitor is active

const clampZoom = (z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z || 1));

// Resize the window to the current content height at the current zoom, and
// pin the aspect ratio so the OS keeps proportions during a manual drag.
function applyContentSize() {
  if (!win) return;
  const w = Math.round(BASE_WIDTH * zoom);
  const h = Math.max(1, Math.round(lastContentHeight * zoom));
  applyingSize = true;
  try {
    win.setContentSize(w, h);
    win.setAspectRatio(w / h); // = BASE_WIDTH / lastContentHeight (zoom cancels)
  } finally {
    applyingSize = false;
  }
}

// User dragged a corner: derive the zoom from the new width and scale content.
// The aspect ratio (set above) already keeps the height proportional, so the
// CSS viewport stays BASE_WIDTH × lastContentHeight and the content fits exactly.
function onWindowResize() {
  if (applyingSize || !win || preMaximize) return; // ignore drags while maximized
  const [w] = win.getContentSize();
  const z = clampZoom(w / BASE_WIDTH);
  if (Math.abs(z - zoom) < 0.005) return;
  zoom = z;
  try { win.webContents.setZoomFactor(zoom); } catch {}
  clearTimeout(zoomSaveTimer);
  zoomSaveTimer = setTimeout(() => { try { saveConfig({ widgetZoom: zoom }); } catch {} }, 400);
}

// "Maximize": make the window cover the whole work area of the current monitor.
// The widget is taller than the screen and portrait, so preserving its aspect
// would only shrink it; instead we drop the zoom to 1 and let the 820px layout
// widen to the full monitor width (the renderer enables vertical scroll while
// maximized). Toggles back to the previous size + position on a second call.
function toggleMaximize() {
  if (!win) return;
  if (preMaximize) { restoreFromMaximize(); return; }
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const [cw, ch] = win.getContentSize();
  const [px, py] = win.getPosition();
  preMaximize = { cw, ch, px, py, zoom };
  zoom = 1;
  applyingSize = true;
  try {
    win.setMaximumSize(wa.width, wa.height); // lift the corner-drag width cap
    win.setAspectRatio(0);                   // drop the proportion lock
    win.setContentSize(wa.width, wa.height);
    win.setPosition(wa.x, wa.y);
    win.webContents.setZoomFactor(1);
  } finally { applyingSize = false; }
  try { win.webContents.send('window-maximized', true); } catch {}
}

function restoreFromMaximize() {
  if (!win || !preMaximize) return;
  const { cw, ch, px, py, zoom: z } = preMaximize;
  preMaximize = null;
  zoom = clampZoom(z);
  applyingSize = true;
  try {
    win.setMaximumSize(Math.round(BASE_WIDTH * MAX_ZOOM), 32000); // restore the corner-drag width cap (height effectively unlimited; 0 would clamp height to the minimum)
    win.setAspectRatio(cw / ch);
    win.setContentSize(cw, ch);
    win.setPosition(px, py);
    win.webContents.setZoomFactor(zoom);
  } finally { applyingSize = false; }
  try { win.webContents.send('window-maximized', false); } catch {}
  applyContentSize();
}

// ── PNG encoder (no deps) ──────────────────────────────────────
// Builds a 32x32 RGBA PNG with two horizontal bars reflecting Claude
// session % (top) and weekly % (bottom). Same approach as CC_usage_widget.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgbaRowsWithFilter) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(rgbaRowsWithFilter);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function colorForPct(pct) {
  if (pct == null) return [120, 120, 130];
  if (pct >= 75) return [239, 68, 68];
  if (pct >= 50) return [250, 204, 21];
  return [74, 222, 128];
}

function buildTrayIcon(sessionPct, weekPct) {
  const size = 32;
  const rowSize = 1 + size * 4;
  const raw = Buffer.alloc(rowSize * size);
  const empty = [60, 60, 70, 200];

  for (let y = 0; y < size; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * rowSize + 1 + x * 4;
      raw[i + 3] = 0;
    }
  }

  const drawBar = (yStart, yEnd, pct) => {
    const [r, g, b] = colorForPct(pct);
    const barStart = 2, barEnd = size - 2;
    const barWidth = barEnd - barStart;
    const fillPx = pct == null ? 0 : Math.max(1, Math.round(barWidth * pct / 100));
    for (let y = yStart; y < yEnd; y++) {
      for (let x = barStart; x < barEnd; x++) {
        const i = y * rowSize + 1 + x * 4;
        const filled = (x - barStart) < fillPx;
        if (filled) { raw[i] = r; raw[i+1] = g; raw[i+2] = b; raw[i+3] = 255; }
        else { raw[i] = empty[0]; raw[i+1] = empty[1]; raw[i+2] = empty[2]; raw[i+3] = empty[3]; }
      }
    }
  };

  drawBar(6, 14, sessionPct);
  drawBar(18, 26, weekPct);

  return encodePng(size, size, raw);
}

// ── AI usage fetchers (bundled in ./fetchers) ──────────────────
function runFetcher(scriptName) {
  return new Promise((resolve) => {
    const fetcherPath = path.join(__dirname, 'fetchers', scriptName);
    if (!fs.existsSync(fetcherPath)) return resolve(null);
    const child = spawn('node', [fetcherPath], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env },
    });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.on('close', () => {
      try {
        const data = JSON.parse(stdout);
        resolve(data && data.error ? null : data);
      } catch { resolve(null); }
    });
    child.on('error', () => resolve(null));
    setTimeout(() => { try { child.kill(); } catch {} }, 40000);
  });
}

async function fetchAIUsage() {
  const [claude, codex, eleven, local] = await Promise.all([
    runFetcher('claudeFetcher.js'),
    runFetcher('codexFetcher.js'),
    runFetcher('elevenLabsFetcher.js'),
    readLocalUsage().catch(() => null),
  ]);
  return { claude, codex, eleven, local, available: true };
}

// ── Tray ───────────────────────────────────────────────────────
function showWindow() {
  if (!win) { createWindow(); return; }
  win.show();
  win.focus();
}

function updateTray() {
  if (!tray) return;

  const s   = latestUsage?.session?.pct;
  const w   = latestUsage?.weekAll?.pct;
  const ws  = latestUsage?.weekSonnet?.pct;
  const e   = latestUsage?.extra;
  const cx5 = latestCodex?.session5h?.pct;
  const cxw = latestCodex?.weekly?.pct;
  const elc = latestEleven?.characters;
  const elPct = elc?.pct;

  tray.setImage(nativeImage.createFromBuffer(buildTrayIcon(s ?? null, w ?? null)));

  const tipLines = ['System Dashboard'];
  tipLines.push('— Claude —');
  tipLines.push(s != null ? `Session: ${s}%` : 'Session: —');
  tipLines.push(w != null ? `Week (all): ${w}%` : 'Week (all): —');
  if (ws != null) tipLines.push(`Week (Sonnet): ${ws}%`);
  if (e) tipLines.push(`Extra: ${e.pct}% ($${e.spent} / $${e.total})`);
  if (cx5 != null || cxw != null) {
    tipLines.push('— Codex —');
    if (cx5 != null) tipLines.push(`5h limit: ${cx5}%`);
    if (cxw != null) tipLines.push(`Weekly: ${cxw}%`);
  }
  if (elPct != null) {
    tipLines.push('— ElevenLabs —');
    tipLines.push(`Chars: ${elPct}% (${elc.used}/${elc.limit})`);
  }
  tray.setToolTip(tipLines.join('\n'));

  const menu = Menu.buildFromTemplate([
    { label: 'Claude', enabled: false },
    { label: s != null ? `  Session  ${s}%` : '  Session  —', enabled: false },
    { label: w != null ? `  Week (all)  ${w}%` : '  Week (all)  —', enabled: false },
    ...(ws != null ? [{ label: `  Week (Sonnet)  ${ws}%`, enabled: false }] : []),
    ...(e ? [{ label: `  Extra  ${e.pct}%  ($${e.spent}/$${e.total})`, enabled: false }] : []),
    ...(cx5 != null || cxw != null ? [
      { type: 'separator' },
      { label: 'Codex', enabled: false },
      ...(cx5 != null ? [{ label: `  5h limit  ${cx5}%`, enabled: false }] : []),
      ...(cxw != null ? [{ label: `  Weekly  ${cxw}%`, enabled: false }] : []),
    ] : []),
    ...(elPct != null ? [
      { type: 'separator' },
      { label: `ElevenLabs${latestEleven?.tier ? `  ·  ${latestEleven.tier}` : ''}`, enabled: false },
      { label: `  Chars  ${elPct}%  (${elc.used}/${elc.limit})`, enabled: false },
    ] : []),
    { type: 'separator' },
    { label: 'Show widget', click: () => showWindow() },
    { label: 'Refresh now', click: () => { if (win) win.webContents.send('trigger-refresh'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => {
        isQuitting = true;
        try { if (tray) tray.destroy(); } catch {}
        try { if (win) win.destroy(); } catch {}
        app.exit(0);
      } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(buildTrayIcon(null, null)));
  tray.setToolTip('System Dashboard — loading…');
  tray.on('click', () => {
    if (!win) { createWindow(); return; }
    if (win.isVisible()) win.hide(); else showWindow();
  });
  updateTray();
}

// ── Window ─────────────────────────────────────────────────────
function createWindow() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  zoom = clampZoom(loadConfig().widgetZoom);
  const initialW = Math.round(BASE_WIDTH * zoom);
  const initialH = Math.round(lastContentHeight * zoom);
  win = new BrowserWindow({
    width: initialW,
    height: initialH,
    x: Math.max(20, screenW - initialW - 20),
    y: 20,
    useContentSize: true,
    show: !startHidden,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    minWidth: Math.round(BASE_WIDTH * MIN_ZOOM),
    maxWidth: Math.round(BASE_WIDTH * MAX_ZOOM),
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAspectRatio(initialW / initialH);
  win.loadFile('index.html');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // setZoomFactor resets on every load, so (re)apply it once the page is ready.
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.setZoomFactor(zoom); } catch {}
  });
  win.on('resize', onWindowResize);
  win.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });
}

// ── IPC ────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('fetch-system', () => systemStats.snapshot());
ipcMain.handle('fetch-weather', async () => {
  try {
    return await fetchWeather(loadConfig().weather);
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('fetch-ai-usage', () => fetchAIUsage());
ipcMain.handle('fetch-markets', async () => {
  try {
    return await fetchMarkets();
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('run-speedtest', async (event) => {
  try {
    const result = await runSpeedtest({
      onProgress: (p) => {
        try { event.sender.send('speedtest-progress', p); } catch {}
      },
    });
    const history = speedtestHistory.record(result);
    return { result, history };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('get-speedtest-history', () => speedtestHistory.read());
ipcMain.handle('reset-speedtest-history', () => speedtestHistory.reset());

// ── Tray usage push (from renderer) ────────────────────────────
ipcMain.on('usage-updated',        (_e, data) => { latestUsage  = data; updateTray(); });
ipcMain.on('codex-usage-updated',  (_e, data) => { latestCodex  = data; updateTray(); });
ipcMain.on('eleven-usage-updated', (_e, data) => { latestEleven = data; updateTray(); });

// ── API keys ───────────────────────────────────────────────────
ipcMain.handle('get-api-keys', () => {
  const cfg = loadConfig();
  const list = Array.isArray(cfg.apiKeys) ? cfg.apiKeys.slice() : [];
  if (cfg.elevenLabsApiKey && !list.some(k => (k.name || '').toLowerCase() === 'elevenlabs')) {
    list.unshift({ id: 'elevenlabs-legacy', name: 'ElevenLabs', key: cfg.elevenLabsApiKey });
  }
  return list;
});
ipcMain.handle('save-api-keys', (_event, keys) => {
  const list = Array.isArray(keys) ? keys.filter(k => k && k.name && k.key) : [];
  const cfg = loadConfig();
  const patch = { apiKeys: list };
  const eleven = list.find(k => (k.name || '').toLowerCase() === 'elevenlabs');
  if (eleven) patch.elevenLabsApiKey = eleven.key;
  else if (cfg.elevenLabsApiKey) patch.elevenLabsApiKey = '';
  saveConfig(patch);
  return list;
});

// ── Finanzas ───────────────────────────────────────────────────
ipcMain.handle('finances:get-state', () => finances.getState());
ipcMain.handle('finances:get-history', () => finances.getHistory());
ipcMain.handle('finances:save-manual', (_e, { accountId, uyu, usd }) =>
  finances.saveManual(accountId, uyu, usd));
ipcMain.handle('finances:clear-account', (_e, accountId) => finances.clearAccount(accountId));
ipcMain.handle('finances:clear-all', () => finances.clearAll());
ipcMain.handle('finances:set-hidden', (_e, hidden) => finances.setHidden(hidden));
ipcMain.handle('finances:record-fx', (_e, { ym, rate }) => finances.recordFx(ym, rate));
ipcMain.handle('finances:mongo-status', () => finances.getMongoStatus());
ipcMain.handle('finances:sync', () => finances.syncNow());
ipcMain.handle('finances:list-expenses', () => finances.listExpenses());
ipcMain.handle('finances:add-expense', (_e, payload) => finances.addExpense(payload));
ipcMain.handle('finances:update-expense', (_e, payload) => finances.updateExpense(payload));
ipcMain.handle('finances:delete-expense', (_e, id) => finances.deleteExpense(id));

// Open a URL in the user's default browser (used by the Finanzas account links).
ipcMain.handle('open-external', (_e, url) => {
  try {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  } catch {}
  return { ok: true };
});

// ── Auto-launch ────────────────────────────────────────────────
function loginItemOptions(extra = {}) {
  if (app.isPackaged) {
    return { args: ['--hidden'], ...extra };
  }
  return {
    path: process.execPath,
    args: [path.resolve(__dirname), '--hidden'],
    ...extra,
  };
}
ipcMain.handle('get-auto-launch', () => {
  try {
    return !!app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  } catch { return false; }
});
ipcMain.handle('set-auto-launch', (_event, enabled) => {
  try {
    app.setLoginItemSettings(loginItemOptions({ openAtLogin: !!enabled }));
    return !!app.getLoginItemSettings(loginItemOptions()).openAtLogin;
  } catch { return false; }
});

ipcMain.on('window-minimize', () => { if (win) win.hide(); });
ipcMain.on('window-maximize', () => toggleMaximize());
ipcMain.on('window-close',    () => { if (win) win.hide(); });
ipcMain.on('resize-content', (_e, height) => {
  if (!win) return;
  // Content reported its natural CSS height (zoom-independent). Store it and
  // re-fit the window at the current zoom — keeps the no-scroll, auto-height
  // behavior intact while honoring the corner-drag zoom factor.
  // While maximized the widened layout reports a different height; ignore it so
  // it doesn't clobber the normal-layout height used on restore.
  if (preMaximize) return;
  lastContentHeight = Math.max(320, Math.min(4000, Math.round(Number(height) || 0)));
  applyContentSize();
});

// ── Lifecycle ──────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  createTray();
  app.on('activate', () => { if (!win) createWindow(); });
});

// Tray keeps the app alive after window-all-closed.
app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('before-quit', () => { isQuitting = true; });
