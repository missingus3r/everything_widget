const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');

// La app se llamaba Nexus: el perfil (localStorage con tema, previsión de IA y
// toggles) sigue en %APPDATA%\Nexus para no perderlo con el cambio de nombre.
app.setPath('userData', path.join(app.getPath('appData'), 'Nexus'));

const { loadConfig, saveConfig, findApiKey } = require('./config');
const systemStats = require('./systemStats');
const { fetchWeather } = require('./weather');
const { fetchMarkets } = require('./markets');
const { runSpeedtest } = require('./speedtest');
const speedtestHistory = require('./speedtestHistory');
const { readLocalUsage } = require('./localUsage');
const finances = require('./finances');
const { checkYify, fetchYifyMovies, fetchYifyDetails, fetchYifySuggestions, fetchYifyByImdb } = require('./yify');
const { checkLime, fetchLimeMovies, fetchLimeTvShows, fetchLimeGameGroups, searchLime } = require('./limetorrents');
const limeArchive = require('./limeArchive');
const streaming = require('./streaming');
const transcode = require('./transcode');
const subtitles = require('./subtitles');
const { checkEztv, fetchEztvTorrents, fetchEztvShows, searchShows } = require('./eztv');
// Archivos históricos de las otras tres fuentes (mismo patrón que limeArchive:
// SQLite local + Mongo, aditivo). Los tabs listan desde acá y el crawler los
// llena en segundo plano.
const yifyArchive = require('./yifyArchive');
const eztvArchive = require('./eztvArchive');
const gamesArchive = require('./gamesArchive');
const archiveCrawl = require('./archiveCrawl');
const favorites = require('./favorites');
const favSources = require('./favSources');
const { listApiDefs, checkApis } = require('./apiStatus');
const { fetchUpcoming } = require('./tvmaze');
const { fetchRedditPosts } = require('./reddit');
const { fetchNews } = require('./news');
const { fetchHolidays } = require('./holidays');
const { fetchDeals } = require('./games');
const { fetchGithub } = require('./github');
const { fetchTvByImdb, fetchMovieByImdb, fetchMovieByTmdbId } = require('./tmdb');
const { fetchQuotes, DEFAULT_SYMBOLS } = require('./stocks');
const pcPublish = require('./pcPublish');
const netUsage = require('./netUsage');

// Key guardada en API Keys por nombre: GitHub, TMDB, Finnhub, ElevenLabs… El
// match es tolerante (alias y variantes como "ElevenLabs Api" o "The Movie
// Database"): ver findApiKey en config.js.
function getApiKey(name) {
  return findApiKey(loadConfig().apiKeys, name);
}

let win = null;
let tray = null;
let latestUsage = null;
let latestCodex = null;
let latestAgy = null;
let latestEleven = null;
let latestForecast = null;   // previsión semanal tal como la pinta el renderer
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
  const [claude, codex, agy, eleven] = await Promise.all([
    runFetcher('claudeFetcher.js'),
    runFetcher('codexFetcher.js'),
    runFetcher('agyFetcher.js'),
    runFetcher('elevenLabsFetcher.js'),
  ]);
  return { claude, codex, agy, eleven, available: true };
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
  const wf  = latestUsage?.weekFable?.pct;
  const e   = latestUsage?.extra;
  const cx5 = latestCodex?.session5h?.pct;
  const cxw = latestCodex?.weekly?.pct;
  const elc = latestEleven?.characters;
  // Antigravity: one used-% per quota group, the 5h one when it's the fuller.
  const agyRows = [['Gemini', latestAgy?.gemini], ['Claude/GPT', latestAgy?.partner], ['Argon', latestAgy?.argon]]
    .filter(([, g]) => g && (g.weekly || g.h5))
    .map(([name, g]) => {
      const q = (g.h5?.pct ?? -1) > (g.weekly?.pct ?? -1) ? ['5h', g.h5] : ['Week', g.weekly];
      return `${name} ${q[0]}: ${q[1].pct}%`;
    });
  const elPct = elc?.pct;

  tray.setImage(nativeImage.createFromBuffer(buildTrayIcon(s ?? null, w ?? null)));

  const tipLines = ['Control Center'];
  tipLines.push('— Claude —');
  tipLines.push(s != null ? `Session: ${s}%` : 'Session: —');
  tipLines.push(w != null ? `Week (all): ${w}%` : 'Week (all): —');
  if (ws != null) tipLines.push(`Week (Sonnet): ${ws}%`);
  if (wf != null) tipLines.push(`Week (Fable): ${wf}%`);
  if (e) tipLines.push(`Extra: ${e.pct}% ($${e.spent} / $${e.total})`);
  if (cx5 != null || cxw != null) {
    tipLines.push('— Codex —');
    if (cx5 != null) tipLines.push(`5h limit: ${cx5}%`);
    if (cxw != null) tipLines.push(`Weekly: ${cxw}%`);
  }
  if (agyRows.length) {
    tipLines.push('— Antigravity —');
    tipLines.push(...agyRows);
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
    ...(wf != null ? [{ label: `  Week (Fable)  ${wf}%`, enabled: false }] : []),
    ...(e ? [{ label: `  Extra  ${e.pct}%  ($${e.spent}/$${e.total})`, enabled: false }] : []),
    ...(cx5 != null || cxw != null ? [
      { type: 'separator' },
      { label: 'Codex', enabled: false },
      ...(cx5 != null ? [{ label: `  5h limit  ${cx5}%`, enabled: false }] : []),
      ...(cxw != null ? [{ label: `  Weekly  ${cxw}%`, enabled: false }] : []),
    ] : []),
    ...(agyRows.length ? [
      { type: 'separator' },
      { label: `Antigravity${latestAgy?.account?.plan ? `  ·  ${latestAgy.account.plan}` : ''}`, enabled: false },
      ...agyRows.map((r) => ({ label: `  ${r.replace(': ', '  ')}`, enabled: false })),
    ] : []),
    ...(elPct != null ? [
      { type: 'separator' },
      { label: `ElevenLabs${latestEleven?.tier ? `  ·  ${latestEleven.tier}` : ''}`, enabled: false },
      { label: `  Chars  ${elPct}%  (${elc.used}/${elc.limit})`, enabled: false },
    ] : []),
    { type: 'separator' },
    { label: 'Show widget', click: () => showWindow() },
    { label: 'Refresh now', click: () => { if (win) win.webContents.send('trigger-refresh'); } },
    { label: 'Always on top', type: 'checkbox', checked: !!loadConfig().alwaysOnTop,
      click: (item) => setAlwaysOnTop(item.checked) },
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
  tray.setToolTip('Control Center — loading…');
  tray.on('click', () => {
    if (!win) { createWindow(); return; }
    if (win.isVisible()) win.hide(); else showWindow();
  });
  updateTray();
}

// ── Window ─────────────────────────────────────────────────────
function createWindow() {
  const { width: screenW } = screen.getPrimaryDisplay().workAreaSize;
  const cfg = loadConfig();
  zoom = clampZoom(cfg.widgetZoom);
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
    // Por defecto NO queda siempre adelante (se puede tapar con otras apps);
    // es un toggle en Settings y en el menú de la bandeja (config.alwaysOnTop).
    alwaysOnTop: !!cfg.alwaysOnTop,
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
  if (cfg.alwaysOnTop) applyAlwaysOnTop(true);   // mismo nivel que el toggle (ver applyAlwaysOnTop)
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

// ── YIFY torrents ──────────────────────────────────────────────
// El mirror puede morir en cualquier momento: yify:check sigue siendo el probe
// de arranque (nunca tira) y el listado ya no depende de él — sale del archivo
// histórico (yifyArchive), que el crawler mantiene al día. De la API viva solo
// se traen las novedades para archivarlas.
ipcMain.handle('yify:check', () => checkYify());
ipcMain.handle('yify:list', async (_e, params) => {
  const p = params || {};
  const q = String(p.query || '').trim();
  let live = null;
  let liveErr = null;
  try {
    // Sin búsqueda: se refresca la primera página de recientes para que lo que
    // se acaba de subir esté en la base antes de listar. Con búsqueda: la API
    // busca además por actor y director, cosa que el LIKE local no puede, así
    // que si está viva manda ella y lo que devuelve queda archivado.
    if (q) {
      live = await fetchYifyMovies(p);
      await yifyArchive.ingest(live.movies);
    } else if ((p.page || 1) === 1) {
      const fresh = await fetchYifyMovies({ limit: 50, page: 1, sort: 'date_added' });
      await yifyArchive.ingest(fresh.movies);
    }
  } catch (e) {
    liveErr = String(e && e.message || e);
  }
  if (live) return live;
  try {
    // API caída: el listado sale igual del archivo, marcado como `stale`. El
    // cartel de "API caída" del tab queda solo para cuando tampoco hay nada
    // archivado todavía.
    const local = await yifyArchive.list(p);
    if (liveErr && !local.movies.length) return { error: liveErr };
    return liveErr ? { ...local, stale: true } : local;
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
// Ficha: si el mirror responde, la versión completa — que además se archiva
// (sinopsis larga, download_count) para la próxima vez. Si no, la del archivo.
ipcMain.handle('yify:details', async (_e, movieId) => {
  try {
    const full = await fetchYifyDetails(movieId);
    await yifyArchive.ingest([full]);
    return full;
  } catch (e) {
    try {
      const archived = await yifyArchive.byId(movieId);
      if (archived) return archived;
    } catch {}
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('yify:suggestions', async (_e, movieId) => {
  try {
    return await fetchYifySuggestions(movieId);
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Ficha extendida de película (LimeTorrents) ─────────────────
// El RSS de Lime no trae reparto, sinopsis ni sugerencias: con el imdb id del
// match se completa la ficha para que el modal quede como el de YIFY.
//   1. YIFY por código IMDb (el id sale del archivo si está; si no, del
//      mirror): movie_details (cast + sinopsis) + movie_suggestions. Es la
//      misma info que la ficha de YIFY y las sugerencias abren esa ficha.
//   2. Si YIFY no la tiene (o está caído), TMDB con la key de API Keys:
//      sinopsis en español, reparto y similares (tmdbId → se resuelven al
//      click). Sin key, con el mirror caído y la película archivada, al menos
//      va la sinopsis del archivo.
// También resuelve un tmdbId (click en una similar de TMDB): la ficha de TMDB
// trae el imdb id y con él se intenta YIFY, para caer en la ficha completa.
// Nunca tira: degrada a { error }.
ipcMain.handle('movies:ficha', async (_e, params) => {
  const p = params || {};
  const key = getApiKey('TMDB');
  let imdb = String(p.imdb || '').trim().toLowerCase() || null;
  let tmdbFicha = null;
  try {
    if (!imdb && p.tmdbId) {
      if (!key) return { error: 'sin key de TMDB' };
      tmdbFicha = await fetchMovieByTmdbId(key, p.tmdbId);
      if (tmdbFicha && tmdbFicha.error) return tmdbFicha;
      imdb = tmdbFicha.imdb ? tmdbFicha.imdb.toLowerCase() : null;
    }
    let archived = null;
    if (imdb) {
      try { archived = await yifyArchive.byImdb(imdb); } catch {}
      try {
        const base = archived || await fetchYifyByImdb(imdb);
        if (base && base.id) {
          const [det, sug] = await Promise.all([
            fetchYifyDetails(base.id),
            fetchYifySuggestions(base.id).catch(() => ({ movies: [] })),
          ]);
          yifyArchive.ingest([det]).catch(() => {});
          return {
            ...det,
            source: 'yify',
            suggestions: (sug.movies || []).map((m) => ({ ...m, src: 'yify' })),
          };
        }
      } catch {
        // Mirror caído: sigue TMDB (si hay key) y, como último recurso, lo
        // archivado (sinopsis sin cast).
      }
    }
    if (key && imdb && !tmdbFicha) {
      try { tmdbFicha = await fetchMovieByImdb(key, imdb); }
      catch (e) { tmdbFicha = { error: String(e && e.message || e) }; }
    }
    if (tmdbFicha && !tmdbFicha.error) return tmdbFicha;
    if (archived) return { ...archived, source: 'yify', suggestions: [], stale: true };
    if (tmdbFicha) return tmdbFicha;
    return { error: !imdb ? 'sin imdb id' : key ? 'sin ficha' : 'no está en YIFY; una key "TMDB" en API Keys completa estas fichas' };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── LimeTorrents RSS (tab Films) ───────────────────────────────
// Misma defensa que YIFY: lime:check nunca tira, lime:list degrada a { error }.
ipcMain.handle('lime:check', () => checkLime());
ipcMain.handle('lime:list', async (_e, params) => {
  try {
    return await fetchLimeMovies(params || {});
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
// Series agrupadas por show (tab Series) y juegos agrupados (tab Juegos).
ipcMain.handle('lime:tv-shows', async () => {
  try {
    return await fetchLimeTvShows();
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('lime:games', async () => {
  try {
    return await fetchLimeGameGroups();
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
// Búsqueda del sitio (searchrss) filtrada por categoría (movies / tv / games).
ipcMain.handle('lime:search', async (_e, params) => {
  try {
    return await searchLime(params || {});
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Reproducción en directo (WebTorrent) ───────────────────────
// stream:start agrega el magnet y devuelve una URL local que el <video> lee con
// Range (adelantar/buscar). stream:stop borra del disco lo descargado. Todo
// degrada a { error }; nunca tira.
ipcMain.handle('stream:start', async (_e, magnet) => {
  try {
    const s = await streaming.start(magnet);
    if (s && s.error) return s;
    // ffmpeg decide: servir directo (mp4/x264) o transcodificar/remuxear a HLS
    // (HEVC/MKV/AC3…) para que reproduzca cualquier formato.
    const pb = await transcode.prepare({ srcUrl: s.url, name: s.name, infoHash: s.infoHash });
    return { infoHash: s.infoHash, name: s.name, length: s.length, ...pb };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('stream:stop', async (_e, hash) => {
  try {
    await transcode.stopJob(hash);   // mata ffmpeg + borra segmentos HLS
    return await streaming.stop(hash);
  } catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('stream:stats', (_e, hash) => {
  try { return streaming.stats(hash); }
  catch { return { active: false }; }
});

// ── Subtítulos (OpenSubtitles, sin key) ────────────────────────
// subs:search lista opciones; subs:fetch trae el VTT para el <track>; y
// subs:download baja el .srt a disco (con diálogo de guardado).
ipcMain.handle('subs:search', async (_e, params) => {
  try { return await subtitles.search(params || {}); }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('subs:fetch', async (_e, params) => {
  try { return await subtitles.fetchSub(params || {}); }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('subs:download', async (_e, params) => {
  try {
    const { link, encoding, filename } = params || {};
    const { srt } = await subtitles.fetchSub({ link, encoding });
    let safe = String(filename || 'subtitulo').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'subtitulo';
    if (!/\.srt$/i.test(safe)) safe += '.srt';
    const def = path.join(app.getPath('downloads'), safe);
    const res = await dialog.showSaveDialog(win || undefined, {
      defaultPath: def,
      filters: [{ name: 'Subtítulo', extensions: ['srt'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    await fs.promises.writeFile(res.filePath, '﻿' + srt, 'utf8');   // BOM → tildes OK en cualquier player
    return { ok: true, path: res.filePath };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Estado de las APIs (Settings) ──────────────────────────────
ipcMain.handle('api-status:defs', () => listApiDefs());
ipcMain.handle('api-status:check', async (_e, ids) => {
  try { return await checkApis(ids); }
  catch { return []; }
});

// ── EZTV series ────────────────────────────────────────────────
// Mismo contrato defensivo que YIFY: eztv:check nunca tira, el resto degrada
// a { error }. La búsqueda por nombre va contra la suggestion API de IMDb.
ipcMain.handle('eztv:check', () => checkEztv());
// Episodios de una serie (modal) o recientes: salen del archivo. Si de esa
// serie todavía no se bajó el histórico completo, se le pide a la API y se
// archiva antes de responder — así el modal nunca muestra menos de lo que EZTV
// tiene, aunque el crawler no haya llegado a esa serie.
ipcMain.handle('eztv:list', async (_e, params) => {
  const p = params || {};
  try {
    if (p.imdbId) {
      const known = await eztvArchive.showFor(p.imdbId);
      if (!known || !known.fullAt) {
        const live = await fetchEztvTorrents({ ...p, limit: 100 });
        await eztvArchive.ingest(live.torrents);
      }
    }
  } catch {}
  try {
    return await eztvArchive.listTorrents(p);
  } catch (e) {
    try { return await fetchEztvTorrents(p); }
    catch (err) { return { error: String(err && err.message || err) }; }
  }
});
// Listado del tab: una card por serie, paginado sobre el archivo. Antes de
// listar se archiva la página viva de recientes (las novedades).
ipcMain.handle('eztv:shows', async (_e, params) => {
  const p = params || {};
  let stale = false;
  try {
    const live = await fetchEztvTorrents({ limit: 100, page: 1 });
    await eztvArchive.ingest(live.torrents);
  } catch { stale = true; }
  try {
    const r = await eztvArchive.listShows(p);
    if (stale && !r.shows.length) return { error: 'EZTV no responde' };
    return stale ? { ...r, stale: true } : r;
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('eztv:search-shows', async (_e, query) => {
  try {
    return await searchShows(query);
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── TVMaze: próximos episodios de las series favoritas ─────────
// Los imdb ids salen de los favoritos guardados en la base; TVMaze resuelve
// el próximo episodio de cada serie. Degrada a { error }.
ipcMain.handle('tvmaze:upcoming', async () => {
  try {
    const favs = await favorites.listSeries();
    const ids = (Array.isArray(favs) ? favs : []).map((f) => f.imdbId).filter(Boolean);
    return await fetchUpcoming(ids);
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── TMDB: ficha de serie en español + dónde ver (modal) ────────
ipcMain.handle('tmdb:tv', async (_e, imdbNum) => {
  try {
    return await fetchTvByImdb(getApiKey('TMDB'), imdbNum);
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Reddit ─────────────────────────────────────────────────────
ipcMain.handle('reddit:posts', async (_e, params) => {
  try {
    return await fetchRedditPosts(params || {});
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Noticias UY (feeds RSS) ────────────────────────────────────
ipcMain.handle('news:posts', async (_e, params) => {
  try {
    return await fetchNews(params || {});
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Feriados (Nager.Date) ──────────────────────────────────────
ipcMain.handle('holidays:next', async () => {
  try {
    return await fetchHolidays('UY');
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Juegos (CheapShark) ────────────────────────────────────────
// Igual que Films y Series: la página viva se archiva y el listado (con su
// orden, filtros y pager) sale de games.sqlite, que guarda todas las ofertas
// vistas — incluido el precio mínimo histórico de cada una.
ipcMain.handle('games:deals', async (_e, params) => {
  const p = params || {};
  let stale = false;
  try {
    const live = await fetchDeals(p);
    await gamesArchive.ingestStores(live.stores || []);
    await gamesArchive.ingest(live.deals || []);
  } catch { stale = true; }
  try {
    const r = await gamesArchive.list(p);
    if (stale && !r.deals.length) return { error: 'CheapShark no responde' };
    return { ...r, stores: await gamesArchive.listStores(), ...(stale ? { stale: true } : {}) };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// Progreso de los archivos históricos (Settings): cuánto hay guardado de cada
// fuente y en qué anda el crawler.
ipcMain.handle('archive:status', async () => {
  try { return await archiveCrawl.status(); }
  catch (e) { return { error: String(e && e.message || e) }; }
});

// ── GitHub (token en API Keys con nombre "GitHub") ─────────────
ipcMain.handle('github:overview', async () => {
  try {
    return await fetchGithub(getApiKey('GitHub'));
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Acciones y ETFs (Finnhub, key en API Keys) ─────────────────
ipcMain.handle('stocks:quotes', async () => {
  try {
    const cfg = loadConfig();
    const symbols = Array.isArray(cfg.stockSymbols) && cfg.stockSymbols.length
      ? cfg.stockSymbols : DEFAULT_SYMBOLS;
    const r = await fetchQuotes(getApiKey('Finnhub'), symbols);
    return { ...r, symbols };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('stocks:set-symbols', (_e, symbols) => {
  const list = (Array.isArray(symbols) ? symbols : [])
    .map((s) => String(s || '').trim().toUpperCase())
    .filter((s) => /^[A-Z.\-^]{1,12}$/.test(s))
    .slice(0, 12);
  saveConfig({ stockSymbols: list });
  return list;
});

// ── Favoritos (YIFY) ───────────────────────────────────────────
// Persisten completos en SQLite (portada incluida) para sobrevivir a la API.
// Al agregar se intenta enriquecer con movie_details (sinopsis completa +
// cast); si la API no responde se guarda lo que el renderer ya tenía.
ipcMain.handle('favs:ids', async () => {
  try { return await favorites.getKeys(); }
  catch { return { ids: [], imdbs: [] }; }
});
ipcMain.handle('favs:list', async () => {
  try { return await favorites.list(); }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('favs:add', async (_e, movie) => {
  try {
    if (!movie || !movie.id) return { error: 'película inválida' };
    let full = movie;
    // Los de LimeTorrents tienen id sintético (negativo) sin ficha en YIFY:
    // se guardan tal cual llegan del renderer (magnets + poster de IMDb).
    if (movie.source !== 'lime') {
      try { full = { ...movie, ...(await fetchYifyDetails(movie.id)) }; } catch {}
    }
    // La misma película puede estar en la otra fuente: se guardan también sus
    // torrents (y, para Lime, la ficha de YIFY) así la ficha en Favoritos
    // muestra los dos orígenes. Best-effort.
    try { full = await favSources.complement(full); } catch {}
    const saved = await favorites.add(full);
    return { ok: true, id: saved.id };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('favs:remove', async (_e, movieId) => {
  try {
    await favorites.remove(movieId);
    return { ok: true };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});

// ── Carpetas de favoritos (YIFY) ───────────────────────────────
ipcMain.handle('favs:folders', async () => {
  try { return await favorites.listFolders(); }
  catch { return []; }
});
ipcMain.handle('favs:folder-create', async (_e, { name, parentId } = {}) => {
  try { return { ok: true, folder: await favorites.createFolder(name, parentId ?? null) }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('favs:folder-rename', async (_e, { id, name }) => {
  try { await favorites.renameFolder(id, name); return { ok: true }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('favs:folder-delete', async (_e, id) => {
  try { await favorites.deleteFolder(id); return { ok: true }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('favs:move', async (_e, { movieId, folderId }) => {
  try { await favorites.moveToFolder(movieId, folderId); return { ok: true }; }
  catch (e) { return { error: String(e && e.message || e) }; }
});

// ── Favoritos de series (EZTV) ─────────────────────────────────
// El renderer pasa el torrent normalizado + contexto de la serie (showTitle /
// showImage de IMDb); no hay endpoint de detalles que enriquecer.
ipcMain.handle('sfavs:ids', async () => {
  try { return await favorites.getSeriesIds(); }
  catch { return []; }
});
ipcMain.handle('sfavs:list', async () => {
  try { return await favorites.listSeries(); }
  catch (e) { return { error: String(e && e.message || e) }; }
});
ipcMain.handle('sfavs:add', async (_e, torrent) => {
  try {
    await favorites.addSeries(torrent);
    return { ok: true };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('sfavs:remove', async (_e, torrentId) => {
  try {
    await favorites.removeSeries(torrentId);
    return { ok: true };
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
});
ipcMain.handle('reset-speedtest-history', () => speedtestHistory.reset());

// ── Tray usage push (from renderer) ────────────────────────────
ipcMain.on('usage-updated',        (_e, data) => { latestUsage  = data; updateTray(); });
ipcMain.on('codex-usage-updated',  (_e, data) => { latestCodex  = data; updateTray(); });
ipcMain.on('agy-usage-updated',    (_e, data) => { latestAgy    = data; updateTray(); });
ipcMain.on('eleven-usage-updated', (_e, data) => { latestEleven = data; updateTray(); });
ipcMain.on('pc-status:forecast',   (_e, data) => { latestForecast = data; });

// ── API keys ───────────────────────────────────────────────────
// La key de ElevenLabs se busca con el mismo match tolerante que el resto
// ("ElevenLabs Api" también vale); el campo legacy elevenLabsApiKey se
// mantiene espejado para el fetcher standalone y configs viejas.
ipcMain.handle('get-api-keys', () => {
  const cfg = loadConfig();
  const list = Array.isArray(cfg.apiKeys) ? cfg.apiKeys.slice() : [];
  if (cfg.elevenLabsApiKey && !findApiKey(list, 'elevenlabs')) {
    list.unshift({ id: 'elevenlabs-legacy', name: 'ElevenLabs', key: cfg.elevenLabsApiKey });
  }
  return list;
});
ipcMain.handle('save-api-keys', (_event, keys) => {
  const list = Array.isArray(keys) ? keys.filter(k => k && k.name && k.key) : [];
  const cfg = loadConfig();
  const patch = { apiKeys: list };
  const eleven = findApiKey(list, 'elevenlabs');
  if (eleven) patch.elevenLabsApiKey = eleven;
  else if (cfg.elevenLabsApiKey) patch.elevenLabsApiKey = '';
  saveConfig(patch);
  pcPublish.publishKeys(list);   // las que usa Nexus Mobile (TMDB, GitHub, Finnhub)
  return list;
});

// ── Finanzas ───────────────────────────────────────────────────
ipcMain.handle('finances:get-state', () => finances.getState());
ipcMain.handle('finances:get-history', () => finances.getHistory());
ipcMain.handle('finances:get-history-full', () => finances.getHistoryFull());
ipcMain.handle('finances:save-manual', (_e, { accountId, uyu, usd }) =>
  finances.saveManual(accountId, uyu, usd));
ipcMain.handle('finances:clear-account', (_e, accountId) => finances.clearAccount(accountId));
ipcMain.handle('finances:clear-all', () => finances.clearAll());
ipcMain.handle('finances:save-projection', (_e, { accountId, uyu, usd }) =>
  finances.saveProjection(accountId, uyu, usd));
ipcMain.handle('finances:clear-projection', (_e, accountId) => finances.clearProjection(accountId));
ipcMain.handle('finances:save-description', (_e, { accountId, text }) =>
  finances.saveDescription(accountId, text));
ipcMain.handle('finances:set-hidden', (_e, hidden) => finances.setHidden(hidden));
ipcMain.handle('finances:record-fx', (_e, { ym, rate }) => finances.recordFx(ym, rate));
ipcMain.handle('finances:mongo-status', () => finances.getMongoStatus());
// Sincronización automática de las bases (Finanzas + favoritos + archivo de
// LimeTorrents, YIFY, EZTV y CheapShark, misma Mongo): corre al arranque y
// cada SYNC_INTERVAL_MS.
// Siempre ADITIVA — cada lado sube lo que al otro le falta y nada se borra ni
// se pisa (una instalación nueva baja todo el histórico en vez de subir su
// base vacía). Reemplaza al viejo botón "Sincronizar bases" de Settings.
const DB_SYNC_INTERVAL_MS = 15 * 60 * 1000;
let dbSyncRunning = false;
async function syncDatabases() {
  if (dbSyncRunning) return;
  dbSyncRunning = true;
  let st = null;
  let favs = null;
  try {
    [st, favs] = await Promise.all([
      finances.syncNow().catch(() => null),
      favorites.syncNow().catch(() => null),
      limeArchive.syncNow().catch(() => {}),
      yifyArchive.syncNow().catch(() => {}),
      eztvArchive.syncNow().catch(() => {}),
      gamesArchive.syncNow().catch(() => {}),
    ]);
    // Favoritos: imdb faltante, duplicados YIFY/Lime y torrents de la otra
    // fuente (usa los archivos recién sincronizados). Nunca tira.
    await favSources.refreshAll();
  } finally {
    dbSyncRunning = false;
  }
  // El renderer refresca Finanzas y muestra "última sincronización" en Settings.
  if (win) {
    try { win.webContents.send('db-synced', { ok: !!(st && st.ok), at: Date.now() }); } catch {}
  }
  notifyFavsChanged(favs);
}

// Favoritos compartidos con Nexus Mobile: el teléfono escribe directo en
// Mongo, así que además de la pasada grande cada 15 min los favoritos se
// reconcilian cada 5 (es barata: baja docs sin portadas). Si algo cambió, el
// renderer repinta los ♥ y las vistas de Favoritos.
const FAVS_SYNC_INTERVAL_MS = 5 * 60 * 1000;
function notifyFavsChanged(r) {
  if (!r || !r.changed || !win) return;
  try { win.webContents.send('favs-synced', { at: Date.now() }); } catch {}
}
async function syncFavorites() {
  notifyFavsChanged(await favorites.syncNow().catch(() => null));
}
ipcMain.handle('finances:list-expenses', () => finances.listExpenses());
ipcMain.handle('finances:add-expense', (_e, payload) => finances.addExpense(payload));
ipcMain.handle('finances:update-expense', (_e, payload) => finances.updateExpense(payload));
ipcMain.handle('finances:delete-expense', (_e, id) => finances.deleteExpense(id));

// Open a URL in the user's default browser (Finanzas links) or the torrent
// client for magnet: links (YIFY tab).
ipcMain.handle('open-external', (_e, url) => {
  try {
    if (typeof url === 'string' && /^(https?:\/\/|magnet:\?)/i.test(url)) shell.openExternal(url);
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

// "Siempre adelante": persiste en config y se aplica en caliente a la ventana.
// Lo cambian el toggle de Settings y el ítem del menú de la bandeja.
// Nivel 'screen-saver' a propósito: con el nivel por defecto ('floating')
// Electron en Windows, después de marcar la ventana TOPMOST, la reubica
// detrás de la barra de tareas (SetWindowPos con la barra como insertAfter) y
// si la barra en ese momento no es topmost la ventana pierde el flag — en la
// práctica el toggle "no hacía nada". 'screen-saver' no pasa por ese paso.
// Además, en Windows el PRIMER SetWindowPos(HWND_TOPMOST) después del arranque
// a veces no prende el flag (el siguiente sí — reproducido con el toggle de
// Settings): se verifica con isAlwaysOnTop() y, si no quedó, se alterna y se
// vuelve a aplicar.
function applyAlwaysOnTop(on) {
  if (!win) return false;
  const set = (v) => {
    try { win.setAlwaysOnTop(v, 'screen-saver'); }
    catch (e) { console.error('[window] setAlwaysOnTop', e && e.message); }
  };
  set(on);
  if (win.isAlwaysOnTop() !== on) {
    set(!on);
    set(on);
    console.warn('[window] alwaysOnTop', on, 'reintentado →', win.isAlwaysOnTop());
  }
  return win.isAlwaysOnTop() === on;
}
function setAlwaysOnTop(enabled) {
  const on = !!enabled;
  saveConfig({ alwaysOnTop: on });
  applyAlwaysOnTop(on);
  updateTray();   // refleja el check del menú
  return on;
}
ipcMain.handle('get-always-on-top', () => !!loadConfig().alwaysOnTop);
ipcMain.handle('set-always-on-top', (_event, enabled) => setAlwaysOnTop(enabled));

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
// Una sola instancia. Con dos abiertas (el arranque automático de Windows más
// un doble click, por ejemplo) hay dos crawlers y dos copias en memoria de los
// mismos .sqlite: sql.js vuelca el archivo ENTERO en cada guardado, así que la
// última en escribir pisa lo que hizo la otra — se pierden páginas del archivo
// y el cursor del backfill retrocede. La segunda instancia se cierra y trae al
// frente la ventana de la primera.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) { createWindow(); return; }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;   // la segunda instancia solo se cierra
  createWindow();
  createTray();
  streaming.sweep();   // limpia restos de streams de una sesión anterior
  transcode.sweep();   // ídem para segmentos HLS huérfanos
  syncDatabases();     // sync inicial de las bases (aditivo, best-effort)
  setInterval(syncDatabases, DB_SYNC_INTERVAL_MS);
  setInterval(syncFavorites, FAVS_SYNC_INTERVAL_MS).unref();
  // Nexus Mobile: estado del PC, keys compartidas e índices que usa el teléfono.
  pcPublish.ensureIndexes();
  pcPublish.publishKeys(loadConfig().apiKeys);
  pcPublish.start({
    getState: async () => {
      const cfg = loadConfig();
      return {
        system: await systemStats.snapshot(),
        net: netUsage.read(),
        speedtest: speedtestHistory.read(),
        ai: { claude: latestUsage, codex: latestCodex, agy: latestAgy, eleven: latestEleven, local: await readLocalUsage().catch(() => null) },
        forecast: latestForecast,
        stockSymbols: Array.isArray(cfg.stockSymbols) && cfg.stockSymbols.length ? cfg.stockSymbols : DEFAULT_SYMBOLS,
        now: Date.now(),
      };
    },
  });
  archiveCrawl.start();   // backfill de los catálogos, en segundo plano
  app.on('activate', () => { if (!win) createWindow(); });
});

// Tray keeps the app alive after window-all-closed.
app.on('window-all-closed', (e) => { e.preventDefault(); });
app.on('before-quit', () => {
  isQuitting = true;
  transcode.stopAll();
  streaming.stopAll();
  // Los archivos históricos guardan diferido (reescribir 80 MB en cada ingest
  // congelaría la UI): acá se vuelca lo que quedó en memoria.
  archiveCrawl.stop();
  yifyArchive.flush();
  eztvArchive.flush();
  gamesArchive.flush();
});
