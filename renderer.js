// ── State ──────────────────────────────────────────────────────
let cfg = null;
let aiData = null;
let weatherData = null;
let marketsData = null;
let lastSystem = null;
let aiFetching = false;
let speedtestRunning = false;
let lastAIRefreshAt = 0;

const SYS_INTERVAL_MS = 2000;
const WEATHER_INTERVAL_MS = 15 * 60 * 1000;
const MARKETS_INTERVAL_MS = 5 * 60 * 1000;
let AI_INTERVAL_MS = 15 * 60 * 1000;

// ── Pricing & plan label ───────────────────────────────────────
const CLAUDE_PLAN = 'MAX 5x';
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
let pricing = {
  claude: {
    perMillionInput: 3,
    perMillionOutput: 15,
    perMillionCacheRead: 0.30,
    perMillionCacheCreate: 3.75,
  },
  planWeeklyEquivalent: {
    'Pro': 80, 'MAX 5x': 400, 'MAX 20x': 1500,
    'Plus': 50, 'Pro+': 200, 'Business': 200, 'Enterprise': 500,
  },
};
// Tracks `${section}:${resetsString}` pairs we've already force-refreshed for,
// so a countdown that sits at "Ahora!" for a while doesn't re-trigger every tick.
const firedResets = new Set();

// ── DOM refs ───────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

// ── Tabs ───────────────────────────────────────────────────────
const tabButtons = document.querySelectorAll('.tab');
const tabPanels = {
  dashboard: document.getElementById('tab-dashboard'),
  finanzas: document.getElementById('tab-finanzas'),
  keys: document.getElementById('tab-keys'),
  settings: document.getElementById('tab-settings'),
};
function switchTab(target) {
  tabButtons.forEach((b) => b.classList.toggle('active', b.dataset.tab === target));
  Object.entries(tabPanels).forEach(([name, el]) => {
    if (el) el.classList.toggle('hidden', name !== target);
  });
  if (target === 'keys') loadKeys();
  if (target === 'settings') loadSettings();
  if (target === 'finanzas') renderFinanzas();
  adjustWindowSize();
}
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Auto-resize window to content ──────────────────────────────
let resizeRaf = null;
function adjustWindowSize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const widget = document.querySelector('.widget');
    if (!widget) return;
    const h = Math.ceil(widget.getBoundingClientRect().height);
    if (window.api && window.api.resizeContent) window.api.resizeContent(h);
  });
}

// ── Formatters ─────────────────────────────────────────────────
function fmtBytes(n) {
  if (n == null || !isFinite(n) || n <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(k)));
  const v = n / Math.pow(k, i);
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

function fmtRate(bytesPerSec) {
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return (bits / 1e9).toFixed(2) + ' Gbps';
  if (bits >= 1e6) return (bits / 1e6).toFixed(1) + ' Mbps';
  if (bits >= 1e3) return (bits / 1e3).toFixed(1) + ' Kbps';
  return Math.round(bits) + ' bps';
}

function fmtUptime(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// 'YYYY-MM' → "Mayo 2026" (current calendar month for the network usage label).
function fmtMonthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key || '');
  if (!m) return 'Este mes';
  const months = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
    'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const name = months[parseInt(m[2], 10) - 1] || '';
  return name ? `${name} ${m[1]}` : 'Este mes';
}

function barClassPct(pct) {
  if (pct >= 85) return 'red';
  if (pct >= 65) return 'yellow';
  return '';
}

function pctColor(pct) {
  if (pct >= 85) return '#ef4444';
  if (pct >= 65) return '#facc15';
  return '#4ade80';
}

function setBar(fillEl, valEl, pct, valText) {
  fillEl.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  fillEl.className = 'bar-fill ' + barClassPct(pct);
  if (valEl) valEl.textContent = valText;
}

// Circular gauge (donut). Same color logic as the bars (green/yellow/red).
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 42; // r=42 in the 100x100 viewBox
function setGauge(arcEl, centerEl, subEl, pct, centerText, subText) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (arcEl) {
    arcEl.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE}`;
    arcEl.style.strokeDashoffset = `${GAUGE_CIRCUMFERENCE * (1 - p / 100)}`;
    arcEl.style.stroke = pctColor(p);
  }
  if (centerEl) centerEl.textContent = centerText;
  if (subEl) subEl.textContent = subText || '';
}

// ── Clock + date (tick every second) ───────────────────────────
const MONTHS = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const DAYS   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

function updateClock() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  $('clock').textContent = `${hh}:${mm}:${ss}`;
  $('date').textContent = `${DAYS[now.getDay()]}, ${now.getDate()} de ${MONTHS[now.getMonth()]} de ${now.getFullYear()}`;
}

// ── System stats ───────────────────────────────────────────────
async function refreshSystem() {
  let s;
  try { s = await window.api.fetchSystem(); }
  catch { return; }
  if (!s) return;
  lastSystem = s;

  // CPU
  setGauge($('cpu-arc'), $('cpu-val'), $('cpu-sub'), s.cpu, `${s.cpu}%`, '');

  // RAM
  const ramPct = s.mem.pct;
  setGauge($('ram-arc'), $('ram-val'), $('ram-sub'), ramPct, `${ramPct}%`,
    `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}`);

  // Disks
  const disksEl = $('disks');
  const html = (s.disks || []).map((d, i) => `
    <div class="stat-row">
      <div class="stat-label">${d.name}:</div>
      <div class="stat-bar"><div class="bar-fill ${barClassPct(d.pct)}" style="width:${d.pct}%"></div></div>
      <div class="stat-val">${fmtBytes(d.used)} / ${fmtBytes(d.total)}</div>
    </div>
  `).join('');
  if (disksEl.innerHTML !== html) disksEl.innerHTML = html;

  // Temp
  const tempEl = $('temp-val');
  if (s.temp && (s.temp.gpu != null || s.temp.cpu != null)) {
    const parts = [];
    if (s.temp.cpu != null) parts.push(`CPU ${s.temp.cpu}°`);
    if (s.temp.gpu != null) parts.push(`GPU ${s.temp.gpu}°`);
    tempEl.textContent = parts.join(' / ');
    if (s.temp.cpu == null && s.temp.gpu != null) {
      tempEl.title = 'CPU temp no disponible. Instalá LibreHardwareMonitor (gratis) y dejalo corriendo en background para verla.';
    } else {
      tempEl.title = '';
    }
  } else {
    tempEl.textContent = '—';
    tempEl.title = 'Para temperaturas, instalá LibreHardwareMonitor (CPU) o tené nvidia-smi en el PATH (GPU).';
  }

  // Uptime + OS sub
  $('uptime-val').textContent = fmtUptime(s.os.uptimeSec);
  $('sys-sub').textContent = `${s.os.cores} cores · ${s.os.platform}`;

  // Battery
  if (s.battery && s.battery.pct != null) {
    $('batt-cell').hidden = false;
    $('batt-val').textContent = `${s.battery.pct}%${s.battery.charging ? ' ⚡' : ''}`;
  } else {
    $('batt-cell').hidden = true;
  }

  // Network live
  $('net-down').textContent = fmtRate(s.net.downBps);
  $('net-up').textContent   = fmtRate(s.net.upBps);
  $('net-sub').textContent  = (s.net.adapters && s.net.adapters[0]) ? s.net.adapters.map(a => a.name).slice(0, 2).join(' · ') : '';

  // Monthly consumption (accumulated by the main process)
  const mo = s.net.monthly;
  if (mo) {
    $('net-month-down').textContent = fmtBytes(mo.rxBytes);
    $('net-month-up').textContent   = fmtBytes(mo.txBytes);
    const lbl = $('net-month-label');
    if (lbl && mo.month) {
      lbl.textContent = fmtMonthLabel(mo.month);
      lbl.title = `Consumo acumulado del mes ${mo.month}`;
    }
  }

  adjustWindowSize();
}

// ── Weather ────────────────────────────────────────────────────
function renderWeather(w) {
  const grid = $('weather-grid');
  if (!w || w.error) {
    grid.innerHTML = `<div class="weather-loading">Clima no disponible</div>`;
    return;
  }
  $('weather-loc').textContent = w.location || '';

  const c = w.current || {};
  const today = w.today || {};
  const tom = w.tomorrow || {};

  grid.innerHTML = `
    <div class="weather-cell now">
      <div class="weather-icon">${c.emoji || '•'}</div>
      <div class="weather-info">
        <div class="weather-when">Ahora · ${escapeHtml(c.label || '')}</div>
        <div class="weather-temp">${fmtTemp(c.temp)}</div>
        <div class="weather-detail">
          Sensación <b>${fmtTemp(c.feels)}</b> ·
          Humedad <b>${c.humidity != null ? c.humidity + '%' : '—'}</b> ·
          Viento <b>${c.wind != null ? c.wind + ' km/h' : '—'}</b>
        </div>
      </div>
    </div>
    <div class="weather-cell">
      <div class="weather-icon">${today.emoji || '•'}</div>
      <div class="weather-info">
        <div class="weather-when">Hoy</div>
        <div class="weather-temp">${fmtTemp(today.max)}<span style="font-size:60%;color:#71717a"> / ${fmtTemp(today.min)}</span></div>
        <div class="weather-detail">Lluvia <b>${today.rainPct != null ? today.rainPct + '%' : '—'}</b></div>
      </div>
    </div>
    <div class="weather-cell">
      <div class="weather-icon">${tom.emoji || '•'}</div>
      <div class="weather-info">
        <div class="weather-when">Mañana</div>
        <div class="weather-temp">${fmtTemp(tom.max)}<span style="font-size:60%;color:#71717a"> / ${fmtTemp(tom.min)}</span></div>
        <div class="weather-detail">Lluvia <b>${tom.rainPct != null ? tom.rainPct + '%' : '—'}</b></div>
      </div>
    </div>
  `;
  adjustWindowSize();
}

function fmtTemp(t) {
  if (t == null || !isFinite(t)) return '—';
  return Math.round(t) + '°';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function refreshWeather() {
  const btn = $('weather-refresh');
  btn.classList.add('spinning');
  try {
    const w = await window.api.fetchWeather();
    weatherData = w;
    renderWeather(w);
  } catch (e) {
    renderWeather({ error: String(e) });
  } finally {
    btn.classList.remove('spinning');
  }
}

$('weather-refresh').addEventListener('click', refreshWeather);

// ── Mercado: cripto (USD) + divisas → UYU (dos fuentes) ────────
function fmtCryptoUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1000) return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (v >= 1)    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function fmtUyuRate(v) {
  if (v == null || !isFinite(v)) return '—';
  const max = v >= 1 ? 2 : 4;
  return '$' + v.toLocaleString('es-UY', { minimumFractionDigits: 2, maximumFractionDigits: max });
}

function fmtChange(v) {
  if (v == null || !isFinite(v)) return '';
  const up = v >= 0;
  return `<span class="mkt-chg ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(v).toFixed(2)}%</span>`;
}

function renderMarkets(m) {
  const el = $('mkt-content');
  if (!el) return;
  if (!m || m.error) {
    el.innerHTML = `<div class="ai-loading">Mercado no disponible</div>`;
    return;
  }
  const whenEl = $('mkt-when');
  if (whenEl) whenEl.textContent = m.fetchedAt ? fmtWhen(m.fetchedAt) : '';

  let cryptoHtml;
  if (Array.isArray(m.crypto) && m.crypto.length) {
    cryptoHtml = m.crypto.map((c) => `
      <div class="mkt-coin">
        <span class="mkt-coin-sym">${escapeHtml(c.symbol)}</span>
        <span class="mkt-coin-name">${escapeHtml(c.name)}</span>
        <span class="mkt-coin-price">${fmtCryptoUsd(c.usd)}</span>
        ${fmtChange(c.change24h)}
      </div>`).join('');
  } else {
    cryptoHtml = `<div class="mkt-empty">Cripto no disponible</div>`;
  }

  const fx = m.fx || {};
  const codes = fx.codes || [];
  const da = fx.dolarapi, er = fx.erapi;
  const fxRows = codes.map((code) => {
    const name = (fx.names && fx.names[code]) || code;
    const daCell = da && da[code]
      ? `<span class="mkt-fx-val">${fmtUyuRate(da[code].venta)}</span>` +
        `<span class="mkt-fx-sub">compra ${fmtUyuRate(da[code].compra)}</span>`
      : `<span class="mkt-fx-val">—</span>`;
    const erVal = er && er[code] != null ? er[code] : null;
    return `
      <div class="mkt-fx-row">
        <span class="mkt-fx-cur"><b>${escapeHtml(code)}</b> ${escapeHtml(name)}</span>
        <span class="mkt-fx-cell">${daCell}</span>
        <span class="mkt-fx-cell"><span class="mkt-fx-val">${fmtUyuRate(erVal)}</span></span>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="mkt-cols">
      <div class="mkt-col">
        <div class="mkt-sub-title">Cripto <span class="mkt-src">· USD</span></div>
        <div class="mkt-list">${cryptoHtml}</div>
      </div>
      <div class="mkt-col">
        <div class="mkt-sub-title">Divisas <span class="mkt-src">· 1 = UYU</span></div>
        <div class="mkt-fx-row mkt-fx-head">
          <span class="mkt-fx-cur"></span>
          <span class="mkt-fx-cell">DolarAPI</span>
          <span class="mkt-fx-cell">ExchangeRate</span>
        </div>
        <div class="mkt-list">${fxRows}</div>
      </div>
    </div>`;
  adjustWindowSize();
}

async function refreshMarkets() {
  const btn = $('mkt-refresh');
  if (btn) btn.classList.add('spinning');
  try {
    const m = await window.api.fetchMarkets();
    marketsData = m;
    renderMarkets(m);

    // Feed the USD buy/sell rate into Finanzas for UYU↔USD conversions.
    const usd = m && m.fx && m.fx.dolarapi && m.fx.dolarapi.USD;
    if (usd && usd.compra && usd.venta) {
      finUsdRate = { compra: usd.compra, venta: usd.venta };
      paintConvertedTotals();
      // Refresh charts (the "por tipo" chart converts USD items) without a full
      // re-render, so any balance the user is typing isn't wiped.
      if (finChartsEl && finLastExpenses.length) {
        renderFinanzasCharts(finLastAccounts, finLastExpenses);
      }
    }
  } catch (e) {
    renderMarkets({ error: String(e) });
  } finally {
    if (btn) btn.classList.remove('spinning');
  }
}

const mktRefreshBtn = $('mkt-refresh');
if (mktRefreshBtn) mktRefreshBtn.addEventListener('click', refreshMarkets);

// ── Speedtest ──────────────────────────────────────────────────
function fmtMbps(v) {
  if (v == null || !isFinite(v)) return '—';
  return `${v.toFixed(1)} Mbps`;
}
function fmtMs(v) {
  if (v == null || !isFinite(v)) return '—';
  return `${Math.round(v)} ms`;
}
function fmtWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderSpeedtest(history) {
  const last = history?.last;
  $('st-last-down').textContent = fmtMbps(last?.downloadMbps);
  $('st-last-up').textContent   = fmtMbps(last?.uploadMbps);
  $('st-last-ping').textContent = fmtMs(last?.pingMs);
  $('st-last-when').textContent = fmtWhen(last?.at);

  const best = history?.best || {};
  $('st-best-down').textContent = fmtMbps(best.downloadMbps?.value);
  $('st-best-up').textContent   = fmtMbps(best.uploadMbps?.value);
  $('st-best-ping').textContent = fmtMs(best.pingMs?.value);

  adjustWindowSize();
}

async function loadSpeedtest() {
  try {
    const h = await window.api.getSpeedtestHistory();
    renderSpeedtest(h);
  } catch {
    renderSpeedtest(null);
  }
}

$('speedtest-btn').addEventListener('click', async () => {
  if (speedtestRunning) return;
  speedtestRunning = true;
  const btn = $('speedtest-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Midiendo…';
  $('speedtest-status').textContent = 'Iniciando…';
  try {
    const r = await window.api.runSpeedtest();
    if (r && !r.error && r.result) {
      renderSpeedtest(r.history);
      $('speedtest-status').textContent = `Completado a las ${new Date(r.result.at).toLocaleTimeString()}`;
    } else {
      $('speedtest-status').textContent = 'Falló el test';
    }
  } catch {
    $('speedtest-status').textContent = 'Falló el test';
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Speedtest';
    speedtestRunning = false;
    adjustWindowSize();
  }
});

$('st-reset').addEventListener('click', async () => {
  try {
    const h = await window.api.resetSpeedtestHistory();
    renderSpeedtest(h);
    $('speedtest-status').textContent = 'Récords reiniciados';
    setTimeout(() => {
      if ($('speedtest-status').textContent === 'Récords reiniciados') {
        $('speedtest-status').textContent = '';
      }
    }, 2000);
  } catch {}
});

window.api.onSpeedtestProgress((p) => {
  const labels = {
    ping: 'Midiendo ping…',
    download: 'Midiendo descarga…',
    upload: 'Midiendo subida…',
  };
  $('speedtest-status').textContent = labels[p.phase] || '';
});

// ── AI Usage ───────────────────────────────────────────────────
function aiBarClass(pct) {
  if (pct >= 75) return 'red';
  if (pct >= 50) return 'yellow';
  return '';
}

// `referenceTime` anchors "next occurrence" math to when the data was
// fetched, not to the wall clock at tick time. Without this, a string
// like "Resets 10am" would silently roll forward to tomorrow once 10am
// passes, making the countdown jump to ~23h instead of crossing zero.
function parseResetDate(resetStr, referenceTime) {
  const now = referenceTime || new Date();
  const timeMatch = resetStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
  let hour = 0, minute = 0;
  if (timeMatch) {
    hour = parseInt(timeMatch[1]);
    minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    const ampm = timeMatch[3].toLowerCase();
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
  }
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const dateMatch = resetStr.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/i);
  let target;
  if (dateMatch) {
    const month = months[dateMatch[1].toLowerCase()];
    const day = parseInt(dateMatch[2]);
    target = new Date(now.getFullYear(), month, day, hour, minute, 0);
    if (target < now && (now - target) > 180 * 24 * 3600 * 1000) {
      target.setFullYear(target.getFullYear() + 1);
    }
  } else {
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
  }
  // Convert from ART (UTC-3) to local
  const localOffsetMin = now.getTimezoneOffset();
  const artOffsetMin = 180;
  const diffMin = artOffsetMin - localOffsetMin;
  target = new Date(target.getTime() + diffMin * 60 * 1000);
  return target;
}

// Codex /status prints resets in local time, with formats like
// "23:51" or "18:51 on 28 Apr".
function parseCodexResetDate(resetStr, referenceTime) {
  const now = referenceTime || new Date();
  const timeMatch = resetStr.match(/(\d{1,2}):(\d{2})/);
  let hour = 0, minute = 0;
  if (timeMatch) { hour = parseInt(timeMatch[1]); minute = parseInt(timeMatch[2]); }
  const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
  const dateMatch = resetStr.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i);
  let target;
  if (dateMatch) {
    const day = parseInt(dateMatch[1]);
    const month = months[dateMatch[2].toLowerCase()];
    target = new Date(now.getFullYear(), month, day, hour, minute, 0);
    if (target < now && (now - target) > 180 * 24 * 3600 * 1000) target.setFullYear(target.getFullYear() + 1);
  } else {
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
  }
  return target;
}

function attachResetDates(data, parser, sections, fetchedAt) {
  if (!data) return;
  for (const k of sections) {
    const s = data[k];
    if (s && s.resets) s.resetAt = parser(s.resets, fetchedAt);
  }
}

function fmtCountdown(ms) {
  if (ms <= 0) return '¡Ahora!';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

function fmtNum(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtUSD(n) {
  if (n == null || !isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${n.toFixed(0)}`;
  if (abs >= 100)  return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

function localApiCost(t) {
  if (!t) return 0;
  const p = pricing.claude;
  return (
    (t.input || 0)       * p.perMillionInput +
    (t.output || 0)      * p.perMillionOutput +
    (t.cacheRead || 0)   * p.perMillionCacheRead +
    (t.cacheCreate || 0) * p.perMillionCacheCreate
  ) / 1e6;
}

function planWeeklyCost(plan, pct) {
  if (!plan || pct == null) return null;
  const eq = pricing.planWeeklyEquivalent[plan];
  if (eq == null) return null;
  return (pct / 100) * eq;
}

function aiRow(label, pct, meta, countdownId) {
  if (pct == null) return '';
  const cls = aiBarClass(pct);
  return `
    <div class="ai-row">
      <div class="ai-row-head">
        <span class="ai-row-label">${escapeHtml(label)}</span>
        <span class="ai-row-pct" style="color:${pctColor(pct)}">${pct}%</span>
      </div>
      <div class="ai-row-track"><div class="ai-row-fill ${cls}" style="width:${Math.min(100, pct)}%"></div></div>
      ${meta ? `<div class="ai-row-meta">${meta}</div>` : ''}
      ${countdownId ? `<div class="ai-row-meta">Reinicia en <span class="countdown-value" id="${countdownId}">—</span></div>` : ''}
    </div>`;
}

function renderLocalTokens(local) {
  if (!local) return '';
  const tokenTotal = (t) => (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheCreate || 0);

  const stackedBar = (t) => {
    const total = tokenTotal(t);
    if (total === 0) return `<div class="local-stacked-bar empty"></div>`;
    const inPct    = ((t.input || 0)  / total) * 100;
    const outPct   = ((t.output || 0) / total) * 100;
    const cachePct = (((t.cacheRead || 0) + (t.cacheCreate || 0)) / total) * 100;
    return `
      <div class="local-stacked-bar">
        <div class="seg seg-in"    style="width:${inPct}%"></div>
        <div class="seg seg-out"   style="width:${outPct}%"></div>
        <div class="seg seg-cache" style="width:${cachePct}%"></div>
      </div>`;
  };

  const legend = (t) => `
    <div class="local-legend">
      <span class="leg"><i class="dot dot-in"></i>In <b>${fmtNum(t.input || 0)}</b></span>
      <span class="leg"><i class="dot dot-out"></i>Out <b>${fmtNum(t.output || 0)}</b></span>
      <span class="leg"><i class="dot dot-cache"></i>Cache <b>${fmtNum((t.cacheRead || 0) + (t.cacheCreate || 0))}</b></span>
      <span class="leg leg-msgs">${t.messages || 0} msgs</span>
    </div>`;

  const row = (label, t) => `
    <div class="local-row">
      <div class="local-row-head">
        <span class="local-row-label">${label}</span>
        <span class="local-row-total">${fmtNum(tokenTotal(t))}</span>
      </div>
      ${stackedBar(t)}
      ${legend(t)}
    </div>`;

  const sparkline = () => {
    if (!Array.isArray(local.daily) || !local.daily.length) return '';
    const totals = local.daily.map(d => tokenTotal(d.totals));
    const maxT   = Math.max(1, ...totals);
    const maxM   = Math.max(1, ...local.daily.map(d => d.totals.messages || 0));
    const lastIdx = local.daily.length - 1;
    return `
      <div class="local-spark-title">Últimos 7 días · tokens · mensajes</div>
      <div class="local-sparkline">
        ${local.daily.map((d, i) => {
          const t   = totals[i];
          const msg = d.totals.messages || 0;
          const hT  = t   > 0 ? Math.max(3, (t   / maxT) * 100) : 0;
          const hM  = msg > 0 ? Math.max(3, (msg / maxM) * 100) : 0;
          const isToday = i === lastIdx;
          return `
            <div class="spark-col${isToday ? ' spark-today' : ''}" title="${d.label} ${d.date}&#10;${fmtNum(t)} tokens · ${msg} msgs">
              <div class="spark-track">
                <div class="spark-bar spark-bar-tok" style="height:${hT}%"></div>
                <div class="spark-bar spark-bar-msg" style="height:${hM}%"></div>
              </div>
              <span class="spark-label">${d.label[0]}</span>
            </div>`;
        }).join('')}
      </div>`;
  };

  const todayCost = localApiCost(local.today);
  const weekCost  = localApiCost(local.week);

  return `
    <div class="local-section">
      ${row('Hoy', local.today || {})}
      ${row('7 días', local.week || {})}
      ${sparkline()}
      <div class="api-cost" title="Costo API estimado para estos tokens al pricing de lista de Sonnet.">
        Hoy ≈ <span class="api-cost-value">${fmtUSD(todayCost)}</span>
        <span class="api-cost-sep">·</span>
        7d ≈ <span class="api-cost-value">${fmtUSD(weekCost)}</span>
        <span class="api-cost-suffix">API</span>
      </div>
    </div>`;
}

function aiSkeletonHTML() {
  const skRow = () => `
    <div class="ai-row">
      <div class="ai-row-head"><span class="sk sk-label"></span><span class="sk sk-pct"></span></div>
      <div class="sk sk-track"></div>
    </div>`;
  const skBlock = (rows) => `
    <div class="ai-stack-item">
      <span class="sk sk-provider"></span>
      ${Array.from({ length: rows }, skRow).join('')}
    </div>`;
  return `
    <div class="ai-col">
      ${skBlock(3)}
      ${skBlock(2)}
    </div>
    <div class="ai-col">
      <span class="sk sk-provider"></span>
      <div class="sk sk-track" style="height:14px;margin-top:6px;"></div>
      <span class="sk sk-line" style="margin-top:8px;"></span>
      <span class="sk sk-line short"></span>
    </div>`;
}

function renderAI() {
  const el = $('ai-content');
  if (!aiData) {
    el.innerHTML = aiSkeletonHTML();
    return;
  }
  if (!aiData.available) {
    el.innerHTML = `<div class="ai-loading">Datos de IA no disponibles</div>`;
    return;
  }

  const providerBlocks = [];
  const c = aiData.claude;
  if (c) {
    const parts = [`<div class="ai-provider">Claude${CLAUDE_PLAN ? ' · ' + CLAUDE_PLAN : ''}</div>`];
    if (c.session)    parts.push(aiRow('Sesión',         c.session.pct, '',                                                        'cd-session'));
    if (c.weekAll)    parts.push(aiRow('Semana (todos)', c.weekAll.pct, '',                                                        'cd-week'));
    if (c.weekSonnet) parts.push(aiRow('Semana (Sonnet)', c.weekSonnet.pct, ''));
    if (c.extra)      parts.push(aiRow('Extra',          c.extra.pct,   `<span style="color:#d4d4d8;font-weight:600;">$${c.extra.spent}</span> / $${c.extra.total} gastado`, 'cd-extra'));

    if (c.insight) {
      parts.push(`<div class="ai-row-meta" style="margin-top:6px;color:#fbbf24;">⚡ ${escapeHtml(c.insight)}</div>`);
    }

    if (c.weekAll) {
      const weekCost = planWeeklyCost(CLAUDE_PLAN, c.weekAll.pct);
      const eq = pricing.planWeeklyEquivalent[CLAUDE_PLAN];
      if (weekCost != null) {
        parts.push(`
          <div class="api-cost" title="API equivalente estimado al ${c.weekAll.pct}% del plan ${CLAUDE_PLAN} semanal (≈ ${fmtUSD(eq)}/sem).">
            ≈ <span class="api-cost-value">${fmtUSD(weekCost)}</span>
            <span class="api-cost-suffix">en API · esta semana</span>
          </div>`);
      }
    }
    providerBlocks.push(`<div class="ai-stack-item">${parts.join('')}</div>`);
  }

  const cx = aiData.codex;
  if (cx) {
    const plan = cx.account?.plan;
    const parts = [`<div class="ai-provider">Codex${plan ? ' · ' + escapeHtml(plan) : ''}</div>`];
    if (cx.session5h) parts.push(aiRow('5h limit', cx.session5h.pct, '', 'cd-codex-5h'));
    if (cx.weekly)    parts.push(aiRow('Semanal',  cx.weekly.pct,    '', 'cd-codex-week'));

    if (cx.weekly) {
      const weekCost = planWeeklyCost(plan, cx.weekly.pct);
      const eq = plan ? pricing.planWeeklyEquivalent[plan] : null;
      if (weekCost != null) {
        parts.push(`
          <div class="api-cost" title="API equivalente estimado al ${cx.weekly.pct}% del plan ${plan} semanal (≈ ${fmtUSD(eq)}/sem).">
            ≈ <span class="api-cost-value">${fmtUSD(weekCost)}</span>
            <span class="api-cost-suffix">en API · esta semana</span>
          </div>`);
      }
    }
    providerBlocks.push(`<div class="ai-stack-item">${parts.join('')}</div>`);
  }

  const el11 = aiData.eleven;
  if (el11 && el11.characters && el11.characters.pct != null) {
    const parts = [`<div class="ai-provider">ElevenLabs${el11.tier ? ' · ' + escapeHtml(el11.tier) : ''}</div>`];
    parts.push(aiRow(
      'Caracteres',
      el11.characters.pct,
      `<span style="color:#d4d4d8;font-weight:600;">${fmtNum(el11.characters.used)}</span> / ${fmtNum(el11.characters.limit)} usados`,
      el11.resetUnix ? 'cd-eleven' : null,
    ));
    if (el11.voices && el11.voices.limit != null) {
      parts.push(`<div class="ai-row-meta">Voice slots: <b style="color:#d4d4d8">${el11.voices.used ?? 0} / ${el11.voices.limit}</b></div>`);
    }
    providerBlocks.push(`<div class="ai-stack-item">${parts.join('')}</div>`);
  }

  // Left column: Claude / Codex / ElevenLabs stacked. Right column: Local Tokens.
  const cols = [];
  if (providerBlocks.length) cols.push(`<div class="ai-col">${providerBlocks.join('')}</div>`);
  if (aiData.local) {
    cols.push(`<div class="ai-col"><div class="ai-provider">Local Tokens</div>${renderLocalTokens(aiData.local)}</div>`);
  }

  if (!cols.length) {
    el.innerHTML = `<div class="ai-loading">Sin datos de uso (¿logueaste claude/codex?)</div>`;
  } else {
    el.innerHTML = cols.join('');
  }

  tickCountdowns();
  adjustWindowSize();
}

function tickCountdowns() {
  if (!aiData) return;
  const now = new Date();
  let forceRefresh = false;

  // `rolling5h` sections (Claude Current Session, Codex 5h limit) snap to a
  // fresh 5-hour placeholder when the original reset passes, so the UI matches
  // the new window Claude/Codex actually opens until the next fetch confirms it.
  const updateSection = (prefix, data, section, elId, rolling5h) => {
    const d = data?.[section];
    if (!d || !d.resetAt) return;
    const el = document.getElementById(elId);
    if (!el) return;
    let remaining = d.resetAt.getTime() - now.getTime();
    if (remaining <= 0) {
      const key = `${prefix}:${section}:${d.resetAt.getTime()}`;
      if (!firedResets.has(key)) {
        firedResets.add(key);
        forceRefresh = true;
        if (rolling5h) {
          d.resetAt = new Date(now.getTime() + FIVE_HOURS_MS);
          remaining = FIVE_HOURS_MS;
        }
      }
    }
    el.textContent = fmtCountdown(Math.max(0, remaining));
  };

  updateSection('claude', aiData.claude, 'session', 'cd-session', true);
  updateSection('claude', aiData.claude, 'weekAll', 'cd-week',    false);
  updateSection('claude', aiData.claude, 'extra',   'cd-extra',   false);
  updateSection('codex',  aiData.codex,  'session5h', 'cd-codex-5h',   true);
  updateSection('codex',  aiData.codex,  'weekly',    'cd-codex-week', false);

  const el11 = aiData.eleven;
  if (el11?.resetUnix) {
    const el = document.getElementById('cd-eleven');
    if (el) {
      const remaining = el11.resetUnix * 1000 - now.getTime();
      el.textContent = fmtCountdown(remaining);
      if (remaining <= 0) {
        const key = `eleven:${el11.resetUnix}`;
        if (!firedResets.has(key)) {
          firedResets.add(key);
          forceRefresh = true;
        }
      }
    }
  }

  if (forceRefresh && !aiFetching) refreshAI();
}

async function refreshAI() {
  if (aiFetching) return;
  aiFetching = true;
  const btn = $('ai-refresh');
  btn.classList.add('spinning');
  if (!aiData) renderAI(); // paint skeleton while the first fetch is in flight
  try {
    aiData = await window.api.fetchAIUsage();
  } catch {
    aiData = aiData || { available: false };
  } finally {
    btn.classList.remove('spinning');
    aiFetching = false;
  }
  const fetchedAt = new Date();
  if (aiData) {
    attachResetDates(aiData.claude, parseResetDate,      ['session', 'weekAll', 'extra'], fetchedAt);
    attachResetDates(aiData.codex,  parseCodexResetDate, ['session5h', 'weekly'],         fetchedAt);
  }
  renderAI();
  // Push to main process so the tray icon + tooltip stay in sync.
  if (aiData) {
    if (aiData.claude) window.api.sendUsage(aiData.claude);
    if (aiData.codex)  window.api.sendCodexUsage(aiData.codex);
    if (aiData.eleven && !aiData.eleven.error) window.api.sendElevenUsage(aiData.eleven);
  }
  lastAIRefreshAt = Date.now();
  $('footer-updated').textContent = `Actualizado ${new Date().toLocaleTimeString()}`;
  updateAINextCountdown();
}

function updateAINextCountdown() {
  const el = $('ai-next');
  if (!el) return;
  if (!lastAIRefreshAt) { el.textContent = 'próx. —'; return; }
  const remaining = AI_INTERVAL_MS - (Date.now() - lastAIRefreshAt);
  if (remaining <= 0) { el.textContent = 'próx. ahora'; return; }
  const s = Math.floor(remaining / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  el.textContent = `próx. ${m}:${String(sec).padStart(2, '0')}`;
}

$('ai-refresh').addEventListener('click', refreshAI);

// ── API Keys ───────────────────────────────────────────────────
let apiKeys = [];
const keysList   = $('keys-list');
const keyName    = $('key-name');
const keyValue   = $('key-value');
const keyAddBtn  = $('key-add-btn');
const keyStatus  = $('key-status');

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return key.slice(0, 4) + '•'.repeat(Math.max(8, key.length - 8)) + key.slice(-4);
}

function setKeyStatus(msg, kind) {
  keyStatus.textContent = msg || '';
  keyStatus.className = 'key-status' + (kind ? ` ${kind}` : '');
  if (msg) {
    setTimeout(() => {
      if (keyStatus.textContent === msg) {
        keyStatus.textContent = '';
        keyStatus.className = 'key-status';
      }
    }, 2500);
  }
}

function renderKeys() {
  if (!apiKeys.length) {
    keysList.innerHTML = `<div class="keys-empty">Sin keys guardadas todavía.</div>`;
    adjustWindowSize();
    return;
  }
  keysList.innerHTML = apiKeys.map((k, idx) => {
    const visible = !!k._visible;
    const display = visible ? k.key : maskKey(k.key);
    return `
      <div class="key-card" data-idx="${idx}">
        <div class="key-card-head">
          <span class="key-card-name">${escapeHtml(k.name)}</span>
          <div class="key-card-actions">
            <button class="key-icon-btn js-toggle" title="${visible ? 'Ocultar' : 'Ver'}">${visible ? '🙈' : '👁'}</button>
            <button class="key-icon-btn js-copy" title="Copiar">⧉</button>
            <button class="key-icon-btn danger js-delete" title="Borrar">✕</button>
          </div>
        </div>
        <div class="key-value js-value">${escapeHtml(display)}</div>
      </div>`;
  }).join('');
  adjustWindowSize();

  keysList.querySelectorAll('.key-card').forEach((card) => {
    const idx = +card.dataset.idx;
    card.querySelector('.js-toggle').addEventListener('click', () => {
      apiKeys[idx]._visible = !apiKeys[idx]._visible;
      renderKeys();
    });
    card.querySelector('.js-copy').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      try {
        await navigator.clipboard.writeText(apiKeys[idx].key);
        btn.classList.add('copied');
        btn.textContent = '✓';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.textContent = '⧉';
        }, 1200);
      } catch {
        setKeyStatus('Copia falló', 'error');
      }
    });
    card.querySelector('.js-delete').addEventListener('click', async () => {
      const wasEleven = (apiKeys[idx].name || '').toLowerCase() === 'elevenlabs';
      apiKeys.splice(idx, 1);
      await persistKeys();
      renderKeys();
      if (wasEleven) refreshAI();
    });
  });
}

async function loadKeys() {
  try {
    const list = await window.api.getApiKeys();
    apiKeys = (Array.isArray(list) ? list : []).map((k) => ({
      id: k.id || `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: k.name || '',
      key: k.key || '',
      _visible: false,
    }));
    renderKeys();
  } catch {
    apiKeys = [];
    renderKeys();
  }
}

async function persistKeys() {
  const payload = apiKeys.map(({ id, name, key }) => ({ id, name, key }));
  try {
    await window.api.saveApiKeys(payload);
  } catch {
    setKeyStatus('Guardar falló', 'error');
  }
}

keyAddBtn.addEventListener('click', async () => {
  const name = keyName.value.trim();
  const key  = keyValue.value.trim();
  if (!name || !key) {
    setKeyStatus('Nombre y key son obligatorios', 'error');
    return;
  }
  if (apiKeys.some((k) => k.name.toLowerCase() === name.toLowerCase())) {
    setKeyStatus('Ya existe una key con ese nombre', 'error');
    return;
  }
  apiKeys.push({
    id: `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name, key, _visible: false,
  });
  await persistKeys();
  keyName.value = '';
  keyValue.value = '';
  setKeyStatus('Agregada', 'success');
  renderKeys();
  if (name.toLowerCase() === 'elevenlabs') refreshAI();
});

keyValue.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') keyAddBtn.click();
});

// ── Finanzas ───────────────────────────────────────────────────
const finAccountsEl = $('fin-accounts');
const finExpensesEl = $('fin-expenses');
const finChartsEl = $('fin-charts');
let finHidden = false;        // "hide values" toggle (persisted in the db)
let finHiddenLoaded = false;  // becomes true once we've read the saved state
let finExpSort = 'name';      // gastos y servicios sort: 'name' | 'day' | 'kind'
let finUsdRate = null;        // { compra, venta } from DolarAPI, for UYU↔USD conversion
let finTotals = { uyu: 0, usd: 0 };   // last computed savings totals (per currency)
let finSvc = { uyu: 0, usd: 0 };      // last computed gastos+servicios totals (per currency)
let finLastAccounts = [];     // cached for chart re-render when the rate arrives
let finLastExpenses = [];
let finExpSorted = [];        // latest sorted expenses (shared with the "ver todo" modal)
let finExpModalEl = null;     // the open "ver toda la lista" modal overlay, if any
const FIN_EXP_INLINE_LIMIT = 10; // how many expenses to show inline before "ver todo"

// In-app confirmation modal. We deliberately avoid the native window.confirm():
// on this frameless + transparent + always-on-top window, the OS dialog steals
// keyboard focus and never returns it to the renderer, leaving the inputs unable
// to receive typed text afterwards. An HTML overlay stays inside the renderer.
function finConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fin-modal';
    overlay.innerHTML = `
      <div class="fin-modal-box">
        <div class="fin-modal-msg"></div>
        <div class="fin-modal-actions">
          <button class="fin-btn js-modal-cancel">Cancelar</button>
          <button class="fin-btn danger js-modal-ok">Borrar</button>
        </div>
      </div>`;
    overlay.querySelector('.fin-modal-msg').textContent = message;
    const done = (val) => { overlay.remove(); resolve(val); };
    overlay.querySelector('.js-modal-cancel').addEventListener('click', () => done(false));
    overlay.querySelector('.js-modal-ok').addEventListener('click', () => done(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
    document.body.appendChild(overlay);
  });
}

function fmtMoney(n, cur) {
  const sym = cur === 'USD' ? 'U$S' : '$';
  const v = Number(n).toLocaleString('es-UY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return `${sym} ${v}`;
}

// Plain localized number (no symbol) for prefilling editable inputs.
function fmtPlain(n) {
  return Number(n).toLocaleString('es-UY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function fmtDelta(d, cur) {
  if (d == null) return '<span class="fin-delta none">nuevo</span>';
  if (Math.abs(d) < 0.005) return '<span class="fin-delta flat">=</span>';
  const sym = cur === 'USD' ? 'U$S' : '$';
  const abs = Math.abs(d).toLocaleString('es-UY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const up = d > 0;
  return `<span class="fin-delta ${up ? 'up' : 'down'}">${up ? '+' : '−'}${sym} ${abs}</span>`;
}

function finTimeAgo(ts) {
  if (!ts) return 'sin datos';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'recién';
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  return `hace ${d}d`;
}

const FIN_MASK = '••••';

function accountCardHtml(a) {
  const rows = a.currencies.map((cur) => {
    const key = cur.toLowerCase();
    const cell = a[key];
    const amount = finHidden
      ? `<span class="fin-amt-hidden">${FIN_MASK}</span>`
      : (cell ? fmtMoney(cell.value, cur) : `<span class="fin-amt-empty">—</span>`);
    const delta = finHidden ? '' : (cell ? fmtDelta(cell.delta, cur) : '');
    return `
      <div class="fin-row">
        <span class="fin-cur">${cur === 'USD' ? 'U$S' : '$U'}</span>
        <span class="fin-amt">${amount}</span>
        ${delta}
      </div>`;
  }).join('');

  const inputs = a.currencies.map((cur) => {
    const cell = a[cur.toLowerCase()];
    const ph = (finHidden || !cell) ? (cur === 'USD' ? 'Dólares' : 'Pesos') : fmtPlain(cell.value);
    return `
      <input class="fin-input js-manual" data-cur="${cur}" type="text" inputmode="decimal"
             placeholder="${ph}" autocomplete="off">`;
  }).join('');

  const nameHtml = a.url
    ? `<a class="fin-card-name js-site" href="#" data-url="${escapeHtml(a.url)}" title="Abrir sitio">${escapeHtml(a.name)} <span class="fin-site-arrow">↗</span></a>`
    : `<span class="fin-card-name">${escapeHtml(a.name)}</span>`;

  return `
    <div class="fin-card" data-id="${a.id}">
      <div class="fin-card-head">
        ${nameHtml}
        <span class="fin-card-time">${finTimeAgo(a.ts)}</span>
      </div>
      <div class="fin-rows">${rows}</div>
      <div class="fin-inputs-row">${inputs}</div>
      <div class="fin-actions-row">
        <button class="fin-btn js-save-manual">Guardar</button>
        <button class="fin-btn danger js-clear" title="Borrar entradas de ${escapeHtml(a.name)}">Limpiar</button>
      </div>
      <div class="fin-card-status"></div>
    </div>`;
}

function setCardStatus(card, msg, kind) {
  const el = card.querySelector('.fin-card-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'fin-card-status' + (kind ? ` ${kind}` : '');
}

const EXP_KINDS = ['servicio', 'gasto', 'suscripcion'];
const EXP_KIND_LABELS = { servicio: 'Servicio', gasto: 'Gasto', suscripcion: 'Suscripción' };
function expKind(e) { return EXP_KINDS.includes(e.kind) ? e.kind : 'servicio'; }

function expenseItemHtml(e) {
  const kind = expKind(e);
  const amt = finHidden ? FIN_MASK : fmtMoney(e.amount, e.currency);
  const dayBadge = e.billing_day
    ? `<span class="fin-exp-day-badge" title="Día de cobro">día ${e.billing_day}</span>` : '';
  return `
    <div class="fin-exp-item" data-id="${e.id}">
      <span class="fin-exp-kind fin-exp-kind-${kind}">${EXP_KIND_LABELS[kind]}</span>
      <span class="fin-exp-name">${escapeHtml(e.name)}</span>
      ${dayBadge}
      <span class="fin-exp-amt">${amt}</span>
      <button class="fin-exp-edit js-exp-edit" title="Editar">✎</button>
      <button class="fin-exp-del js-exp-del" title="Borrar">✕</button>
    </div>`;
}

// Attach edit + delete handlers to every expense row inside `container` (used for
// both the inline list and the "ver todo" modal). On success re-renders Finanzas,
// which also refreshes the modal list if it's open.
function wireExpenseRowActions(container) {
  container.querySelectorAll('.js-exp-del').forEach((b) => {
    b.addEventListener('click', async () => {
      const item = b.closest('.fin-exp-item');
      const id = item && item.dataset.id;
      if (!id) return;
      const name = item.querySelector('.fin-exp-name')?.textContent || 'este ítem';
      if (!(await finConfirm(`¿Borrar "${name}"?`))) return;
      b.disabled = true;
      try {
        const r = await window.api.finances.deleteExpense(Number(id));
        if (r && r.ok) await renderFinanzas();
      } catch {} finally { b.disabled = false; }
    });
  });
  container.querySelectorAll('.js-exp-edit').forEach((b) => {
    b.addEventListener('click', () => {
      const item = b.closest('.fin-exp-item');
      const id = item && item.dataset.id;
      if (!id) return;
      const exp = finExpSorted.find((e) => String(e.id) === String(id));
      if (exp) openExpenseEditModal(exp);
    });
  });
}

// Edit modal: a pre-filled form mirroring the "add" fields. Saving updates the
// row in place; the underlying lists/banners refresh via renderFinanzas().
function openExpenseEditModal(e) {
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box fin-exp-edit-box">
      <div class="fin-exp-modal-head">
        <span class="fin-exp-modal-title">Editar gasto / servicio</span>
        <button class="fin-modal-x js-edit-close" title="Cerrar">✕</button>
      </div>
      <input class="fin-input js-edit-name" placeholder="Nombre" autocomplete="off">
      <div class="fin-exp-add-row">
        <input class="fin-input js-edit-amount" type="text" inputmode="decimal" placeholder="Monto" autocomplete="off">
        <select class="fin-select js-edit-cur" title="Moneda">
          <option value="UYU">$U</option>
          <option value="USD">U$S</option>
        </select>
        <select class="fin-select js-edit-kind" title="Tipo">
          <option value="servicio">Servicio</option>
          <option value="gasto">Gasto</option>
          <option value="suscripcion">Suscripción</option>
        </select>
        <input class="fin-input fin-input-day js-edit-day" type="text" inputmode="numeric" placeholder="Día" title="Día de cobro (opcional)" autocomplete="off">
      </div>
      <div class="fin-exp-status js-edit-status"></div>
      <div class="fin-modal-actions">
        <button class="fin-btn js-edit-cancel">Cancelar</button>
        <button class="fin-btn js-edit-save">Guardar</button>
      </div>
    </div>`;

  const nameI = overlay.querySelector('.js-edit-name');
  const amtI = overlay.querySelector('.js-edit-amount');
  const curI = overlay.querySelector('.js-edit-cur');
  const kindI = overlay.querySelector('.js-edit-kind');
  const dayI = overlay.querySelector('.js-edit-day');
  const statusEl = overlay.querySelector('.js-edit-status');
  const saveBtn = overlay.querySelector('.js-edit-save');

  nameI.value = e.name || '';
  amtI.value = e.amount != null ? fmtPlain(e.amount) : '';
  curI.value = String(e.currency || 'UYU').toUpperCase() === 'USD' ? 'USD' : 'UYU';
  kindI.value = expKind(e);
  dayI.value = e.billing_day != null ? e.billing_day : '';

  const close = () => overlay.remove();
  overlay.querySelector('.js-edit-close').addEventListener('click', close);
  overlay.querySelector('.js-edit-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  const setStatus = (msg, kind) => {
    statusEl.textContent = msg || '';
    statusEl.className = 'fin-exp-status js-edit-status' + (kind ? ` ${kind}` : '');
  };

  const save = async () => {
    const name = nameI.value.trim();
    const amount = amtI.value.trim();
    if (!name) { setStatus('Ingresá un nombre', 'error'); return; }
    if (!amount) { setStatus('Ingresá un monto', 'error'); return; }
    saveBtn.disabled = true;
    setStatus('Guardando…');
    try {
      const r = await window.api.finances.updateExpense({
        id: e.id,
        name,
        amount,
        currency: curI.value,
        kind: kindI.value,
        billingDay: dayI.value.trim() || null,
      });
      if (r && r.ok) { close(); await renderFinanzas(); }
      else setStatus((r && r.error) || 'Error', 'error');
    } catch { setStatus('Error', 'error'); }
    finally { saveBtn.disabled = false; }
  };
  saveBtn.addEventListener('click', save);
  [nameI, amtI, dayI].forEach((i) => i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); }));

  document.body.appendChild(overlay);
  nameI.focus();
}

function renderExpenseModalList() {
  if (!finExpModalEl) return;
  const list = finExpModalEl.querySelector('.fin-exp-modal-list');
  const count = finExpModalEl.querySelector('.fin-exp-modal-count');
  if (count) count.textContent = finExpSorted.length ? `${finExpSorted.length} ítems` : '';
  if (!list) return;
  list.innerHTML = finExpSorted.length
    ? finExpSorted.map(expenseItemHtml).join('')
    : '<div class="fin-exp-empty">Sin gastos ni servicios.</div>';
  wireExpenseRowActions(list);
}

function openExpenseModal() {
  if (finExpModalEl) return;
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box fin-exp-modal-box">
      <div class="fin-exp-modal-head">
        <span class="fin-exp-modal-title">Gastos y Servicios <span class="fin-exp-modal-count"></span></span>
        <button class="fin-modal-x js-modal-close" title="Cerrar">✕</button>
      </div>
      <div class="fin-exp-modal-list"></div>
    </div>`;
  const close = () => { overlay.remove(); finExpModalEl = null; };
  overlay.querySelector('.js-modal-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  finExpModalEl = overlay;
  renderExpenseModalList();
}

// ── Finanzas charts (drawn with inline SVG / divs, no libraries) ──
function finDateShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit' });
}

// Area + line chart from a numeric series, scaled into a 100×40 viewBox.
function finAreaChart(values) {
  const n = values.length;
  if (n < 2) return '';
  const W = 100, H = 40, padY = 3;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const x = (i) => (i / (n - 1)) * W;
  const y = (v) => H - padY - ((v - min) / range) * (H - padY * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const line = `M ${pts.join(' L ')}`;
  const area = `M ${x(0).toFixed(2)},${H} L ${pts.join(' L ')} L ${x(n - 1).toFixed(2)},${H} Z`;
  return `
    <svg class="fin-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path class="fin-area-fill" d="${area}"/>
      <path class="fin-area-line" d="${line}"/>
    </svg>`;
}

// Horizontal bars. items: [{ label, value, text, cls }].
function finBars(items) {
  if (!items.length) return '';
  const max = Math.max(1, ...items.map((i) => i.value));
  return `<div class="fin-bars">` + items.map((i) => {
    const pct = i.value > 0 ? Math.max(3, (i.value / max) * 100) : 0;
    const val = finHidden ? FIN_MASK : i.text;
    return `
      <div class="fin-bar-row">
        <span class="fin-bar-label" title="${escapeHtml(i.label)}">${escapeHtml(i.label)}</span>
        <span class="fin-bar-track"><span class="fin-bar-fill ${i.cls || ''}" style="width:${pct.toFixed(1)}%"></span></span>
        <span class="fin-bar-val">${val}</span>
      </div>`;
  }).join('') + `</div>`;
}

// Consolidated totals: everything valued in pesos and in dollars using the
// DolarAPI buy/sell rate (USD→UYU at compra, UYU→USD at venta — liquidation value).
function paintConvertedTotals() {
  const set = (id, uyu, usd) => {
    const el = $(id);
    if (!el) return;
    if (!finUsdRate || !finUsdRate.compra || !finUsdRate.venta) { el.textContent = ''; el.title = ''; return; }
    if (finHidden) { el.textContent = `Total ${FIN_MASK}`; el.title = ''; return; }
    const pesos = uyu + usd * finUsdRate.compra;
    const dolares = usd + uyu / finUsdRate.venta;
    el.textContent = `Total ≈ $U ${fmtPlain(pesos)} · U$S ${fmtPlain(dolares)}`;
    el.title = `USD valuado a compra $${fmtPlain(finUsdRate.compra)} · ` +
               `UYU valuado a venta $${fmtPlain(finUsdRate.venta)}`;
  };
  set('fin-total-conv',     finTotals.uyu, finTotals.usd);
  set('fin-sum-conv',       finTotals.uyu, finTotals.usd);
  set('fin-exp-total-conv', finSvc.uyu,    finSvc.usd);
  set('fin-sum-svc-conv',   finSvc.uyu,    finSvc.usd);
}

async function renderFinanzasCharts(accounts, expenses) {
  if (!finChartsEl) return;
  let history = [];
  try { history = await window.api.finances.getHistory(); } catch {}

  const blocks = [];

  // 1) Ahorros en el tiempo (total UYU).
  const uyuVals = (history || []).map((p) => p.uyu || 0);
  if (uyuVals.length >= 2) {
    const last = uyuVals[uyuVals.length - 1];
    blocks.push(`
      <div class="fin-chart">
        <div class="fin-chart-head">
          <span class="fin-chart-title">Ahorros en el tiempo</span>
          <span class="fin-chart-meta">$U ${finHidden ? FIN_MASK : fmtPlain(last)}</span>
        </div>
        ${finAreaChart(uyuVals)}
        <div class="fin-chart-foot">
          <span>${finDateShort(history[0].ts)}</span>
          <span>${finDateShort(history[history.length - 1].ts)}</span>
        </div>
      </div>`);
  } else {
    blocks.push(`
      <div class="fin-chart">
        <div class="fin-chart-head"><span class="fin-chart-title">Ahorros en el tiempo</span></div>
        <div class="fin-chart-empty">Cargá saldos en al menos 2 fechas para ver la evolución.</div>
      </div>`);
  }

  // 2) Ahorros por cuenta (UYU).
  const accBars = accounts
    .filter((a) => a.uyu && a.uyu.value > 0)
    .map((a) => ({ label: a.name, value: a.uyu.value, text: fmtMoney(a.uyu.value, 'UYU'), cls: 'green' }))
    .sort((x, y) => y.value - x.value);
  blocks.push(`
    <div class="fin-chart">
      <div class="fin-chart-head"><span class="fin-chart-title">Ahorros por cuenta <span class="fin-chart-meta">$U</span></span></div>
      ${accBars.length ? finBars(accBars) : '<div class="fin-chart-empty">Sin saldos en pesos.</div>'}
    </div>`);

  // 3) Gastos y servicios por tipo (en pesos). USD items are converted with the
  //    dollar buy rate so every kind is comparable in one currency; without a
  //    rate yet, USD items fall back to their nominal amount.
  const toUyu = (e) => {
    const amt = e.amount || 0;
    if (String(e.currency).toUpperCase() !== 'USD') return amt;
    return finUsdRate && finUsdRate.compra ? amt * finUsdRate.compra : amt;
  };
  const byKind = { servicio: 0, gasto: 0, suscripcion: 0 };
  for (const e of expenses) byKind[expKind(e)] += toUyu(e);
  const typeBars = [
    { label: 'Servicios',     value: byKind.servicio,    text: fmtMoney(byKind.servicio, 'UYU'),    cls: 'blue' },
    { label: 'Gastos',        value: byKind.gasto,       text: fmtMoney(byKind.gasto, 'UYU'),       cls: 'amber' },
    { label: 'Suscripciones', value: byKind.suscripcion, text: fmtMoney(byKind.suscripcion, 'UYU'), cls: 'violet' },
  ].filter((b) => b.value > 0);
  blocks.push(`
    <div class="fin-chart">
      <div class="fin-chart-head"><span class="fin-chart-title">Gastos y servicios por tipo <span class="fin-chart-meta">$U / mes</span></span></div>
      ${typeBars.length ? finBars(typeBars) : '<div class="fin-chart-empty">Sin gastos en pesos.</div>'}
    </div>`);

  finChartsEl.innerHTML = blocks.join('');
  adjustWindowSize();
}

async function renderFinanzas() {
  if (!finAccountsEl) return;
  let state;
  try {
    state = await window.api.finances.getState();
  } catch {
    finAccountsEl.innerHTML = '<div class="keys-empty">Error cargando finanzas.</div>';
    return;
  }

  const accounts = (state && state.accounts) || [];

  // Initialize the "hide values" toggle from the saved state, once.
  if (!finHiddenLoaded) { finHidden = !!(state && state.hidden); finHiddenLoaded = true; }
  const eyeBtn = $('fin-eye');
  if (eyeBtn) {
    eyeBtn.textContent = finHidden ? '🙈' : '👁';
    eyeBtn.title = finHidden ? 'Mostrar valores' : 'Ocultar valores';
  }

  // Totals per currency across all accounts, plus the aggregate gain/loss vs each
  // account's previous entry (sum of per-account deltas, skipping brand-new ones).
  let totUyu = 0, totUsd = 0;
  let dUyu = 0, dUsd = 0, hasDUyu = false, hasDUsd = false;
  for (const a of accounts) {
    if (a.uyu) {
      totUyu += a.uyu.value;
      if (a.uyu.delta != null) { dUyu += a.uyu.delta; hasDUyu = true; }
    }
    if (a.usd) {
      totUsd += a.usd.value;
      if (a.usd.delta != null) { dUsd += a.usd.delta; hasDUsd = true; }
    }
  }
  const totalUyuEl = $('fin-total-uyu');
  const totalUsdEl = $('fin-total-usd');
  if (totalUyuEl) totalUyuEl.textContent = finHidden ? FIN_MASK : fmtPlain(totUyu);
  if (totalUsdEl) totalUsdEl.textContent = finHidden ? FIN_MASK : fmtPlain(totUsd);
  const totalUyuDeltaEl = $('fin-total-uyu-delta');
  const totalUsdDeltaEl = $('fin-total-usd-delta');
  if (totalUyuDeltaEl) totalUyuDeltaEl.innerHTML = (finHidden || !hasDUyu) ? '' : fmtDelta(dUyu, 'UYU');
  if (totalUsdDeltaEl) totalUsdDeltaEl.innerHTML = (finHidden || !hasDUsd) ? '' : fmtDelta(dUsd, 'USD');

  // Dashboard summary mirrors the estimated total (read-only, no deltas).
  const sumUyuEl = $('fin-sum-uyu');
  const sumUsdEl = $('fin-sum-usd');
  if (sumUyuEl) sumUyuEl.textContent = finHidden ? FIN_MASK : fmtPlain(totUyu);
  if (sumUsdEl) sumUsdEl.textContent = finHidden ? FIN_MASK : fmtPlain(totUsd);

  // Gastos y servicios: monthly totals per currency + dashboard summary.
  const expenses = (state && state.expenses) || [];
  let svcUyu = 0, svcUsd = 0;
  for (const e of expenses) {
    if (String(e.currency).toUpperCase() === 'USD') svcUsd += e.amount || 0;
    else svcUyu += e.amount || 0;
  }

  // Cache for the converted totals + chart re-render when the dollar rate loads.
  finTotals = { uyu: totUyu, usd: totUsd };
  finSvc = { uyu: svcUyu, usd: svcUsd };
  finLastAccounts = accounts;
  finLastExpenses = expenses;
  paintConvertedTotals();

  // Dashboard "Gastos totales" banner.
  const sumSvcUyuEl = $('fin-sum-svc-uyu');
  const sumSvcUsdEl = $('fin-sum-svc-usd');
  const sumSvcCountEl = $('fin-sum-svc-count');
  if (sumSvcUyuEl) sumSvcUyuEl.textContent = finHidden ? FIN_MASK : fmtPlain(svcUyu);
  if (sumSvcUsdEl) sumSvcUsdEl.textContent = finHidden ? FIN_MASK : fmtPlain(svcUsd);
  if (sumSvcCountEl) sumSvcCountEl.textContent = expenses.length
    ? `· ${expenses.length} ${expenses.length === 1 ? 'ítem' : 'ítems'}` : '';
  // Finanzas tab "Gastos totales" banner.
  const expTotUyuEl = $('fin-exp-total-uyu');
  const expTotUsdEl = $('fin-exp-total-usd');
  if (expTotUyuEl) expTotUyuEl.textContent = finHidden ? FIN_MASK : fmtPlain(svcUyu);
  if (expTotUsdEl) expTotUsdEl.textContent = finHidden ? FIN_MASK : fmtPlain(svcUsd);

  // Reflect the active sort in the toggle buttons.
  document.querySelectorAll('.fin-sort-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === finExpSort);
  });

  if (finExpensesEl) {
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' });
    const KIND_RANK = { gasto: 0, servicio: 1, suscripcion: 2 };
    finExpSorted = expenses.slice().sort((a, b) => {
      if (finExpSort === 'day') {
        // Sort by billing day (ascending); items without a day go last,
        // ties broken by name.
        const da = a.billing_day == null ? Infinity : a.billing_day;
        const dbb = b.billing_day == null ? Infinity : b.billing_day;
        return da !== dbb ? da - dbb : byName(a, b);
      }
      if (finExpSort === 'kind') {
        // Group by type (gasto, servicio, suscripción), then by name.
        const ra = KIND_RANK[expKind(a)] ?? 9;
        const rb = KIND_RANK[expKind(b)] ?? 9;
        return ra !== rb ? ra - rb : byName(a, b);
      }
      return byName(a, b);
    });

    if (!finExpSorted.length) {
      finExpensesEl.innerHTML = '<div class="fin-exp-empty">Sin gastos ni servicios. Agregá uno arriba.</div>';
    } else {
      const shown = finExpSorted.slice(0, FIN_EXP_INLINE_LIMIT);
      const more = finExpSorted.length - shown.length;
      finExpensesEl.innerHTML = shown.map(expenseItemHtml).join('')
        + (more > 0
          ? `<button class="fin-exp-viewall js-exp-viewall">Ver toda la lista (${finExpSorted.length})</button>`
          : '');
      wireExpenseRowActions(finExpensesEl);
      const viewAll = finExpensesEl.querySelector('.js-exp-viewall');
      if (viewAll) viewAll.addEventListener('click', openExpenseModal);
    }

    // Keep the "ver todo" modal in sync if it's open.
    if (finExpModalEl) renderExpenseModalList();
  }

  finAccountsEl.innerHTML = accounts.map(accountCardHtml).join('');
  adjustWindowSize();

  finAccountsEl.querySelectorAll('.fin-card').forEach((card) => {
    const id = card.dataset.id;

    const saveManualBtn = card.querySelector('.js-save-manual');
    if (saveManualBtn) {
      saveManualBtn.addEventListener('click', async () => {
        const payload = { accountId: id, uyu: null, usd: null };
        card.querySelectorAll('.js-manual').forEach((inp) => {
          const cur = inp.dataset.cur;
          const v = inp.value.trim();
          if (v !== '') payload[cur.toLowerCase()] = v.replace(/\./g, '').replace(',', '.');
        });
        if (payload.uyu == null && payload.usd == null) {
          setCardStatus(card, 'Ingresá al menos un monto', 'error');
          return;
        }
        saveManualBtn.disabled = true;
        setCardStatus(card, 'Guardando…');
        try {
          const r = await window.api.finances.saveManual(payload);
          if (r && r.ok) { await renderFinanzas(); }
          else setCardStatus(card, (r && r.error) || 'Error', 'error');
        } catch { setCardStatus(card, 'Error', 'error'); }
        finally { saveManualBtn.disabled = false; }
      });
    }

    const siteLink = card.querySelector('.js-site');
    if (siteLink) {
      siteLink.addEventListener('click', (e) => {
        e.preventDefault();
        const url = siteLink.dataset.url;
        if (url) window.api.openExternal(url);
      });
    }

    const clearBtn = card.querySelector('.js-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        const name = card.querySelector('.fin-card-name')?.textContent || 'esta cuenta';
        if (!(await finConfirm(`¿Borrar todas las entradas de ${name}?`))) return;
        clearBtn.disabled = true;
        setCardStatus(card, 'Limpiando…');
        try {
          const r = await window.api.finances.clearAccount(id);
          if (r && r.ok) { await renderFinanzas(); }
          else setCardStatus(card, (r && r.error) || 'Error', 'error');
        } catch { setCardStatus(card, 'Error', 'error'); }
        finally { clearBtn.disabled = false; }
      });
    }
  });

  renderFinanzasCharts(accounts, expenses);
}

// "Limpiar todo" lives in the static total banner, so wire it up once.
(function wireClearAll() {
  const btn = $('fin-clear-all');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!(await finConfirm('¿Borrar TODAS las entradas de todas las cuentas? Esta acción no se puede deshacer.'))) return;
    btn.disabled = true;
    try {
      await window.api.finances.clearAll();
      await renderFinanzas();
    } catch {}
    finally { btn.disabled = false; }
  });
})();

// Eye toggle: hide/show all Finanzas values; the state is persisted in the db.
(function wireEyeToggle() {
  const btn = $('fin-eye');
  if (!btn) return;
  btn.addEventListener('click', () => {
    finHidden = !finHidden;
    finHiddenLoaded = true; // don't let the next render overwrite the choice
    window.api.finances.setHidden(finHidden);
    renderFinanzas();
  });
})();

// Dashboard "Finanzas" summary card → jump to the full Finanzas tab.
(function wireSummaryCard() {
  const card = $('fin-summary-card');
  if (!card) return;
  card.addEventListener('click', () => switchTab('finanzas'));
})();

// Gastos y Servicios sort toggle (Nombre / Fecha).
(function wireExpenseSort() {
  document.querySelectorAll('.fin-sort-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const next = b.dataset.sort;
      if (next === finExpSort) return;
      finExpSort = next;
      renderFinanzas();
    });
  });
})();

// "Gastos y Servicios" add form (lives in the Finanzas tab, wired once).
(function wireExpenseAdd() {
  const btn = $('fin-exp-add-btn');
  if (!btn) return;
  const nameI = $('fin-exp-name'), amtI = $('fin-exp-amount'),
        curI = $('fin-exp-cur'), kindI = $('fin-exp-kind'), dayI = $('fin-exp-day'),
        statusEl = $('fin-exp-status');
  const setStatus = (msg, kind) => {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.className = 'fin-exp-status' + (kind ? ` ${kind}` : '');
  };
  const submit = async () => {
    const name = nameI.value.trim();
    const amount = amtI.value.trim();
    if (!name) { setStatus('Ingresá un nombre', 'error'); return; }
    if (!amount) { setStatus('Ingresá un monto', 'error'); return; }
    btn.disabled = true;
    setStatus('Guardando…');
    try {
      const r = await window.api.finances.addExpense({
        name,
        amount,
        currency: curI.value,
        kind: kindI.value,
        billingDay: dayI.value.trim() || null,
      });
      if (r && r.ok) {
        nameI.value = ''; amtI.value = ''; dayI.value = '';
        setStatus('');
        await renderFinanzas();
        nameI.focus();
      } else {
        setStatus((r && r.error) || 'Error', 'error');
      }
    } catch { setStatus('Error', 'error'); }
    finally { btn.disabled = false; }
  };
  btn.addEventListener('click', submit);
  [nameI, amtI, dayI].forEach((i) => {
    if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
})();

// ── Settings ───────────────────────────────────────────────────
const autoLaunchCheckbox = $('setting-autolaunch');
const settingStatus = $('setting-status');

function setSettingStatus(msg, kind) {
  settingStatus.textContent = msg || '';
  settingStatus.className = 'setting-status' + (kind ? ` ${kind}` : '');
  if (msg) {
    setTimeout(() => {
      if (settingStatus.textContent === msg) {
        settingStatus.textContent = '';
        settingStatus.className = 'setting-status';
      }
    }, 2500);
  }
}

async function loadSettings() {
  try {
    const enabled = await window.api.getAutoLaunch();
    autoLaunchCheckbox.checked = !!enabled;
  } catch {
    autoLaunchCheckbox.checked = false;
  }
}

autoLaunchCheckbox.addEventListener('change', async () => {
  const desired = autoLaunchCheckbox.checked;
  try {
    const actual = await window.api.setAutoLaunch(desired);
    autoLaunchCheckbox.checked = !!actual;
    if (actual === desired) {
      setSettingStatus(desired ? 'Se iniciará al inicio' : 'Auto-launch desactivado', 'success');
    } else {
      setSettingStatus('No se pudo actualizar', 'error');
    }
  } catch {
    autoLaunchCheckbox.checked = !desired;
    setSettingStatus('No se pudo actualizar', 'error');
  }
});

// ── Init ───────────────────────────────────────────────────────
(async () => {
  try {
    cfg = await window.api.getConfig();
    if (cfg?.refreshMinutesAI > 0) AI_INTERVAL_MS = cfg.refreshMinutesAI * 60 * 1000;
    if (cfg?.pricing) {
      if (cfg.pricing.claude) {
        pricing.claude = { ...pricing.claude, ...cfg.pricing.claude };
      }
      if (cfg.pricing.planWeeklyEquivalent) {
        pricing.planWeeklyEquivalent = {
          ...pricing.planWeeklyEquivalent,
          ...cfg.pricing.planWeeklyEquivalent,
        };
      }
    }
  } catch {}

  updateClock();
  setInterval(() => { updateClock(); tickCountdowns(); updateAINextCountdown(); }, 1000);

  await refreshSystem();
  setInterval(refreshSystem, SYS_INTERVAL_MS);

  refreshWeather();
  setInterval(refreshWeather, WEATHER_INTERVAL_MS);

  refreshMarkets();
  setInterval(refreshMarkets, MARKETS_INTERVAL_MS);

  refreshAI();
  setInterval(refreshAI, AI_INTERVAL_MS);

  loadSpeedtest();

  renderFinanzas();

  // Tray "Refresh now" → re-fetch everything except speedtest (manual).
  window.api.onRefresh(() => {
    refreshSystem();
    refreshWeather();
    refreshMarkets();
    refreshAI();
  });

  adjustWindowSize();
  window.addEventListener('load', adjustWindowSize);
})();
