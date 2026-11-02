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
const WEATHER_INTERVAL_MS = 15 * 60 * 1000;  // clima: cada 15 min
const MARKETS_INTERVAL_MS = 15 * 60 * 1000;  // crypto + divisas: cada 15 min
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

// Debounce: retrasa la ejecución hasta que dejan de pasar eventos por `wait` ms.
// Lo usan los buscadores que le pegan a una API para buscar en vivo mientras se
// escribe sin disparar una request por cada tecla.
function debounce(fn, wait = 350) {
  let t = null;
  return function (...args) {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn.apply(this, args); }, wait);
  };
}

// Limpiar los buscadores del tab usando su misma ruta de filtrado en vivo.
['yify', 'ez', 'gd'].forEach((prefix) => {
  const input = $(`${prefix}-search`);
  const clear = $(`${prefix}-search-clear`);
  if (!input || !clear) return;
  clear.addEventListener('click', () => {
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
});

document.getElementById('btn-min').addEventListener('click', () => window.api.minimize());
document.getElementById('btn-max').addEventListener('click', () => window.api.maximize());
document.getElementById('btn-close').addEventListener('click', () => window.api.close());

// Toggle full-monitor mode: enables vertical scroll + square corners and flips
// the button affordance. Driven by the main process so the state always matches
// the actual window geometry.
if (window.api.onWindowMaximized) window.api.onWindowMaximized((isMax) => {
  document.body.classList.toggle('maximized', isMax);
  const b = document.getElementById('btn-max');
  if (b) b.title = isMax ? 'Restaurar' : 'Maximizar / ajustar al monitor';
});

// ── Tabs ───────────────────────────────────────────────────────
const tabButtons = document.querySelectorAll('.tab');
const tabPanels = {
  dashboard: document.getElementById('tab-dashboard'),
  finanzas: document.getElementById('tab-finanzas'),
  torrents: document.getElementById('tab-torrents'),
  series: document.getElementById('tab-series'),
  juegos: document.getElementById('tab-juegos'),
  reddit: document.getElementById('tab-reddit'),
  noticias: document.getElementById('tab-noticias'),
  github: document.getElementById('tab-github'),
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
  if (target === 'juegos') initGames();    // lazy: primera vez que se abre
  if (target === 'reddit') initReddit();
  if (target === 'noticias') initNews();
  if (target === 'github') initGithub();
  adjustWindowSize();
}
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// ── Auto-resize window to content ──────────────────────────────
// El Dashboard define el alto de la ventana; el resto de tabs se fija a ese
// mismo alto (clase .tab-scroll + --tab-h) y scrollea por dentro si su
// contenido es más largo. En maximizado scrollea el .widget entero, así que
// ahí no se fija nada.
let resizeRaf = null;
let dashHeight = 0;   // alto natural del dashboard (última medición visible)
function adjustWindowSize() {
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    const widget = document.querySelector('.widget');
    if (!widget) return;
    // Alto del top fijo (controles + menú): el reloj sticky se ancla debajo.
    const top = document.querySelector('.widget-top');
    if (top) document.documentElement.style.setProperty('--topbar-h', top.offsetHeight + 'px');
    const active = document.querySelector('.screen:not(.hidden)');
    const isDash = !active || active.id === 'tab-dashboard';
    // Medición con altura natural (sin el alto fijo de una pasada anterior).
    if (active) active.classList.remove('tab-scroll');
    const natural = Math.ceil(widget.getBoundingClientRect().height);
    const report = (h) => { if (window.api && window.api.resizeContent) window.api.resizeContent(h); };
    if (isDash || document.body.classList.contains('maximized')) {
      if (isDash) dashHeight = natural;
      report(natural);
      return;
    }
    if (dashHeight > 0) {
      // Alto disponible para la screen = alto del dashboard menos el chrome
      // que la rodea (top fijo arriba y, si lo hubiera, borde inferior).
      const wRect = widget.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      const chrome = Math.ceil((aRect.top - wRect.top) + Math.max(0, wRect.bottom - aRect.bottom));
      const avail = Math.max(120, dashHeight - chrome);
      document.documentElement.style.setProperty('--tab-h', avail + 'px');
      active.classList.add('tab-scroll');
      report(dashHeight);
    } else {
      report(natural);
    }
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
  if (pct >= 85) return 'var(--danger)';
  if (pct >= 65) return 'var(--warn)';
  return 'var(--ok)';
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
    // Color fijo de marca por gauge (CPU violeta / RAM cian), definido en CSS.
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
// De noche los iconos con sol no tienen sentido: despejado → luna, con algo
// de nube → luna con nube (compuesta con CSS, no hay emoji), sol con lluvia →
// nube con lluvia. Nublado, tormenta, nieve y niebla son iguales día y noche.
const NIGHT_EMOJI = { 0: '🌙', 51: '🌧', 53: '🌧', 61: '🌧', 80: '🌧' };
const MOON_CLOUD = { 1: 'few', 2: 'some' };   // WMO 1: nube chica · 2: nube grande

function weatherIconHtml(x, isDay) {
  const code = x.code;
  if (!isDay && MOON_CLOUD[code]) {
    return `<span class="wx-moon-cloud ${MOON_CLOUD[code]}" title="${escapeHtml(x.label || '')}">` +
      `<span class="wx-moon">🌙</span><span class="wx-cloud">☁</span></span>`;
  }
  if (!isDay && NIGHT_EMOJI[code]) return NIGHT_EMOJI[code];
  return x.emoji || '•';
}

// Día/noche por la hora actual contra amanecer/atardecer del lugar (hoy y
// mañana). Si el API no los trae (latitudes polares) cae en su is_day.
function isDayNow(w) {
  const t = Date.now();
  const spans = [w.today, w.tomorrow].filter((d) => d && d.sunriseMs && d.sunsetMs);
  if (!spans.length) return w.current?.isDay !== false;
  return spans.some((d) => t >= d.sunriseMs && t < d.sunsetMs);
}

// Re-dibuja justo al cruzar el próximo amanecer/atardecer, así el icono cambia
// a la hora exacta y no recién en el próximo refresco (cada 15 min).
let dayNightTimer = null;
function scheduleDayNightRender(w) {
  clearTimeout(dayNightTimer);
  const t = Date.now();
  const next = [w.today, w.tomorrow]
    .flatMap((d) => (d ? [d.sunriseMs, d.sunsetMs] : []))
    .filter((ms) => ms && ms > t)
    .sort((a, b) => a - b)[0];
  if (!next) return;
  dayNightTimer = setTimeout(() => { if (weatherData === w) renderWeather(w); },
    Math.min(next - t + 1000, 0x7fffffff));
}

// Fondo animado de la card según el tiempo actual. Prioridad: lluvia (códigos
// WMO de llovizna, lluvia, chaparrones y tormenta) → viento (≥ 20 km/h o
// ráfagas ≥ 40) → sol (despejado de día). Nublado, nieve, niebla y noche: nada.
function weatherFx(c, isDay) {
  const code = c.code;
  const wind = c.wind || 0;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) {
    const heavy = code === 65 || code === 67 || code === 82 || code >= 95;
    return { kind: 'rain', count: heavy ? 44 : (code <= 57 ? 16 : 28), slant: Math.min(25, Math.round(wind / 2)) };
  }
  if (wind >= 20 || (c.gusts || 0) >= 40) {
    // Segundos que tarda una ráfaga en cruzar la card: más viento, más rápido.
    return { kind: 'wind', count: wind >= 40 ? 14 : 10, speed: Math.min(3, Math.max(0.8, 60 / Math.max(wind, 20))) };
  }
  if (isDay && code <= 1) return { kind: 'sun' };
  return null;
}

function renderWeatherFx(c, isDay) {
  const el = $('weather-fx');
  if (!el) return;
  const fx = weatherFx(c || {}, isDay);
  const key = fx ? JSON.stringify(fx) : '';
  if (el.dataset.key === key) return;   // mismo efecto: no reiniciar la animación
  el.dataset.key = key;
  el.className = 'wx-fx' + (fx ? ` ${fx.kind}` : '');
  el.style.setProperty('--wx-slant', fx?.slant || 0);
  const rnd = (min, max) => (min + Math.random() * (max - min)).toFixed(2);
  const particle = {
    rain: () => `<i style="left:${rnd(0, 100)}%;animation-duration:${rnd(0.6, 1.1)}s;animation-delay:-${rnd(0, 1.1)}s;opacity:${rnd(0.4, 1)}"></i>`,
    wind: () => `<i style="top:${rnd(6, 94)}%;--w:${rnd(30, 70)}px;animation-duration:${rnd(fx.speed * 0.8, fx.speed * 1.4)}s;animation-delay:-${rnd(0, fx.speed * 1.4)}s"></i>`,
  }[fx?.kind];
  el.innerHTML = particle ? Array.from({ length: fx.count }, particle).join('') : '';
}

function renderWeather(w) {
  const grid = $('weather-grid');
  if (!w || w.error) {
    grid.innerHTML = `<div class="weather-loading">Clima no disponible</div>`;
    renderWeatherFx(null);
    return;
  }
  $('weather-loc').textContent = w.location || '';

  const c = w.current || {};
  const today = w.today || {};
  const tom = w.tomorrow || {};
  const isDay = isDayNow(w);

  grid.innerHTML = `
    <div class="weather-cell now">
      <div class="weather-icon">${weatherIconHtml(c, isDay)}</div>
      <div class="weather-info">
        <div class="weather-when">Ahora · ${escapeHtml(c.label || '')}</div>
        <div class="weather-temp">${fmtTemp(c.temp)}</div>
        <div class="weather-detail">
          Sensación <b>${fmtTemp(c.feels)}</b> ·
          Humedad <b>${c.humidity != null ? c.humidity + '%' : '—'}</b> ·
          Viento <b>${c.wind != null ? c.wind + ' km/h' : '—'}</b>
        </div>
        ${airDetailHtml(w.air)}
      </div>
    </div>
    <div class="weather-cell">
      <div class="weather-icon">${today.emoji || '•'}</div>
      <div class="weather-info">
        <div class="weather-when">Hoy</div>
        <div class="weather-temp">${fmtTemp(today.max)}<span style="font-size:60%;color:var(--text-dim)"> / ${fmtTemp(today.min)}</span></div>
        <div class="weather-detail">Lluvia <b>${today.rainPct != null ? today.rainPct + '%' : '—'}</b></div>
      </div>
    </div>
    <div class="weather-cell">
      <div class="weather-icon">${tom.emoji || '•'}</div>
      <div class="weather-info">
        <div class="weather-when">Mañana</div>
        <div class="weather-temp">${fmtTemp(tom.max)}<span style="font-size:60%;color:var(--text-dim)"> / ${fmtTemp(tom.min)}</span></div>
        <div class="weather-detail">Lluvia <b>${tom.rainPct != null ? tom.rainPct + '%' : '—'}</b></div>
      </div>
    </div>
  `;
  renderWeatherFx(c, isDay);
  scheduleDayNightRender(w);
  adjustWindowSize();
  if (wxModalEl) renderWxModal();
}

function fmtTemp(t) {
  if (t == null || !isFinite(t)) return '—';
  return Math.round(t) + '°';
}

// Calidad del aire (US AQI) + UV, bajo el detalle de "Ahora". Colores por
// banda oficial del AQI; UV por la escala de la OMS.
function aqiBand(aqi) {
  if (aqi <= 50) return ['Buena', 'good'];
  if (aqi <= 100) return ['Moderada', 'mod'];
  if (aqi <= 150) return ['Sensibles', 'usg'];
  if (aqi <= 200) return ['Mala', 'bad'];
  if (aqi <= 300) return ['Muy mala', 'vbad'];
  return ['Peligrosa', 'haz'];
}
function uvBand(uv) {
  if (uv < 3) return ['bajo', 'good'];
  if (uv < 6) return ['moderado', 'mod'];
  if (uv < 8) return ['alto', 'usg'];
  if (uv < 11) return ['muy alto', 'bad'];
  return ['extremo', 'vbad'];
}
function airDetailHtml(air) {
  if (!air || (air.aqi == null && air.uv == null)) return '';
  const bits = [];
  if (air.aqi != null) {
    const [label, cls] = aqiBand(air.aqi);
    bits.push(`Aire <b class="air-${cls}" title="US AQI ${air.aqi}${air.pm25 != null ? ` · PM2.5 ${air.pm25} µg/m³` : ''}">${air.aqi} ${label}</b>`);
  }
  if (air.uv != null) {
    const [label, cls] = uvBand(air.uv);
    bits.push(`UV <b class="air-${cls}">${Math.round(air.uv * 10) / 10} ${label}</b>`);
  }
  return `<div class="weather-detail">${bits.join(' · ')}</div>`;
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

// ── Modal de clima: detalle de ahora + pronóstico de la semana ──
// Se abre al hacer click en la card. Usa el mismo weatherData del dashboard
// (sin fetch propio) y se re-dibuja si llega un refresco con el modal abierto.
let wxModalEl = null;
const WX_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const WX_DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function wxDir(deg) {
  return deg == null || !isFinite(deg) ? '' : WX_DIRS[Math.round(deg / 45) % 8];
}
function wxNum(v, unit, digits = 0) {
  if (v == null || !isFinite(v)) return '—';
  const f = 10 ** digits;
  return `${Math.round(v * f) / f}${unit}`;
}
// "2026-10-05T06:15" (hora local del lugar) → "06:15"
function wxClock(s) {
  return typeof s === 'string' && s.length >= 16 ? s.slice(11, 16) : '—';
}
function wxDayName(d, i) {
  if (i === 0) return 'Hoy';
  if (i === 1) return 'Mañana';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d.date || '');
  if (!m) return '—';
  return `${WX_DOW[new Date(+m[1], +m[2] - 1, +m[3]).getDay()]} ${+m[3]}`;
}

function renderWxModal() {
  if (!wxModalEl) return;
  const body = wxModalEl.querySelector('.js-wx-body');
  const w = weatherData;
  if (!w || w.error) {
    body.innerHTML = '<div class="weather-loading">Clima no disponible</div>';
    return;
  }
  wxModalEl.querySelector('.js-wx-loc').textContent = w.location ? ` · ${w.location}` : '';
  const c = w.current || {};
  const today = w.today || {};
  const air = w.air || {};
  const days = Array.isArray(w.days) && w.days.length ? w.days : [w.today, w.tomorrow].filter(Boolean);

  const tiles = [
    ['Humedad', wxNum(c.humidity, '%')],
    ['Viento', `${wxNum(c.wind, ' km/h')} ${wxDir(c.windDir)}`],
    ['Ráfagas', wxNum(c.gusts, ' km/h')],
    ['Presión', wxNum(c.pressure, ' hPa')],
    ['Nubosidad', wxNum(c.clouds, '%')],
    ['Precipitación', wxNum(c.precip, ' mm', 1)],
    ['Punto de rocío', fmtTemp(c.dewPoint)],
    ['Visibilidad', c.visibility != null ? wxNum(c.visibility / 1000, ' km', 1) : '—'],
  ];
  if (air.uv != null) {
    const [label, cls] = uvBand(air.uv);
    tiles.push(['UV', `<span class="air-${cls}">${wxNum(air.uv, '', 1)} ${label}</span>`]);
  }
  if (air.aqi != null) {
    const [label, cls] = aqiBand(air.aqi);
    tiles.push(['Aire (US AQI)', `<span class="air-${cls}">${air.aqi} ${label}</span>`]);
  }
  if (air.pm25 != null) tiles.push(['PM2.5', wxNum(air.pm25, ' µg/m³', 1)]);
  if (air.pm10 != null) tiles.push(['PM10', wxNum(air.pm10, ' µg/m³', 1)]);
  tiles.push(['Amanecer', wxClock(today.sunrise)], ['Atardecer', wxClock(today.sunset)]);

  // Barra min–max de cada día, posicionada sobre el rango de toda la semana.
  const mins = days.map((d) => d.min).filter((v) => v != null && isFinite(v));
  const maxs = days.map((d) => d.max).filter((v) => v != null && isFinite(v));
  const lo = mins.length ? Math.min(...mins) : 0;
  const hi = maxs.length ? Math.max(...maxs) : 0;
  const span = hi - lo || 1;

  body.innerHTML = `
    <div class="weather-cell now wx-now">
      <div class="weather-icon">${weatherIconHtml(c, isDayNow(w))}</div>
      <div class="weather-info">
        <div class="weather-when">Ahora · ${escapeHtml(c.label || '')}</div>
        <div class="weather-temp">${fmtTemp(c.temp)}</div>
        <div class="weather-detail">
          Sensación <b>${fmtTemp(c.feels)}</b> ·
          Hoy <b>${fmtTemp(today.max)}</b> / ${fmtTemp(today.min)}
        </div>
      </div>
    </div>
    <div class="wx-tiles">
      ${tiles.map(([k, v]) => `
        <div class="wx-tile"><span class="wx-tile-k">${k}</span><span class="wx-tile-v">${v}</span></div>`).join('')}
    </div>
    <div class="yify-cast-title">Próximos ${days.length} días</div>
    <div class="wx-week">
      ${days.map((d, i) => {
        const ok = d.min != null && d.max != null;
        const left = ok ? ((d.min - lo) / span) * 100 : 0;
        const width = ok ? Math.max(((d.max - d.min) / span) * 100, 4) : 0;
        return `
        <div class="wx-day" title="${escapeHtml(d.label || '')}">
          <span class="wx-day-name">${wxDayName(d, i)}</span>
          <span class="wx-day-icon">${d.emoji || '•'}</span>
          <span class="wx-day-label">${escapeHtml(d.label || '')}</span>
          <span class="wx-day-rain" title="Probabilidad de lluvia · acumulado">💧 ${wxNum(d.rainPct, '%')}${d.rainMm ? ` · ${wxNum(d.rainMm, ' mm', 1)}` : ''}</span>
          <span class="wx-day-wind" title="Viento máximo · ráfagas ${wxNum(d.gustMax, ' km/h')}">🌬 ${wxNum(d.windMax, '')} ${wxDir(d.windDir)}</span>
          <span class="wx-day-min">${fmtTemp(d.min)}</span>
          <span class="wx-day-bar"><i style="left:${left}%;width:${Math.min(width, 100 - left)}%"></i></span>
          <span class="wx-day-max">${fmtTemp(d.max)}</span>
        </div>`;
      }).join('')}
    </div>`;
}

function wxModalEsc(e) { if (e.key === 'Escape') closeWxModal(); }
function closeWxModal() {
  if (!wxModalEl) return;
  document.removeEventListener('keydown', wxModalEsc);
  wxModalEl.remove();
  wxModalEl = null;
}
function openWxModal() {
  closeWxModal();
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box wx-modal-box">
      <div class="fin-exp-modal-head">
        <span class="fin-exp-modal-title">🌤 Clima<span class="fin-exp-modal-count js-wx-loc"></span></span>
        <button class="fin-modal-x js-wx-x" title="Cerrar">✕</button>
      </div>
      <div class="wx-modal-body js-wx-body"></div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeWxModal(); });
  overlay.querySelector('.js-wx-x').addEventListener('click', closeWxModal);
  document.addEventListener('keydown', wxModalEsc);
  document.body.appendChild(overlay);
  wxModalEl = overlay;
  renderWxModal();
}

$('weather-grid').addEventListener('click', () => {
  if (weatherData && !weatherData.error) openWxModal();
});

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

// ── Iconitos del card Mercado ──────────────────────────────────
// Banderas y logos de cripto van como SVG inline: no dependen de la red y
// evitan los emoji de bandera (Windows no los dibuja: muestra "US", "AR"…).
// Los logos de acciones sí son remotos (Finnhub) con monograma de respaldo.
const FLAG_SVG = {
  USD: `<rect width="21" height="15" fill="#fff"/>
    <g fill="#b22234"><rect width="21" height="1.16"/><rect y="2.31" width="21" height="1.16"/>
    <rect y="4.62" width="21" height="1.16"/><rect y="6.92" width="21" height="1.16"/>
    <rect y="9.23" width="21" height="1.16"/><rect y="11.54" width="21" height="1.16"/>
    <rect y="13.85" width="21" height="1.16"/></g>
    <rect width="8.6" height="8.08" fill="#3c3b6e"/>
    <g fill="#fff"><circle cx="1.6" cy="1.6" r=".42"/><circle cx="3.4" cy="1.6" r=".42"/>
    <circle cx="5.2" cy="1.6" r=".42"/><circle cx="7" cy="1.6" r=".42"/>
    <circle cx="2.5" cy="4" r=".42"/><circle cx="4.3" cy="4" r=".42"/><circle cx="6.1" cy="4" r=".42"/>
    <circle cx="1.6" cy="6.4" r=".42"/><circle cx="3.4" cy="6.4" r=".42"/>
    <circle cx="5.2" cy="6.4" r=".42"/><circle cx="7" cy="6.4" r=".42"/></g>`,
  ARS: `<rect width="21" height="15" fill="#fff"/>
    <rect width="21" height="5" fill="#74acdf"/><rect y="10" width="21" height="5" fill="#74acdf"/>
    <circle cx="10.5" cy="7.5" r="2.3" fill="#f6b40e" opacity=".45"/>
    <circle cx="10.5" cy="7.5" r="1.5" fill="#f6b40e"/>`,
  BRL: `<rect width="21" height="15" fill="#009b3a"/>
    <path d="M10.5 1.6 19.3 7.5 10.5 13.4 1.7 7.5Z" fill="#fedf00"/>
    <circle cx="10.5" cy="7.5" r="3.1" fill="#002776"/>
    <path d="M7.5 7.4Q10.5 5.4 13.5 8Q10.5 6.6 7.5 8.1Z" fill="#fff"/>`,
  EUR: `<rect width="21" height="15" fill="#039"/>
    <g fill="#fc0"><circle cx="10.5" cy="3.2" r=".62"/><circle cx="12.65" cy="3.78" r=".62"/>
    <circle cx="14.22" cy="5.35" r=".62"/><circle cx="14.8" cy="7.5" r=".62"/>
    <circle cx="14.22" cy="9.65" r=".62"/><circle cx="12.65" cy="11.22" r=".62"/>
    <circle cx="10.5" cy="11.8" r=".62"/><circle cx="8.35" cy="11.22" r=".62"/>
    <circle cx="6.78" cy="9.65" r=".62"/><circle cx="6.2" cy="7.5" r=".62"/>
    <circle cx="6.78" cy="5.35" r=".62"/><circle cx="8.35" cy="3.78" r=".62"/></g>`,
  UYU: `<rect width="21" height="15" fill="#fff"/>
    <g fill="#0038a8"><rect x="8.4" y="1.67" width="12.6" height="1.67"/>
    <rect x="8.4" y="5" width="12.6" height="1.67"/>
    <rect y="8.33" width="21" height="1.67"/><rect y="11.67" width="21" height="1.67"/></g>
    <circle cx="4.2" cy="3.3" r="2.1" fill="#f6b40e" opacity=".4"/>
    <circle cx="4.2" cy="3.3" r="1.4" fill="#f6b40e"/>`,
};

function flagIcon(code) {
  const body = FLAG_SVG[code];
  if (!body) return '';
  return `<svg class="mkt-flag" viewBox="0 0 21 15" aria-hidden="true">${body}</svg>`;
}

// Marcas dibujadas a mano (el set de monedas es fijo): círculo con el color
// de la moneda + el glifo (₿, Ł, la M de Monero, la X de Ripple).
const COIN_SVG = {
  BTC: `<circle cx="8" cy="8" r="8" fill="#f7931a"/>
    <g fill="none" stroke="#fff" stroke-width="1.55" stroke-linecap="round">
      <path d="M5.9 4.5v7"/><path d="M5.5 4.5h3.2a1.65 1.65 0 0 1 0 3.3H5.5"/>
      <path d="M5.5 7.8h3.7a1.75 1.75 0 0 1 0 3.5H5.5"/>
      <path d="M6 2.5v11"/><path d="M8.4 2.5v11"/></g>`,
  LTC: `<circle cx="8" cy="8" r="8" fill="#345d9d"/>
    <g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9.5 3.2 7.4 10.3h4.9"/><path d="M4.6 8.6 9.9 6.9"/></g>`,
  XMR: `<circle cx="8" cy="8" r="8" fill="#f60"/>
    <path d="M3.2 12.2V4L8 9 12.8 4v8.2" fill="none" stroke="#fff" stroke-width="1.9"
      stroke-linecap="round" stroke-linejoin="round"/>`,
  XRP: `<circle cx="8" cy="8" r="8" fill="#23292f"/>
    <g fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 3.8 8 7.7l4-3.9"/><path d="M4 12.2 8 8.3l4 3.9"/></g>`,
};

// Color estable por símbolo para los monogramas de respaldo.
function symbolHue(sym) {
  let h = 0;
  for (let i = 0; i < sym.length; i++) h = (h * 31 + sym.charCodeAt(i)) % 360;
  return h;
}

function monogramIcon(sym, cls) {
  const s = String(sym || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const hue = symbolHue(String(sym || ''));
  return `<span class="${cls} mkt-ico-fb" style="background:hsl(${hue} 55% 32%); color:hsl(${hue} 90% 82%)">${escapeHtml(s)}</span>`;
}

function coinIcon(symbol) {
  const body = COIN_SVG[symbol];
  if (!body) return monogramIcon(symbol, 'mkt-ico');
  return `<svg class="mkt-ico" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
}

function stockIcon(q) {
  if (q && q.logo) {
    return `<img class="mkt-ico stk-logo" src="${escapeHtml(q.logo)}" alt="" loading="lazy"
      data-sym="${escapeHtml(q.symbol)}">`;
  }
  return monogramIcon(q && q.symbol, 'mkt-ico');
}

// Si el logo remoto no carga (símbolo sin perfil, red caída), se reemplaza por
// el monograma en vez de dejar el hueco del ícono roto.
function wireLogoFallbacks(root) {
  root.querySelectorAll('img.stk-logo').forEach((img) => {
    img.addEventListener('error', () => {
      const tmp = document.createElement('div');
      tmp.innerHTML = monogramIcon(img.dataset.sym, 'mkt-ico');
      if (tmp.firstElementChild) img.replaceWith(tmp.firstElementChild);
    }, { once: true });
  });
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
        ${coinIcon(c.symbol)}
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
        <span class="mkt-fx-cur">${flagIcon(code)}<span class="mkt-fx-cur-txt"><b>${escapeHtml(code)}</b> ${escapeHtml(name)}</span></span>
        <span class="mkt-fx-cell">${daCell}</span>
        <span class="mkt-fx-cell"><span class="mkt-fx-val">${fmtUyuRate(erVal)}</span></span>
      </div>`;
  }).join('');

  // Dos columnas de la grilla de 3 (la 3ª, Acciones, la pinta renderStocks).
  el.innerHTML = `
    <div class="mkt-col">
      <div class="mkt-sub-title">Cripto <span class="mkt-src">· USD</span></div>
      <div class="mkt-list">${cryptoHtml}</div>
    </div>
    <div class="mkt-col mkt-col-sep">
      <div class="mkt-sub-title">Divisas <span class="mkt-src">· UYU</span>${flagIcon('UYU')}</div>
      <div class="mkt-fx-row mkt-fx-head">
        <span class="mkt-fx-cur"></span>
        <span class="mkt-fx-cell">DolarAPI</span>
        <span class="mkt-fx-cell">Exch.Rate</span>
      </div>
      <div class="mkt-list">${fxRows}</div>
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
      // Lock in the current month's rate; it keeps updating while the month is
      // open and freezes once it closes, so past balances stop moving.
      const curYm = monthKey(Date.now());
      finMonthlyFx[curYm] = usd.compra;
      window.api.finances.recordFx(curYm, usd.compra).catch(() => {});
      paintConvertedTotals();
      // Refresh charts (the "por tipo" chart converts USD items) without a full
      // re-render, so any balance the user is typing isn't wiped.
      if (finChartsEl && finLastExpenses.length) {
        renderFinanzasCharts(finLastAccounts, finLastExpenses);
      }
      // The monthly summary also converts USD movements to pesos; keep the open
      // modals in sync with the refreshed card (and its new rate).
      if (finMonthlyEl && finLastExpenses.length) {
        renderMonthly();
        if (finMonthModalEl) renderMonthModalList();
        if (finBalancesModalEl) renderBalancesModalList();
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

// ── Acciones y ETFs (Finnhub) — bloque dentro del card Mercado ──
// Necesita key "Finnhub" en API Keys; sin key el bloque muestra el hint.
// Los símbolos viven en config.json y se editan inline con el lápiz.
let stocksEditing = false;
let stocksLast = null;

function fmtStockPrice(v) {
  if (v == null || !isFinite(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderStocks(r) {
  const el = $('stocks-block');
  if (!el) return;
  stocksLast = r;
  if (r && r.error === 'sin key') {
    el.innerHTML = `
      <div class="mkt-col mkt-col-sep">
        <div class="mkt-sub-title">Acciones y ETFs <span class="mkt-src">· Finnhub</span></div>
        <div class="stocks-hint">Agregá una key llamada <code>Finnhub</code> en API Keys (gratis en finnhub.io) para ver cotizaciones acá.</div>
      </div>`;
    adjustWindowSize();
    return;
  }
  if (!r || r.error) {
    el.innerHTML = `
      <div class="mkt-col mkt-col-sep">
        <div class="mkt-sub-title">Acciones y ETFs <span class="mkt-src">· Finnhub</span></div>
        <div class="mkt-empty">No disponible${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>
      </div>`;
    adjustWindowSize();
    return;
  }
  const quotes = Array.isArray(r.quotes) ? r.quotes : [];
  el.innerHTML = `
    <div class="mkt-col mkt-col-sep">
      <div class="mkt-sub-title stocks-title">
        Acciones y ETFs <span class="mkt-src">· USD</span>
        <button class="key-icon-btn js-stocks-edit" title="Editar símbolos">✎</button>
      </div>
      ${stocksEditing ? `
        <div class="stocks-edit-row">
          <input id="stocks-symbols" class="fin-input" value="${escapeHtml((r.symbols || []).join(', '))}"
            placeholder="Símbolos separados por coma (ej. AAPL, SPY, VOO)" autocomplete="off">
          <button class="fin-btn js-stocks-save">Guardar</button>
        </div>` : ''}
      <div class="mkt-list">
        ${quotes.map((q) => `
          <div class="mkt-coin">
            ${stockIcon(q)}
            <span class="mkt-coin-sym" title="${escapeHtml(q.name || q.symbol)}">${escapeHtml(q.symbol)}</span>
            <span class="mkt-coin-price">${fmtStockPrice(q.price)}</span>
            ${q.price != null ? fmtChange(q.changePct) : '<span class="mkt-chg">—</span>'}
          </div>`).join('')}
      </div>
    </div>`;
  wireLogoFallbacks(el);
  const editBtn = el.querySelector('.js-stocks-edit');
  if (editBtn) editBtn.addEventListener('click', () => {
    stocksEditing = !stocksEditing;
    renderStocks(stocksLast);
  });
  const saveBtn = el.querySelector('.js-stocks-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const input = $('stocks-symbols');
    const symbols = (input ? input.value : '').split(',').map((s) => s.trim()).filter(Boolean);
    saveBtn.disabled = true;
    try { await window.api.stocks.setSymbols(symbols); } catch {}
    stocksEditing = false;
    refreshStocks();
  });
  const inputEl = $('stocks-symbols');
  if (inputEl) inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && saveBtn) saveBtn.click(); });
  adjustWindowSize();
}

async function refreshStocks() {
  try {
    renderStocks(await window.api.stocks.quotes());
  } catch (e) {
    renderStocks({ error: String(e && e.message || e) });
  }
}

// ── Próximos feriados de Uruguay (Nager.Date, dashboard) ───────
// Mini cards en una sola fila con scroll horizontal si son muchos. El card
// queda oculto si la API no responde (no aporta nada vacío).
function holidayCountdown(ts) {
  const days = Math.round((ts - Date.now()) / 86400000);
  if (days <= 0) return ['¡hoy!', 'today'];
  if (days === 1) return ['mañana', 'soon'];
  if (days <= 7) return [`en ${days} días`, 'soon'];
  return [`en ${days} días`, ''];
}

async function refreshHolidays() {
  const card = $('holidays-card'), list = $('holidays-list');
  if (!card || !list) return;
  let r = null;
  try { r = await window.api.holidays.next(); } catch {}
  const holidays = (r && !r.error && Array.isArray(r.holidays)) ? r.holidays : [];
  if (!holidays.length) { card.hidden = true; adjustWindowSize(); return; }
  card.hidden = false;
  list.innerHTML = holidays.map((h) => {
    const d = new Date(h.ts);
    const [cd, cls] = holidayCountdown(h.ts);
    return `
      <div class="holiday-card" title="${escapeHtml(h.name)}">
        <div class="holiday-card-top">
          <span class="holiday-card-date">${d.toLocaleDateString('es-UY', { weekday: 'short', day: '2-digit', month: 'short' })}</span>
          <span class="holiday-card-count ${cls}">${cd}</span>
        </div>
        <div class="holiday-card-name">${escapeHtml(h.name)}</div>
      </div>`;
  }).join('');
  adjustWindowSize();
}

// ── YIFY torrents ──────────────────────────────────────────────
// La API es un mirror comunitario y puede morir en cualquier momento: al
// iniciar corre un health check (yify.check). Si falla, el card del dashboard
// se oculta y el tab muestra "API caída" con un botón de reintento — nunca
// rompe el resto del widget.
const YIFY_INTERVAL_MS = 30 * 60 * 1000;   // últimas películas: cada 30 min
const YIFY_DASH_COUNT = 4;   // 1 fila de 4 películas en el dashboard
const EZ_DASH_COUNT = 4;     // 1 fila de 4 series
let ezDashShows = [];      // últimas series agrupadas para la mitad derecha del card
// Ítems por página según la vista (la API acepta hasta 50): las tarjetas son
// grandes (12), los iconos chicos llenan 5 filas de 8 (40), la lista 20 films.
const YIFY_PAGE_SIZES = { grid: 12, icons: 40, list: 20 };
function yifyPageSize() { return YIFY_PAGE_SIZES[yifyView] || 12; }
let yifyOk = null;        // null = verificando; resultado del health check
// Los listados salen del archivo histórico (yify.sqlite), así que la muerte
// del mirror ya no vacía el tab: `stale` marca que lo que se ve es lo
// archivado y que la API no contestó.
let yifyStale = false;
let yifyLatest = null;    // último listado "recientes" (alimenta el dashboard)
let yifyShown = [];       // películas renderizadas en el tab (para los clicks)
let yifyPage = 1;         // página actual del listado del tab
let yifyView = 'grid';    // vista del tab: 'grid' (tarjetas) | 'icons' | 'list'
try { yifyView = localStorage.getItem('yifyView') || 'grid'; } catch {}
let yifyFetching = false;
let yifyTimerStarted = false;
// Favoritos: viven completos en SQLite (portada incluida) así sobreviven a la
// muerte de la API. favIds pinta los corazones; yifyFavsMode es la sección ♥.
let yifyFavsMode = false;
let favIds = new Set();
let favImdbs = new Set();   // imdb ids de los favoritos: la misma película en YIFY y en Lime
// Carpetas de favoritos: un explorador simple dentro de la sección ♥.
// favAll = todas las pelis guardadas; favFolders = carpetas; favFolderId =
// carpeta abierta (null = raíz, muestra carpetas + pelis sin carpeta).
let favAll = [];
let favFolders = [];
let favFolderId = null;
let favCreating = false;    // input "nueva carpeta" abierto
let favDragId = null;       // id de la peli que se está arrastrando

function setYifyStatus(kind, text) {
  const wrap = $('yify-status'), txt = $('yify-status-text');
  if (!wrap || !txt) return;
  wrap.className = 'db-status' + (kind ? ` ${kind}` : '');
  txt.textContent = text;
}

function yifyMeta(m) {
  const bits = [];
  if (m.year) bits.push(String(m.year));
  if (m.runtime) bits.push(`${m.runtime} min`);
  if (m.rating) bits.push(`★ ${m.rating}`);
  return bits.join(' · ');
}

// Corazón de like, compartido por las tres vistas. `mini` es la variante
// inline de la vista lista (las otras dos lo superponen sobre el poster).
function yifyFavHtml(m, i, mini = false) {
  const on = isFav(m);
  return `<button class="yify-fav-btn${mini ? ' yify-fav-mini' : ''}${on ? ' faved' : ''} js-yify-fav" data-i="${i}"
    title="${on ? 'Quitar de favoritos' : 'Guardar en favoritos'}">${on ? '♥' : '♡'}</button>`;
}

// Etiqueta del origen de una película: LIME / YIFY / TMDB (una similar de
// TMDB que no tiene torrents en ninguna de las dos fuentes).
function srcLabel(source) {
  return source === 'lime' ? 'LIME' : source === 'tmdb' ? 'TMDB' : 'YIFY';
}

// Chip de origen (YIFY / LIME) en la sección Favoritos: distingue de qué API
// salió cada favorito; "YIFY + LIME" cuando tiene torrents de las dos.
// `inline` es la variante para la vista lista y la ficha.
function favSrcHtml(m, inline = false) {
  if (!yifyFavsMode || !m.source) return '';
  const both = Array.isArray(m.sources) && m.sources.length > 1;
  const cls = both ? 'fav-src-both' : `fav-src-${m.source}`;
  return `<span class="fav-src ${cls}${inline ? ' fav-src-inline' : ''}">${both ? 'YIFY + LIME' : srcLabel(m.source)}</span>`;
}

// La misma película puede estar en YIFY y en Lime con ids distintos: un
// favorito se reconoce también por su imdb id, así el ♥ se ve en las dos
// fuentes y quitarlo desde cualquiera saca el único registro que hay.
function favImdbKey(m) {
  if (!m) return null;
  const direct = String(m.imdb || '').trim().toLowerCase();
  if (/^tt\d+$/.test(direct)) return direct;
  const mm = /imdb\.com\/title\/(tt\d+)/i.exec(`${m.imdbUrl || ''} ${m.url || ''}`);
  return mm ? mm[1].toLowerCase() : null;
}
function isFav(m) {
  if (!m) return false;
  if (favIds.has(m.id)) return true;
  const k = favImdbKey(m);
  return !!(k && favImdbs.has(k));
}
function setFavKeys(keys) {
  favIds = new Set(Array.isArray(keys && keys.ids) ? keys.ids : []);
  favImdbs = new Set((Array.isArray(keys && keys.imdbs) ? keys.imdbs : []).map((s) => String(s).toLowerCase()));
}
async function refreshFavKeys() {
  try { setFavKeys(await window.api.favs.ids()); } catch {}
}

// Alta/baja del favorito y refresco de las grillas para repintar los
// corazones (las dos: la película puede estar en YIFY y en Lime). El alta es
// lenta (main baja la portada, la ficha completa y los torrents de la otra
// fuente): el botón queda deshabilitado mientras tanto.
async function toggleYifyFav(m) {
  if (!m || !m.id) return;
  try {
    if (isFav(m)) await window.api.favs.remove({ id: m.id, imdb: favImdbKey(m) });
    else await window.api.favs.add(m);
  } catch {}
  await refreshFavKeys();   // ids reales: el alta pudo fundirse en un favorito existente
  if (yifyFavsMode) loadYifyFavs();
  else {
    if (yifyShown.length) renderYifyMovies(yifyShown);
    if (limeShown.length) renderLimeCards(limeShown);
  }
}

// El card de "Últimos estrenos" se muestra si hay pelis O series — o si una
// fuente de películas está caída (los chips de estado tienen que verse);
// cada mitad se renderiza por separado (APIs distintas, refrescos
// independientes).
function updateDashMediaCard() {
  const card = $('yify-dash-card');
  if (!card) return;
  const hasMovies = (yifyOk && yifyLatest && Array.isArray(yifyLatest.movies) && yifyLatest.movies.length)
    || (limeOk && limeLatest && Array.isArray(limeLatest.movies) && limeLatest.movies.length);
  const hasSeries = ezDashShows.length;
  const someDown = yifyOk === false || limeOk === false;
  card.hidden = !(hasMovies || hasSeries || someDown);
}

// Chips de estado de las dos fuentes de películas (YIFY / LimeTorrents) en el
// card del dashboard: verde en línea, rojo caída, amarillo verificando.
function updateDashApiChips() {
  const chips = [
    { el: $('dash-yify-chip'), ok: yifyOk === null ? null : (yifyOk && !yifyStale), name: 'YIFY' },
    { el: $('dash-lime-chip'), ok: limeOk, name: 'LimeTorrents' },
  ];
  for (const { el, ok, name } of chips) {
    if (!el) continue;
    const kind = ok === null ? 'checking' : ok ? 'connected' : 'disconnected';
    el.className = `db-status dash-api-chip ${kind}`;
    el.title = `${name}: ${ok === null ? 'verificando…' : ok ? 'en línea' : 'caída'}`;
  }
}

// Mitad izquierda: últimas películas mezclando las dos fuentes del tab Films —
// 2 de YIFY + 2 de LimeTorrents. Si una fuente está caída (o trae menos de 2),
// la otra completa la fila de 4. Click → ficha según la fuente.
let dashMovies = [];   // { src: 'yify'|'lime', m } de las celdas renderizadas
function renderYifyDash() {
  updateDashApiChips();   // toda transición de yifyOk/limeOk pasa por acá
  const grid = $('yify-dash');
  if (!grid) return;
  const yify = (yifyOk && yifyLatest && Array.isArray(yifyLatest.movies)) ? yifyLatest.movies : [];
  const lime = (limeOk && limeLatest && Array.isArray(limeLatest.movies)) ? limeLatest.movies : [];
  const half = Math.floor(YIFY_DASH_COUNT / 2);
  const yifyTake = yify.slice(0, YIFY_DASH_COUNT - Math.min(half, lime.length));
  const limeTake = lime.slice(0, YIFY_DASH_COUNT - yifyTake.length);
  dashMovies = [
    ...yifyTake.map((m) => ({ src: 'yify', m })),
    ...limeTake.map((m) => ({ src: 'lime', m })),
  ];
  const whenEl = $('yify-dash-when');
  const ts = Math.max((yifyLatest && yifyLatest.fetchedAt) || 0, (limeLatest && limeLatest.fetchedAt) || 0);
  if (whenEl && ts) whenEl.textContent = fmtWhen(ts);
  grid.innerHTML = dashMovies.length
    ? dashMovies.map(({ src, m }, i) => `
      <div class="yify-dash-cell" data-i="${i}" title="${escapeHtml(m.title)}${m.year ? ` (${m.year})` : ''} — ver ficha">
        ${m.cover
          ? `<img class="yify-poster" src="${escapeHtml(m.cover)}" loading="lazy" alt="">`
          : `<div class="yify-poster yify-noposter">🎬</div>`}
        <span class="fav-src fav-src-${src}">${src === 'lime' ? 'LIME' : 'YIFY'}</span>
        <div class="yify-dash-title">${escapeHtml(m.title)}</div>
        <div class="yify-dash-meta">${escapeHtml(src === 'lime' ? limeMeta(m) : yifyMeta(m))}</div>
      </div>`).join('')
    : `<div class="dash-media-empty">${(yifyOk || limeOk) ? 'Sin novedades' : 'APIs caídas'}</div>`;
  grid.querySelectorAll('.yify-dash-cell').forEach((c) => {
    c.addEventListener('click', () => {
      const d = dashMovies[+c.dataset.i];
      if (!d) return;
      if (d.src === 'lime') openFavModal(d.m);
      else openYifyModal(d.m.id);
    });
  });
  updateDashMediaCard();
  adjustWindowSize();
}

// Mitad derecha: últimas series agrupadas (mismo fetch que el tab Series).
// Click → modal de la serie (subidos recientes + todos los episodios).
function renderEztvDash() {
  const grid = $('ez-dash');
  if (!grid) return;
  grid.innerHTML = ezDashShows.length
    ? ezDashShows.slice(0, EZ_DASH_COUNT).map((g, i) => `
      <div class="yify-dash-cell ez-dash-cell" data-i="${i}"
        title="${escapeHtml(g.title)}${g.year ? ` (${g.year})` : ''}${g.episodes && g.episodes.length > 1 ? ` · ${g.episodes.length} eps` : ''} — ver episodios">
        ${g.image
          ? `<img class="yify-poster" src="${escapeHtml(g.image)}" loading="lazy" alt="">`
          : `<div class="yify-poster yify-noposter">📺</div>`}
        ${g.episodes && g.episodes.length > 1 ? `<span class="ez-ep-count">${g.episodes.length}</span>` : ''}
        <div class="yify-dash-title">${escapeHtml(g.title)}</div>
        <div class="yify-dash-meta">${escapeHtml(ezCardMeta(g))}</div>
      </div>`).join('')
    : `<div class="dash-media-empty">${ezOk === false ? 'API caída' : 'Cargando…'}</div>`;
  grid.querySelectorAll('.ez-dash-cell').forEach((c) => {
    c.addEventListener('click', () => openEzShowModal(ezDashShows[+c.dataset.i]));
  });
  updateDashMediaCard();
  adjustWindowSize();
}

async function refreshEztvDash() {
  try {
    const r = await window.api.eztv.shows({ limit: 24, page: 1 });
    if (r && !r.error && Array.isArray(r.shows)) {
      ezDashShows = r.shows;
      renderEztvDash();
    }
  } catch {}
}

function renderYifyDown(err) {
  const el = $('yify-list');
  if (!el) return;
  if (yifyFavsMode) return;   // los favoritos viven en la base: API caída no los pisa
  el.className = 'yify-grid';
  const pager = $('yify-pager');
  if (pager) pager.innerHTML = '';
  el.innerHTML = `
    <div class="yify-down">
      <div class="yify-down-msg">⚠️ La API de YIFY no responde${err ? ` <span class="yify-down-err">(${escapeHtml(err)})</span>` : ''}</div>
      <button id="yify-retry" class="fin-btn">Reintentar</button>
    </div>`;
  const btn = $('yify-retry');
  if (btn) btn.addEventListener('click', initYify);
  adjustWindowSize();
}

// Clicks compartidos por las tres vistas: ficha (js-yify-open), magnet y ♥.
// En Favoritos la ficha se arma con los datos guardados (no toca la API).
function attachYifyClickHandlers(el) {
  el.querySelectorAll('.js-yify-open').forEach((n) => {
    n.addEventListener('click', () => {
      const m = yifyShown[+n.dataset.i];
      if (!m) return;
      if (yifyFavsMode) openFavModal(m);
      else openYifyModal(m.id);
    });
  });
  el.querySelectorAll('.js-yify-magnet').forEach((b) => {
    b.addEventListener('click', () => {
      const m = yifyShown[+b.dataset.i];
      const t = m && m.torrents ? m.torrents[+b.dataset.t] : null;
      const link = t && (t.magnet || t.url);
      if (link) window.api.openExternal(link);
    });
  });
  el.querySelectorAll('.js-yify-fav').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();   // el padre abre la ficha
      const m = yifyShown[+b.dataset.i];
      if (!m || b.disabled) return;
      b.disabled = true;
      b.textContent = '…';
      await toggleYifyFav(m);   // re-renderiza la vista (el botón se descarta)
    });
  });
}

// Vista "grid": tarjetas con poster grande + badges de calidad (la original).
function renderYifyCards(el) {
  el.className = 'yify-grid';
  el.innerHTML = yifyShown.map((m, i) => `
    <div class="yify-movie">
      <div class="yify-poster-wrap js-yify-open" data-i="${i}" title="Ver ficha">
        ${m.cover
          ? `<img class="yify-poster" src="${escapeHtml(m.cover)}" loading="lazy" alt="">`
          : `<div class="yify-poster yify-noposter">🎬</div>`}
        ${m.rating ? `<span class="yify-rating">★ ${m.rating}</span>` : ''}
        ${yifyFavHtml(m, i)}
        ${favSrcHtml(m)}
      </div>
      <div class="yify-info">
        <div class="yify-title js-yify-open" data-i="${i}" title="${escapeHtml(m.title)}">${escapeHtml(m.title)}</div>
        <div class="yify-meta">${escapeHtml(yifyMeta(m))}</div>
        ${m.genres && m.genres.length ? `<div class="yify-genres">${escapeHtml(m.genres.join(' · '))}</div>` : ''}
        <div class="yify-quals">
          ${(m.torrents || []).map((t, ti) => `
            <button class="yify-q js-yify-magnet" data-i="${i}" data-t="${ti}"${qualSrcAttr(m, t)}
              title="Magnet ${escapeHtml(t.quality || '?')}${t.type ? ` ${escapeHtml(t.type)}` : ''} · ${escapeHtml(t.size)}${t.seeds != null ? ` · ${t.seeds} seeds` : ''}${qualSrcTitle(m, t)}">
              🧲 ${escapeHtml(t.quality || '?')}
            </button>`).join('')}
        </div>
      </div>
    </div>`).join('');
}

// Vista "icons": grilla densa de posters chicos (reusa las celdas del dashboard).
function renderYifyIcons(el) {
  el.className = 'yify-icons-grid';
  el.innerHTML = yifyShown.map((m, i) => `
    <div class="yify-dash-cell js-yify-open" data-i="${i}"
      title="${escapeHtml(m.title)}${m.year ? ` (${m.year})` : ''}${m.rating ? ` · ★ ${m.rating}` : ''} — ver ficha">
      ${m.cover
        ? `<img class="yify-poster" src="${escapeHtml(m.cover)}" loading="lazy" alt="">`
        : `<div class="yify-poster yify-noposter">🎬</div>`}
      ${yifyFavHtml(m, i)}
      ${favSrcHtml(m)}
      <div class="yify-dash-title">${escapeHtml(m.title)}</div>
      <div class="yify-dash-meta">${escapeHtml(yifyMeta(m))}</div>
    </div>`).join('');
}

// Vista "list": una fila por torrent con columnas (año, rating, calidad,
// tamaño, seeders, leechers, magnet) tipo tracker.
function renderYifyTable(el) {
  el.className = 'yify-table';
  const rows = [];
  yifyShown.forEach((m, i) => {
    const ts = (m.torrents && m.torrents.length) ? m.torrents : [null];
    ts.forEach((t, ti) => {
      rows.push(`
        <div class="yify-tr">
          <span class="yify-td-title js-yify-open" data-i="${i}" title="${escapeHtml(m.title)} — ver ficha">${ti === 0 ? yifyFavHtml(m, i, true) + favSrcHtml(m, true) : ''}${escapeHtml(m.title)}</span>
          <span class="yify-td-num">${m.year ?? '—'}</span>
          <span class="yify-td-num yify-td-rating">${m.rating ? '★ ' + m.rating : '—'}</span>
          <span class="yify-td-qual">${t ? escapeHtml(t.quality + (t.type ? ' · ' + t.type : '')) : '—'}</span>
          <span class="yify-td-num">${t && t.size ? escapeHtml(t.size) : '—'}</span>
          <span class="yify-td-num yify-td-seeds">${t && t.seeds != null ? t.seeds : '—'}</span>
          <span class="yify-td-num yify-td-peers">${t && t.peers != null ? t.peers : '—'}</span>
          <span class="yify-td-mag">${t ? `
            <button class="yify-q yify-q-mini js-yify-magnet" data-i="${i}" data-t="${ti}"
              title="Magnet ${escapeHtml(t.quality)} · ${escapeHtml(t.size)}">🧲</button>` : ''}</span>
        </div>`);
    });
  });
  el.innerHTML = `
    <div class="yify-tr yify-tr-head">
      <span>Película</span>
      <span class="yify-td-num">Año</span>
      <span class="yify-td-num">★</span>
      <span>Calidad</span>
      <span class="yify-td-num">Tamaño</span>
      <span class="yify-td-num" title="Seeders">Seeds</span>
      <span class="yify-td-num" title="Leechers">Leech</span>
      <span></span>
    </div>` + rows.join('');
}

function renderYifyMovies(movies) {
  const el = $('yify-list');
  if (!el) return;
  yifyShown = Array.isArray(movies) ? movies : [];
  if (!yifyShown.length) {
    el.className = 'yify-grid';
    el.innerHTML = `<div class="ai-loading">Sin resultados</div>`;
    adjustWindowSize();
    return;
  }
  if (yifyView === 'icons') renderYifyIcons(el);
  else if (yifyView === 'list') renderYifyTable(el);
  else renderYifyCards(el);
  attachYifyClickHandlers(el);
  if (yifyFavsMode) enableFavDnD(el);   // arrastrar películas a carpetas
  adjustWindowSize();
}

function markYifyDown(err) {
  yifyOk = false;
  yifyLatest = null;
  setYifyStatus('disconnected', 'API caída');
  renderYifyDash();   // oculta el card del dashboard
  renderYifyDown(err);
}

// Bajada de "recientes": alimenta el card del dashboard y, si no hay búsqueda
// activa, también el listado del tab.
async function refreshYifyLatest() {
  if (yifyFetching) return;
  yifyFetching = true;
  const btn = $('yify-dash-refresh');
  if (btn) btn.classList.add('spinning');
  try {
    const r = await window.api.yify.list({ limit: yifyPageSize(), sort: 'date_added' });
    if (r && !r.error) {
      yifyOk = true;
      yifyStale = !!r.stale;
      setYifyStatus(yifyStale ? 'disconnected' : 'connected',
        yifyStale ? 'API caída — listando el archivo' : 'API conectada');
      yifyLatest = r;
      renderYifyDash();
      // Solo pisar el listado del tab si no hay búsqueda, filtros ni página
      // avanzada (este fetch es el de "recientes" sin filtrar, página 1).
      const v = (id) => { const n = $(id); return n ? n.value : ''; };
      const filtersDefault = yifyPage === 1 && !v('yify-search').trim() && !v('yify-genre') &&
        !v('yify-quality') && (v('yify-minrating') === '0' || !v('yify-minrating')) &&
        (v('yify-sort') === 'date_added' || !v('yify-sort'));
      if (filtersDefault && !yifyFavsMode) {
        renderYifyMovies(r.movies);
        renderYifyPager(r.count);
      }
    } else {
      markYifyDown(r && r.error);
    }
  } catch (e) {
    markYifyDown(String(e && e.message || e));
  } finally {
    if (btn) btn.classList.remove('spinning');
    yifyFetching = false;
  }
}

// Pager "‹ Página X de Y ›" bajo la grilla del tab.
function renderYifyPager(count) {
  const el = $('yify-pager');
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil((count || 0) / yifyPageSize()));
  if (!count || totalPages <= 1) { el.innerHTML = ''; adjustWindowSize(); return; }
  if (yifyPage > totalPages) yifyPage = totalPages;
  el.innerHTML = `
    <button class="fin-month-nav-btn js-yify-prev" title="Página anterior" ${yifyPage <= 1 ? 'disabled' : ''}>‹</button>
    <span class="yify-pager-info">Página ${yifyPage.toLocaleString('es-UY')} de ${totalPages.toLocaleString('es-UY')} · ${count.toLocaleString('es-UY')} películas</span>
    <button class="fin-month-nav-btn js-yify-next" title="Página siguiente" ${yifyPage >= totalPages ? 'disabled' : ''}>›</button>`;
  el.querySelector('.js-yify-prev').addEventListener('click', () => {
    if (yifyPage > 1) { yifyPage--; loadYifyList(); }
  });
  el.querySelector('.js-yify-next').addEventListener('click', () => {
    if (yifyPage < totalPages) { yifyPage++; loadYifyList(); }
  });
  adjustWindowSize();
}

// Búsqueda del tab (texto + género + calidad + rating mínimo + orden) con
// paginación. yifySearchNew() resetea a la página 1 (filtros nuevos).
async function loadYifyList() {
  const el = $('yify-list');
  const val = (id, def = '') => { const n = $(id); return n ? n.value : def; };
  if (el) { el.className = 'yify-grid'; el.innerHTML = `<div class="ai-loading">Buscando…</div>`; }
  try {
    const r = await window.api.yify.list({
      limit: yifyPageSize(),
      page: yifyPage,
      query: val('yify-search').trim(),
      sort: val('yify-sort', 'date_added'),
      genre: val('yify-genre'),
      quality: val('yify-quality'),
      minRating: parseInt(val('yify-minrating', '0'), 10) || 0,
    });
    if (r && !r.error) {
      yifyStale = !!r.stale;
      setYifyStatus(yifyStale ? 'disconnected' : 'connected',
        yifyStale ? 'API caída — listando el archivo' : 'API conectada');
      updateDashApiChips();
      renderYifyMovies(r.movies);
      renderYifyPager(r.count);
    } else {
      renderYifyDown(r && r.error);
    }
  } catch (e) {
    renderYifyDown(String(e && e.message || e));
  }
}

function yifySearchNew() {
  yifyPage = 1;
  loadYifyList();
  // El mismo buscador le pega a la otra fuente del tab (LimeTorrents); los
  // cambios de filtros de YIFY (género/orden/…) no la re-disparan.
  const q = ($('yify-search') ? $('yify-search').value : '').trim();
  if (q !== limeQuery) limeSearchMovies(q);
}

// ── Sección Favoritos ─────────────────────────────────────────
// Lee la base local y reusa las mismas vistas (grid/iconos/lista). No depende
// de la API en absoluto: portada (data URL), ficha y magnets salen de SQLite.
async function loadYifyFavs() {
  const el = $('yify-list');
  const pager = $('yify-pager');
  if (pager) pager.innerHTML = '';
  if (el) { el.className = 'yify-grid'; el.innerHTML = `<div class="ai-loading">Cargando favoritos…</div>`; }
  let favs = [], folders = [], loadErr = null;
  try {
    const [r, fs] = await Promise.all([window.api.favs.list(), window.api.favs.folders()]);
    if (Array.isArray(r)) favs = r;
    else loadErr = (r && r.error) || 'respuesta inválida';
    if (Array.isArray(fs)) folders = fs;
  } catch (e) { loadErr = (e && e.message) || String(e); }
  if (!yifyFavsMode) return;   // salieron de la sección mientras cargaba
  // La base local no se pudo leer: se muestra el error real en vez de fingir
  // "sin favoritos" (nada se pierde — la copia autoritativa vive en Mongo).
  if (loadErr) {
    yifyShown = [];
    renderFavBar();
    if (el) {
      el.className = 'yify-grid';
      el.innerHTML = `<div class="ai-loading">No se pudieron leer los favoritos: ${escapeHtml(loadErr)}. Nada se perdió — la copia vive en Mongo; reabrí el widget para regenerar la base local.</div>`;
    }
    adjustWindowSize();
    return;
  }
  favAll = favs;
  favFolders = folders;
  favIds = new Set(favs.map((f) => f.id));
  favImdbs = new Set(favs.map((f) => f.imdb).filter(Boolean));
  // Si la carpeta abierta ya no existe (borrada en otra máquina), volvé a raíz.
  if (favFolderId != null && !favFolders.some((f) => f.id === favFolderId)) favFolderId = null;
  renderFavBar();
  // En cada nivel mostramos las pelis de esa carpeta (raíz = sin carpeta).
  const shown = favAll.filter((f) => (f.folderId ?? null) === favFolderId);
  const subs = favFolders.filter((f) => (f.parentId ?? null) === favFolderId);
  if (!favAll.length && !favFolders.length) {
    if (el) {
      el.className = 'yify-grid';
      el.innerHTML = `<div class="ai-loading">Sin favoritos todavía — tocá ♡ en una película para guardarla acá.</div>`;
    }
    adjustWindowSize();
    return;
  }
  if (!shown.length) {
    yifyShown = [];
    if (el) {
      el.className = 'yify-grid';
      // Con subcarpetas visibles arriba no hace falta un cartel grande.
      el.innerHTML = subs.length
        ? `<div class="ai-loading">Abrí una subcarpeta, o arrastrá películas a esta carpeta.</div>`
        : (favFolderId != null
          ? `<div class="ai-loading">Carpeta vacía — arrastrá películas acá, o creá una subcarpeta arriba.</div>`
          : `<div class="ai-loading">Todas tus películas están en carpetas. Abrí una arriba.</div>`);
    }
    adjustWindowSize();
    return;
  }
  renderYifyMovies(shown);
}

// Ruta desde la raíz hasta la carpeta abierta (para el breadcrumb).
function favPath() {
  const byId = new Map(favFolders.map((f) => [f.id, f]));
  const path = [];
  let id = favFolderId;
  const guard = new Set();   // corta ciclos por si un parent quedó mal
  while (id != null && byId.has(id) && !guard.has(id)) {
    guard.add(id);
    const f = byId.get(id);
    path.unshift(f);
    id = f.parentId ?? null;
  }
  return path;
}

// Cantidad total de items dentro de una carpeta (pelis directas + subcarpetas).
function favFolderCount(fid) {
  const movies = favAll.filter((f) => (f.folderId ?? null) === fid).length;
  const subs = favFolders.filter((f) => (f.parentId ?? null) === fid).length;
  return { movies, subs };
}

// Barra de carpetas de Favoritos: breadcrumb navegable + botón "Nueva carpeta"
// (crea en el nivel actual) + las subcarpetas del nivel (como destinos de
// arrastre). Renombrar/eliminar de la carpeta abierta a la derecha. Cada nivel
// muestra sus subcarpetas y, en la grilla, sus películas. Solo en modo Favoritos.
function renderFavBar() {
  const bar = $('yify-fav-bar');
  if (!bar) return;
  if (!yifyFavsMode) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;

  const path = favPath();
  const current = path.length ? path[path.length - 1] : null;
  if (favFolderId != null && !current) { favFolderId = null; renderFavBar(); return; }

  // Breadcrumb: 🏠 Todas › … › carpeta actual. Cada tramo navega y recibe drops.
  const crumbs = `<button class="yify-fav-crumb-btn js-fav-crumb" data-fid="" title="Raíz — soltá una película acá para sacarla de toda carpeta">🏠 Todas</button>`
    + path.map((f) => `<span class="yify-fav-sep">›</span><button class="yify-fav-crumb-btn js-fav-crumb${f.id === favFolderId ? ' current' : ''}" data-fid="${f.id}" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</button>`).join('');

  const subs = favFolders.filter((f) => (f.parentId ?? null) === favFolderId);
  const tiles = subs.map((f) => {
    const c = favFolderCount(f.id);
    const badge = c.subs
      ? `<span class="yify-fav-count" title="${c.movies} película(s), ${c.subs} subcarpeta(s)">${c.movies} · 📁${c.subs}</span>`
      : `<span class="yify-fav-count">${c.movies}</span>`;
    return `
    <div class="yify-fav-folder" data-fid="${f.id}" title="${escapeHtml(f.name)} — abrí, o soltá una película acá">
      <span class="yify-fav-folder-ico">📁</span>
      <span class="yify-fav-folder-name js-fav-rename">${escapeHtml(f.name)}</span>
      ${badge}
      <button class="yify-fav-folder-btn js-fav-edit" title="Renombrar">✎</button>
      <button class="yify-fav-folder-btn js-fav-del" title="Eliminar carpeta">✕</button>
    </div>`;
  }).join('');

  const newLabel = favFolderId != null ? '＋ Subcarpeta' : '＋ Nueva carpeta';
  bar.innerHTML = `
    <div class="yify-fav-crumbs">${crumbs}</div>
    <div class="yify-fav-newwrap">
      ${favCreating
        ? `<input class="fin-input yify-fav-newinput" id="fav-new-input" placeholder="Nombre de la carpeta… (Enter)" autocomplete="off" maxlength="40">`
        : `<button class="fin-btn yify-fav-newbtn js-fav-new" title="Crear una carpeta en este nivel">${newLabel}</button>`}
    </div>
    ${favFolders.length ? `<button class="yify-fav-tool js-fav-tree" title="Ver el árbol completo de carpetas">🗂 Árbol</button>` : ''}
    ${current ? `
      <span class="yify-fav-bar-spacer"></span>
      <button class="yify-fav-tool js-fav-edit-cur" title="Renombrar «${escapeHtml(current.name)}»">✎ Renombrar</button>
      <button class="yify-fav-del js-fav-del-cur" title="Eliminar carpeta (su contenido vuelve a la raíz)">🗑 Eliminar</button>` : ''}
    <div class="yify-fav-folders">${tiles || (favCreating ? '' : `<span class="yify-fav-empty">${favFolderId != null ? 'Sin subcarpetas — creá una o arrastrá películas acá' : 'Creá una carpeta y arrastrá películas adentro ↓'}</span>`)}</div>`;

  // Breadcrumb: navegación + drop.
  bar.querySelectorAll('.js-fav-crumb').forEach((btn) => {
    const fid = btn.dataset.fid === '' ? null : +btn.dataset.fid;
    btn.addEventListener('click', () => { if (fid !== favFolderId) { favFolderId = fid; loadYifyFavs(); } });
    wireFavDropTarget(btn, fid);
  });

  // Nueva carpeta / subcarpeta (input inline).
  if (favCreating) {
    const input = bar.querySelector('#fav-new-input');
    input.focus();
    let done = false;
    const parent = favFolderId;   // capturado: crea en el nivel actual
    const commit = async () => {
      if (done) return; done = true;
      const name = input.value.trim();
      favCreating = false;
      if (name) await window.api.favs.createFolder(name, parent);
      loadYifyFavs();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') { done = true; favCreating = false; renderFavBar(); }
    });
    input.addEventListener('blur', () => { if (!done && !input.value.trim()) { favCreating = false; renderFavBar(); } });
  } else {
    const nb = bar.querySelector('.js-fav-new');
    if (nb) nb.addEventListener('click', () => { favCreating = true; renderFavBar(); });
  }

  // Árbol completo.
  const treeBtn = bar.querySelector('.js-fav-tree');
  if (treeBtn) treeBtn.addEventListener('click', openFavTreeModal);

  // Herramientas de la carpeta abierta.
  if (current) {
    bar.querySelector('.js-fav-del-cur').addEventListener('click', () => deleteFavFolder(current));
    bar.querySelector('.js-fav-edit-cur').addEventListener('click', () => {
      const nameEl = bar.querySelector(`.js-fav-crumb.current`);
      if (nameEl) startRenameFolder(current, nameEl);
    });
  }

  // Tiles de subcarpeta.
  bar.querySelectorAll('.yify-fav-folder').forEach((tile) => {
    const fid = +tile.dataset.fid;
    const folder = favFolders.find((f) => f.id === fid);
    tile.addEventListener('click', (e) => {
      if (e.target.closest('.js-fav-del') || e.target.closest('.js-fav-edit') || e.target.closest('input')) return;
      favFolderId = fid; loadYifyFavs();
    });
    tile.querySelector('.js-fav-del').addEventListener('click', (e) => { e.stopPropagation(); deleteFavFolder(folder); });
    const nameEl = tile.querySelector('.js-fav-rename');
    tile.querySelector('.js-fav-edit').addEventListener('click', (e) => { e.stopPropagation(); startRenameFolder(folder, nameEl); });
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRenameFolder(folder, nameEl); });
    wireFavDropTarget(tile, fid);
  });
}

// Convierte un span de nombre en un input para renombrar en el lugar.
function startRenameFolder(folder, nameEl) {
  const input = document.createElement('input');
  input.className = 'fin-input yify-fav-renameinput';
  input.value = folder.name;
  input.maxLength = 40;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async (save) => {
    if (done) return; done = true;
    const name = input.value.trim();
    if (save && name && name !== folder.name) await window.api.favs.renameFolder(folder.id, name);
    loadYifyFavs();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
    e.stopPropagation();
  });
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('blur', () => commit(true));
}

async function deleteFavFolder(folder) {
  const n = favAll.filter((f) => (f.folderId ?? null) === folder.id).length;
  const subs = favFolders.filter((f) => (f.parentId ?? null) === folder.id).length;
  const parts = [];
  if (n) parts.push(`${n} película${n === 1 ? '' : 's'}`);
  if (subs) parts.push(`${subs} subcarpeta${subs === 1 ? '' : 's'}`);
  const msg = parts.length
    ? `¿Eliminar la carpeta «${folder.name}»? Sus ${parts.join(' y ')} vuelven a la raíz (nada se borra de favoritos).`
    : `¿Eliminar la carpeta «${folder.name}»?`;
  if (!(await finConfirm(msg))) return;
  await window.api.favs.deleteFolder(folder.id);
  if (favFolderId === folder.id) favFolderId = null;
  loadYifyFavs();
}

// Modal con el árbol completo de carpetas. Clic en una la abre; clic en la raíz
// vuelve al nivel superior. Solo lectura (crear/borrar/mover se hacen en la barra).
let favTreeEl = null;
function closeFavTree() {
  if (favTreeEl) { favTreeEl.remove(); favTreeEl = null; }
  document.removeEventListener('keydown', favTreeEsc);
}
function favTreeEsc(e) { if (e.key === 'Escape') closeFavTree(); }
function openFavTreeModal() {
  closeFavTree();
  const childrenOf = (pid) => favFolders.filter((f) => (f.parentId ?? null) === pid);
  const movieCount = (fid) => favAll.filter((f) => (f.folderId ?? null) === fid).length;
  const guard = new Set();   // corta ciclos accidentales
  const renderNodes = (pid, depth) => childrenOf(pid).map((f) => {
    if (guard.has(f.id)) return '';
    guard.add(f.id);
    const c = movieCount(f.id);
    return `
    <div class="fav-tree-row${f.id === favFolderId ? ' current' : ''}" data-fid="${f.id}" style="padding-left:${depth * 18 + 12}px">
      <span class="fav-tree-ico">📁</span>
      <span class="fav-tree-name">${escapeHtml(f.name)}</span>
      <span class="yify-fav-count">${c}</span>
    </div>` + renderNodes(f.id, depth + 1);
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box fav-tree-box">
      <div class="fin-exp-modal-head">
        <span class="fin-exp-modal-title">🗂 Árbol de carpetas</span>
        <button class="fin-modal-x js-tree-x" title="Cerrar">✕</button>
      </div>
      <div class="fav-tree">
        <div class="fav-tree-row${favFolderId === null ? ' current' : ''}" data-fid="" style="padding-left:12px">
          <span class="fav-tree-ico">🏠</span>
          <span class="fav-tree-name">Todas (raíz)</span>
          <span class="yify-fav-count">${movieCount(null)}</span>
        </div>
        ${renderNodes(null, 1) || '<div class="yify-fav-empty" style="padding:12px">Sin carpetas todavía</div>'}
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFavTree(); });
  overlay.querySelector('.js-tree-x').addEventListener('click', closeFavTree);
  overlay.querySelectorAll('.fav-tree-row').forEach((row) => {
    row.addEventListener('click', () => {
      favFolderId = row.dataset.fid === '' ? null : +row.dataset.fid;
      closeFavTree();
      loadYifyFavs();
    });
  });
  document.addEventListener('keydown', favTreeEsc);
  document.body.appendChild(overlay);
  favTreeEl = overlay;
}

// Hace de `el` un destino donde soltar una peli para moverla a `folderId`
// (null = raíz). Compartido por los tiles de carpeta y el botón "◀ Todas".
function wireFavDropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => {
    if (favDragId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('fav-drop-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('fav-drop-over'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    el.classList.remove('fav-drop-over');
    let id = favDragId;
    if (id == null) { const d = +e.dataTransfer.getData('text/plain'); id = Number.isNaN(d) ? null : d; }
    favDragId = null;
    if (id == null) return;
    const m = favAll.find((x) => x.id === id);
    if (m && (m.folderId ?? null) === (folderId ?? null)) return;   // ya está ahí
    const r = await window.api.favs.move(id, folderId);
    if (r && r.error) return;
    loadYifyFavs();
  });
}

// Habilita el arrastre de las tarjetas/filas de película en modo Favoritos y
// el menú de click derecho ("Mover a…").
// Se llama tras cada render (también al cambiar de vista).
function enableFavDnD(el) {
  let items;
  if (yifyView === 'icons') items = el.querySelectorAll('.yify-dash-cell');
  else if (yifyView === 'list') items = el.querySelectorAll('.yify-tr:not(.yify-tr-head)');
  else items = el.querySelectorAll('.yify-movie');
  items.forEach((item) => {
    const idxEl = item.dataset.i != null ? item : item.querySelector('[data-i]');
    if (!idxEl) return;
    const m = yifyShown[+idxEl.dataset.i];
    if (!m) return;
    item.setAttribute('draggable', 'true');
    item.classList.add('fav-draggable');
    item.querySelectorAll('img').forEach((im) => { im.draggable = false; });
    // Click derecho: el menú con "Mover a…" (lo mismo que arrastrar, pero
    // llegando a cualquier carpeta del árbol).
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openFavCtxMenu(e.clientX, e.clientY, m);
    });
    item.addEventListener('dragstart', (e) => {
      favDragId = m.id;
      try { e.dataTransfer.setData('text/plain', String(m.id)); } catch {}
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('fav-dragging');
      const bar = $('yify-fav-bar');
      if (bar) bar.classList.add('fav-dnd-active');
    });
    item.addEventListener('dragend', () => {
      favDragId = null;
      item.classList.remove('fav-dragging');
      const bar = $('yify-fav-bar');
      if (bar) bar.classList.remove('fav-dnd-active');
      document.querySelectorAll('.fav-drop-over').forEach((n) => n.classList.remove('fav-drop-over'));
    });
  });
}

// ── Click derecho sobre una película favorita ──────────────────
// Menú flotante chico anclado al puntero: "Mover a…" abre el selector de
// carpetas (donde además se puede crear una nueva) y, si la peli ya está en
// una carpeta, un atajo para devolverla a la raíz. Es la alternativa al
// arrastre para cuando la carpeta destino no está a la vista (otro nivel del
// árbol) o la ventana quedó chica. Solo existe en modo Favoritos.
let favCtxEl = null;
function closeFavCtx() {
  if (favCtxEl) { favCtxEl.remove(); favCtxEl = null; }
  document.removeEventListener('mousedown', favCtxAway, true);
  document.removeEventListener('keydown', favCtxKey, true);
  window.removeEventListener('resize', closeFavCtx);
  window.removeEventListener('scroll', closeFavCtx, true);
}
function favCtxAway(e) { if (favCtxEl && !favCtxEl.contains(e.target)) closeFavCtx(); }
function favCtxKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeFavCtx(); } }

function openFavCtxMenu(x, y, movie) {
  closeFavCtx();
  const fid = movie.folderId ?? null;
  const folder = favFolders.find((f) => f.id === fid) || null;
  const menu = document.createElement('div');
  menu.className = 'fav-ctx';
  menu.innerHTML = `
    <div class="fav-ctx-head" title="${escapeHtml(movie.title || '')}">${escapeHtml(movie.title || 'Película')}</div>
    <div class="fav-ctx-where">${folder ? `📁 En «${escapeHtml(folder.name)}»` : '🏠 Sin carpeta'}</div>
    <button class="fav-ctx-item js-ctx-move">📂 Mover a…</button>
    ${folder ? `<button class="fav-ctx-item js-ctx-root">🏠 Sacar de la carpeta</button>` : ''}`;
  document.body.appendChild(menu);
  favCtxEl = menu;

  // Que no se salga de la ventana (la grilla llega hasta el borde).
  const pad = 6;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - w - pad))}px`;
  menu.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - h - pad))}px`;

  menu.querySelector('.js-ctx-move').addEventListener('click', () => openFavMoveModal(movie));
  const rootBtn = menu.querySelector('.js-ctx-root');
  if (rootBtn) rootBtn.addEventListener('click', async () => {
    closeFavCtx();
    const r = await window.api.favs.move(movie.id, null);
    if (r && r.error) return;
    loadYifyFavs();
  });
  document.addEventListener('mousedown', favCtxAway, true);
  document.addEventListener('keydown', favCtxKey, true);
  window.addEventListener('resize', closeFavCtx);
  window.addEventListener('scroll', closeFavCtx, true);
}

// Modal "Mover a": árbol completo de carpetas para elegir destino (raíz
// incluida) + crear una carpeta nueva sin salir. La carpeta nueva cuelga del
// destino elegido — así se arma la jerarquía desde el mismo modal — y queda
// seleccionada para mover ahí de una.
let favMoveEl = null;
function closeFavMove() {
  if (favMoveEl) { favMoveEl.remove(); favMoveEl = null; }
  document.removeEventListener('keydown', favMoveEsc);
}
function favMoveEsc(e) { if (e.key === 'Escape') closeFavMove(); }

function openFavMoveModal(movie) {
  closeFavCtx();
  closeFavMove();
  const from = movie.folderId ?? null;   // dónde está ahora
  let dest = from;                       // destino elegido
  let creating = false;                  // input "nueva carpeta" abierto
  let err = '';

  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  document.body.appendChild(overlay);
  favMoveEl = overlay;
  document.addEventListener('keydown', favMoveEsc);

  const nameOf = (id) => {
    const f = favFolders.find((x) => x.id === id);
    return f ? f.name : 'Todas (raíz)';
  };
  const row = (id, name, ico, depth) => {
    const n = favAll.filter((m) => (m.folderId ?? null) === id).length;
    return `
    <div class="fav-tree-row fav-move-row${dest === id ? ' sel' : ''}" data-fid="${id == null ? '' : id}" style="padding-left:${depth * 18 + 12}px">
      <span class="fav-tree-ico">${ico}</span>
      <span class="fav-tree-name">${escapeHtml(name)}</span>
      ${from === id ? '<span class="fav-move-here">acá está</span>' : ''}
      <span class="yify-fav-count">${n}</span>
    </div>`;
  };
  // Subcarpetas recursivas; `guard` corta ciclos por si un parent quedó mal.
  const walk = (pid, depth, guard) => favFolders
    .filter((f) => (f.parentId ?? null) === pid)
    .map((f) => {
      if (guard.has(f.id)) return '';
      guard.add(f.id);
      return row(f.id, f.name, '📁', depth) + walk(f.id, depth + 1, guard);
    }).join('');

  const draw = () => {
    overlay.innerHTML = `
      <div class="fin-modal-box fav-move-box">
        <div class="fin-exp-modal-head">
          <span class="fin-exp-modal-title">📂 Mover a…</span>
          <button class="fin-modal-x js-move-x" title="Cerrar">✕</button>
        </div>
        <div class="fav-move-movie" title="${escapeHtml(movie.title || '')}">🎬 ${escapeHtml(movie.title || 'Película')}</div>
        <div class="fav-tree fav-move-tree">
          ${row(null, 'Todas (raíz)', '🏠', 0)}
          ${walk(null, 1, new Set())}
        </div>
        <div class="fav-move-new">
          ${creating
            ? `<input class="fin-input yify-fav-newinput js-move-newinput" placeholder="Nombre de la carpeta… (Enter)" autocomplete="off" maxlength="40">`
            : `<button class="fin-btn js-move-new" title="Crear una carpeta dentro de «${escapeHtml(nameOf(dest))}»">＋ Nueva carpeta en «${escapeHtml(nameOf(dest))}»</button>`}
        </div>
        ${err ? `<div class="fav-move-err">${escapeHtml(err)}</div>` : ''}
        <div class="fin-modal-actions">
          <button class="yify-fav-tool js-move-cancel">Cancelar</button>
          <button class="fin-btn js-move-ok"${dest === from ? ' disabled title="Ya está en esa carpeta"' : ''}>Mover acá</button>
        </div>
      </div>`;
    wire();
    const sel = overlay.querySelector('.fav-move-row.sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  };

  // Cambiar de destino no redibuja el modal (si no, el segundo clic del
  // doble clic caería sobre una fila ya reemplazada): retoca lo que cambia.
  const syncSel = () => {
    overlay.querySelectorAll('.fav-move-row').forEach((r) => {
      const id = r.dataset.fid === '' ? null : +r.dataset.fid;
      r.classList.toggle('sel', id === dest);
    });
    const nb = overlay.querySelector('.js-move-new');
    if (nb) {
      nb.textContent = `＋ Nueva carpeta en «${nameOf(dest)}»`;
      nb.title = `Crear una carpeta dentro de «${nameOf(dest)}»`;
    }
    const ok = overlay.querySelector('.js-move-ok');
    if (ok) { ok.disabled = dest === from; ok.title = dest === from ? 'Ya está en esa carpeta' : ''; }
    const e = overlay.querySelector('.fav-move-err');
    if (e) e.remove();
  };

  const doMove = async () => {
    if (dest === from) { closeFavMove(); return; }
    const btn = overlay.querySelector('.js-move-ok');
    if (btn) { btn.disabled = true; btn.textContent = 'Moviendo…'; }
    const r = await window.api.favs.move(movie.id, dest);
    if (r && r.error) { err = r.error; draw(); return; }
    closeFavMove();
    loadYifyFavs();
  };

  const wire = () => {
    overlay.querySelector('.js-move-x').addEventListener('click', closeFavMove);
    overlay.querySelector('.js-move-cancel').addEventListener('click', closeFavMove);
    overlay.querySelector('.js-move-ok').addEventListener('click', doMove);

    overlay.querySelectorAll('.fav-move-row').forEach((r) => {
      const id = r.dataset.fid === '' ? null : +r.dataset.fid;
      r.addEventListener('click', () => { dest = id; err = ''; syncSel(); });
      r.addEventListener('dblclick', () => { dest = id; doMove(); });
    });

    if (creating) {
      const input = overlay.querySelector('.js-move-newinput');
      input.focus();
      let done = false;
      const commit = async () => {
        if (done) return; done = true;
        const name = input.value.trim();
        creating = false;
        if (!name) { draw(); return; }
        // Cuelga del destino elegido en ese momento (se puede cambiar de fila
        // con el input abierto).
        const r = await window.api.favs.createFolder(name, dest);
        if (r && r.ok && r.folder) {
          favFolders.push(r.folder);
          dest = r.folder.id;   // queda elegida: un clic más y la peli va ahí
          renderFavBar();       // la barra de atrás muestra la carpeta nueva
        } else {
          err = (r && r.error) || 'No se pudo crear la carpeta';
        }
        draw();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') { done = true; creating = false; draw(); }
      });
    } else {
      overlay.querySelector('.js-move-new').addEventListener('click', () => { creating = true; err = ''; draw(); });
    }
  };

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFavMove(); });
  draw();
}

function setYifyFavsMode(on) {
  yifyFavsMode = !!on;
  const btn = $('yify-favs-btn');
  if (btn) btn.classList.toggle('active', yifyFavsMode);
  // La búsqueda y los filtros le pegan a la API: se ocultan en Favoritos
  // (el toggle de vista sí aplica, queda visible).
  ['yify-search', 'yify-search-clear', 'yify-search-btn'].forEach((id) => {
    const n = $(id);
    if (n) n.style.display = yifyFavsMode ? 'none' : '';
  });
  const filters = document.querySelector('#tab-torrents .yify-filters');
  if (filters) filters.style.display = yifyFavsMode ? 'none' : '';
  // La barra manda sobre todo el tab: en Favoritos la sección de "Últimos
  // Films" (subidas recientes de Lime) sobra — los favoritos de Lime ya salen
  // en la grilla de arriba, con su chip LIME.
  const limeCard = $('lime-list') && $('lime-list').closest('section');
  if (limeCard) limeCard.style.display = yifyFavsMode ? 'none' : '';
  if (yifyFavsMode) {
    loadYifyFavs();
  } else {
    favFolderId = null;
    favCreating = false;
    renderFavBar();   // oculta la barra de carpetas
    if (yifyOk) loadYifyList();
    else initYify();
  }
}

// ── Ficha de película (modal): movie_details + movie_suggestions ──
let yifyModalEl = null;
function closeYifyModal() {
  if (yifyModalEl) { yifyModalEl.remove(); yifyModalEl = null; }
  document.removeEventListener('keydown', yifyModalEsc);
}
// Con el reproductor abierto, Escape cierra el player primero (no la ficha).
function yifyModalEsc(e) { if (e.key === 'Escape' && !playerState) closeYifyModal(); }

async function openYifyModal(movieId) {
  closeYifyModal();
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box yify-modal-box">
      <div class="ai-loading">Cargando ficha…</div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeYifyModal(); });
  document.addEventListener('keydown', yifyModalEsc);
  document.body.appendChild(overlay);
  yifyModalEl = overlay;

  let det = null, sug = null;
  try {
    [det, sug] = await Promise.all([
      window.api.yify.details(movieId),
      window.api.yify.suggestions(movieId).catch(() => null),
    ]);
  } catch {}
  if (yifyModalEl !== overlay) return;   // la cerraron mientras cargaba

  const box = overlay.querySelector('.yify-modal-box');
  if (!det || det.error) {
    // API caída pero la película es favorita: la ficha sale de la base local.
    if (favIds.has(movieId)) {
      try {
        const favs = await window.api.favs.list();
        const f = Array.isArray(favs) ? favs.find((x) => x.id === movieId) : null;
        if (yifyModalEl !== overlay) return;
        if (f) { fillYifyModal(box, f, []); return; }
      } catch {}
      if (yifyModalEl !== overlay) return;
    }
    box.innerHTML = `
      <div class="yify-down-msg">⚠️ No se pudo cargar la ficha${det && det.error ? ` <span class="yify-down-err">(${escapeHtml(det.error)})</span>` : ''}</div>
      <div class="fin-modal-actions"><button class="fin-btn js-yify-x">Cerrar</button></div>`;
    box.querySelector('.js-yify-x').addEventListener('click', closeYifyModal);
    return;
  }

  const sugMovies = (sug && !sug.error && Array.isArray(sug.movies)) ? sug.movies : [];
  fillYifyModal(box, det, sugMovies);
}

// Ficha armada con un objeto ya cargado (sin pegarle a la API de YIFY):
// favoritos desde SQLite, y también las películas de LimeTorrents (el feed
// ya trae los magnets; no hay endpoint de detalles que consultar). Las de
// Lime se pintan al instante con lo que trae el feed y después se completan
// con reparto, sinopsis y similares (movies:ficha por imdb id: YIFY o TMDB),
// para que la ficha quede como la de YIFY.
function openFavModal(m) {
  closeYifyModal();
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `<div class="fin-modal-box yify-modal-box"></div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeYifyModal(); });
  document.addEventListener('keydown', yifyModalEsc);
  document.body.appendChild(overlay);
  yifyModalEl = overlay;
  const box = overlay.querySelector('.yify-modal-box');
  fillYifyModal(box, m, []);
  if (m.source === 'lime') enrichLimeModal(overlay, box, m);
}

// imdb id de una película de Lime: el del grupo o, en un favorito viejo (solo
// persiste `url`), el de la URL de IMDb. null si el feed no tuvo match.
function limeImdbOf(m) {
  if (m.imdb) return m.imdb;
  const mm = /imdb\.com\/title\/(tt\d+)/i.exec(m.imdbUrl || m.url || '');
  return mm ? mm[1] : null;
}

// Completa la ficha de Lime con reparto, sinopsis, géneros, trailer y
// sugerencias y re-pinta el modal con el objeto fusionado (id, torrents y
// origen siguen siendo los de Lime — así el ♥ guarda la ficha completa).
async function enrichLimeModal(overlay, box, m) {
  const imdb = limeImdbOf(m);
  if (!imdb) return;
  const hasFicha = m.synopsis && m.cast && m.cast.length;   // favorito ya completo
  const note = document.createElement('div');
  note.className = 'yify-modal-note';
  note.textContent = hasFicha ? 'Buscando similares…' : 'Buscando reparto, sinopsis y similares…';
  box.appendChild(note);
  let f = null;
  try { f = await window.api.movies.ficha({ imdb }); } catch {}
  if (yifyModalEl !== overlay) return;   // la cerraron mientras cargaba
  if (!f || f.error) {
    if (hasFicha) note.remove();
    else note.textContent = `Sin ficha extendida${f && f.error ? ` (${f.error})` : ''}`;
    return;
  }
  fillYifyModal(box, mergeFicha(m, f), Array.isArray(f.suggestions) ? f.suggestions : []);
}

// Fusión de una película (Lime) con una ficha extendida (YIFY/TMDB): lo que
// la película ya sabe manda (título, año, poster, torrents, id, origen); la
// ficha aporta lo que falta.
function mergeFicha(m, f) {
  return {
    ...m,
    synopsis: f.synopsis || m.synopsis || '',
    cast: (f.cast && f.cast.length) ? f.cast : (m.cast || []),
    genres: (m.genres && m.genres.length) ? m.genres : (f.genres || []),
    rating: m.rating ?? f.rating ?? null,
    runtime: m.runtime ?? f.runtime ?? null,
    trailer: m.trailer || f.trailer || null,
    cover: m.cover || f.cover || null,
    imdb: m.imdb || f.imdb || null,
  };
}

// Ficha de una película similar de TMDB (click en "Sugerencias" de una ficha
// de Lime completada por TMDB). movies:ficha resuelve tmdbId → imdb id y
// prueba YIFY: si está, se abre la ficha completa de YIFY (torrents + "Ver
// online"). Si no, se muestra la de TMDB y se buscan magnets en LimeTorrents
// por título; sin torrents en ninguna, queda la ficha sola con un acceso al
// buscador del tab Films.
async function openTmdbMovieModal(tmdbId) {
  closeYifyModal();
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box yify-modal-box">
      <div class="ai-loading">Cargando ficha…</div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeYifyModal(); });
  document.addEventListener('keydown', yifyModalEsc);
  document.body.appendChild(overlay);
  yifyModalEl = overlay;

  let f = null;
  try { f = await window.api.movies.ficha({ tmdbId }); } catch {}
  if (yifyModalEl !== overlay) return;
  const box = overlay.querySelector('.yify-modal-box');
  if (!f || f.error) {
    box.innerHTML = `
      <div class="yify-down-msg">⚠️ No se pudo cargar la ficha${f && f.error ? ` <span class="yify-down-err">(${escapeHtml(f.error)})</span>` : ''}</div>
      <div class="fin-modal-actions"><button class="fin-btn js-yify-x">Cerrar</button></div>`;
    box.querySelector('.js-yify-x').addEventListener('click', closeYifyModal);
    return;
  }
  // Está en YIFY: su ficha completa (torrents, "Ver online", sugerencias).
  if (f.source === 'yify' && f.id) { openYifyModal(f.id); return; }

  const sug = Array.isArray(f.suggestions) ? f.suggestions : [];
  fillYifyModal(box, { ...f, id: null, source: 'tmdb', torrents: [] }, sug);
  const note = document.createElement('div');
  note.className = 'yify-modal-note';
  note.textContent = 'No está en YIFY — buscando torrents en LimeTorrents…';
  const quals = box.querySelector('.yify-quals');
  if (quals) quals.after(note);

  // Torrents de Lime: primero lo ya cargado en el tab (mismo imdb id, o mismo
  // título y año) y, si no está, el buscador del sitio. El searchrss no banca
  // los dos puntos ni otros signos, así que la consulta va limpia; con
  // subtítulo ("Título: Lo que sea") se reintenta solo con la parte principal.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const imdb = (f.imdb || '').toLowerCase();
  const sameMovie = (x) => (imdb && x.imdb && x.imdb.toLowerCase() === imdb)
    || (norm(x.title) === norm(f.title) && (!f.year || !x.year || Math.abs(x.year - f.year) <= 1));
  let g = limeAll.find(sameMovie) || null;
  if (!g) {
    const queries = [norm(f.title)];
    if (f.title.includes(':')) queries.push(norm(f.title.split(':')[0]));
    for (const q of queries) {
      if (g || !q) break;
      try {
        const r = await window.api.lime.search({ cat: 'movies', query: q });
        if (yifyModalEl !== overlay) return;
        const list = (r && !r.error && Array.isArray(r.movies)) ? r.movies : [];
        g = list.find(sameMovie) || null;
      } catch {}
    }
  }
  if (yifyModalEl !== overlay) return;
  if (g) {
    // Ficha de Lime completada con lo de TMDB (♥ y magnets como cualquier Lime).
    fillYifyModal(box, mergeFicha(g, f), sug);
    return;
  }
  note.innerHTML = `Sin torrents en YIFY ni LimeTorrents. <button class="rd-ext js-yify-find">Buscar en Films ↗</button>`;
  note.querySelector('.js-yify-find').addEventListener('click', () => {
    closeYifyModal();
    switchTab('torrents');
    if (yifyFavsMode) setYifyFavsMode(false);
    const inp = $('yify-search');
    if (inp) { inp.value = f.title; yifySearchNew(); }
  });
}

// Links externos de la ficha según las fuentes: YIFY → YTS; Lime/TMDB → IMDb +
// página del torrent. Un favorito con torrents de las dos fuentes muestra los
// tres: la página de YTS / de Lime sale de sus propios torrents (`page`).
function movieLinkButtons(m) {
  const btn = (label, url) => `<button class="fin-btn js-yify-link" data-url="${escapeHtml(url)}">${label}</button>`;
  const ts = m.torrents || [];
  const isImdb = (u) => /imdb\.com/i.test(u || '');
  const pageOf = (src) => { const t = ts.find((x) => x.source === src && x.page); return t ? t.page : null; };
  const fromYify = m.source !== 'lime' && m.source !== 'tmdb';
  const yts = (fromYify && m.url && !isImdb(m.url)) ? m.url : pageOf('yify');
  const lime = m.page || (!fromYify && m.url && !isImdb(m.url) ? m.url : null) || pageOf('lime');
  const imdb = (!fromYify || lime)
    ? (m.imdbUrl || (m.imdb ? `https://www.imdb.com/title/${m.imdb}/` : null) || (isImdb(m.url) ? m.url : null))
    : null;
  return (yts ? btn('Ver en YTS ↗', yts) : '') + (imdb ? btn('Ver en IMDb ↗', imdb) : '') + (lime ? btn('LimeTorrents ↗', lime) : '');
}

// Un favorito con torrents de YIFY y de Lime a la vez: los badges de calidad
// se distinguen por origen (data-src pinta los de Lime).
function mixedSources(m) {
  return Array.isArray(m.sources) && m.sources.length > 1;
}
function qualSrcAttr(m, t) {
  return (mixedSources(m) && t.source) ? ` data-src="${t.source}"` : '';
}
function qualSrcTitle(m, t) {
  return (mixedSources(m) && t.source) ? ` · ${srcLabel(t.source)}` : '';
}

// Botones de magnet de la ficha. Con torrents de las dos fuentes se agrupan
// por origen con su etiqueta; con una sola se ven como siempre.
function modalQualsHtml(m) {
  const ts = m.torrents || [];
  const btn = (t, ti) => `
            <button class="yify-q js-yify-modal-magnet" data-t="${ti}"${qualSrcAttr(m, t)}
              title="Magnet ${escapeHtml(t.quality || '?')}${t.type ? ` ${escapeHtml(t.type)}` : ''} · ${escapeHtml(t.size)}${t.seeds != null ? ` · ${t.seeds} seeds` : ''}${qualSrcTitle(m, t)}">
              🧲 ${escapeHtml(t.quality || '?')} <span class="yify-q-size">${escapeHtml(t.size)}</span>
            </button>`;
  const srcs = [...new Set(ts.map((t) => t.source).filter(Boolean))];
  if (!mixedSources(m) || srcs.length < 2) return `<div class="yify-quals">${ts.map(btn).join('')}</div>`;
  return srcs.map((s) => `
        <div class="yify-quals yify-quals-src">
          <span class="fav-src fav-src-${s} fav-src-inline">${srcLabel(s)}</span>
          ${ts.map((t, ti) => (t.source === s ? btn(t, ti) : '')).join('')}
        </div>`).join('');
}

// Cuerpo + wiring de la ficha, compartido entre la versión API (YIFY), las
// películas de LimeTorrents y la versión offline (favoritos de ambas fuentes).
function fillYifyModal(box, m, sugMovies) {
  box.innerHTML = `
    <div class="fin-exp-modal-head">
      <span class="fin-exp-modal-title">${escapeHtml(m.title)}${m.year ? ` (${m.year})` : ''}</span>
      <button class="fin-modal-x js-yify-x" title="Cerrar">✕</button>
    </div>
    <div class="yify-modal-body">
      ${m.cover
        ? `<img class="yify-poster yify-modal-poster" src="${escapeHtml(m.cover)}" alt="">`
        : `<div class="yify-poster yify-modal-poster yify-noposter">🎬</div>`}
      <div class="yify-modal-info">
        <div class="yify-meta">${escapeHtml(yifyMeta(m))}${m.source ? ` <span class="fav-src fav-src-${m.source} fav-src-inline">${srcLabel(m.source)}</span>` : ''}</div>
        ${m.genres && m.genres.length ? `<div class="yify-genres">${escapeHtml(m.genres.join(' · '))}</div>` : ''}
        <div class="yify-modal-actions-row">
          ${bestStreamTorrent(m) ? `<button class="fin-btn yify-watch-action js-yify-watch">▶ Ver online</button>` : ''}
          ${m.id ? `<button class="fin-btn yify-fav-action js-yify-modal-fav${isFav(m) ? ' faved' : ''}">${isFav(m) ? '♥ En favoritos' : '♡ Guardar en favoritos'}</button>` : ''}
          ${m.trailer ? `<button class="fin-btn js-yify-link" data-url="${escapeHtml(m.trailer)}">▶ Trailer</button>` : ''}
          ${movieLinkButtons(m)}
        </div>
        ${modalQualsHtml(m)}
        ${m.cast && m.cast.length ? `
          <div class="yify-cast-title">Reparto</div>
          <div class="yify-cast">${m.cast.map((c) =>
            `<span class="yify-cast-item"><b>${escapeHtml(c.name)}</b>${c.character ? ` — ${escapeHtml(c.character)}` : ''}</span>`
          ).join('')}</div>` : ''}
      </div>
    </div>
    ${m.synopsis ? `<div class="yify-synopsis">${escapeHtml(m.synopsis)}</div>` : ''}
    ${sugMovies.length ? `
      <div class="yify-cast-title">Sugerencias</div>
      <div class="yify-sug-grid">
        ${sugMovies.map((s) => `
          <div class="yify-dash-cell js-yify-sug" data-id="${s.id}" data-src="${s.src || 'yify'}" title="${escapeHtml(s.title)}${s.year ? ` (${s.year})` : ''}">
            ${s.cover
              ? `<img class="yify-poster" src="${escapeHtml(s.cover)}" loading="lazy" alt="">`
              : `<div class="yify-poster yify-noposter">🎬</div>`}
            <div class="yify-dash-title">${escapeHtml(s.title)}</div>
            <div class="yify-dash-meta">${escapeHtml(yifyMeta(s))}</div>
          </div>`).join('')}
      </div>` : ''}`;

  box.querySelector('.js-yify-x').addEventListener('click', closeYifyModal);
  const favBtn = box.querySelector('.js-yify-modal-fav');
  if (favBtn) favBtn.addEventListener('click', async () => {
    if (favBtn.disabled) return;
    favBtn.disabled = true;
    favBtn.textContent = isFav(m) ? 'Quitando…' : 'Guardando…';
    await toggleYifyFav(m);
    favBtn.disabled = false;
    const on = isFav(m);
    favBtn.classList.toggle('faved', on);
    favBtn.textContent = on ? '♥ En favoritos' : '♡ Guardar en favoritos';
  });
  box.querySelectorAll('.js-yify-link').forEach((b) => {
    b.addEventListener('click', () => { if (b.dataset.url) window.api.openExternal(b.dataset.url); });
  });
  const watchBtn = box.querySelector('.js-yify-watch');
  if (watchBtn) watchBtn.addEventListener('click', () => openPlayer(m));
  box.querySelectorAll('.js-yify-modal-magnet').forEach((b) => {
    b.addEventListener('click', () => {
      const t = (m.torrents || [])[+b.dataset.t];
      const link = t && (t.magnet || t.url);
      if (link) window.api.openExternal(link);
    });
  });
  // Sugerencias: las de YIFY abren su ficha; las de TMDB (similares de una
  // película de Lime que YIFY no tiene) se resuelven en openTmdbMovieModal.
  box.querySelectorAll('.js-yify-sug').forEach((c) => {
    c.addEventListener('click', () => {
      if (c.dataset.src === 'tmdb') openTmdbMovieModal(+c.dataset.id);
      else openYifyModal(+c.dataset.id);
    });
  });
}

// ── Reproductor en directo (WebTorrent + <video>) ─────────────────────────
// Abre un overlay sobre la ficha, agrega el magnet en el proceso principal y
// apunta el <video> a la URL local (soporta Range → adelantar/retroceder y
// volumen nativos). Los subtítulos se bajan de OpenSubtitles y se muestran como
// <track>. Al cerrar se detiene el torrent y se borran del disco las partes ya
// descargadas.
let playerState = null;   // { overlay, infoHash, statsTimer, blobUrls, subs, movie, currentSub }

// Mejor torrent para stream: prioriza contenedores que Chromium reproduce
// (x264 .mp4 de 1080p/720p) y deja el 2160p x265 último (suele no decodificar).
function bestStreamTorrent(m) {
  const ts = (m.torrents || []).filter((t) => t && t.magnet);
  if (!ts.length) return null;
  const rank = (t) => {
    const q = String(t.quality || '');
    if (q.startsWith('1080')) return 4;
    if (q.startsWith('720')) return 3;
    if (q.startsWith('480')) return 2;
    if (q.startsWith('2160')) return 1;   // HEVC: menos compatible
    return 0;
  };
  const srcRank = (t) => (t.source === 'lime' ? 0 : 1);   // YIFY reproduce directo; Lime suele ser MKV/HEVC
  return ts.slice().sort((a, b) => rank(b) - rank(a) || srcRank(b) - srcRank(a))[0];
}

function fmtSpeed(bps) {
  if (!bps || bps < 1024) return `${Math.round(bps || 0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(0)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function closePlayer() {
  const st = playerState;
  if (!st) return;
  playerState = null;
  try { clearInterval(st.statsTimer); } catch {}
  try { if (st.hls) st.hls.destroy(); } catch {}
  const v = st.overlay && st.overlay.querySelector('video');
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
  (st.blobUrls || []).forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
  if (st.overlay) st.overlay.remove();
  document.removeEventListener('keydown', playerEsc);
  if (st.infoHash) { try { window.api.stream.stop(st.infoHash); } catch {} }   // borra lo bajado
}
function playerEsc(e) { if (e.key === 'Escape') closePlayer(); }

function openPlayer(m, torrentIndex) {
  closePlayer();
  const torrents = (m.torrents || []).filter((t) => t && t.magnet);
  const torrent = (torrentIndex != null && torrents[torrentIndex]) ? torrents[torrentIndex] : bestStreamTorrent(m);
  if (!torrent) return;

  const overlay = document.createElement('div');
  overlay.className = 'player-overlay';
  overlay.innerHTML = `
    <div class="player-box">
      <div class="player-head">
        <span class="player-title">${escapeHtml(m.title)}${m.year ? ` (${m.year})` : ''}</span>
        <span class="player-mode" id="player-mode"></span>
        <span class="player-status" id="player-status">Conectando…</span>
        <button class="fin-modal-x js-player-x" title="Cerrar (Esc)">✕</button>
      </div>
      <div class="player-stage">
        <video id="player-video" controls autoplay playsinline></video>
        <div class="player-stage-msg" id="player-msg">
          <div class="ai-loading">Buscando seeds y preparando la reproducción…</div>
        </div>
      </div>
      <div class="player-controls">
        <label class="player-ctl">
          <span>Calidad</span>
          <select id="player-quality">
            ${torrents.map((t, i) => `<option value="${i}">${escapeHtml(t.quality || '?')}${t.type ? ' · ' + escapeHtml(t.type) : ''}${t.size ? ' · ' + escapeHtml(t.size) : ''}</option>`).join('')}
          </select>
        </label>
        <label class="player-ctl">
          <span>Subtítulos</span>
          <select id="player-subs"><option value="">Cargando…</option></select>
        </label>
        <button class="fin-btn player-sub-dl js-player-subdl" disabled title="Descargar el subtítulo seleccionado (.srt)">⬇ Descargar sub</button>
        <span class="player-sub-note" id="player-sub-note"></span>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePlayer(); });
  document.addEventListener('keydown', playerEsc);
  document.body.appendChild(overlay);

  playerState = { overlay, infoHash: null, statsTimer: null, blobUrls: [], subs: [], movie: m, currentSub: null };

  overlay.querySelector('.js-player-x').addEventListener('click', closePlayer);
  const qSel = overlay.querySelector('#player-quality');
  qSel.value = String(torrents.indexOf(torrent));
  qSel.addEventListener('change', () => {
    const t = torrents[+qSel.value];
    if (t) startPlayback(t);
  });
  overlay.querySelector('.js-player-subdl').addEventListener('click', downloadPlayerSub);
  overlay.querySelector('#player-subs').addEventListener('change', (e) => {
    if (e.target.value === '') clearPlayerSub();
    else applyPlayerSub(+e.target.value);
  });

  loadPlayerSubs(m);
  startPlayback(torrent);
}

async function startPlayback(torrent) {
  const st = playerState;
  if (!st) return;
  const token = (st.playToken = (st.playToken || 0) + 1);   // invalida cargas anteriores
  const video = st.overlay.querySelector('#player-video');
  const status = st.overlay.querySelector('#player-status');
  const msg = st.overlay.querySelector('#player-msg');

  const modeEl = st.overlay.querySelector('#player-mode');
  if (st.infoHash) { try { window.api.stream.stop(st.infoHash); } catch {} st.infoHash = null; }
  try { clearInterval(st.statsTimer); } catch {}
  st.statsTimer = null;
  try { if (st.hls) { st.hls.destroy(); st.hls = null; } } catch {}
  try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
  msg.style.display = 'flex';
  msg.innerHTML = `<div class="ai-loading">Buscando seeds y preparando la reproducción…</div>`;
  status.textContent = 'Conectando…';
  if (modeEl) { modeEl.textContent = ''; modeEl.title = ''; }

  const r = await window.api.stream.start(torrent.magnet);
  if (playerState !== st || st.playToken !== token) {   // cerraron o cambiaron de calidad mientras conectaba
    if (r && r.infoHash) { try { window.api.stream.stop(r.infoHash); } catch {} }
    return;
  }
  if (!r || r.error) {
    status.textContent = 'Error';
    msg.innerHTML = `<div class="player-err">No se pudo iniciar la reproducción${r && r.error ? `<br><span class="yify-down-err">${escapeHtml(r.error)}</span>` : ''}<br><br>Probá otra calidad, o abrí el 🧲 magnet en tu cliente de torrents.</div>`;
    return;
  }
  st.infoHash = r.infoHash;

  if (modeEl && r.note) { modeEl.textContent = r.transcoding ? '⚙ Transcodificando' : (r.mode === 'hls' ? '⚙ Remux' : ''); modeEl.title = r.note; }

  if (r.mode === 'hls' && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ maxBufferLength: 30 });
    st.hls = hls;
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (playerState !== st || st.playToken !== token || !data.fatal) return;
      status.textContent = 'Error de transcodificación';
      msg.style.display = 'flex';
      msg.innerHTML = `<div class="player-err">Falló el stream transcodificado.<br>Probá otra calidad.</div>`;
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
    hls.loadSource(r.url);
    hls.attachMedia(video);
  } else {
    video.src = r.url;
    video.play().catch(() => {});
    if (!r.playable) {
      msg.innerHTML = `<div class="player-err">El archivo <b>${escapeHtml(r.name)}</b> puede no reproducirse aquí (contenedor/códec no soportado por Chromium).${r.note ? `<br><span class="yify-down-err">${escapeHtml(r.note)}</span>` : ''}<br>Probá 720p o 1080p (x264 .mp4).</div>`;
    }
  }

  video.addEventListener('playing', () => { if (playerState === st && st.playToken === token) msg.style.display = 'none'; }, { once: true });
  video.addEventListener('error', () => {
    if (playerState !== st || st.playToken !== token) return;
    status.textContent = 'Error de reproducción';
    msg.style.display = 'flex';
    msg.innerHTML = `<div class="player-err">El navegador no pudo reproducir este archivo (códec/contenedor no soportado).<br>Probá 720p o 1080p (x264 .mp4).</div>`;
  }, { once: true });

  st.statsTimer = setInterval(async () => {
    if (playerState !== st || st.playToken !== token || !st.infoHash) return;
    const s = await window.api.stream.stats(st.infoHash);
    if (playerState !== st || st.playToken !== token || !s || !s.active) return;
    const pct = Math.round((s.progress || 0) * 100);
    status.textContent = `${s.numPeers || 0} peers · ${fmtSpeed(s.downloadSpeed)} · ${pct}% buffer`;
  }, 1500);
}

// Baja la lista de subtítulos (ES/EN) y llena el dropdown; auto-selecciona el
// primer español si lo hay.
async function loadPlayerSubs(m) {
  const st = playerState;
  if (!st) return;
  const sel = st.overlay.querySelector('#player-subs');
  const note = st.overlay.querySelector('#player-sub-note');
  const r = await window.api.subs.search({ imdbId: m.imdb, query: m.title, langs: ['spa', 'eng'] });
  if (playerState !== st || !sel) return;
  const subs = (r && !r.error && Array.isArray(r.subs)) ? r.subs : [];
  st.subs = subs;
  if (!subs.length) {
    sel.innerHTML = `<option value="">Sin subtítulos</option>`;
    sel.disabled = true;
    if (note) note.textContent = (r && r.error) ? 'No se pudieron buscar subtítulos' : 'Sin subtítulos disponibles';
    return;
  }
  sel.innerHTML = `<option value="">Sin subtítulos</option>` + subs.map((s, i) =>
    `<option value="${i}">${escapeHtml(s.langName)} · ${escapeHtml(s.name)}${s.downloads ? ` (${s.downloads})` : ''}</option>`
  ).join('');
  sel.disabled = false;
  const firstEs = subs.findIndex((s) => s.lang === 'spa');
  if (firstEs >= 0) { sel.value = String(firstEs); applyPlayerSub(firstEs); }
}

function clearPlayerSub() {
  const st = playerState;
  if (!st) return;
  const video = st.overlay.querySelector('#player-video');
  video.querySelectorAll('track').forEach((t) => t.remove());
  try { for (const tt of video.textTracks) tt.mode = 'disabled'; } catch {}
  (st.blobUrls || []).forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
  st.blobUrls = [];
  st.currentSub = null;
  const dlBtn = st.overlay.querySelector('.js-player-subdl');
  const note = st.overlay.querySelector('#player-sub-note');
  if (dlBtn) dlBtn.disabled = true;
  if (note) note.textContent = '';
}

// Baja el sub elegido, lo convierte a track VTT y lo muestra en vivo.
async function applyPlayerSub(index) {
  const st = playerState;
  if (!st) return;
  clearPlayerSub();
  const sub = st.subs[index];
  if (!sub) return;
  const video = st.overlay.querySelector('#player-video');
  const note = st.overlay.querySelector('#player-sub-note');
  if (note) note.textContent = 'Bajando subtítulo…';
  const r = await window.api.subs.fetch({ link: sub.link, encoding: sub.encoding });
  if (playerState !== st) return;
  if (!r || r.error || !r.vtt) { if (note) note.textContent = 'No se pudo bajar el subtítulo'; return; }
  const url = URL.createObjectURL(new Blob([r.vtt], { type: 'text/vtt' }));
  st.blobUrls.push(url);
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = sub.langName;
  track.srclang = sub.lang === 'spa' ? 'es' : (sub.lang === 'eng' ? 'en' : sub.lang);
  track.src = url;
  track.default = true;
  video.appendChild(track);
  const enable = () => { try { const tt = video.textTracks[video.textTracks.length - 1]; if (tt) tt.mode = 'showing'; } catch {} };
  track.addEventListener('load', enable, { once: true });
  setTimeout(enable, 250);
  st.currentSub = sub;
  const dlBtn = st.overlay.querySelector('.js-player-subdl');
  if (dlBtn) dlBtn.disabled = false;
  if (note) note.textContent = '';
}

// Guarda a disco el .srt del subtítulo seleccionado (diálogo de guardado).
async function downloadPlayerSub() {
  const st = playerState;
  if (!st || !st.currentSub) return;
  const sub = st.currentSub;
  const dlBtn = st.overlay.querySelector('.js-player-subdl');
  const note = st.overlay.querySelector('#player-sub-note');
  if (dlBtn) dlBtn.disabled = true;
  if (note) note.textContent = 'Guardando…';
  const base = `${st.movie.title}${st.movie.year ? ` (${st.movie.year})` : ''}.${sub.lang}.srt`;
  const r = await window.api.subs.download({ link: sub.link, encoding: sub.encoding, filename: base });
  if (playerState !== st) return;
  if (dlBtn) dlBtn.disabled = false;
  if (!note) return;
  if (r && r.ok) note.textContent = '✓ Guardado en disco';
  else if (r && r.canceled) note.textContent = '';
  else note.textContent = 'No se pudo guardar';
}

// Health check de arranque. También lo reusa el botón "Reintentar".
async function initYify() {
  setYifyStatus('checking', 'Verificando…');
  const list = $('yify-list');
  if (list) list.innerHTML = `<div class="ai-loading">Verificando API…</div>`;
  let st;
  try { st = await window.api.yify.check(); } catch { st = { ok: false, error: 'error interno' }; }
  if (!yifyTimerStarted) {
    yifyTimerStarted = true;
    setInterval(() => { if (yifyOk) refreshYifyLatest(); }, YIFY_INTERVAL_MS);
  }
  // Aunque el probe falle se intenta listar: el tab sale del archivo
  // histórico y solo cae en "API caída" si la base todavía está vacía
  // (refreshYifyLatest llama a markYifyDown cuando no hay ni una cosa ni la
  // otra).
  if (st && st.ok) {
    yifyOk = true;
    setYifyStatus('connected', 'API conectada');
  } else {
    setYifyStatus('disconnected', 'API caída — listando el archivo');
  }
  refreshYifyLatest();
}

const yifySearchBtn = $('yify-search-btn');
if (yifySearchBtn) yifySearchBtn.addEventListener('click', yifySearchNew);
const yifySearchInput = $('yify-search');
if (yifySearchInput) {
  yifySearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') yifySearchNew(); });
  // Búsqueda en vivo: filtra mientras se escribe; al limpiar vuelve al listado.
  yifySearchInput.addEventListener('input', debounce(yifySearchNew, 400));
}
['yify-sort', 'yify-genre', 'yify-quality', 'yify-minrating'].forEach((id) => {
  const sel = $(id);
  if (sel) sel.addEventListener('change', yifySearchNew);
});
// Toggle de vista (tarjetas / iconos / lista) del TAB Films: re-renderiza lo
// ya cargado en LAS DOS fuentes (YIFY y LimeTorrents) sin volver a pegarle a
// la API. La elección persiste en localStorage.
function setYifyView(view) {
  if (view === yifyView) return;
  const oldSize = yifyPageSize();
  yifyView = view;
  try { localStorage.setItem('yifyView', view); } catch {}
  document.querySelectorAll('#yify-view-toggle .yify-view-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  const newSize = yifyPageSize();
  // Lime pagina local: rehacer la página con el tamaño nuevo alcanza.
  if (limeAll.length) {
    limePage = Math.floor(((limePage - 1) * oldSize) / newSize) + 1;
    renderLimePage();
  } else if (limeShown.length) {
    renderLimeCards(limeShown);
  }
  // Favoritos no pagina: alcanza con re-renderizar lo ya cargado.
  if (yifyFavsMode) { if (yifyShown.length) renderYifyMovies(yifyShown); return; }
  if (newSize === oldSize) {
    if (yifyShown.length) renderYifyMovies(yifyShown);
    return;
  }
  // El tamaño de página cambió: mantener la posición aproximada en el listado
  // y recargar con el límite nuevo (los iconos muestran muchos más por página).
  const firstIdx = (yifyPage - 1) * oldSize;
  yifyPage = Math.floor(firstIdx / newSize) + 1;
  if (yifyOk) loadYifyList();
  else if (yifyShown.length) renderYifyMovies(yifyShown);
}
document.querySelectorAll('#yify-view-toggle .yify-view-btn').forEach((b) => {
  b.classList.toggle('active', b.dataset.view === yifyView);
  b.addEventListener('click', () => setYifyView(b.dataset.view));
});
const yifyRefreshBtn = $('yify-refresh');
if (yifyRefreshBtn) yifyRefreshBtn.addEventListener('click', () => {
  if (yifyFavsMode) loadYifyFavs();
  else if (yifyOk) loadYifyList();
  else initYify();
});
const yifyDashRefreshBtn = $('yify-dash-refresh');
if (yifyDashRefreshBtn) yifyDashRefreshBtn.addEventListener('click', () => { refreshYifyLatest(); refreshLime(); refreshEztvDash(); });
const yifyFavsBtn = $('yify-favs-btn');
if (yifyFavsBtn) yifyFavsBtn.addEventListener('click', () => setYifyFavsMode(!yifyFavsMode));
// Ids de favoritos al arrancar, para pintar los ♥ sobre lo ya renderizado.
window.api.favs.ids().then((keys) => {
  setFavKeys(keys);
  if (!yifyFavsMode && yifyShown.length) renderYifyMovies(yifyShown);
  if (limeShown.length) renderLimeCards(limeShown);
}).catch(() => {});

// ── LimeTorrents RSS (tab Torrents Films) ──────────────────────
// Segunda fuente del tab Films: el feed RSS de limetorrents.fun (categoría
// Movies). No hay búsqueda — main agrupa los releases del feed por película
// y los enriquece con el poster de IMDb, así las cards se ven como las de
// YIFY (poster + badges de calidad con magnet). El click abre la ficha, que
// se completa con reparto, sinopsis y similares por imdb id. Mismo patrón
// defensivo que YIFY/EZTV: initLime() corre el health check y si el feed se
// cae la grilla degrada a "RSS caído" con Reintentar.
const LIME_COUNT = 50;      // releases del feed (se apilan por película)
// El RSS no pagina (probado /rss/16/2/, ?p=2 y date/2/ — siempre devuelve la
// misma primera página), así que la paginación es local sobre lo agrupado.
// El tamaño de página sale de la vista del tab (la misma que YIFY): tarjetas
// 12, iconos 40, lista 20.
let limeOk = null;        // null = verificando; resultado del health check
let limeLatest = null;    // último listado (alimenta el dashboard, 2 celdas)
let limeAll = [];         // todas las películas agrupadas del feed
let limePage = 1;         // página local actual
let limeShown = [];       // películas renderizadas (para los clicks)
let limeFetching = false;
let limeTimerStarted = false;

function setLimeStatus(kind, text) {
  const wrap = $('lime-status'), txt = $('lime-status-text');
  if (!wrap) return;
  wrap.className = `db-status ${kind}`;
  if (txt) txt.textContent = text;
}

function renderLimeDown(err) {
  const el = $('lime-list');
  if (!el) return;
  el.className = 'yify-grid';
  el.innerHTML = `
    <div class="yify-down">
      <div class="yify-down-msg">⚠️ El RSS de LimeTorrents no responde${err ? ` <span class="yify-down-err">(${escapeHtml(err)})</span>` : ''}</div>
      <button id="lime-retry" class="fin-btn">Reintentar</button>
    </div>`;
  const btn = $('lime-retry');
  if (btn) btn.addEventListener('click', initLime);
}

function markLimeDown(err) {
  limeOk = false;
  limeLatest = null;
  limeAll = [];
  limePage = 1;
  limeShown = [];
  const pager = $('lime-pager');
  if (pager) pager.innerHTML = '';
  setLimeStatus('disconnected', 'RSS caído');
  renderLimeDown(err);
  renderYifyDash();   // el dashboard rellena sus celdas con YIFY
}

function limeMeta(m) {
  const bits = [];
  if (m.year) bits.push(String(m.year));
  if (m.latestAt) bits.push(ezDate(m.latestAt));
  const seeds = Math.max(0, ...m.torrents.map((t) => t.seeds || 0));
  if (seeds > 0) bits.push(`▲ ${seeds}`);
  return bits.join(' · ');
}

function limeFavHtml(m, i, mini = false) {
  const on = isFav(m);
  return `<button class="yify-fav-btn${mini ? ' yify-fav-mini' : ''}${on ? ' faved' : ''} js-lime-fav" data-i="${i}"
    title="${on ? 'Quitar de favoritos' : 'Guardar en favoritos'}">${on ? '♥' : '♡'}</button>`;
}

// Clicks compartidos por las tres vistas: ficha (js-lime-open), magnet y ♥.
function attachLimeClickHandlers(el) {
  el.querySelectorAll('.js-lime-open').forEach((n) => {
    n.addEventListener('click', () => {
      const m = limeShown[+n.dataset.i];
      if (m) openFavModal(m);   // ficha con lo que trae el feed (magnets incluidos)
    });
  });
  el.querySelectorAll('.js-lime-magnet').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();   // en la vista lista el padre abre la ficha
      const m = limeShown[+b.dataset.i];
      const t = m && m.torrents ? m.torrents[+b.dataset.t] : null;
      if (t && t.magnet) window.api.openExternal(t.magnet);
    });
  });
  el.querySelectorAll('.js-lime-fav').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.stopPropagation();   // el padre abre la ficha
      const m = limeShown[+b.dataset.i];
      if (!m || b.disabled) return;
      b.disabled = true;
      b.textContent = '…';
      await toggleYifyFav(m);   // re-renderiza la grilla (el botón se descarta)
    });
  });
}

// Vista "grid": cards como las de YIFY (mismas clases): poster de IMDb, ♥
// para guardar en favoritos y badges de calidad con el magnet de cada release.
function renderLimeGrid(el) {
  el.className = 'yify-grid';
  el.innerHTML = limeShown.map((m, i) => `
    <div class="yify-movie">
      <div class="yify-poster-wrap js-lime-open" data-i="${i}" title="Ver ficha">
        ${m.cover
          ? `<img class="yify-poster" src="${escapeHtml(m.cover)}" loading="lazy" alt="">`
          : `<div class="yify-poster yify-noposter">🎬</div>`}
        ${limeFavHtml(m, i)}
      </div>
      <div class="yify-info">
        <div class="yify-title js-lime-open" data-i="${i}" title="${escapeHtml(m.title)}">${escapeHtml(m.title)}</div>
        <div class="yify-meta">${escapeHtml(limeMeta(m))}</div>
        <div class="yify-quals">
          ${(m.torrents || []).map((t, ti) => `
            <button class="yify-q js-lime-magnet" data-i="${i}" data-t="${ti}"
              title="Magnet${t.quality ? ` ${escapeHtml(t.quality)}` : ''}${t.size ? ` · ${escapeHtml(t.size)}` : ''}${t.seeds != null ? ` · ${t.seeds} seeds` : ''}">
              🧲 ${escapeHtml(t.quality || '?')}
            </button>`).join('')}
        </div>
      </div>
    </div>`).join('');
}

// Vista "icons": grilla densa de posters chicos (igual que la de YIFY).
function renderLimeIcons(el) {
  el.className = 'yify-icons-grid';
  el.innerHTML = limeShown.map((m, i) => `
    <div class="yify-dash-cell js-lime-open" data-i="${i}"
      title="${escapeHtml(m.title)}${m.year ? ` (${m.year})` : ''} — ver ficha">
      ${m.cover
        ? `<img class="yify-poster" src="${escapeHtml(m.cover)}" loading="lazy" alt="">`
        : `<div class="yify-poster yify-noposter">🎬</div>`}
      ${limeFavHtml(m, i)}
      <div class="yify-dash-title">${escapeHtml(m.title)}</div>
      <div class="yify-dash-meta">${escapeHtml(limeMeta(m))}</div>
    </div>`).join('');
}

// Vista "list": una fila por release, con las mismas columnas que la de YIFY
// (el RSS no trae rating: esa columna va en —).
function renderLimeTable(el) {
  el.className = 'yify-table';
  const rows = [];
  limeShown.forEach((m, i) => {
    const ts = (m.torrents && m.torrents.length) ? m.torrents : [null];
    ts.forEach((t, ti) => {
      rows.push(`
        <div class="yify-tr">
          <span class="yify-td-title js-lime-open" data-i="${i}" title="${escapeHtml(t ? t.title : m.title)} — ver ficha">${ti === 0 ? limeFavHtml(m, i, true) : ''}${escapeHtml(m.title)}</span>
          <span class="yify-td-num">${m.year ?? '—'}</span>
          <span class="yify-td-num yify-td-rating">—</span>
          <span class="yify-td-qual">${t && t.quality ? escapeHtml(t.quality) : '—'}</span>
          <span class="yify-td-num">${t && t.size ? escapeHtml(t.size) : '—'}</span>
          <span class="yify-td-num yify-td-seeds">${t && t.seeds != null ? t.seeds : '—'}</span>
          <span class="yify-td-num yify-td-peers">${t && t.peers != null ? t.peers : '—'}</span>
          <span class="yify-td-mag">${t && t.magnet ? `
            <button class="yify-q yify-q-mini js-lime-magnet" data-i="${i}" data-t="${ti}"
              title="Magnet${t.quality ? ` ${escapeHtml(t.quality)}` : ''}${t.size ? ` · ${escapeHtml(t.size)}` : ''}">🧲</button>` : ''}</span>
        </div>`);
    });
  });
  el.innerHTML = `
    <div class="yify-tr yify-tr-head">
      <span>Película</span>
      <span class="yify-td-num">Año</span>
      <span class="yify-td-num">★</span>
      <span>Calidad</span>
      <span class="yify-td-num">Tamaño</span>
      <span class="yify-td-num" title="Seeders">Seeds</span>
      <span class="yify-td-num" title="Leechers">Leech</span>
      <span></span>
    </div>` + rows.join('');
}

// Dispatcher de la grilla: usa la MISMA vista que YIFY — el toggle vive en la
// barra del tab y manda sobre las dos fuentes. El click abre la ficha (mismo
// modal que YIFY; el RSS no trae sinopsis/cast, se completan por imdb id —
// ver openFavModal / enrichLimeModal).
function renderLimeCards(movies) {
  const el = $('lime-list');
  if (!el) return;
  limeShown = Array.isArray(movies) ? movies : [];
  if (!limeShown.length) {
    el.className = 'yify-grid';
    el.innerHTML = `<div class="ai-loading">${limeQuery
      ? `Sin resultados en LimeTorrents para “${escapeHtml(limeQuery)}”`
      : 'Sin subidas recientes'}</div>`;
    return;
  }
  if (yifyView === 'icons') renderLimeIcons(el);
  else if (yifyView === 'list') renderLimeTable(el);
  else renderLimeGrid(el);
  attachLimeClickHandlers(el);
}

// Pager local "‹ Página X de Y ›" (mismo look que el de YIFY).
function renderLimePager() {
  const el = $('lime-pager');
  if (!el) return;
  const total = limeAll.length;
  const totalPages = Math.max(1, Math.ceil(total / yifyPageSize()));
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  if (limePage > totalPages) limePage = totalPages;
  el.innerHTML = `
    <button class="fin-month-nav-btn js-lime-prev" title="Página anterior" ${limePage <= 1 ? 'disabled' : ''}>‹</button>
    <span class="yify-pager-info">Página ${limePage.toLocaleString('es-UY')} de ${totalPages.toLocaleString('es-UY')} · ${total.toLocaleString('es-UY')} películas</span>
    <button class="fin-month-nav-btn js-lime-next" title="Página siguiente" ${limePage >= totalPages ? 'disabled' : ''}>›</button>`;
  el.querySelector('.js-lime-prev').addEventListener('click', () => {
    if (limePage > 1) { limePage--; renderLimePage(); }
  });
  el.querySelector('.js-lime-next').addEventListener('click', () => {
    if (limePage < totalPages) { limePage++; renderLimePage(); }
  });
}

// Página actual de la grilla + pager. Se llama al cargar y al navegar.
function renderLimePage() {
  const size = yifyPageSize();
  const totalPages = Math.max(1, Math.ceil(limeAll.length / size));
  if (limePage > totalPages) limePage = totalPages;
  const start = (limePage - 1) * size;
  renderLimeCards(limeAll.slice(start, start + size));
  renderLimePager();
  adjustWindowSize();
}

async function refreshLime() {
  if (limeFetching) return;
  limeFetching = true;
  const btn = $('lime-refresh');
  if (btn) btn.disabled = true;
  try {
    const r = await window.api.lime.list({ limit: LIME_COUNT });
    if (r && !r.error && Array.isArray(r.movies)) {
      limeOk = true;
      setLimeStatus('connected', 'RSS conectado');
      limeLatest = r;
      // Una búsqueda activa no se pisa con los recientes (el refresco
      // periódico igual alimenta el dashboard).
      if (!limeQuery) {
        limeAll = r.movies;
        renderLimePage();   // grilla paginada + pager
      }
      renderYifyDash();   // 2 celdas del dashboard salen de este listado
    } else {
      markLimeDown(r && r.error);
    }
  } catch (e) {
    markLimeDown(String(e && e.message || e));
  } finally {
    if (btn) btn.disabled = false;
    limeFetching = false;
  }
}

// Búsqueda de películas en LimeTorrents (la dispara el buscador del tab
// Films, la misma caja que YIFY): con query la grilla de Lime muestra esos
// resultados agrupados por película; al limpiar vuelve a los recientes.
let limeQuery = '';
async function limeSearchMovies(q) {
  limeQuery = String(q || '').trim();
  if (!limeQuery) { limePage = 1; limeOk ? refreshLime() : initLime(); return; }
  const el = $('lime-list');
  if (el) { el.className = 'yify-grid'; el.innerHTML = `<div class="ai-loading">Buscando en LimeTorrents…</div>`; }
  const pager = $('lime-pager');
  if (pager) pager.innerHTML = '';
  adjustWindowSize();
  const mine = limeQuery;
  try {
    const r = await window.api.lime.search({ cat: 'movies', query: mine });
    if (limeQuery !== mine) return;   // ya hay otra búsqueda (o se limpió)
    if (r && !r.error && Array.isArray(r.movies)) {
      limeOk = true;
      setLimeStatus('connected', 'RSS conectado');
      limeAll = r.movies;
      limePage = 1;
      renderLimePage();
    } else if (el) {
      el.innerHTML = `<div class="ai-loading">Falló la búsqueda${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>`;
      adjustWindowSize();
    }
  } catch (e) {
    if (limeQuery === mine && el) {
      el.innerHTML = `<div class="ai-loading">Falló la búsqueda (${escapeHtml(String(e && e.message || e))})</div>`;
      adjustWindowSize();
    }
  }
}

// Health check de arranque. También lo reusa el botón "Reintentar".
async function initLime() {
  setLimeStatus('checking', 'Verificando…');
  const list = $('lime-list');
  if (list) list.innerHTML = `<div class="ai-loading">Verificando RSS…</div>`;
  let st;
  try { st = await window.api.lime.check(); } catch { st = { ok: false, error: 'error interno' }; }
  if (!limeTimerStarted) {
    limeTimerStarted = true;
    setInterval(() => { if (limeOk) refreshLime(); }, YIFY_INTERVAL_MS);
  }
  if (st && st.ok) {
    limeOk = true;
    setLimeStatus('connected', 'RSS conectado');
    refreshLime();
  } else {
    markLimeDown(st && st.error);
  }
}

const limeRefreshBtn = $('lime-refresh');
if (limeRefreshBtn) limeRefreshBtn.addEventListener('click', () => {
  limeOk ? refreshLime() : initLime();
});

// ── Secciones de LimeTorrents por categoría (Series / Juegos) ───────────────
// Cards agrupadas servidas por main (lime:tv-shows / lime:games): series con
// el estilo de EZTV (una card por show, episodios adentro) y juegos con el de
// CheapShark (una card por juego con sus releases). Mismo patrón defensivo de
// siempre (RSS caído → Reintentar). `search(q)` conecta el buscador del tab
// con el buscador del sitio (searchrss filtrado por categoría): con query la
// grilla muestra esos resultados y el refresco automático no la pisa; al
// limpiar vuelve al listado reciente.
// `getView` devuelve la vista vigente del tab (el toggle de la barra manda
// sobre las dos fuentes); `viewClass(view)` es la clase del contenedor y
// `renderCards(el, shown, view)` pinta según la vista.
function limeCardSection({ prefix, viewClass, noun, getView, fetchList, searchCat, pickGroups, renderCards }) {
  const st = { ok: null, all: [], page: 1, shown: [], query: '', fetching: false, timer: false };
  const $id = (suf) => $(`${prefix}-${suf}`);
  const view = () => (getView ? getView() : 'grid');
  const pageSize = () => YIFY_PAGE_SIZES[view()] || 12;

  function setStatus(kind, text) {
    const wrap = $id('status'), txt = $id('status-text');
    if (!wrap) return;
    wrap.className = `db-status ${kind}`;
    if (txt) txt.textContent = text;
  }

  function renderDown(err) {
    const el = $id('list'), pager = $id('pager');
    if (pager) pager.innerHTML = '';
    if (!el) return;
    el.className = 'yify-table';
    el.innerHTML = `
      <div class="yify-down">
        <div class="yify-down-msg">⚠️ El RSS de LimeTorrents no responde${err ? ` <span class="yify-down-err">(${escapeHtml(err)})</span>` : ''}</div>
        <button class="fin-btn js-lime-retry">Reintentar</button>
      </div>`;
    el.querySelector('.js-lime-retry').addEventListener('click', init);
  }

  function markDown(err) {
    st.ok = false; st.all = []; st.page = 1; st.shown = [];
    setStatus('disconnected', 'RSS caído');
    renderDown(err);
  }

  function renderPager(totalPages) {
    const el = $id('pager');
    if (!el) return;
    if (totalPages <= 1) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <button class="fin-month-nav-btn js-prev" title="Página anterior" ${st.page <= 1 ? 'disabled' : ''}>‹</button>
      <span class="yify-pager-info">Página ${st.page.toLocaleString('es-UY')} de ${totalPages.toLocaleString('es-UY')} · ${st.all.length.toLocaleString('es-UY')} ${noun}</span>
      <button class="fin-month-nav-btn js-next" title="Página siguiente" ${st.page >= totalPages ? 'disabled' : ''}>›</button>`;
    el.querySelector('.js-prev').addEventListener('click', () => { if (st.page > 1) { st.page--; renderPage(); } });
    el.querySelector('.js-next').addEventListener('click', () => { st.page++; renderPage(); });
  }

  function renderPage() {
    const el = $id('list');
    if (!el) return;
    const v = view();
    const size = pageSize();
    el.className = viewClass(v);
    const totalPages = Math.max(1, Math.ceil(st.all.length / size));
    if (st.page > totalPages) st.page = totalPages;
    const start = (st.page - 1) * size;
    st.shown = st.all.slice(start, start + size);
    if (!st.shown.length) {
      el.innerHTML = `<div class="ai-loading">${st.query
        ? `Sin resultados en LimeTorrents para “${escapeHtml(st.query)}”`
        : 'Sin subidas recientes'}</div>`;
    } else {
      renderCards(el, st.shown, v);
    }
    renderPager(totalPages);
    adjustWindowSize();
  }

  // Cambio de vista desde la barra del tab: rehace la página con el tamaño
  // nuevo manteniendo la posición aproximada. No vuelve a pegarle al RSS.
  function setView(oldSize) {
    const newSize = pageSize();
    if (st.all.length) {
      st.page = Math.floor(((st.page - 1) * (oldSize || newSize)) / newSize) + 1;
      renderPage();
    }
  }

  async function refresh() {
    if (st.fetching) return;
    st.fetching = true;
    const btn = $id('refresh');
    if (btn) btn.disabled = true;
    try {
      const r = await fetchList();
      const groups = (r && !r.error) ? pickGroups(r) : null;
      if (Array.isArray(groups)) {
        st.ok = true;
        setStatus('connected', 'RSS conectado');
        // Una búsqueda activa no se pisa con el listado de recientes.
        if (!st.query) { st.all = groups; renderPage(); }
      } else {
        markDown(r && r.error);
      }
    } catch (e) {
      markDown(String(e && e.message || e));
    } finally {
      if (btn) btn.disabled = false;
      st.fetching = false;
    }
  }

  // Búsqueda del sitio: la dispara el buscador del tab (misma caja que la
  // otra fuente). Query vacía = volver al listado reciente.
  async function search(q) {
    const query = String(q || '').trim();
    if (query === st.query) return;
    st.query = query;
    if (!query) { st.page = 1; st.ok ? refresh() : init(); return; }
    const el = $id('list');
    if (el) { el.className = viewClass(view()); el.innerHTML = `<div class="ai-loading">Buscando en LimeTorrents…</div>`; }
    const pager = $id('pager');
    if (pager) pager.innerHTML = '';
    adjustWindowSize();
    try {
      const r = await window.api.lime.search({ cat: searchCat, query });
      if (st.query !== query) return;   // ya hay otra búsqueda (o se limpió)
      const groups = (r && !r.error) ? pickGroups(r) : null;
      if (Array.isArray(groups)) {
        st.ok = true;
        setStatus('connected', 'RSS conectado');
        st.all = groups;
        st.page = 1;
        renderPage();
      } else if (el) {
        el.innerHTML = `<div class="ai-loading">Falló la búsqueda${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>`;
        adjustWindowSize();
      }
    } catch (e) {
      if (st.query === query && el) {
        el.innerHTML = `<div class="ai-loading">Falló la búsqueda (${escapeHtml(String(e && e.message || e))})</div>`;
        adjustWindowSize();
      }
    }
  }

  // El primer fetch hace de health check (no hay probe aparte por categoría).
  function init() {
    setStatus('checking', 'Verificando…');
    const el = $id('list');
    if (el) { el.className = viewClass(view()); el.innerHTML = `<div class="ai-loading">Verificando RSS…</div>`; }
    if (!st.timer) {
      st.timer = true;
      setInterval(() => { if (st.ok && !st.query) refresh(); }, YIFY_INTERVAL_MS);
    }
    refresh();
  }

  const refreshBtn = $id('refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => (st.ok ? refresh() : init()));

  return { init, refresh, search, setView, get ok() { return st.ok; } };
}

// ── Vistas compartidas de los tabs Series y Juegos ─────────────
// Igual que en Films: el toggle vive en la barra del tab (fuera de los cards)
// y manda sobre las DOS fuentes — EZTV + Lime en Series, CheapShark + Lime en
// Juegos. Las tres vistas son las mismas de siempre: tarjetas, iconos chicos
// y lista con detalles. La elección persiste en localStorage.
let ezView = 'grid';
try { ezView = localStorage.getItem('ezView') || 'grid'; } catch {}
let gdView = 'grid';
try { gdView = localStorage.getItem('gdView') || 'grid'; } catch {}

function tvViewClass(view) {
  if (view === 'icons') return 'yify-icons-grid';
  if (view === 'list') return 'yify-table tv-table';
  return 'ez-cards-grid';
}

function gdViewClass(view) {
  if (view === 'icons') return 'gd-icons-grid';
  if (view === 'list') return 'yify-table gd-table';
  return 'gd-grid';
}

// Celdas de serie: tarjetas e iconos comparten markup (cambia la grilla del
// contenedor). `cls` es la clase de click de cada fuente (EZTV o Lime).
function tvShowCellsHtml(shown, cls, emoji, meta) {
  return shown.map((g, i) => `
    <div class="yify-dash-cell ez-card ${cls}" data-i="${i}"
      title="${escapeHtml(g.title)}${g.year ? ` (${g.year})` : ''} — ver episodios">
      ${(g.cover || g.image)
        ? `<img class="yify-poster" src="${escapeHtml(g.cover || g.image)}" loading="lazy" alt="">`
        : `<div class="yify-poster yify-noposter">${emoji}</div>`}
      ${(g.epCount ?? (g.episodes || []).length) > 1 ? `<span class="ez-ep-count">${g.epCount ?? g.episodes.length} eps</span>` : ''}
      <div class="yify-dash-title">${escapeHtml(g.title)}</div>
      <div class="yify-dash-meta">${escapeHtml(meta(g))}</div>
    </div>`).join('');
}

// Vista lista de series: una fila por serie (año, episodios, último, fecha).
function tvShowRowsHtml(shown, cls) {
  return `
    <div class="yify-tr yify-tr-head">
      <span>Serie</span>
      <span class="yify-td-num">Año</span>
      <span class="yify-td-num">Eps</span>
      <span>Último</span>
      <span class="yify-td-num">Subido</span>
    </div>` + shown.map((g, i) => {
    const last = g.episodes && g.episodes[0];
    return `
      <div class="yify-tr">
        <span class="yify-td-title ${cls}" data-i="${i}" title="${escapeHtml(g.title)} — ver episodios">${escapeHtml(g.title)}</span>
        <span class="yify-td-num">${g.year ?? '—'}</span>
        <span class="yify-td-num">${g.epCount ?? (g.episodes || []).length}</span>
        <span class="yify-td-qual">${last ? escapeHtml(ezEpTag(last)) : '—'}</span>
        <span class="yify-td-num">${g.latestAt ? escapeHtml(ezDate(g.latestAt)) : '—'}</span>
      </div>`;
  }).join('');
}

// Vista iconos de los juegos de Lime: capsule de Steam + título + meta.
function limeGamesCellsHtml(shown) {
  return shown.map((g, i) => {
    const seeds = Math.max(0, ...g.torrents.map((t) => t.seeds || 0));
    const meta = [ezDate(g.latestAt), seeds > 0 ? `▲ ${seeds}` : ''].filter(Boolean).join(' · ');
    return `
      <div class="yify-dash-cell js-lg-card" data-i="${i}"
        title="${escapeHtml(g.title)} — abrir en LimeTorrents">
        ${g.cover
          ? `<img class="yify-poster" src="${escapeHtml(g.cover)}" loading="lazy" alt="">`
          : `<div class="yify-poster yify-noposter">🎮</div>`}
        ${g.torrents.length > 1 ? `<span class="ez-ep-count">${g.torrents.length}</span>` : ''}
        <div class="yify-dash-title">${escapeHtml(g.title)}</div>
        <div class="yify-dash-meta">${escapeHtml(meta)}</div>
      </div>`;
  }).join('');
}

// Vista lista de los juegos de Lime: una fila por release (tamaño, seeds,
// fecha y magnet), con el juego agrupado en la segunda columna.
function limeGamesRowsHtml(shown) {
  const rows = [];
  shown.forEach((g, i) => {
    (g.torrents || []).forEach((t, ti) => {
      rows.push(`
        <div class="yify-tr">
          <span class="yify-td-title js-lg-card" data-i="${i}" title="${escapeHtml(t.title)} — abrir en LimeTorrents">${escapeHtml(t.title)}</span>
          <span class="yify-td-store">${escapeHtml(g.title)}</span>
          <span class="yify-td-num">${t.size ? escapeHtml(t.size) : '—'}</span>
          <span class="yify-td-num yify-td-seeds">${t.seeds != null ? t.seeds : '—'}</span>
          <span class="yify-td-num">${t.releasedAt ? escapeHtml(ezDate(t.releasedAt)) : '—'}</span>
          <span class="yify-td-mag">${t.magnet ? `
            <button class="yify-q yify-q-mini js-lg-mag" data-i="${i}" data-t="${ti}"
              title="Magnet${t.size ? ` · ${escapeHtml(t.size)}` : ''}">🧲</button>` : ''}</span>
        </div>`);
    });
  });
  return `
    <div class="yify-tr yify-tr-head">
      <span>Release</span>
      <span>Juego</span>
      <span class="yify-td-num">Tamaño</span>
      <span class="yify-td-num" title="Seeders">Seeds</span>
      <span class="yify-td-num">Subido</span>
      <span></span>
    </div>` + rows.join('');
}

// Meta de la card de serie: S·E del último episodio + fecha (como EZTV).
function limeTvCardMeta(g) {
  const bits = [];
  const last = g.episodes && g.episodes[0];
  if (last) {
    const tag = ezEpTag(last);
    if (tag !== '—') bits.push(tag);
  }
  if (g.latestAt) bits.push(ezDate(g.latestAt));
  return bits.join(' · ');
}

// Series: una card por show → click abre el MISMO modal de serie de EZTV
// (ficha TMDB + "Subidos recientemente" con los episodios de Lime + "Todos
// los episodios" vía EZTV por imdb id). Los ids de episodio van negados para
// no chocar con los de EZTV en favoritos.
const limeTv = limeCardSection({
  prefix: 'lime-tv', noun: 'series',
  getView: () => ezView,
  viewClass: tvViewClass,
  fetchList: () => window.api.lime.tvShows(),
  searchCat: 'tv',
  pickGroups: (r) => r.shows,
  renderCards(el, shown, view) {
    el.innerHTML = view === 'list'
      ? tvShowRowsHtml(shown, 'js-ltv-card')
      : tvShowCellsHtml(shown, 'js-ltv-card', '📺', limeTvCardMeta);
    el.querySelectorAll('.js-ltv-card').forEach((c) => {
      c.addEventListener('click', () => {
        const g = shown[+c.dataset.i];
        if (!g) return;
        openEzShowModal({
          imdbNum: g.imdbNum || null,
          title: g.title,
          year: g.year,
          image: g.cover,
          episodes: (g.episodes || []).map((t) => ({ ...t, id: -t.id, filename: t.title })),
        });
      });
    });
  },
});

// Juegos: una card por juego (como las ofertas de CheapShark): capsule de
// Steam, última subida y magnets de sus releases (updates/repacks). El click
// en la card abre la página del torrent en LimeTorrents.
const limeGames = limeCardSection({
  prefix: 'lime-games', noun: 'juegos',
  getView: () => gdView,
  viewClass: gdViewClass,
  fetchList: () => window.api.lime.games(),
  searchCat: 'games',
  pickGroups: (r) => r.games,
  renderCards(el, shown, view) {
    if (view === 'icons') { el.innerHTML = limeGamesCellsHtml(shown); }
    else if (view === 'list') { el.innerHTML = limeGamesRowsHtml(shown); }
    else el.innerHTML = shown.map((g, i) => {
      const seeds = Math.max(0, ...g.torrents.map((t) => t.seeds || 0));
      const meta = [ezDate(g.latestAt), seeds > 0 ? `▲ ${seeds}` : '']
        .filter(Boolean).join(' · ');
      return `
      <div class="gd-card js-lg-card" data-i="${i}"
        title="${escapeHtml(g.torrents[0] ? g.torrents[0].title : g.title)} — abrir en LimeTorrents">
        <div class="gd-thumb-wrap">
          ${g.cover
            ? `<img class="gd-thumb lg-thumb" src="${escapeHtml(g.cover)}" loading="lazy" alt="">`
            : `<div class="gd-thumb lg-thumb gd-nothumb">🎮</div>`}
          ${g.torrents.length > 1 ? `<span class="ez-ep-count">${g.torrents.length}</span>` : ''}
        </div>
        <div class="gd-info">
          <div class="gd-title">${escapeHtml(g.title)}</div>
          <div class="gd-meta">${escapeHtml(meta)}</div>
          <div class="yify-quals">
            ${g.torrents.slice(0, 3).map((t, ti) => `
              <button class="yify-q js-lg-mag" data-i="${i}" data-t="${ti}"
                title="${escapeHtml(t.title)}${t.size ? ` · ${escapeHtml(t.size)}` : ''}${t.seeds != null ? ` · ${t.seeds} seeds` : ''}">
                🧲 ${escapeHtml(t.size || 'magnet')}
              </button>`).join('')}
          </div>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('.js-lg-card').forEach((c) => {
      c.addEventListener('click', () => {
        const g = shown[+c.dataset.i];
        const t = g && g.torrents[0];
        if (t && t.page) window.api.openExternal(t.page);
      });
    });
    el.querySelectorAll('.js-lg-mag').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();   // el magnet no debe abrir también la página
        const g = shown[+b.dataset.i];
        const t = g && g.torrents[+b.dataset.t];
        if (t && t.magnet) window.api.openExternal(t.magnet);
      });
    });
  },
});

// ── EZTV series (tab Torrents Series) ──────────────────────────
// La vista principal son cards por serie (como Films): main agrupa la página
// de torrents por imdb_id / nombre y la enriquece con el poster de IMDb
// (eztv:shows). El click abre el modal de la serie: episodios recién subidos
// + búsqueda de todos los demás por imdb_id. La búsqueda por nombre va contra
// la suggestion API de IMDb (chips) y también abre el modal. Favoritos =
// episodios guardados completos en la base (imagen + magnet links).
const EZ_PAGE_SIZE = 40;     // series por página (el listado sale del archivo)
const EZ_MODAL_PAGE = 50;    // episodios por tanda en "Todos los episodios"
let ezOk = null;          // null = verificando; resultado del health check
let ezGroups = [];        // cards de series renderizadas (para los clicks)
let ezShown = [];         // filas de Favoritos renderizadas
let ezPage = 1;
let ezFavsMode = false;
let ezFavIds = new Set();

function setEzStatus(kind, text) {
  const wrap = $('ez-status'), txt = $('ez-status-text');
  if (!wrap || !txt) return;
  wrap.className = 'db-status' + (kind ? ` ${kind}` : '');
  txt.textContent = text;
}

function ezEpTag(t) {
  const s = t.season ? `S${String(t.season).padStart(2, '0')}` : '';
  const e = t.episode ? `E${String(t.episode).padStart(2, '0')}` : '';
  return (s + e) || '—';
}

function ezDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function ezFavHtml(t, i) {
  const on = ezFavIds.has(t.id);
  return `<button class="yify-fav-btn yify-fav-mini${on ? ' faved' : ''} js-ez-fav" data-i="${i}"
    title="${on ? 'Quitar de favoritos' : 'Guardar en favoritos'}">${on ? '♥' : '♡'}</button>`;
}

function renderEzDown(err) {
  if (ezFavsMode) return;   // los favoritos viven en la base: API caída no los pisa
  const el = $('ez-list');
  if (!el) return;
  el.className = 'yify-table';
  const pager = $('ez-pager');
  if (pager) pager.innerHTML = '';
  el.innerHTML = `
    <div class="yify-down">
      <div class="yify-down-msg">⚠️ La API de EZTV no responde${err ? ` <span class="yify-down-err">(${escapeHtml(err)})</span>` : ''}</div>
      <button id="ez-retry" class="fin-btn">Reintentar</button>
    </div>`;
  const btn = $('ez-retry');
  if (btn) btn.addEventListener('click', initEztv);
  adjustWindowSize();
}

function markEzDown(err) {
  ezOk = false;
  setEzStatus('disconnected', 'API caída');
  renderEzDown(err);
}

// ── Orden de las tablas de episodios (modal de serie) ──────────
// Click en un encabezado (S·E, calidad, tamaño, seeds, leech, fecha) ordena
// la tabla de mayor a menor; segundo click invierte; tercero vuelve al orden
// de la API (más reciente primero). Persiste en localStorage y aplica a las
// dos tablas del modal a la vez ("Subidos recientemente" y "Todos").
let ezEpSort = null;   // { key, dir: 1 (desc) | -1 (asc) } | null
try { ezEpSort = JSON.parse(localStorage.getItem('ezEpSort') || 'null'); } catch {}
if (ezEpSort && (typeof ezEpSort.key !== 'string' || ![1, -1].includes(ezEpSort.dir))) ezEpSort = null;

// Tamaño en bytes: EZTV y Lime traen sizeBytes; los favoritos viejos solo el
// texto ("1.2 GB", "700 MB").
function ezSizeBytes(t) {
  if (t.sizeBytes) return Number(t.sizeBytes) || 0;
  const m = /([\d.,]+)\s*([KMGT])i?B/i.exec(t.size || '');
  if (!m) return 0;
  const n = parseFloat(m[1].replace(',', '.'));
  const exp = { K: 1, M: 2, G: 3, T: 4 }[m[2].toUpperCase()];
  return isFinite(n) ? n * 1024 ** exp : 0;
}

const EZ_SORT_KEYS = {
  se:      (t) => (t.season || 0) * 1000 + (t.episode || 0),
  quality: (t) => parseInt(t.quality, 10) || 0,   // "1080p" → 1080; sin calidad → 0
  size:    ezSizeBytes,
  seeds:   (t) => (t.seeds != null ? t.seeds : -1),
  peers:   (t) => (t.peers != null ? t.peers : -1),
  date:    (t) => t.releasedAt || 0,
};

// Copia ordenada según ezEpSort (estable: a igual valor queda el orden de la
// API). Sin orden activo devuelve el array tal cual.
function ezSortedEps(torrents) {
  const val = ezEpSort && EZ_SORT_KEYS[ezEpSort.key];
  if (!val) return torrents;
  return torrents.map((t, i) => ({ t, i, v: val(t) }))
    .sort((a, b) => ((b.v - a.v) * ezEpSort.dir) || (a.i - b.i))
    .map((x) => x.t);
}

// Encabezado de columna ordenable: la activa va resaltada con ▾ (desc) / ▴ (asc).
function ezThHtml(key, label, cls = '', title = '') {
  const on = ezEpSort && ezEpSort.key === key;
  const arrow = on ? (ezEpSort.dir === 1 ? ' ▾' : ' ▴') : '';
  return `<span class="${cls} ez-th js-ez-sort${on ? ' active' : ''}" data-k="${key}"
    title="${title ? `${escapeHtml(title)} — ` : ''}ordenar">${label}${arrow}</span>`;
}

// Filas tracker: ♥, episodio, S·E, calidad, tamaño, seeds, leech, fecha, 🧲.
// HTML + wiring separados para reusarlos en Favoritos y en las dos secciones
// del modal de serie (cada contenedor con su propio array de torrents). Los
// data-i indexan el array que se le pasa: si va ordenado, wireEzRows tiene
// que recibir el mismo array ordenado (ver renderEzEpTable).
function ezEpRowsHtml(torrents) {
  return `
    <div class="yify-tr yify-tr-head ez-tr">
      <span></span>
      <span>Episodio</span>
      ${ezThHtml('se', 'S·E', 'yify-td-num', 'Temporada · episodio')}
      ${ezThHtml('quality', 'Calidad')}
      ${ezThHtml('size', 'Tamaño', 'yify-td-num')}
      ${ezThHtml('seeds', 'Seeds', 'yify-td-num', 'Seeders')}
      ${ezThHtml('peers', 'Leech', 'yify-td-num', 'Leechers')}
      ${ezThHtml('date', 'Fecha', 'yify-td-num')}
      <span></span>
    </div>` + torrents.map((t, i) => `
    <div class="yify-tr ez-tr">
      <span class="ez-td-fav">${ezFavHtml(t, i)}</span>
      <span class="yify-td-title ez-td-title" title="${escapeHtml(t.filename || t.title)}">${escapeHtml(t.title)}</span>
      <span class="yify-td-num">${ezEpTag(t)}</span>
      <span class="yify-td-qual">${t.quality ? escapeHtml(t.quality) : '—'}</span>
      <span class="yify-td-num">${t.size ? escapeHtml(t.size) : '—'}</span>
      <span class="yify-td-num yify-td-seeds">${t.seeds != null ? t.seeds : '—'}</span>
      <span class="yify-td-num yify-td-peers">${t.peers != null ? t.peers : '—'}</span>
      <span class="yify-td-num">${ezDate(t.releasedAt)}</span>
      <span class="yify-td-mag">${t.magnet ? `
        <button class="yify-q yify-q-mini js-ez-magnet" data-i="${i}"
          title="Magnet${t.quality ? ` ${escapeHtml(t.quality)}` : ''}${t.size ? ` · ${escapeHtml(t.size)}` : ''}">🧲</button>` : ''}</span>
    </div>`).join('');
}

// Clicks de las filas (scope = contenedor). showCtx aporta nombre + poster de
// la serie al guardar un favorito desde el modal.
function wireEzRows(container, torrents, showCtx) {
  container.querySelectorAll('.js-ez-magnet').forEach((b) => {
    b.addEventListener('click', () => {
      const t = torrents[+b.dataset.i];
      if (t && t.magnet) window.api.openExternal(t.magnet);
    });
  });
  container.querySelectorAll('.js-ez-fav').forEach((b) => {
    b.addEventListener('click', async () => {
      const t = torrents[+b.dataset.i];
      if (!t || b.disabled) return;
      b.disabled = true;
      b.textContent = '…';
      await ezToggleFav(t, showCtx);
      const on = ezFavIds.has(t.id);
      b.disabled = false;
      b.textContent = on ? '♥' : '♡';
      b.classList.toggle('faved', on);
      b.title = on ? 'Quitar de favoritos' : 'Guardar en favoritos';
      if (ezFavsMode) loadEzFavs();   // en Favoritos la baja saca la fila
    });
  });
}

// Tabla de episodios del modal: ordena, pinta y cablea (filas + encabezados).
// El click en un encabezado cambia el orden y re-renderiza TODAS las tablas
// del modal (cada contenedor guarda su propio re-render en _ezRender).
function renderEzEpTable(container, torrents, showCtx) {
  const sorted = ezSortedEps(torrents);
  container.innerHTML = ezEpRowsHtml(sorted);
  wireEzRows(container, sorted, showCtx);
  container._ezRender = () => renderEzEpTable(container, torrents, showCtx);
  container.querySelectorAll('.js-ez-sort').forEach((h) => {
    h.addEventListener('click', () => {
      const k = h.dataset.k;
      if (!ezEpSort || ezEpSort.key !== k) ezEpSort = { key: k, dir: 1 };
      else if (ezEpSort.dir === 1) ezEpSort = { key: k, dir: -1 };
      else ezEpSort = null;
      try { localStorage.setItem('ezEpSort', JSON.stringify(ezEpSort)); } catch {}
      document.querySelectorAll('.ez-modal-eplist').forEach((c) => { if (c._ezRender) c._ezRender(); });
    });
  });
}

// Cards con miniatura para la sección Favoritos de series (como las películas).
// La imagen es el screenshot de EZTV (apaisado) o el poster de la serie.
function ezFavCardsHtml(favs) {
  return favs.map((t, i) => {
    const img = t.screenshot;
    const epTag = ezEpTag(t);
    const meta = [epTag !== '—' ? epTag : '', t.quality, t.size].filter(Boolean).join(' · ');
    const seeds = t.seeds != null ? `▲ ${t.seeds}` : '';
    const title = t.showTitle || t.title;
    return `
    <div class="yify-movie ez-fav-card">
      <div class="yify-poster-wrap">
        ${img
          ? `<img class="yify-poster" src="${escapeHtml(img)}" loading="lazy" alt="">`
          : `<div class="yify-poster yify-noposter">📺</div>`}
        <button class="yify-fav-btn faved js-ez-fav" data-i="${i}" title="Quitar de favoritos">♥</button>
        ${epTag !== '—' ? `<span class="ez-fav-setag">${escapeHtml(epTag)}</span>` : ''}
      </div>
      <div class="yify-info">
        <div class="yify-title" title="${escapeHtml(t.filename || t.title)}">${escapeHtml(title)}</div>
        <div class="yify-meta">${escapeHtml(meta || '—')}${seeds ? ` · <span class="yify-td-seeds">${seeds}</span>` : ''}</div>
        <div class="yify-quals">
          ${t.magnet ? `<button class="yify-q js-ez-magnet" data-i="${i}"
            title="Abrir magnet${t.quality ? ` ${escapeHtml(t.quality)}` : ''}${t.size ? ` · ${escapeHtml(t.size)}` : ''}">🧲 Magnet</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

// Sección Favoritos de series: cards con miniatura (datos de la base). El modal
// de serie sigue usando la tabla (ezEpRowsHtml); esta función es solo Favoritos.
function renderEzRows(torrents) {
  const el = $('ez-list');
  if (!el) return;
  ezShown = Array.isArray(torrents) ? torrents : [];
  if (!ezShown.length) {
    el.className = 'yify-grid';
    el.innerHTML = `<div class="ai-loading">${ezFavsMode
      ? 'Sin favoritos todavía — tocá ♡ en un episodio para guardarlo acá.'
      : 'Sin resultados'}</div>`;
    adjustWindowSize();
    return;
  }
  el.className = 'yify-grid';
  el.innerHTML = ezFavCardsHtml(ezShown);
  wireEzRows(el, ezShown, null);
  adjustWindowSize();
}

// Alta/baja del episodio favorito. El alta adjunta el contexto de la serie
// (nombre + poster de IMDb) cuando lo hay; main baja la imagen y guarda todo
// en la base (Mongo + espejo SQLite).
async function ezToggleFav(t, showCtx) {
  if (!t || !t.id) return;
  try {
    if (ezFavIds.has(t.id)) {
      const r = await window.api.sfavs.remove(t.id);
      if (r && r.ok) ezFavIds.delete(t.id);
    } else {
      const payload = {
        ...t,
        showTitle: t.showTitle || (showCtx && showCtx.title) || null,
        showImage: (showCtx && showCtx.image) || null,
      };
      const r = await window.api.sfavs.add(payload);
      if (r && r.ok) ezFavIds.add(t.id);
    }
  } catch {}
  refreshTvmaze();   // los próximos episodios salen de los favoritos
}

// Bloque TMDB del modal de serie: sinopsis en español, rating, géneros y
// "dónde ver" (streamings de UY). Falla suave: sin key/ficha no aparece nada.
async function fillEzTmdb(overlay, imdbNum) {
  let f = null;
  try { f = await window.api.tmdb.tv(imdbNum); } catch {}
  if (ezModalEl !== overlay) return;   // la cerraron mientras cargaba
  const box = overlay.querySelector('#ez-modal-tmdb');
  if (!box || !f || f.error) return;
  const metaBits = [];
  if (f.rating) metaBits.push(`★ ${f.rating}${f.votes ? ` (${f.votes.toLocaleString('es-UY')})` : ''}`);
  if (f.seasons) metaBits.push(`${f.seasons} temporada${f.seasons > 1 ? 's' : ''}`);
  if (f.episodes) metaBits.push(`${f.episodes} episodios`);
  if (f.firstAir) metaBits.push(f.firstAir.slice(0, 4) + (f.inProduction ? '–' : f.lastAir ? `–${f.lastAir.slice(0, 4)}` : ''));
  box.innerHTML = `
    <div class="ez-tmdb">
      <div class="yify-meta">${escapeHtml(metaBits.join(' · '))}${f.genres.length ? ` <span class="yify-genres">· ${escapeHtml(f.genres.join(' · '))}</span>` : ''}</div>
      ${f.overview ? `<div class="ez-tmdb-overview">${escapeHtml(f.overview)}</div>` : ''}
      ${f.providers.length ? `
        <div class="ez-tmdb-prov">
          <span class="ez-tmdb-prov-label">Ver en</span>
          ${f.providers.map((p) => `
            ${p.logo ? `<img class="ez-tmdb-prov-logo" src="${escapeHtml(p.logo)}" title="${escapeHtml(p.name)}" alt="${escapeHtml(p.name)}">`
              : `<span class="ez-tmdb-prov-name">${escapeHtml(p.name)}</span>`}`).join('')}
          ${f.providersLink ? `<button class="rd-ext js-ez-tmdb-link">↗ opciones</button>` : ''}
        </div>` : ''}
    </div>`;
  const link = box.querySelector('.js-ez-tmdb-link');
  if (link) link.addEventListener('click', () => window.api.openExternal(f.providersLink));
  box.dataset.src = 'tmdb';
}

// ── Cards de series (vista recientes, como Films) ──────────────
function ezCardMeta(g) {
  const bits = [];
  const last = g.episodes && g.episodes[0];
  if (last) bits.push(ezEpTag(last));
  if (g.latestAt) bits.push(ezDate(g.latestAt));
  return bits.join(' · ');
}

function renderEzShows(groups) {
  const el = $('ez-list');
  if (!el) return;
  ezGroups = Array.isArray(groups) ? groups : [];
  if (!ezGroups.length) {
    el.className = 'yify-table';
    el.innerHTML = `<div class="ai-loading">Sin resultados</div>`;
    adjustWindowSize();
    return;
  }
  // La vista sale del toggle de la barra del tab (la misma que usa Lime).
  el.className = tvViewClass(ezView);
  el.innerHTML = ezView === 'list'
    ? tvShowRowsHtml(ezGroups, 'js-ez-card')
    : tvShowCellsHtml(ezGroups, 'js-ez-card', '📺', ezCardMeta);
  el.querySelectorAll('.js-ez-card').forEach((c) => {
    c.addEventListener('click', () => openEzShowModal(ezGroups[+c.dataset.i]));
  });
  adjustWindowSize();
}

// ── Modal de serie: subidos recientes + todos los episodios ────
let ezModalEl = null;
function closeEzModal() {
  if (ezModalEl) { ezModalEl.remove(); ezModalEl = null; }
  document.removeEventListener('keydown', ezModalEsc);
}
function ezModalEsc(e) { if (e.key === 'Escape') closeEzModal(); }

// show: { imdbNum?, title, year?, image?, episodes? }. Con episodes (card de
// recientes) se muestran arriba; "Todos los episodios" filtra EZTV por
// imdb_id — si el grupo no trae id, se resuelve por nombre contra IMDb.
async function openEzShowModal(show) {
  if (!show) return;
  closeEzModal();
  const recent = Array.isArray(show.episodes) ? show.episodes : [];
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box yify-modal-box ez-modal-box">
      <div class="fin-exp-modal-head">
        ${show.image ? `<img class="ez-modal-poster" src="${escapeHtml(show.image)}" alt="">` : ''}
        <span class="fin-exp-modal-title ez-modal-title">📺 ${escapeHtml(show.title)}${show.year ? ` (${show.year})` : ''}</span>
        <button class="fin-modal-x js-ez-x" title="Cerrar">✕</button>
      </div>
      <div id="ez-modal-tmdb"></div>
      ${recent.length ? `
        <div class="yify-cast-title">Subidos recientemente</div>
        <div class="yify-table ez-modal-eplist ez-modal-recent" id="ez-modal-recent"></div>` : ''}
      <div class="yify-cast-title">Todos los episodios</div>
      <div class="yify-table ez-modal-eplist ez-modal-all" id="ez-modal-all"><div class="ai-loading">Buscando episodios…</div></div>
      <div class="yify-pager" id="ez-modal-more"></div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEzModal(); });
  document.addEventListener('keydown', ezModalEsc);
  document.body.appendChild(overlay);
  ezModalEl = overlay;
  overlay.querySelector('.js-ez-x').addEventListener('click', closeEzModal);
  const recentBox = overlay.querySelector('#ez-modal-recent');
  if (recentBox) renderEzEpTable(recentBox, recent, show);

  // tt id para el filtro: el del grupo, o búsqueda por nombre como fallback.
  const allBox = overlay.querySelector('#ez-modal-all');
  let imdbNum = show.imdbNum || null;
  if (!imdbNum) {
    try {
      const r = await window.api.eztv.searchShows(show.title);
      const hit = (r && !r.error && Array.isArray(r.shows)) ? r.shows[0] : null;
      if (hit) imdbNum = hit.imdbNum;
    } catch {}
    if (ezModalEl !== overlay) return;   // la cerraron mientras buscaba
  }
  // Ficha de TMDB (sinopsis en español + rating + dónde ver). Asíncrona e
  // independiente del listado: sin key o sin ficha, el bloque queda vacío.
  if (imdbNum) fillEzTmdb(overlay, imdbNum);

  if (!imdbNum) {
    allBox.innerHTML = `<div class="ai-loading">No se encontró la serie en IMDb para listar el resto de los episodios.</div>`;
    return;
  }

  // Carga paginada: 50 por tanda + botón "Cargar más" hasta agotar el total.
  const loaded = [];
  let page = 1;
  const moreBox = overlay.querySelector('#ez-modal-more');
  async function loadPage() {
    moreBox.innerHTML = '';
    let r = null;
    try { r = await window.api.eztv.list({ limit: EZ_MODAL_PAGE, page, imdbId: imdbNum }); } catch {}
    if (ezModalEl !== overlay) return;
    if (!r || r.error) {
      if (page === 1) {
        allBox.innerHTML = `<div class="ai-loading">No se pudieron cargar los episodios${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>`;
      }
      return;
    }
    loaded.push(...(r.torrents || []));
    if (loaded.length) renderEzEpTable(allBox, loaded, show);
    else allBox.innerHTML = `<div class="ai-loading">EZTV no tiene torrents de esta serie.</div>`;
    const total = r.count || 0;
    if (loaded.length && loaded.length < total) {
      moreBox.innerHTML = `<button class="fin-btn js-ez-more">Cargar más (${loaded.length.toLocaleString('es-UY')} de ${total.toLocaleString('es-UY')})</button>`;
      moreBox.querySelector('.js-ez-more').addEventListener('click', () => { page++; loadPage(); });
    }
  }
  loadPage();
}

function renderEzPager(count) {
  const el = $('ez-pager');
  if (!el) return;
  const totalPages = Math.max(1, Math.ceil((count || 0) / EZ_PAGE_SIZE));
  if (!count || totalPages <= 1) { el.innerHTML = ''; adjustWindowSize(); return; }
  if (ezPage > totalPages) ezPage = totalPages;
  el.innerHTML = `
    <button class="fin-month-nav-btn js-ez-prev" title="Página anterior" ${ezPage <= 1 ? 'disabled' : ''}>‹</button>
    <span class="yify-pager-info">Página ${ezPage.toLocaleString('es-UY')} de ${totalPages.toLocaleString('es-UY')} · ${count.toLocaleString('es-UY')} series</span>
    <button class="fin-month-nav-btn js-ez-next" title="Página siguiente" ${ezPage >= totalPages ? 'disabled' : ''}>›</button>`;
  el.querySelector('.js-ez-prev').addEventListener('click', () => {
    if (ezPage > 1) { ezPage--; loadEzList(); }
  });
  el.querySelector('.js-ez-next').addEventListener('click', () => {
    if (ezPage < totalPages) { ezPage++; loadEzList(); }
  });
  adjustWindowSize();
}

// Listado de recientes agrupado por serie (cards). La página es de torrents
// crudos de la API: los episodios subidos juntos caen en el mismo card.
async function loadEzList() {
  if (ezFavsMode) { loadEzFavs(); return; }
  const el = $('ez-list');
  if (el) { el.className = 'yify-table'; el.innerHTML = `<div class="ai-loading">Buscando…</div>`; }
  try {
    const r = await window.api.eztv.shows({ limit: EZ_PAGE_SIZE, page: ezPage });
    if (r && !r.error) {
      ezOk = true;
      setEzStatus(r.stale ? 'disconnected' : 'connected',
        r.stale ? 'API caída — listando el archivo' : 'API conectada');
      renderEzShows(r.shows);
      renderEzPager(r.count);
    } else {
      markEzDown(r && r.error);
    }
  } catch (e) {
    markEzDown(String(e && e.message || e));
  }
}

// Búsqueda: nombre → chips de series (IMDb) → click → modal de la serie.
// La misma caja también busca en LimeTorrents (grilla de la sección de Lime).
async function ezSearchShows() {
  const q = ($('ez-search') ? $('ez-search').value : '').trim();
  limeTv.search(q);
  const box = $('ez-shows');
  if (!q || !box) return;
  box.innerHTML = `<div class="ai-loading">Buscando series…</div>`;
  adjustWindowSize();
  try {
    const r = await window.api.eztv.searchShows(q);
    const shows = (r && !r.error && Array.isArray(r.shows)) ? r.shows : [];
    if (!shows.length) {
      box.innerHTML = `<div class="ai-loading">Sin series para “${escapeHtml(q)}”</div>`;
      adjustWindowSize();
      return;
    }
    box.innerHTML = shows.map((s, i) => `
      <div class="ez-show-chip js-ez-show" data-i="${i}" title="Ver torrents de ${escapeHtml(s.title)}">
        ${s.image
          ? `<img src="${escapeHtml(s.image)}" loading="lazy" alt="">`
          : `<div class="ez-chip-noimg">📺</div>`}
        <span class="ez-chip-title">${escapeHtml(s.title)}</span>
        ${s.year ? `<span class="ez-chip-year">${s.year}</span>` : ''}
      </div>`).join('');
    box.querySelectorAll('.js-ez-show').forEach((c) => {
      c.addEventListener('click', () => openEzShowModal(shows[+c.dataset.i]));
    });
    adjustWindowSize();
  } catch {
    box.innerHTML = `<div class="ai-loading">Falló la búsqueda</div>`;
    adjustWindowSize();
  }
}

// Sección Favoritos: episodios guardados en la base, 100% offline.
async function loadEzFavs() {
  const el = $('ez-list');
  const pager = $('ez-pager');
  if (pager) pager.innerHTML = '';
  if (el) el.innerHTML = `<div class="ai-loading">Cargando favoritos…</div>`;
  let favs = [], loadErr = null;
  try {
    const r = await window.api.sfavs.list();
    if (Array.isArray(r)) favs = r;
    else loadErr = (r && r.error) || 'respuesta inválida';
  } catch (e) { loadErr = (e && e.message) || String(e); }
  if (!ezFavsMode) return;   // salieron de la sección mientras cargaba
  // Ídem películas: un error de la base local se muestra, no se disfraza de vacío.
  if (loadErr) {
    ezShown = [];
    if (el) {
      el.className = 'yify-grid';
      el.innerHTML = `<div class="ai-loading">No se pudieron leer los favoritos: ${escapeHtml(loadErr)}. Nada se perdió — la copia vive en Mongo; reabrí el widget para regenerar la base local.</div>`;
    }
    adjustWindowSize();
    return;
  }
  ezFavIds = new Set(favs.map((f) => f.id));
  renderEzRows(favs);
}

function setEzFavsMode(on) {
  ezFavsMode = !!on;
  const btn = $('ez-favs-btn');
  if (btn) btn.classList.toggle('active', ezFavsMode);
  ['ez-search', 'ez-search-clear', 'ez-search-btn'].forEach((id) => {
    const n = $(id);
    if (n) n.style.display = ezFavsMode ? 'none' : '';
  });
  const shows = $('ez-shows');
  if (shows) shows.innerHTML = '';
  // Ídem Films: la barra manda sobre el tab, así que la sección de "Últimas
  // Series" de Lime se esconde mientras se navegan los favoritos.
  const limeTvCard = $('lime-tv-list') && $('lime-tv-list').closest('section');
  if (limeTvCard) limeTvCard.style.display = ezFavsMode ? 'none' : '';
  if (ezFavsMode) loadEzFavs();
  else if (ezOk) loadEzList();
  else initEztv();
}

// Health check de arranque. También lo reusa el botón "Reintentar".
async function initEztv() {
  setEzStatus('checking', 'Verificando…');
  const list = $('ez-list');
  if (list) list.innerHTML = `<div class="ai-loading">Verificando API…</div>`;
  let st;
  try { st = await window.api.eztv.check(); } catch { st = { ok: false, error: 'error interno' }; }
  // Ídem Films: el listado sale del archivo, así que se intenta igual y solo
  // se muestra "API caída" si no hay nada guardado (loadEzList → markEzDown).
  if (st && st.ok) {
    ezOk = true;
    setEzStatus('connected', 'API conectada');
  } else {
    setEzStatus('disconnected', 'API caída — listando el archivo');
  }
  loadEzList();
}

const ezSearchBtn = $('ez-search-btn');
if (ezSearchBtn) ezSearchBtn.addEventListener('click', ezSearchShows);
const ezSearchInput = $('ez-search');
if (ezSearchInput) {
  ezSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ezSearchShows(); });
  // Búsqueda en vivo: al limpiar, borra los chips de series y vuelve al listado.
  const ezLiveSearch = debounce(() => {
    if (ezSearchInput.value.trim()) ezSearchShows();
    else {
      limeTv.search('');   // Lime vuelve al listado reciente
      const box = $('ez-shows');
      if (box) box.innerHTML = '';
      adjustWindowSize();
    }
  }, 400);
  ezSearchInput.addEventListener('input', ezLiveSearch);
}
// Toggle de vista del TAB Series (barra compartida): re-renderiza lo ya
// cargado en las dos fuentes sin volver a pegarle a las APIs.
function setEzView(view) {
  if (view === ezView) return;
  const oldSize = YIFY_PAGE_SIZES[ezView] || 12;
  ezView = view;
  try { localStorage.setItem('ezView', view); } catch {}
  document.querySelectorAll('#ez-view-toggle .yify-view-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  if (!ezFavsMode && ezGroups.length) renderEzShows(ezGroups);
  limeTv.setView(oldSize);
}
document.querySelectorAll('#ez-view-toggle .yify-view-btn').forEach((b) => {
  b.classList.toggle('active', b.dataset.view === ezView);
  b.addEventListener('click', () => setEzView(b.dataset.view));
});
const ezFavsBtn = $('ez-favs-btn');
if (ezFavsBtn) ezFavsBtn.addEventListener('click', () => setEzFavsMode(!ezFavsMode));
const ezRefreshBtn = $('ez-refresh');
if (ezRefreshBtn) ezRefreshBtn.addEventListener('click', () => {
  if (ezFavsMode) loadEzFavs();
  else if (ezOk) loadEzList();
  else initEztv();
});
// Ids de favoritos al arrancar, para pintar los ♥ sobre lo ya renderizado.
window.api.sfavs.ids().then((ids) => {
  ezFavIds = new Set(Array.isArray(ids) ? ids : []);
  if (ezFavsMode && ezShown.length) renderEzRows(ezShown);
}).catch(() => {});

// Favoritos cambiados desde otro dispositivo (Nexus Mobile escribe en Mongo y
// main los reconcilia cada 5 min): se refrescan los ♥ y las vistas abiertas.
window.api.onFavsSynced(async () => {
  await refreshFavKeys();
  if (yifyFavsMode) loadYifyFavs();
  else {
    if (yifyShown.length) renderYifyMovies(yifyShown);
    if (limeShown.length) renderLimeCards(limeShown);
  }
  try { ezFavIds = new Set(await window.api.sfavs.ids()); } catch {}
  if (ezFavsMode) loadEzFavs();
  refreshTvmaze();
});

// ── TVMaze: próximos episodios de las series favoritas ─────────
// Cruza los favoritos EZTV (imdb id en la base) con TVMaze. Mini cards en una
// sola fila con scroll horizontal; solo series con próximo episodio a estrenar
// (las terminadas o sin fecha se descartan).
function tvmCountdown(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return ['¡hoy!', 'today'];
  const days = Math.ceil(ms / 86400000);
  if (days === 1) return ['mañana', 'soon'];
  if (days <= 7) return [`en ${days} días`, 'soon'];
  return [`en ${days} días`, ''];
}

async function refreshTvmaze() {
  const list = $('tvm-list');
  if (!list) return;
  const btn = $('tvm-refresh');
  if (btn) btn.classList.add('spinning');
  try {
    const r = await window.api.tvmaze.upcoming();
    if (!r || r.error) {
      list.innerHTML = `<div class="ai-loading">TVMaze no disponible${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>`;
      return;
    }
    const whenEl = $('tvm-when');
    if (whenEl) whenEl.textContent = r.fetchedAt ? fmtWhen(r.fetchedAt) : '';
    // Solo las que tienen próximo episodio con fecha (ya vienen ordenadas por fecha).
    const shows = (Array.isArray(r.shows) ? r.shows : []).filter((s) => s.next && s.next.airstamp);
    if (!shows.length) {
      list.innerHTML = `<div class="ai-loading">Ninguna de tus series favoritas (♥) tiene episodios próximos a estrenar.</div>`;
      return;
    }
    list.innerHTML = shows.map((s) => {
      const n = s.next;
      const [cd, cls] = tvmCountdown(n.airstamp);
      const date = new Date(n.airstamp).toLocaleDateString('es-UY', { day: '2-digit', month: 'short' });
      return `
        <div class="tvm-card" data-url="${escapeHtml(s.url || '')}" title="${escapeHtml(s.title)}${n.name ? ` — ${escapeHtml(n.name)}` : ''} — abrir en TVMaze">
          ${s.image ? `<img class="tvm-poster" src="${escapeHtml(s.image)}" loading="lazy" alt="">` : `<div class="tvm-poster tvm-noimg">📺</div>`}
          <div class="tvm-card-body">
            <div class="tvm-card-title">${escapeHtml(s.title)}</div>
            <div class="tvm-card-ep"><b>S${String(n.season).padStart(2, '0')}E${String(n.episode).padStart(2, '0')}</b> · ${date}</div>
            <div class="tvm-card-count ${cls}">${cd}</div>
          </div>
        </div>`;
    }).join('');
    list.querySelectorAll('.tvm-card').forEach((row) => {
      row.addEventListener('click', () => { if (row.dataset.url) window.api.openExternal(row.dataset.url); });
    });
  } finally {
    if (btn) btn.classList.remove('spinning');
    adjustWindowSize();
  }
}

const tvmRefreshBtn = $('tvm-refresh');
if (tvmRefreshBtn) tvmRefreshBtn.addEventListener('click', refreshTvmaze);

// ── Reddit (tab) ───────────────────────────────────────────────
// Subreddits configurables (localStorage). Click en un chip alterna "solo
// este sub"; ✕ lo saca de la lista. Posts vía feeds RSS (sin score: el feed
// no lo trae). Click en la fila abre el post en el browser.
const RD_DEFAULT_SUBS = ['uruguay', 'programming', 'technology'];
let rdSubs = RD_DEFAULT_SUBS.slice();
try {
  const saved = JSON.parse(localStorage.getItem('redditSubs') || 'null');
  if (Array.isArray(saved) && saved.length) rdSubs = saved;
} catch {}
let rdOnly = null;        // sub elegido con click en el chip (filtro temporal)
let rdStarted = false;
let rdLoading = false;

function rdSaveSubs() {
  try { localStorage.setItem('redditSubs', JSON.stringify(rdSubs)); } catch {}
}

function rdTimeAgo(ts) {
  if (!ts) return '';
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'ahora';
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function renderRdSubs() {
  const box = $('rd-subs');
  if (!box) return;
  box.innerHTML = rdSubs.map((s, i) => `
    <span class="rd-chip${rdOnly === s ? ' active' : ''}" data-i="${i}" title="${rdOnly === s ? 'Ver todos los subs' : `Ver solo r/${escapeHtml(s)}`}">
      r/${escapeHtml(s)}
      <button class="rd-chip-x js-rd-del" data-i="${i}" title="Quitar r/${escapeHtml(s)}">✕</button>
    </span>`).join('');
  box.querySelectorAll('.rd-chip').forEach((c) => {
    c.addEventListener('click', () => {
      const s = rdSubs[+c.dataset.i];
      rdOnly = rdOnly === s ? null : s;
      renderRdSubs();
      loadReddit();
    });
  });
  box.querySelectorAll('.js-rd-del').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const s = rdSubs[+b.dataset.i];
      rdSubs.splice(+b.dataset.i, 1);
      if (rdOnly === s) rdOnly = null;
      rdSaveSubs();
      renderRdSubs();
      loadReddit();
    });
  });
}

async function loadReddit() {
  const list = $('rd-list');
  if (!list || rdLoading) return;
  const subs = rdOnly ? [rdOnly] : rdSubs;
  if (!subs.length) {
    list.innerHTML = `<div class="ai-loading">Agregá un subreddit arriba para empezar.</div>`;
    adjustWindowSize();
    return;
  }
  rdLoading = true;
  const btn = $('rd-refresh');
  if (btn) btn.classList.add('spinning');
  list.innerHTML = `<div class="ai-loading">Cargando posts…</div>`;
  try {
    const sort = ($('rd-sort') && $('rd-sort').value) || 'hot';
    const t = ($('rd-t') && $('rd-t').value) || 'day';
    const r = await window.api.reddit.posts({ subs, sort, t, limit: 25 });
    if (!r || r.error) {
      list.innerHTML = `<div class="ai-loading">Reddit no responde${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>`;
      return;
    }
    const whenEl = $('rd-when');
    if (whenEl) whenEl.textContent = r.fetchedAt ? fmtWhen(r.fetchedAt) : '';
    const posts = Array.isArray(r.posts) ? r.posts : [];
    if (!posts.length) {
      list.innerHTML = `<div class="ai-loading">Sin posts</div>`;
      return;
    }
    list.innerHTML = posts.map((p, i) => `
      <div class="rd-post js-rd-open" data-i="${i}">
        ${p.thumb ? `<img class="rd-thumb" src="${escapeHtml(p.thumb)}" loading="lazy" alt="">` : `<div class="rd-thumb rd-nothumb">👽</div>`}
        <div class="rd-body">
          <div class="rd-title">${escapeHtml(p.title)}</div>
          <div class="rd-meta">
            <span class="rd-sub">r/${escapeHtml(p.sub)}</span>
            · u/${escapeHtml(p.author)} · ${rdTimeAgo(p.createdAt)}
            ${p.url ? `<button class="rd-ext js-rd-ext" data-i="${i}" title="Abrir link externo">↗ ${escapeHtml((() => { try { return new URL(p.url).hostname.replace(/^www\./, ''); } catch { return 'link'; } })())}</button>` : ''}
          </div>
        </div>
      </div>`).join('');
    const shown = posts;
    list.querySelectorAll('.js-rd-open').forEach((n) => {
      n.addEventListener('click', () => {
        const p = shown[+n.dataset.i];
        if (p && p.permalink) window.api.openExternal(p.permalink);
      });
    });
    list.querySelectorAll('.js-rd-ext').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const p = shown[+b.dataset.i];
        if (p && p.url) window.api.openExternal(p.url);
      });
    });
  } finally {
    rdLoading = false;
    if (btn) btn.classList.remove('spinning');
    adjustWindowSize();
  }
}

function initReddit() {
  if (rdStarted) return;
  rdStarted = true;
  renderRdSubs();
  loadReddit();
}

const rdAddBtn = $('rd-add-btn');
if (rdAddBtn) rdAddBtn.addEventListener('click', () => {
  const input = $('rd-add');
  const s = (input ? input.value : '').trim().replace(/^r\//i, '');
  if (!s || !/^[A-Za-z0-9_]+$/.test(s)) return;
  if (!rdSubs.some((x) => x.toLowerCase() === s.toLowerCase())) {
    rdSubs.push(s);
    rdSaveSubs();
    renderRdSubs();
    loadReddit();
  }
  if (input) input.value = '';
});
const rdAddInput = $('rd-add');
if (rdAddInput) rdAddInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') rdAddBtn.click(); });
const rdSortSel = $('rd-sort');
if (rdSortSel) rdSortSel.addEventListener('change', () => {
  const tSel = $('rd-t');
  if (tSel) tSel.hidden = rdSortSel.value !== 'top';
  loadReddit();
});
const rdTSel = $('rd-t');
if (rdTSel) rdTSel.addEventListener('change', loadReddit);
const rdRefreshBtn = $('rd-refresh');
if (rdRefreshBtn) rdRefreshBtn.addEventListener('click', loadReddit);

// ── Noticias UY (tab) ──────────────────────────────────────────
// Feeds RSS de diarios uruguayos mezclados y ordenados por fecha. Los chips
// activan/desactivan cada fuente (selección en localStorage). Click en una
// noticia abre el artículo en el browser.
let newsCatalog = [];          // [{ id, name }] de las fuentes disponibles
let newsSelected = null;       // Set de ids de diarios activos (null = todos)
let newsAllPosts = [];         // últimas noticias bajadas (sin filtrar)
let newsQuery = '';            // texto del buscador
let newsTopic = null;          // tema filtrado (null = todos)
let newsTopicCatalog = [];     // [{ id, label }] de temas disponibles
let newsView = 'list';         // vista: 'cards' | 'list' | 'compact'
try { newsView = localStorage.getItem('newsView') || 'list'; } catch {}
let newsStarted = false;
let newsLoading = false;
let newsTimer = null;
const NEWS_INTERVAL_MS = 15 * 60 * 1000;   // auto-refresh cada 15 min

// Normaliza para buscar/clasificar sin importar acentos ni mayúsculas.
function newsNorm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function newsTopicLabel(id) {
  const t = newsTopicCatalog.find((x) => x.id === id);
  return t ? t.label : id;
}

// Badges de tema (con color por tema vía .news-tag-<id>).
function newsTagsHtml(p) {
  if (!Array.isArray(p.topics) || !p.topics.length) return '';
  return `<span class="news-tags">${p.topics
    .map((id) => `<span class="news-tag news-tag-${id}">${escapeHtml(newsTopicLabel(id))}</span>`)
    .join('')}</span>`;
}

function newsLoadSelected() {
  try {
    const saved = JSON.parse(localStorage.getItem('newsSelectedSources') || 'null');
    if (Array.isArray(saved)) newsSelected = new Set(saved);
  } catch {}
}
function newsSaveSelected() {
  try { localStorage.setItem('newsSelectedSources', JSON.stringify([...(newsSelected || [])])); } catch {}
}
function newsIsOn(id) { return !newsSelected || newsSelected.has(id); }

function renderNewsChips() {
  const box = $('news-sources');
  if (!box) return;
  box.innerHTML = newsCatalog.map((s) => `
    <span class="rd-chip${newsIsOn(s.id) ? ' active' : ''}" data-id="${escapeHtml(s.id)}"
      title="${newsIsOn(s.id) ? 'Ocultar' : 'Mostrar'} ${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>`).join('');
  box.querySelectorAll('.rd-chip').forEach((c) => {
    c.addEventListener('click', () => {
      const id = c.dataset.id;
      // Primer toggle: materializa el set "todas" para poder sacar una.
      if (!newsSelected) newsSelected = new Set(newsCatalog.map((s) => s.id));
      if (newsSelected.has(id)) newsSelected.delete(id); else newsSelected.add(id);
      if (!newsSelected.size) newsSelected.add(id);   // no dejar todo apagado
      newsSaveSelected();
      renderNewsChips();
      loadNews();
    });
  });
}

async function loadNews() {
  const list = $('news-list');
  if (!list || newsLoading) return;
  newsLoading = true;
  const btn = $('news-refresh');
  if (btn) btn.classList.add('spinning');
  list.innerHTML = `<div class="ai-loading">Cargando noticias…</div>`;
  try {
    const sources = newsSelected ? [...newsSelected] : [];
    const r = await window.api.news.posts({ sources, limit: 50 });
    if (!r || r.error) {
      list.innerHTML = `<div class="ai-loading">No se pudieron cargar las noticias${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>`;
      return;
    }
    if (Array.isArray(r.sources) && r.sources.length && !newsCatalog.length) {
      newsCatalog = r.sources;
      renderNewsChips();
    }
    if (Array.isArray(r.topics) && r.topics.length) newsTopicCatalog = r.topics;
    const whenEl = $('news-when');
    if (whenEl) whenEl.textContent = r.fetchedAt ? fmtWhen(r.fetchedAt) : '';
    newsAllPosts = Array.isArray(r.posts) ? r.posts : [];
    renderNewsTopics();
    renderNewsList();
  } finally {
    newsLoading = false;
    if (btn) btn.classList.remove('spinning');
    adjustWindowSize();
  }
}

// Chips de temas: "Todos" + cada tema presente en lo bajado, con su conteo.
function renderNewsTopics() {
  const box = $('news-topics');
  if (!box) return;
  const counts = {};
  newsAllPosts.forEach((p) => (p.topics || []).forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const avail = newsTopicCatalog.filter((t) => counts[t.id]);
  if (newsTopic && !counts[newsTopic]) newsTopic = null;   // el tema activo desapareció
  const chips = [`<span class="rd-chip news-topic-chip${!newsTopic ? ' active' : ''}" data-id="">Todos</span>`]
    .concat(avail.map((t) => `
      <span class="rd-chip news-topic-chip${newsTopic === t.id ? ' active' : ''}" data-id="${escapeHtml(t.id)}">
        <span class="news-dot news-tag-${t.id}"></span>${escapeHtml(t.label)} <b>${counts[t.id]}</b></span>`));
  box.innerHTML = chips.join('');
  box.querySelectorAll('.news-topic-chip').forEach((c) => {
    c.addEventListener('click', () => {
      newsTopic = c.dataset.id || null;
      renderNewsTopics();
      renderNewsList();
    });
  });
}

// Filtra por tema + texto del buscador y pinta según la vista elegida.
function renderNewsList() {
  const list = $('news-list');
  if (!list) return;
  if (!newsAllPosts.length) {
    list.className = 'rd-list';
    list.innerHTML = `<div class="ai-loading">Sin noticias</div>`;
    adjustWindowSize();
    return;
  }
  let posts = newsAllPosts;
  if (newsTopic) posts = posts.filter((p) => Array.isArray(p.topics) && p.topics.includes(newsTopic));
  const q = newsNorm(newsQuery.trim());
  if (q) posts = posts.filter((p) => newsNorm(`${p.title} ${p.summary} ${p.source}`).includes(q));
  if (!posts.length) {
    list.className = 'rd-list';
    list.innerHTML = `<div class="ai-loading">Sin resultados${newsQuery.trim() ? ` para “${escapeHtml(newsQuery.trim())}”` : ''}</div>`;
    adjustWindowSize();
    return;
  }
  if (newsView === 'cards') renderNewsCards(list, posts);
  else if (newsView === 'compact') renderNewsCompact(list, posts);
  else renderNewsRows(list, posts);
  // Click compartido por las tres vistas (cada ítem trae data-i).
  list.querySelectorAll('.js-news-open').forEach((n) => {
    n.addEventListener('click', () => {
      const p = posts[+n.dataset.i];
      if (p && p.url) window.api.openExternal(p.url);
    });
  });
  adjustWindowSize();
}

// Vista lista (default): miniatura + título + resumen + meta con tags.
function renderNewsRows(list, posts) {
  list.className = 'rd-list';
  list.innerHTML = posts.map((p, i) => `
    <div class="rd-post news-post js-news-open" data-i="${i}">
      ${p.image ? `<img class="rd-thumb" src="${escapeHtml(p.image)}" loading="lazy" alt="">` : `<div class="rd-thumb rd-nothumb">📰</div>`}
      <div class="rd-body">
        <div class="rd-title">${escapeHtml(p.title)}</div>
        ${p.summary ? `<div class="news-summary">${escapeHtml(p.summary)}</div>` : ''}
        <div class="rd-meta">
          <span class="rd-sub">${escapeHtml(p.source)}</span>
          ${p.createdAt ? `· ${rdTimeAgo(p.createdAt)}` : ''}
          ${newsTagsHtml(p)}
        </div>
      </div>
    </div>`).join('');
}

// Vista tarjetas: grilla con imagen grande arriba.
function renderNewsCards(list, posts) {
  list.className = 'news-cards';
  list.innerHTML = posts.map((p, i) => `
    <div class="news-card js-news-open" data-i="${i}" title="${escapeHtml(p.title)}">
      ${p.image ? `<img class="news-card-img" src="${escapeHtml(p.image)}" loading="lazy" alt="">` : `<div class="news-card-img news-card-noimg">📰</div>`}
      <div class="news-card-body">
        ${newsTagsHtml(p)}
        <div class="news-card-title">${escapeHtml(p.title)}</div>
        ${p.summary ? `<div class="news-summary">${escapeHtml(p.summary)}</div>` : ''}
        <div class="rd-meta"><span class="rd-sub">${escapeHtml(p.source)}</span>${p.createdAt ? ` · ${rdTimeAgo(p.createdAt)}` : ''}</div>
      </div>
    </div>`).join('');
}

// Vista compacta: titulares densos, una línea, sin imagen.
function renderNewsCompact(list, posts) {
  list.className = 'news-compact';
  list.innerHTML = posts.map((p, i) => `
    <div class="news-cmp js-news-open" data-i="${i}" title="${escapeHtml(p.summary || p.title)}">
      ${newsTagsHtml(p)}
      <span class="news-cmp-title">${escapeHtml(p.title)}</span>
      <span class="news-cmp-meta">${escapeHtml(p.source)}${p.createdAt ? ` · ${rdTimeAgo(p.createdAt)}` : ''}</span>
    </div>`).join('');
}

function initNews() {
  if (newsStarted) return;
  newsStarted = true;
  newsLoadSelected();
  document.querySelectorAll('#news-view-toggle .yify-view-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === newsView);
  });
  loadNews();
  if (!newsTimer) newsTimer = setInterval(loadNews, NEWS_INTERVAL_MS);   // refresco cada 15 min
}

const newsRefreshBtn = $('news-refresh');
if (newsRefreshBtn) newsRefreshBtn.addEventListener('click', loadNews);
const newsSearchInput = $('news-search');
if (newsSearchInput) newsSearchInput.addEventListener('input', () => {
  newsQuery = newsSearchInput.value;
  renderNewsList();   // filtra en vivo sobre lo ya bajado
});
const newsSearchClear = $('news-search-clear');
if (newsSearchClear) newsSearchClear.addEventListener('click', () => {
  newsQuery = '';
  if (newsSearchInput) newsSearchInput.value = '';
  renderNewsList();
});
// Toggle de vista (tarjetas / lista / compacta), persistido en localStorage.
document.querySelectorAll('#news-view-toggle .yify-view-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.view === newsView) return;
    newsView = b.dataset.view;
    try { localStorage.setItem('newsView', newsView); } catch {}
    document.querySelectorAll('#news-view-toggle .yify-view-btn').forEach((x) => {
      x.classList.toggle('active', x.dataset.view === newsView);
    });
    renderNewsList();
  });
});

// ── Juegos: ofertas CheapShark (tab) ───────────────────────────
// Grid de cards con capsule de la tienda, -% y precio viejo/nuevo. El click
// abre el redirect oficial de CheapShark (lleva a la tienda). Paginado simple
// prev/next: la API no devuelve total en el body.
let gdStarted = false;
let gdPage = 0;
let gdLoading = false;
let gdDeals = [];   // ofertas de la página actual (para re-pintar al cambiar de vista)

function fmtUsd2(v) {
  if (v == null || !isFinite(v)) return '—';
  return 'U$S ' + v.toFixed(2);
}

async function loadGames() {
  const list = $('gd-list');
  if (!list || gdLoading) return;
  gdLoading = true;
  const btn = $('gd-refresh');
  if (btn) btn.classList.add('spinning');
  list.className = gdViewClass(gdView);
  list.innerHTML = `<div class="ai-loading">Cargando ofertas…</div>`;
  const pager = $('gd-pager');
  if (pager) pager.innerHTML = '';
  try {
    const val = (id, def = '') => { const n = $(id); return n ? n.value : def; };
    const r = await window.api.games.deals({
      page: gdPage,
      storeId: val('gd-store'),
      sortBy: val('gd-sort', 'Deal Rating'),
      title: val('gd-search').trim(),
      maxPrice: parseInt(val('gd-maxprice', '0'), 10) || 0,
    });
    if (!r || r.error) {
      gdDeals = [];
      list.innerHTML = `<div class="ai-loading">CheapShark no responde${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>`;
      return;
    }
    const whenEl = $('gd-when');
    if (whenEl) whenEl.textContent = r.fetchedAt ? fmtWhen(r.fetchedAt) : '';
    // Primer load: llenar el select de tiendas (manteniendo la selección).
    const storeSel = $('gd-store');
    if (storeSel && storeSel.options.length <= 1 && Array.isArray(r.stores) && r.stores.length) {
      const cur = storeSel.value;
      storeSel.innerHTML = `<option value="">Todas las tiendas</option>` +
        r.stores.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
      storeSel.value = cur;
    }
    gdDeals = Array.isArray(r.deals) ? r.deals : [];
    if (!gdDeals.length) {
      list.className = gdViewClass(gdView);
      list.innerHTML = `<div class="ai-loading">Sin ofertas con esos filtros</div>`;
      return;
    }
    renderGdDeals();
    if (pager) {
      // El listado sale del archivo (games.sqlite), así que ahora sí hay total
      // y páginas: CheapShark no devolvía ninguna de las dos cosas.
      const totalPages = Math.max(1, Math.ceil((r.count || gdDeals.length) / 24));
      pager.innerHTML = `
        <button class="fin-month-nav-btn js-gd-prev" title="Página anterior" ${gdPage <= 0 ? 'disabled' : ''}>‹</button>
        <span class="yify-pager-info">Página ${(gdPage + 1).toLocaleString('es-UY')} de ${totalPages.toLocaleString('es-UY')}${r.count ? ` · ${r.count.toLocaleString('es-UY')} ofertas` : ''}</span>
        <button class="fin-month-nav-btn js-gd-next" title="Página siguiente" ${gdPage + 1 >= totalPages ? 'disabled' : ''}>›</button>`;
      pager.querySelector('.js-gd-prev').addEventListener('click', () => { if (gdPage > 0) { gdPage--; loadGames(); } });
      pager.querySelector('.js-gd-next').addEventListener('click', () => { gdPage++; loadGames(); });
    }
  } finally {
    gdLoading = false;
    if (btn) btn.classList.remove('spinning');
    adjustWindowSize();
  }
}

// Pinta las ofertas ya bajadas en la vista vigente del tab (tarjetas, iconos
// o lista). No vuelve a pegarle a CheapShark.
function renderGdDeals() {
  const list = $('gd-list');
  if (!list) return;
  list.className = gdViewClass(gdView);
  if (!gdDeals.length) {
    list.innerHTML = `<div class="ai-loading">Sin ofertas con esos filtros</div>`;
    return;
  }
  if (gdView === 'icons') {
    list.innerHTML = gdDeals.map((d, i) => `
      <div class="yify-dash-cell js-gd-open" data-i="${i}"
        title="${escapeHtml(d.title)} — comprar en ${escapeHtml(d.store)}">
        ${d.thumb
          ? `<img class="yify-poster" src="${escapeHtml(d.thumb)}" loading="lazy" alt="">`
          : `<div class="yify-poster yify-noposter">🎮</div>`}
        ${d.savings ? `<span class="gd-savings">-${d.savings}%</span>` : ''}
        <div class="yify-dash-title">${escapeHtml(d.title)}</div>
        <div class="yify-dash-meta">${d.salePrice === 0 ? 'GRATIS' : escapeHtml(fmtUsd2(d.salePrice))}</div>
      </div>`).join('');
  } else if (gdView === 'list') {
    list.innerHTML = `
      <div class="yify-tr yify-tr-head">
        <span>Juego</span>
        <span>Tienda</span>
        <span class="yify-td-num">Antes</span>
        <span class="yify-td-num">Ahora</span>
        <span class="yify-td-num">Descuento</span>
        <span class="yify-td-num" title="Metacritic">MC</span>
      </div>` + gdDeals.map((d, i) => `
      <div class="yify-tr">
        <span class="yify-td-title js-gd-open" data-i="${i}" title="${escapeHtml(d.title)} — comprar en ${escapeHtml(d.store)}">${escapeHtml(d.title)}</span>
        <span class="yify-td-store">${escapeHtml(d.store)}</span>
        <span class="yify-td-old">${d.normalPrice != null && d.salePrice != null && d.normalPrice > d.salePrice ? escapeHtml(fmtUsd2(d.normalPrice)) : ''}</span>
        <span class="yify-td-new">${d.salePrice === 0 ? 'GRATIS' : escapeHtml(fmtUsd2(d.salePrice))}</span>
        <span class="yify-td-num yify-td-seeds">${d.savings ? `-${d.savings}%` : '—'}</span>
        <span class="yify-td-num">${d.metacritic || '—'}</span>
      </div>`).join('');
  } else {
    list.innerHTML = gdDeals.map((d, i) => `
      <div class="gd-card js-gd-open" data-i="${i}" title="${escapeHtml(d.title)} — comprar en ${escapeHtml(d.store)}">
        <div class="gd-thumb-wrap">
          ${d.thumb ? `<img class="gd-thumb" src="${escapeHtml(d.thumb)}" loading="lazy" alt="">` : `<div class="gd-thumb gd-nothumb">🎮</div>`}
          ${d.savings ? `<span class="gd-savings">-${d.savings}%</span>` : ''}
        </div>
        <div class="gd-info">
          <div class="gd-title">${escapeHtml(d.title)}</div>
          <div class="gd-meta">${escapeHtml(d.store)}${d.metacritic ? ` · MC ${d.metacritic}` : ''}${d.steamRating ? ` · 👍 ${d.steamRating}%` : ''}</div>
          <div class="gd-prices">
            ${d.normalPrice != null && d.salePrice != null && d.normalPrice > d.salePrice ? `<span class="gd-old">${fmtUsd2(d.normalPrice)}</span>` : ''}
            <span class="gd-new">${d.salePrice === 0 ? 'GRATIS' : fmtUsd2(d.salePrice)}</span>
          </div>
        </div>
      </div>`).join('');
  }
  list.querySelectorAll('.js-gd-open').forEach((c) => {
    c.addEventListener('click', () => {
      const d = gdDeals[+c.dataset.i];
      if (d && d.url) window.api.openExternal(d.url);
    });
  });
}

// Toggle de vista del TAB Juegos (barra compartida): re-renderiza CheapShark y
// LimeTorrents con lo ya cargado.
function setGdView(view) {
  if (view === gdView) return;
  const oldSize = YIFY_PAGE_SIZES[gdView] || 12;
  gdView = view;
  try { localStorage.setItem('gdView', view); } catch {}
  document.querySelectorAll('#gd-view-toggle .yify-view-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  renderGdDeals();
  limeGames.setView(oldSize);
  adjustWindowSize();
}
document.querySelectorAll('#gd-view-toggle .yify-view-btn').forEach((b) => {
  b.classList.toggle('active', b.dataset.view === gdView);
  b.addEventListener('click', () => setGdView(b.dataset.view));
});

function gdSearchNew() {
  gdPage = 0;
  loadGames();
  // El mismo buscador le pega a los torrents de LimeTorrents; los cambios de
  // filtros de CheapShark (tienda/orden/precio) no la re-disparan porque la
  // sección ignora una query repetida.
  limeGames.search($('gd-search') ? $('gd-search').value : '');
}

function initGames() {
  if (gdStarted) return;
  gdStarted = true;
  loadGames();
}

const gdSearchBtn = $('gd-search-btn');
if (gdSearchBtn) gdSearchBtn.addEventListener('click', gdSearchNew);
const gdSearchInput = $('gd-search');
if (gdSearchInput) {
  gdSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') gdSearchNew(); });
  // Búsqueda en vivo: filtra mientras se escribe; al limpiar vuelve a las ofertas.
  gdSearchInput.addEventListener('input', debounce(gdSearchNew, 400));
}
['gd-store', 'gd-sort', 'gd-maxprice'].forEach((id) => {
  const sel = $(id);
  if (sel) sel.addEventListener('change', gdSearchNew);
});
const gdRefreshBtn = $('gd-refresh');
if (gdRefreshBtn) gdRefreshBtn.addEventListener('click', loadGames);

// ── GitHub (tab) ───────────────────────────────────────────────
// Token personal en API Keys ("GitHub"). Tres bloques: notificaciones, PRs
// abiertos del usuario y repos con push reciente. Todo clickeable al browser.
let ghStarted = false;
let ghLoading = false;

async function loadGithub() {
  const box = $('gh-content');
  if (!box || ghLoading) return;
  ghLoading = true;
  const btn = $('gh-refresh');
  if (btn) btn.classList.add('spinning');
  try {
    const r = await window.api.github.overview();
    if (r && r.error === 'sin key') {
      box.innerHTML = `
        <div class="stocks-hint">Agregá una key llamada <code>GitHub</code> en API Keys (token personal con
        permisos <code>repo</code> + <code>notifications</code>) para ver tus notificaciones, PRs y repos acá.</div>`;
      return;
    }
    if (!r || r.error) {
      box.innerHTML = `<div class="ai-loading">GitHub no responde${r && r.error ? ` (${escapeHtml(r.error)})` : ''}</div>`;
      return;
    }
    const loginEl = $('gh-login');
    if (loginEl) loginEl.textContent = r.login ? `· @${r.login}` : '';
    const whenEl = $('gh-when');
    if (whenEl) whenEl.textContent = r.fetchedAt ? fmtWhen(r.fetchedAt) : '';

    const notifs = Array.isArray(r.notifications) ? r.notifications : [];
    const prs = Array.isArray(r.prs) ? r.prs : [];
    const repos = Array.isArray(r.repos) ? r.repos : [];
    box.innerHTML = `
      <div class="gh-section-title">Notificaciones ${notifs.length ? `<span class="gh-badge">${notifs.length}</span>` : ''}</div>
      ${notifs.length ? notifs.map((n, i) => `
        <div class="gh-row js-gh-open" data-url="${escapeHtml(n.url || '')}" title="${escapeHtml(n.repo)} — abrir">
          <span class="gh-icon">${n.icon}</span>
          <span class="gh-row-main">
            <span class="gh-row-title">${escapeHtml(n.title)}</span>
            <span class="gh-row-sub">${escapeHtml(n.repo)} · ${escapeHtml(n.reason)} · ${rdTimeAgo(n.updatedAt)}</span>
          </span>
        </div>`).join('') : `<div class="gh-empty">Sin notificaciones pendientes 🎉</div>`}

      <div class="gh-section-title">PRs abiertos ${prs.length ? `<span class="gh-badge">${prs.length}</span>` : ''}</div>
      ${prs.length ? prs.map((p) => `
        <div class="gh-row js-gh-open" data-url="${escapeHtml(p.url || '')}" title="Abrir PR">
          <span class="gh-icon">⇄</span>
          <span class="gh-row-main">
            <span class="gh-row-title">${p.draft ? '<span class="gh-draft">draft</span> ' : ''}${escapeHtml(p.title)}</span>
            <span class="gh-row-sub">${escapeHtml(p.repo)}#${p.number} · ${rdTimeAgo(p.updatedAt)}</span>
          </span>
        </div>`).join('') : `<div class="gh-empty">Sin PRs abiertos</div>`}

      <div class="gh-section-title">Repos recientes</div>
      ${repos.map((rp) => `
        <div class="gh-row js-gh-open" data-url="${escapeHtml(rp.url || '')}" title="Abrir repo">
          <span class="gh-icon">${rp.private ? '🔒' : '📦'}</span>
          <span class="gh-row-main">
            <span class="gh-row-title">${escapeHtml(rp.name)}</span>
            <span class="gh-row-sub">${rp.language ? `${escapeHtml(rp.language)} · ` : ''}★ ${rp.stars}${rp.openIssues ? ` · ${rp.openIssues} issues` : ''} · push ${rdTimeAgo(rp.pushedAt)}</span>
          </span>
        </div>`).join('')}`;
    box.querySelectorAll('.js-gh-open').forEach((row) => {
      row.addEventListener('click', () => { if (row.dataset.url) window.api.openExternal(row.dataset.url); });
    });
  } finally {
    ghLoading = false;
    if (btn) btn.classList.remove('spinning');
    adjustWindowSize();
  }
}

function initGithub() {
  if (ghStarted) { return; }
  ghStarted = true;
  loadGithub();
}

const ghRefreshBtn = $('gh-refresh');
if (ghRefreshBtn) ghRefreshBtn.addEventListener('click', loadGithub);

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

// Antigravity /usage gives a relative "Refreshes in 167h 53m", already turned
// into minutes by the fetcher; untouched quotas ("Quota available") have none.
const AGY_GROUPS = [['gemini', 'Gemini'], ['partner', 'Claude/GPT'], ['argon', 'Argon']];
function attachAgyResetDates(agy, fetchedAt) {
  for (const [key] of AGY_GROUPS) {
    for (const q of [agy?.[key]?.h5, agy?.[key]?.weekly]) {
      if (q?.resetInMin) q.resetAt = new Date(fetchedAt.getTime() + q.resetInMin * 60000);
    }
  }
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

function planWeeklyCost(plan, pct) {
  if (!plan || pct == null) return null;
  const eq = pricing.planWeeklyEquivalent[plan];
  if (eq == null) return null;
  return (pct / 100) * eq;
}

// Sheen duration for a usage bar (CSS --bar-speed): 3.4s when empty → 1s when full.
function aiBarSpeed(pct) {
  return (3.4 - 2.4 * Math.min(100, Math.max(0, pct)) / 100).toFixed(2);
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
      <div class="ai-row-track"><div class="ai-row-fill ${cls}" style="width:${Math.min(100, pct)}%;--bar-speed:${aiBarSpeed(pct)}s"></div></div>
      ${meta ? `<div class="ai-row-meta">${meta}</div>` : ''}
      ${countdownId ? `<div class="ai-row-meta">Reinicia en <span class="countdown-value" id="${countdownId}">—</span></div>` : ''}
    </div>`;
}

// Store only quota percentages and timestamps, separately for each provider.
const AI_FORECAST_STORAGE_KEY = 'nexus.ai-weekly-forecast.v1';
let aiWeeklyHistory = {};
let aiForecastReadFailed = false;
let aiForecastFetchedAt = 0;
let aiForecastStorageAvailable = true;
let aiForecastRenderedMinute = -1;

// Weekly quotas with a forecast row; `quota` picks the reading out of aiData.
// Antigravity has one weekly quota per model group.
const AI_FORECAST_QUOTAS = [
  { id: 'claude', name: 'Claude', quota: d => d?.claude?.weekAll },
  { id: 'codex',  name: 'Codex',  quota: d => d?.codex?.weekly },
  ...AGY_GROUPS.map(([key, name]) => ({
    id: `agy-${key}`, name: `Antigravity · ${name}`, quota: d => d?.agy?.[key]?.weekly, agy: true,
  })),
];
try {
  const saved = JSON.parse(localStorage.getItem(AI_FORECAST_STORAGE_KEY) || '{}');
  for (const { id } of AI_FORECAST_QUOTAS) aiWeeklyHistory[id] = AIUsageForecast.normalize(saved?.[id]);
} catch { aiForecastStorageAvailable = false; }

function captureAIWeeklySamples(fetchedAt) {
  for (const q of AI_FORECAST_QUOTAS) {
    const quota = q.quota(aiData);
    if (!aiData?.available || !quota) continue;
    if (q.agy) {
      // "Refreshes in 167h 53m" only has minute precision and is read a few
      // seconds apart each time; snap to the series' reset so the readings
      // stay one series (normalize() splits on a 1-minute difference).
      if (!quota.resetAt) continue;
      const prev = aiWeeklyHistory[q.id]?.at(-1)?.resetAt;
      if (prev && Math.abs(prev - quota.resetAt.getTime()) < 5 * 60000) quota.resetAt = new Date(prev);
    } else {
      // The existing parsers also accept date-only strings; a quota forecast
      // needs a real reset time, not their default midnight.
      const hasTime = /\d{1,2}(?::\d{2})?\s*(am|pm)\b|\d{1,2}:\d{2}/i.test(quota.resets || '');
      if (!hasTime) continue;
    }
    aiWeeklyHistory[q.id] = AIUsageForecast.recordSample(aiWeeklyHistory[q.id], {
      at: fetchedAt.getTime(), pct: quota.pct, resetAt: quota.resetAt?.getTime(),
    });
  }
  try {
    localStorage.setItem(AI_FORECAST_STORAGE_KEY, JSON.stringify(aiWeeklyHistory));
    aiForecastStorageAvailable = true;
  } catch { aiForecastStorageAvailable = false; }
}

function forecastDuration(ms) {
  if (ms <= 0) return 'ahora';
  const minutes = Math.ceil(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function renderAIWeeklyForecast(now = Date.now()) {
  const percent = n => n.toLocaleString('es-UY', { maximumFractionDigits: 1 });
  const published = { at: now };   // lo mismo que se pinta, para Nexus Mobile (pc_status)
  // Antigravity rows only once agy has answered at least once.
  const quotas = AI_FORECAST_QUOTAS.filter(q => !q.agy || aiData?.agy || aiWeeklyHistory[q.id]?.length);
  const rows = quotas.map((q) => {
    const { id, name } = q;
    const quota = q.quota(aiData);
    const fresh = !aiForecastReadFailed && !!aiData?.available && !!quota;
    // An untouched agy quota prints "Quota available" and no reset at all.
    const result = fresh && q.agy && !quota.resetAt && !quota.pct
      ? { status: 'idle', pct: 0 }
      : AIUsageForecast.project(aiWeeklyHistory[id], now, {
        maxAgeMs: Math.max(30 * 60000, AI_INTERVAL_MS * 2),
        available: fresh && aiWeeklyHistory[id]?.at(-1)?.at === aiForecastFetchedAt,
      });
    const labels = {
      idle: 'Sin uso', unavailable: 'Sin datos semanales', resetting: 'Reinicio pendiente',
      stale: 'Lectura desactualizada', exhausted: 'Cupo agotado',
      learning: 'Reuniendo datos', risk: 'No llegás a este ritmo',
      tight: 'Llegás justo', safe: 'Llegás con margen',
    };
    let details;
    if (result.status === 'idle') {
      details = '<p class="ai-forecast-note">Cupo intacto esta semana. La fecha de reinicio aparece cuando se empieza a usar.</p>';
    } else if (result.status === 'unavailable') {
      details = '<p class="ai-forecast-note">Esperando porcentaje y fecha de reinicio.</p>';
    } else if (result.status === 'resetting') {
      details = '<p class="ai-forecast-note">El reinicio ya pasó. Esperando una nueva lectura.</p>';
    } else if (result.status === 'stale') {
      details = `<p class="ai-forecast-note">Última lectura: ${percent(result.pct)}% · hace ${forecastDuration(now - result.at)}. Actualizá AI Usage para renovar la previsión.</p>`;
    } else if (result.status === 'exhausted') {
      details = `<p class="ai-forecast-note">100% utilizado · reinicia en ${forecastDuration(result.remainingMs)}.</p>`;
    } else if (result.status === 'learning') {
      details = `<p class="ai-forecast-note">${percent(result.pct)}% utilizado. Falta historial para estimar el ritmo de esta semana.</p>`;
    } else {
      const date = new Date(result.resetAt).toLocaleString('es-UY', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const projectedWidth = Math.min(100, result.projectedPct);
      // Bar animation speed follows the burn rate: 2s at exactly the available pace,
      // faster when spending above it (clamped 0.5s–4s).
      const pace = result.budgetPerDay > 0 ? result.ratePerDay / result.budgetPerDay : 1;
      const barSpeed = Math.min(4, Math.max(0.5, 2 / (pace || 0.5))).toFixed(2);
      const outcome = result.status === 'risk'
        ? (result.exhaustionAt > now
          ? `Se agotaría en ${forecastDuration(result.exhaustionAt - now)} · ${forecastDuration(result.resetAt - result.exhaustionAt)} antes del reinicio.`
          : 'El cupo ya se habría agotado a este ritmo; actualizá para confirmar.')
        : `Margen estimado al reinicio: ${percent(Math.max(0, 100 - result.projectedPct))}%.`;
      details = `
        <div class="ai-forecast-metrics"><span>Actual <b>${percent(result.pct)}%</b></span><span>Al reinicio <b>≈ ${percent(result.projectedPct)}%</b></span></div>
        <div class="ai-forecast-track" style="--bar-speed:${barSpeed}s" aria-hidden="true"><span class="ai-forecast-projected" style="width:${projectedWidth}%"></span><span class="ai-forecast-used" style="width:${result.pct}%"></span></div>
        <p class="ai-forecast-outcome">${outcome}</p>
        <p class="ai-forecast-note" title="Porcentaje del cupo semanal por día. El disponible se calcula con el saldo y el tiempo restante en la última lectura.">Ritmo ≈ ${percent(result.ratePerDay)}%/día · Disponible ${percent(result.budgetPerDay)}%/día</p>
        ${result.reductionPct ? `<p class="ai-forecast-outcome">Bajá el ritmo un ${result.reductionPct}% para llegar.</p>` : ''}
        <p class="ai-forecast-note" title="${escapeHtml(date)}">Reinicia en ${forecastDuration(result.remainingMs)} · ${escapeHtml(date)}</p>`;
    }
    published[id] = { ...result, label: labels[result.status] };
    return `<div class="ai-forecast-row ${result.status}" data-provider="${id}"><div class="ai-forecast-head"><b>${name}</b><span class="ai-forecast-status">${labels[result.status]}</span></div>${details}</div>`;
  }).join('');
  try { window.api.publishForecast(published); } catch {}
  return `<div class="ai-forecast-title"><div class="ai-provider">Previsión semanal</div><span>Estimación</span></div>
    ${rows}
    ${aiForecastStorageAvailable ? '' : '<p class="ai-forecast-note">Historial temporal: no se pudo guardar en este dispositivo.</p>'}`;
}

function tickAIWeeklyForecast(force = false) {
  const el = $('ai-weekly-forecast');
  const minute = Math.floor(Date.now() / 60000);
  if (!el || (!force && minute === aiForecastRenderedMinute)) return;
  aiForecastRenderedMinute = minute;
  el.innerHTML = renderAIWeeklyForecast();
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
      ${skBlock(3)}
    </div>
    <div class="ai-col">
      <span class="sk sk-provider"></span>
      <div class="sk sk-track" style="height:14px;margin-top:6px;"></div>
      <span class="sk sk-line" style="margin-top:8px;"></span>
      <span class="sk sk-line short"></span>
    </div>`;
}

// Brand marks for the provider headers (simple-icons paths, 24×24 viewBox).
const AI_LOGOS = {
  anthropic: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
  openai: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  elevenlabs: 'M4.6035 0v24h4.9317V0zm9.8613 0v24h4.9317V0z',
  gemini: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81',
};

function aiLogo(brand) {
  return `<svg class="ai-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="${AI_LOGOS[brand]}"/></svg>`;
}

// Default model chip for a provider header: "Opus 5.5 - Xhigh", "gpt-6-sol · medium".
function aiModelTag(model, sep = ' · ') {
  if (!model || !(model.name || model.effort)) return '';
  const label = [model.name || 'default', model.effort].filter(Boolean).join(sep);
  const title = `Modelo por defecto${model.detail ? ' — ' + model.detail : ''}`;
  return `<span class="ai-model" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
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
    const parts = [`<div class="ai-provider">${aiLogo('anthropic')}Claude${CLAUDE_PLAN ? ' · ' + CLAUDE_PLAN : ''}${aiModelTag(c.model, ' - ')}</div>`];
    if (c.session)    parts.push(aiRow('Sesión',         c.session.pct, '',                                                        'cd-session'));
    if (c.weekAll)    parts.push(aiRow('Semana (todos)', c.weekAll.pct, '',                                                        'cd-week'));
    if (c.weekSonnet) parts.push(aiRow('Semana (Sonnet)', c.weekSonnet.pct, ''));
    if (c.weekFable)  parts.push(aiRow('Semana (Fable)',  c.weekFable.pct,  ''));
    if (c.extra)      parts.push(aiRow('Extra',          c.extra.pct,   `<span style="color:var(--text-2);font-weight:600;">$${c.extra.spent}</span> / $${c.extra.total} gastado`, 'cd-extra'));

    if (c.insight) {
      parts.push(`<div class="ai-row-meta" style="margin-top:6px;color:var(--warn-2);">⚡ ${escapeHtml(c.insight)}</div>`);
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
    const parts = [`<div class="ai-provider">${aiLogo('openai')}Codex${plan ? ' · ' + escapeHtml(plan) : ''}${aiModelTag(cx.model)}</div>`];
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

  const agy = aiData.agy;
  if (agy) {
    const plan = agy.account?.plan;
    const parts = [`<div class="ai-provider">${aiLogo('gemini')}Antigravity${plan ? ' · ' + escapeHtml(plan) : ''}${aiModelTag(agy.model, ' - ')}</div>`];
    for (const [key, name] of AGY_GROUPS) {
      const g = agy[key];
      if (g?.h5)     parts.push(aiRow(`${name} · 5h`,      g.h5.pct,     '', g.h5.resetAt     ? `cd-agy-${key}-5h`   : null));
      if (g?.weekly) parts.push(aiRow(`${name} · semanal`, g.weekly.pct, '', g.weekly.resetAt ? `cd-agy-${key}-week` : null));
    }
    providerBlocks.push(`<div class="ai-stack-item">${parts.join('')}</div>`);
  }

  const el11 = aiData.eleven;
  if (el11 && el11.characters && el11.characters.pct != null) {
    const parts = [`<div class="ai-provider">${aiLogo('elevenlabs')}ElevenLabs${el11.tier ? ' · ' + escapeHtml(el11.tier) : ''}</div>`];
    parts.push(aiRow(
      'Caracteres',
      el11.characters.pct,
      `<span style="color:var(--text-2);font-weight:600;">${fmtNum(el11.characters.used)}</span> / ${fmtNum(el11.characters.limit)} usados`,
      el11.resetUnix ? 'cd-eleven' : null,
    ));
    if (el11.voices && el11.voices.limit != null) {
      parts.push(`<div class="ai-row-meta">Voice slots: <b style="color:var(--text-2)">${el11.voices.used ?? 0} / ${el11.voices.limit}</b></div>`);
    }
    providerBlocks.push(`<div class="ai-stack-item">${parts.join('')}</div>`);
  }

  // Right column: the weekly quota forecast.
  const cols = [];
  if (providerBlocks.length) cols.push(`<div class="ai-col">${providerBlocks.join('')}</div>`);
  cols.push(`<div class="ai-col"><section class="ai-forecast" id="ai-weekly-forecast" aria-label="Previsión semanal de uso de IA"></section></div>`);

  if (!cols.length) {
    el.innerHTML = `<div class="ai-loading">Sin datos de uso (¿logueaste claude/codex/agy?)</div>`;
  } else {
    el.innerHTML = cols.join('');
  }

  tickCountdowns();
  tickAIWeeklyForecast(true);
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
  for (const [key] of AGY_GROUPS) {
    updateSection(`agy-${key}`, aiData.agy?.[key], 'h5',     `cd-agy-${key}-5h`,   false);
    updateSection(`agy-${key}`, aiData.agy?.[key], 'weekly', `cd-agy-${key}-week`, false);
  }

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
    const next = await window.api.fetchAIUsage();
    if (!next?.available) throw new Error('AI usage unavailable');
    aiData = next;
    const fetchedAt = new Date();
    aiForecastReadFailed = false;
    aiForecastFetchedAt = fetchedAt.getTime();
    attachResetDates(aiData.claude, parseResetDate,      ['session', 'weekAll', 'extra'], fetchedAt);
    attachResetDates(aiData.codex,  parseCodexResetDate, ['session5h', 'weekly'],         fetchedAt);
    attachAgyResetDates(aiData.agy, fetchedAt);
    captureAIWeeklySamples(fetchedAt);
  } catch {
    aiForecastReadFailed = true;
    aiData = aiData || { available: false };
  } finally {
    btn.classList.remove('spinning');
    aiFetching = false;
  }
  renderAI();
  // Push to main process so the tray icon + tooltip stay in sync.
  if (aiData) {
    if (aiData.claude) window.api.sendUsage(aiData.claude);
    if (aiData.codex)  window.api.sendCodexUsage(aiData.codex);
    if (aiData.agy)    window.api.sendAgyUsage(aiData.agy);
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
const keyUrl     = $('key-url');
const keyAddBtn  = $('key-add-btn');
const keyStatus  = $('key-status');

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '•'.repeat(key.length);
  return key.slice(0, 4) + '•'.repeat(Math.max(8, key.length - 8)) + key.slice(-4);
}

// Link opcional de una entrada (dashboard del servicio, docs…). Devuelve ''
// si está vacío, null si no es una URL http(s) válida; sin esquema asume https.
function normalizeKeyUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.href;
  } catch {
    return null;
  }
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
    if (k._editing) {
      return `
      <div class="key-card editing" data-idx="${idx}">
        <div class="key-card-head">
          <input class="key-input key-edit-input js-edit-name" value="${escapeHtml(k.name)}" placeholder="Nombre" autocomplete="off">
          <div class="key-card-actions">
            <button class="key-icon-btn ok js-save" title="Guardar">✓</button>
            <button class="key-icon-btn js-cancel" title="Cancelar">↩</button>
          </div>
        </div>
        <input class="key-input key-edit-input mono js-edit-key" value="${escapeHtml(k.key)}" placeholder="API key" autocomplete="off" spellcheck="false">
        <input class="key-input key-edit-input js-edit-url" value="${escapeHtml(k.url || '')}" placeholder="Link (opcional)" autocomplete="off" spellcheck="false">
      </div>`;
    }
    const visible = !!k._visible;
    const display = visible ? k.key : maskKey(k.key);
    return `
      <div class="key-card" data-idx="${idx}">
        <div class="key-card-head">
          <span class="key-card-name">${escapeHtml(k.name)}</span>
          <div class="key-card-actions">
            <button class="key-icon-btn js-toggle" title="${visible ? 'Ocultar' : 'Ver'}">${visible ? '🙈' : '👁'}</button>
            <button class="key-icon-btn js-copy" title="Copiar">⧉</button>
            ${k.url ? `<button class="key-icon-btn js-link" title="${escapeHtml(k.url)}">↗</button>` : ''}
            <button class="key-icon-btn js-edit" title="Editar">✎</button>
            <button class="key-icon-btn danger js-delete" title="Borrar">✕</button>
          </div>
        </div>
        <div class="key-value js-value">${escapeHtml(display)}</div>
      </div>`;
  }).join('');
  adjustWindowSize();

  keysList.querySelectorAll('.key-card').forEach((card) => {
    const idx = +card.dataset.idx;
    if (apiKeys[idx]._editing) {
      const nameEl = card.querySelector('.js-edit-name');
      const keyEl = card.querySelector('.js-edit-key');
      const urlEl = card.querySelector('.js-edit-url');
      const cancel = () => {
        apiKeys[idx]._editing = false;
        renderKeys();
      };
      const save = async () => {
        const name = nameEl.value.trim();
        const key = keyEl.value.trim();
        if (!name || !key) {
          setKeyStatus('Nombre y key son obligatorios', 'error');
          return;
        }
        if (apiKeys.some((k, i) => i !== idx && k.name.toLowerCase() === name.toLowerCase())) {
          setKeyStatus('Ya existe una key con ese nombre', 'error');
          return;
        }
        const url = normalizeKeyUrl(urlEl.value);
        if (url === null) {
          setKeyStatus('El link no es una URL válida', 'error');
          return;
        }
        const cur = apiKeys[idx];
        const was = keyServiceOf(cur.name);
        const changed = cur.name !== name || cur.key !== key;
        const urlChanged = (cur.url || '') !== url;
        cur.name = name;
        cur.key = key;
        cur.url = url;
        cur._editing = false;
        if (changed || urlChanged) {
          await persistKeys();
          setKeyStatus('Actualizada', 'success');
        }
        renderKeys();
        if (changed) {
          const now = keyServiceOf(name);
          refreshKeyService(was);
          if (now !== was) refreshKeyService(now);
        }
      };
      card.querySelector('.js-save').addEventListener('click', save);
      card.querySelector('.js-cancel').addEventListener('click', cancel);
      [nameEl, keyEl, urlEl].forEach((el) => el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
        else if (e.key === 'Escape') cancel();
      }));
      return;
    }
    card.querySelector('.js-edit').addEventListener('click', () => {
      apiKeys.forEach((k) => { k._editing = false; });
      apiKeys[idx]._editing = true;
      renderKeys();
      const nameEl = keysList.querySelector(`.key-card[data-idx="${idx}"] .js-edit-name`);
      if (nameEl) { nameEl.focus(); nameEl.select(); }
    });
    const linkBtn = card.querySelector('.js-link');
    if (linkBtn) linkBtn.addEventListener('click', () => window.api.openExternal(apiKeys[idx].url));
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
      const was = keyServiceOf(apiKeys[idx].name);
      apiKeys.splice(idx, 1);
      await persistKeys();
      renderKeys();
      refreshKeyService(was);
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
      url: normalizeKeyUrl(k.url) || '',
      _visible: false,
    }));
    renderKeys();
  } catch {
    apiKeys = [];
    renderKeys();
  }
}

async function persistKeys() {
  const payload = apiKeys.map(({ id, name, key, url }) => (url ? { id, name, key, url } : { id, name, key }));
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
  const url = normalizeKeyUrl(keyUrl.value);
  if (url === null) {
    setKeyStatus('El link no es una URL válida', 'error');
    return;
  }
  apiKeys.push({
    id: `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name, key, url, _visible: false,
  });
  await persistKeys();
  keyName.value = '';
  keyValue.value = '';
  keyUrl.value = '';
  setKeyStatus('Agregada', 'success');
  renderKeys();
  refreshKeyService(keyServiceOf(name));
});

// Refresca la card del widget que depende de la key de ese servicio.
function refreshKeyService(svc) {
  if (svc === 'elevenlabs') refreshAI();
  if (svc === 'finnhub') refreshStocks();
  if (svc === 'github' && ghStarted) loadGithub();
}

// Servicio al que conecta una key por su nombre, con la misma tolerancia que
// main (findApiKey en config.js): "ElevenLabs Api" → elevenlabs, "Finnhub
// key" → finnhub. Decide qué card refrescar al agregar o borrar una key.
function keyServiceOf(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n.includes('eleven') || n.includes('11labs')) return 'elevenlabs';
  if (n.includes('finnhub')) return 'finnhub';
  if (n.includes('github') || n === 'gh') return 'github';
  if (n.includes('tmdb') || n.includes('moviedatabase') || n.includes('movedatabase') || n.includes('moviedb')) return 'tmdb';
  return n;
}

[keyValue, keyUrl].forEach((el) => el.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') keyAddBtn.click();
}));

// ── Finanzas ───────────────────────────────────────────────────
const finAccountsEl = $('fin-accounts');
const finExpensesEl = $('fin-expenses');
const finChartsEl = $('fin-charts');
const finMonthlyEl = $('fin-monthly');
let finHidden = false;        // "hide values" toggle (persisted in the db)
let finHiddenLoaded = false;  // becomes true once we've read the saved state
let finExpSort = 'date';      // movimientos sort: 'date' | 'name' | 'day' | 'kind'
let finExpFlow = 'gasto';     // add-form flow toggle: 'gasto' | 'ingreso'
let finUsdRate = null;        // { compra, venta } from DolarAPI, for UYU↔USD conversion
let finMonthlyFx = {};        // { "YYYY-MM": usd buy rate } locked per closed month
let finTotals = { uyu: 0, usd: 0 };   // last computed savings totals (per currency)
let finSvc = { uyu: 0, usd: 0 };      // last computed gastos+servicios totals (per currency)
let finLastAccounts = [];     // cached for chart re-render when the rate arrives
let finLastExpenses = [];
let finExpSorted = [];        // the 5 most recently entered movements (inline preview)
let finMonthModalEl = null;   // the open "movimientos del mes" modal overlay, if any
let finMonthModalKey = null;  // which month (YYYY-MM) that modal is showing
let finBalancesModalEl = null; // the open "todos los balances" modal overlay, if any
let finMonthlyCache = [];      // last buckets rendered by renderMonthly — single source of truth so
                               // the modals show the exact same totals as the visible "Balance mensual" list
const FIN_EXP_INLINE_LIMIT = 5; // how many movements to show inline before "ver todo"
const FIN_MONTHLY_INLINE = 3;   // how many monthly balances to show inline before "ver todos"

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

  const extra = a.invest ? descriptionBlockHtml(a) : projectionBlockHtml(a);

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
      ${extra}
      <div class="fin-card-status"></div>
    </div>`;
}

// Monthly projection block (regular accounts): a "Total proyectado" readout plus
// inputs to set it. The forecast is independent of the saved balance — it can be
// overwritten or removed and never accumulates.
function projectionBlockHtml(a) {
  const proj = a.projection || {};
  const hasProj = proj.uyu != null || proj.usd != null;
  const total = a.currencies.map((cur) => {
    const v = proj[cur.toLowerCase()];
    if (v == null) return '';
    const amt = finHidden ? `<span class="fin-amt-hidden">${FIN_MASK}</span>` : fmtMoney(v, cur);
    return `<span class="fin-proj-amt">${amt}</span>`;
  }).filter(Boolean).join('');

  const inputs = a.currencies.map((cur) => {
    const v = proj[cur.toLowerCase()];
    const ph = (finHidden || v == null) ? (cur === 'USD' ? 'Dólares' : 'Pesos') : fmtPlain(v);
    return `
      <input class="fin-input js-proj" data-cur="${cur}" type="text" inputmode="decimal"
             placeholder="${ph}" autocomplete="off">`;
  }).join('');

  return `
    <div class="fin-proj">
      <div class="fin-proj-head">
        <span class="fin-proj-label">Total proyectado</span>
        <span class="fin-proj-total">${hasProj ? total : '<span class="fin-amt-empty">—</span>'}</span>
      </div>
      <div class="fin-inputs-row">${inputs}</div>
      <div class="fin-actions-row">
        <button class="fin-btn js-save-proj">Proyectar</button>
        <button class="fin-btn danger js-clear-proj" title="Quitar proyección"${hasProj ? '' : ' disabled'}>Quitar</button>
      </div>
    </div>`;
}

// Description block (Inversiones card): free-text list of investments instead of
// a projection.
function descriptionBlockHtml(a) {
  const desc = a.description || '';
  return `
    <div class="fin-desc">
      <span class="fin-proj-label">Descripción</span>
      <textarea class="fin-input fin-desc-input js-desc" rows="3"
                placeholder="Listá tus inversiones (plazo fijo, acciones, cripto…)"
                autocomplete="off">${escapeHtml(desc)}</textarea>
      <div class="fin-actions-row">
        <button class="fin-btn js-save-desc">Guardar descripción</button>
      </div>
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
function expFlow(e) { return e && e.flow === 'ingreso' ? 'ingreso' : 'gasto'; }
// A movement's effective date: tx_date, falling back to created_at.
function expTxDate(e) { return (e && (e.tx_date || e.created_at)) || Date.now(); }

// "YYYY-MM" bucket key (local time) used to group movements by month.
function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// Month arithmetic via a single integer index (year*12 + month), so we can step
// month-by-month when projecting recurring expenses forward.
function ymToIndex(ym) { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); }
function indexToYm(idx) { return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`; }
function currentMonthIndex() { const d = new Date(); return d.getFullYear() * 12 + d.getMonth(); }

// A gasto with a billing day recurs every month; without one it's an eventual
// expense that only counts in the month of its date. Ingresos are always eventual.
function isRecurringGasto(e) { return expFlow(e) === 'gasto' && e.billing_day != null; }
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('es-UY', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function finDayMonth(ts) {
  return new Date(ts).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit' });
}
// Value a movement in pesos. A USD movement is converted with `rate` when given
// (the month's locked rate), otherwise with the live buy rate, falling back to
// the nominal amount when no rate is known yet.
function expToUyu(e, rate) {
  const amt = e.amount || 0;
  if (String(e.currency).toUpperCase() !== 'USD') return amt;
  const r = rate != null ? rate : (finUsdRate && finUsdRate.compra);
  return r ? amt * r : amt;
}

// The USD buy rate to value a given month with. A closed (past) month uses its
// locked rate (the latest recorded on or before it) so its balance doesn't move
// when the live rate changes; the current/future month uses the live rate.
function usdRateForMonth(ym) {
  const live = (finUsdRate && finUsdRate.compra) || null;
  const curYm = indexToYm(currentMonthIndex());
  if (ym >= curYm) return live;
  if (finMonthlyFx[ym] != null) return finMonthlyFx[ym];
  let bestYm = null;
  for (const k of Object.keys(finMonthlyFx)) {
    if (k <= ym && (bestYm == null || k > bestYm)) bestYm = k;
  }
  return bestYm != null ? finMonthlyFx[bestYm] : live;
}

// <input type="date"> value (YYYY-MM-DD, local) ⇄ epoch ms (anchored at noon to
// avoid a day rolling over across DST/timezone boundaries).
function tsToDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateInputToTs(str) {
  if (!str) return null;
  const [y, m, d] = String(str).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
}

// Reflect the chosen flow ('gasto' | 'ingreso') in a form scope: highlight the
// active toggle button and show only that flow's fields. The .fin-field-gasto /
// .fin-field-ingreso classes live in both the add form and the edit modal.
function applyFlowFields(scope, flow) {
  scope.querySelectorAll('.fin-flow-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.flow === flow));
  scope.querySelectorAll('.fin-field-gasto').forEach((el) => { el.hidden = (flow !== 'gasto'); });
  scope.querySelectorAll('.fin-field-ingreso').forEach((el) => { el.hidden = (flow !== 'ingreso'); });
}

function expenseItemHtml(e) {
  const flow = expFlow(e);
  const isIn = flow === 'ingreso';
  const amt = finHidden ? FIN_MASK : fmtMoney(e.amount, e.currency);
  const sign = (isIn && !finHidden) ? '+ ' : '';
  const tag = isIn
    ? `<span class="fin-exp-kind fin-exp-kind-ingreso">Ingreso</span>`
    : `<span class="fin-exp-kind fin-exp-kind-${expKind(e)}">${EXP_KIND_LABELS[expKind(e)]}</span>`;
  const detailBadge = (isIn && e.detail)
    ? `<span class="fin-exp-detail-badge" title="Detalle">${escapeHtml(e.detail)}</span>` : '';
  // Recurring expense → "día X" (repeats monthly); eventual → its date.
  const recurring = isRecurringGasto(e);
  const dayBadge = recurring
    ? `<span class="fin-exp-day-badge" title="Gasto mensual · día de cobro">mensual · día ${e.billing_day}</span>` : '';
  const dateBadge = !recurring
    ? `<span class="fin-exp-date-badge" title="Fecha">${finDayMonth(expTxDate(e))}</span>` : '';
  return `
    <div class="fin-exp-item fin-exp-${flow}" data-id="${e.id}">
      ${tag}
      <span class="fin-exp-name">${escapeHtml(e.name)}</span>
      ${detailBadge}${dayBadge}${dateBadge}
      <span class="fin-exp-amt">${sign}${amt}</span>
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
      const exp = finLastExpenses.find((e) => String(e.id) === String(id));
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
        <span class="fin-exp-modal-title">Editar movimiento</span>
        <button class="fin-modal-x js-edit-close" title="Cerrar">✕</button>
      </div>
      <div class="fin-flow-toggle js-edit-flow">
        <button type="button" class="fin-flow-btn" data-flow="gasto">Gasto</button>
        <button type="button" class="fin-flow-btn" data-flow="ingreso">Ingreso</button>
      </div>
      <input class="fin-input js-edit-name" placeholder="Nombre" autocomplete="off">
      <div class="fin-exp-add-row">
        <input class="fin-input js-edit-amount" type="text" inputmode="decimal" placeholder="Monto" autocomplete="off">
        <select class="fin-select js-edit-cur" title="Moneda">
          <option value="UYU">$U</option>
          <option value="USD">U$S</option>
        </select>
        <select class="fin-select fin-field-gasto js-edit-kind" title="Tipo">
          <option value="servicio">Servicio</option>
          <option value="gasto">Gasto</option>
          <option value="suscripcion">Suscripción</option>
        </select>
        <input class="fin-input fin-input-day fin-field-gasto js-edit-day" type="text" inputmode="numeric" placeholder="Día" title="Día de cobro → gasto mensual recurrente. Vacío = gasto eventual de ese mes." autocomplete="off">
      </div>
      <input class="fin-input fin-field-ingreso js-edit-detail" list="fin-detail-suggestions" placeholder="Detalle (ej. Salario, PCM, Aguinaldo)" autocomplete="off">
      <div class="fin-exp-add-row">
        <input class="fin-input js-edit-date" type="date" title="Fecha del movimiento" autocomplete="off">
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
  const detailI = overlay.querySelector('.js-edit-detail');
  const dateI = overlay.querySelector('.js-edit-date');
  const statusEl = overlay.querySelector('.js-edit-status');
  const saveBtn = overlay.querySelector('.js-edit-save');

  let flow = expFlow(e);
  nameI.value = e.name || '';
  amtI.value = e.amount != null ? fmtPlain(e.amount) : '';
  curI.value = String(e.currency || 'UYU').toUpperCase() === 'USD' ? 'USD' : 'UYU';
  kindI.value = expKind(e);
  dayI.value = e.billing_day != null ? e.billing_day : '';
  detailI.value = e.detail || '';
  dateI.value = tsToDateInput(expTxDate(e));
  applyFlowFields(overlay, flow);

  overlay.querySelectorAll('.js-edit-flow .fin-flow-btn').forEach((b) => {
    b.addEventListener('click', () => { flow = b.dataset.flow; applyFlowFields(overlay, flow); });
  });

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
        flow,
        detail: flow === 'ingreso' ? detailI.value.trim() : null,
        txDate: dateInputToTs(dateI.value),
      });
      if (r && r.ok) { close(); await renderFinanzas(); }
      else setStatus((r && r.error) || 'Error', 'error');
    } catch { setStatus('Error', 'error'); }
    finally { saveBtn.disabled = false; }
  };
  saveBtn.addEventListener('click', save);
  [nameI, amtI, dayI, detailI].forEach((i) => i.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') save(); }));

  document.body.appendChild(overlay);
  nameI.focus();
}

// ── Balance mensual: resumen ingresos vs gastos por mes ──────────

// The movements that count toward a given month index: every eventual movement
// dated that month, plus every recurring gasto. Recurring gastos are fixed
// monthly expenses, so they repeat every month of the visible timeline —
// backward and forward from when they were added, not just forward.
function movementsForMonthIdx(idx, expenses) {
  const out = [];
  for (const e of (expenses || [])) {
    if (isRecurringGasto(e)) {
      out.push(e);
    } else {
      const startIdx = ymToIndex(monthKey(expTxDate(e)));
      if (startIdx === idx) out.push(e);
    }
  }
  return out;
}

// Bucket movements by month (newest first), valuing everything in pesos.
// Recurring expenses fill the whole visible timeline (earliest movement →
// current month, both directions); eventual movements (ingresos and gastos sin
// día) land only in their own month.
function finMonthlyBuckets(expenses) {
  const list = expenses || [];
  if (!list.length) return [];
  const curIdx = currentMonthIndex();
  const months = new Set();
  let minIdx = curIdx, maxIdx = curIdx, hasRecurring = false;
  for (const e of list) {
    const startIdx = ymToIndex(monthKey(expTxDate(e)));
    if (startIdx < minIdx) minIdx = startIdx;
    if (startIdx > maxIdx) maxIdx = startIdx;
    if (isRecurringGasto(e)) hasRecurring = true;
    else months.add(startIdx); // eventual movements anchor their own month
  }
  // With any recurring gasto, every month in the timeline carries it, so fill
  // the contiguous range; without one, keep only months that have a movement.
  if (hasRecurring) {
    for (let i = minIdx; i <= maxIdx; i++) months.add(i);
  }
  return Array.from(months).sort((a, b) => b - a).map((idx) => {
    const ym = indexToYm(idx);
    const rate = usdRateForMonth(ym); // locked for closed months, live for the current one
    let inUyu = 0, outUyu = 0, count = 0;
    for (const e of movementsForMonthIdx(idx, list)) {
      if (expFlow(e) === 'ingreso') inUyu += expToUyu(e, rate); else outUyu += expToUyu(e, rate);
      count += 1;
    }
    return { ym, inUyu, outUyu, count };
  });
}

// Balance display: an exact zero (within rounding) is neutral/gray and unsigned,
// so a rounding-dust value like -0,00 isn't shown as a red loss.
function netParts(net) {
  if (finHidden) return { cls: 'zero', str: FIN_MASK };
  if (Math.abs(net) < 0.005) return { cls: 'zero', str: fmtMoney(0, 'UYU') };
  return { cls: net > 0 ? 'pos' : 'neg', str: `${net > 0 ? '+' : '−'} ${fmtMoney(Math.abs(net), 'UYU')}` };
}

// One clickable month-balance row, shared by the inline card and the "todos los
// balances" modal. Clicking it opens that month's movements modal.
function monthRowHtml(b) {
  const money = (v) => finHidden ? FIN_MASK : fmtMoney(v, 'UYU');
  const net = netParts(b.inUyu - b.outUyu);
  return `
    <button class="fin-month-row" data-ym="${b.ym}" title="Ver movimientos de ${monthLabel(b.ym)}">
      <span class="fin-month-name">${monthLabel(b.ym)}</span>
      <span class="fin-month-net ${net.cls}" title="Balance">${net.str}</span>
      <span class="fin-month-chevron">›</span>
      <span class="fin-month-figs">
        <span class="fin-month-in" title="Ingresos">+ ${money(b.inUyu)}</span>
        <span class="fin-month-out" title="Gastos">− ${money(b.outUyu)}</span>
      </span>
    </button>`;
}

function renderMonthly() {
  if (!finMonthlyEl) return;
  const buckets = finMonthlyBuckets(finLastExpenses);
  finMonthlyCache = buckets; // so the modals read the same snapshot/rate as the card
  if (!buckets.length) {
    finMonthlyEl.innerHTML = '<div class="fin-exp-empty">Sin movimientos todavía. Agregá gastos o ingresos arriba.</div>';
    return;
  }
  let html = buckets.slice(0, FIN_MONTHLY_INLINE).map(monthRowHtml).join('');
  if (buckets.length > FIN_MONTHLY_INLINE) {
    html += `<button class="fin-exp-viewall js-balances-viewall">Ver todos los balances (${buckets.length})</button>`;
  }
  finMonthlyEl.innerHTML = html;
  finMonthlyEl.querySelectorAll('.fin-month-row').forEach((row) => {
    row.addEventListener('click', () => openMonthModal(row.dataset.ym));
  });
  const viewAll = finMonthlyEl.querySelector('.js-balances-viewall');
  if (viewAll) viewAll.addEventListener('click', openBalancesModal);
}

// Re-render the "todos los balances" modal list in place (called on data changes
// while it's open).
function renderBalancesModalList() {
  if (!finBalancesModalEl) return;
  const buckets = finMonthlyCache;
  const listEl = finBalancesModalEl.querySelector('.js-balances-list');
  const countEl = finBalancesModalEl.querySelector('.js-balances-count');
  if (countEl) countEl.textContent = buckets.length
    ? `${buckets.length} ${buckets.length === 1 ? 'mes' : 'meses'}` : '';
  if (listEl) {
    listEl.innerHTML = buckets.length
      ? buckets.map(monthRowHtml).join('')
      : '<div class="fin-exp-empty">Sin movimientos todavía.</div>';
    listEl.querySelectorAll('.fin-month-row').forEach((row) => {
      row.addEventListener('click', () => openMonthModal(row.dataset.ym));
    });
  }
}

// Modal listing every monthly balance (newest first). Rows open the per-month
// movements modal on top.
function openBalancesModal() {
  if (finBalancesModalEl) { renderBalancesModalList(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box fin-exp-modal-box fin-month-modal-box">
      <div class="fin-exp-modal-head">
        <span class="fin-exp-modal-title">Balance mensual <span class="fin-exp-modal-count js-balances-count"></span></span>
        <button class="fin-modal-x js-balances-close" title="Cerrar">✕</button>
      </div>
      <div class="fin-exp-modal-list fin-monthly js-balances-list"></div>
    </div>`;
  const close = () => {
    overlay.remove(); finBalancesModalEl = null;
    document.removeEventListener('keydown', onKey);
  };
  // Don't close while a per-month modal is stacked on top — let Escape close that first.
  const onKey = (e) => { if (e.key === 'Escape' && !finMonthModalEl) close(); };
  overlay.querySelector('.js-balances-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  finBalancesModalEl = overlay;
  renderBalancesModalList();
}

// Chronological list of months that have movements (oldest → newest), used to
// drive the modal's prev/next navigation cyclically.
function finMonthKeysAsc() {
  return finMonthlyBuckets(finLastExpenses).map((b) => b.ym).sort();
}

// Move the open month modal to the previous (-1) or next (+1) month, wrapping
// around the ends like a carousel.
function stepMonthModal(dir) {
  const keys = finMonthKeysAsc();
  if (!keys.length) return;
  let i = keys.indexOf(finMonthModalKey);
  if (i < 0) i = keys.length - 1;
  finMonthModalKey = keys[(i + dir + keys.length) % keys.length];
  renderMonthModalList();
}

// Shared expense ordering used by both the inline list and the month modal, so
// the Fecha/Nombre/Día/Tipo buttons mean the same thing everywhere.
function sortExpensesBy(arr, mode) {
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'es', { sensitivity: 'base' });
  const KIND_RANK = { gasto: 0, servicio: 1, suscripcion: 2 };
  // Day-of-month: recurring by billing day, eventual by its transaction date.
  const dayOf = (e) => isRecurringGasto(e)
    ? (e.billing_day == null ? 99 : e.billing_day)
    : new Date(expTxDate(e)).getDate();
  return arr.slice().sort((a, b) => {
    if (mode === 'name') return byName(a, b);
    if (mode === 'day') {
      const d = dayOf(a) - dayOf(b);
      return d !== 0 ? d : byName(a, b);
    }
    if (mode === 'kind') {
      // Ingresos form their own group (their `kind` is a leftover from the gasto
      // form), so they don't get interleaved with gasto/servicio/suscripción.
      const rank = (e) => expFlow(e) === 'ingreso' ? 3 : (KIND_RANK[expKind(e)] ?? 9);
      const ra = rank(a), rb = rank(b);
      return ra !== rb ? ra - rb : byName(a, b);
    }
    // 'date' (default): most recent movement first, ties broken by name.
    const ta = expTxDate(a), tb = expTxDate(b);
    return ta !== tb ? tb - ta : byName(a, b);
  });
}

// Modal listing every movement of one month, with running totals + month
// navigation. Reuses the shared expense rows (edit/delete) and stays in sync
// across re-renders. Recurring expenses show in every month; eventual ones only
// in their own.
function renderMonthModalList() {
  if (!finMonthModalEl || finMonthModalKey == null) return;
  const idx = ymToIndex(finMonthModalKey);
  const items = sortExpensesBy(movementsForMonthIdx(idx, finLastExpenses), finExpSort);
  // Reflect the active sort in the modal's toggle buttons.
  finMonthModalEl.querySelectorAll('.fin-month-modal-sort .fin-sort-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.sort === finExpSort);
  });
  const titleEl = finMonthModalEl.querySelector('.js-month-title');
  if (titleEl) titleEl.textContent = monthLabel(finMonthModalKey);
  // Hide the nav arrows when there's only a single month to show.
  const multi = finMonthKeysAsc().length > 1;
  finMonthModalEl.querySelectorAll('.fin-month-nav-btn').forEach((b) => { b.disabled = !multi; });
  const countEl = finMonthModalEl.querySelector('.js-month-count');
  const totalsEl = finMonthModalEl.querySelector('.js-month-totals');
  const listEl = finMonthModalEl.querySelector('.js-month-list');
  if (countEl) countEl.textContent = items.length
    ? `${items.length} ${items.length === 1 ? 'movimiento' : 'movimientos'}` : '';
  // Reuse the exact totals from the "Balance mensual" list (same cached snapshot,
  // same dollar rate) so the modal can't disagree with the row you opened (e.g.
  // list 0,00 vs modal −0,01 from USD conversion rounding). Fall back to summing
  // the items only if the cached bucket is gone.
  const bucket = finMonthlyCache.find((b) => b.ym === finMonthModalKey);
  let inUyu = 0, outUyu = 0;
  if (bucket) {
    inUyu = bucket.inUyu; outUyu = bucket.outUyu;
  } else {
    for (const e of items) { if (expFlow(e) === 'ingreso') inUyu += expToUyu(e); else outUyu += expToUyu(e); }
  }
  const net = netParts(inUyu - outUyu);
  if (totalsEl) {
    const money = (v) => finHidden ? FIN_MASK : fmtMoney(v, 'UYU');
    totalsEl.innerHTML = `
      <span class="fin-month-tot in"><span class="fin-month-tot-lbl">Ingresos</span><span class="fin-month-tot-val">${money(inUyu)}</span></span>
      <span class="fin-month-tot out"><span class="fin-month-tot-lbl">Gastos</span><span class="fin-month-tot-val">${money(outUyu)}</span></span>
      <span class="fin-month-tot net ${net.cls}"><span class="fin-month-tot-lbl">Balance</span><span class="fin-month-tot-val">${net.str}</span></span>`;
  }
  if (listEl) {
    listEl.innerHTML = items.length
      ? items.map(expenseItemHtml).join('')
      : '<div class="fin-exp-empty">Sin movimientos este mes.</div>';
    wireExpenseRowActions(listEl);
  }
}

function openMonthModal(ym) {
  finMonthModalKey = ym;
  if (finMonthModalEl) { renderMonthModalList(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box fin-exp-modal-box fin-month-modal-box">
      <div class="fin-exp-modal-head fin-month-modal-head">
        <div class="fin-month-nav">
          <button class="fin-month-nav-btn js-month-prev" title="Mes anterior">‹</button>
          <span class="fin-month-nav-label js-month-title"></span>
          <button class="fin-month-nav-btn js-month-next" title="Mes siguiente">›</button>
        </div>
        <button class="fin-modal-x js-month-close" title="Cerrar">✕</button>
      </div>
      <div class="fin-month-modal-sub"><span class="fin-exp-modal-count js-month-count"></span></div>
      <div class="fin-month-modal-totals js-month-totals"></div>
      <div class="fin-exp-sort fin-month-modal-sort">
        <button class="fin-sort-btn" data-sort="date">Fecha</button>
        <button class="fin-sort-btn" data-sort="name">Nombre</button>
        <button class="fin-sort-btn" data-sort="day">Día</button>
        <button class="fin-sort-btn" data-sort="kind">Tipo</button>
      </div>
      <div class="fin-exp-modal-list js-month-list"></div>
    </div>`;
  const close = () => {
    overlay.remove(); finMonthModalEl = null; finMonthModalKey = null;
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepMonthModal(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepMonthModal(1); }
    else if (e.key === 'Escape') close();
  };
  overlay.querySelector('.js-month-close').addEventListener('click', close);
  overlay.querySelector('.js-month-prev').addEventListener('click', (e) => { e.stopPropagation(); stepMonthModal(-1); });
  overlay.querySelector('.js-month-next').addEventListener('click', (e) => { e.stopPropagation(); stepMonthModal(1); });
  overlay.querySelectorAll('.fin-month-modal-sort .fin-sort-btn').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (b.dataset.sort === finExpSort) return;
      finExpSort = b.dataset.sort;
      renderMonthModalList();
    });
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  finMonthModalEl = overlay;
  renderMonthModalList();
}

// ── Finanzas charts (drawn with inline SVG / divs, no libraries) ──
function finDateShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit' });
}

// Compact value for the Y axis ("34,3k", "1,2M"), so labels fit the narrow gutter.
function finAxisFmt(v) {
  if (finHidden) return FIN_MASK;
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString('es-UY', { maximumFractionDigits: 1 }) + 'M';
  if (a >= 1e3) return (v / 1e3).toLocaleString('es-UY', { maximumFractionDigits: 1 }) + 'k';
  return v.toLocaleString('es-UY', { maximumFractionDigits: 0 });
}

// "Nice" rounded number for axis ticks (Heckbert's graph-label algorithm).
function finNiceNum(range, round) {
  const exp = Math.floor(Math.log10(range || 1));
  const f = (range || 1) / Math.pow(10, exp);
  let nf;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else       nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

// Round a [min,max] data range to a clean axis with ~`count` evenly-spaced ticks
// on round values (e.g. 0 / 10k / 20k / 30k / 40k). Returns { lo, hi, ticks }
// with ticks ordered high→low.
function finNiceAxis(min, max, count = 5) {
  if (!(max > min)) {                       // flat line or a single value
    const pad = Math.abs(max) > 0 ? Math.abs(max) * 0.1 : 1;
    min = max - pad; max = max + pad;
  }
  const step = finNiceNum(finNiceNum(max - min, false) / (count - 1), true);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = hi; v >= lo - step / 2; v -= step) ticks.push(Math.round(v));
  return { lo, hi, ticks };
}

// Area + line chart from a numeric series, scaled into a 100×40 viewBox, with a
// left Y axis on round values and matching horizontal reference lines so you can
// read how much the savings rose.
function finAreaChart(values) {
  const n = values.length;
  if (n < 2) return '';
  const W = 100, H = 40, padY = 3;
  const dMin = Math.min(...values), dMax = Math.max(...values);
  const { lo, hi, ticks } = finNiceAxis(dMin, dMax);
  const range = (hi - lo) || 1;
  const x = (i) => (i / (n - 1)) * W;
  const y = (v) => H - padY - ((v - lo) / range) * (H - padY * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`);
  const base = y(lo).toFixed(2);
  const line = `M ${pts.join(' L ')}`;
  const area = `M ${x(0).toFixed(2)},${base} L ${pts.join(' L ')} L ${x(n - 1).toFixed(2)},${base} Z`;

  // Rounded reference levels. The grid lines live in the SVG; the labels are HTML
  // positioned at the same heights (the SVG stretches with
  // preserveAspectRatio="none", which would distort <text>, so labels stay outside).
  const grid = ticks.map((v) => {
    const yy = y(v).toFixed(2);
    return `<line class="fin-grid" x1="0" y1="${yy}" x2="${W}" y2="${yy}"/>`;
  }).join('');
  const yLabels = ticks.map((v) => {
    const top = (y(v) / H * 100).toFixed(2);
    return `<span class="fin-yaxis-lbl" style="top:${top}%">${escapeHtml(finAxisFmt(v))}</span>`;
  }).join('');

  return `
    <div class="fin-plot">
      <div class="fin-yaxis">${yLabels}</div>
      <svg class="fin-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${grid}
        <path class="fin-area-fill" d="${area}"/>
        <path class="fin-area-line" d="${line}"/>
      </svg>
    </div>`;
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
  const set = (id, uyu, usd, showRate) => {
    const el = $(id);
    if (!el) return;
    if (!finUsdRate || !finUsdRate.compra || !finUsdRate.venta) { el.textContent = ''; el.title = ''; return; }
    if (finHidden) { el.textContent = `Total ${FIN_MASK}`; el.title = ''; return; }
    const pesos = uyu + usd * finUsdRate.compra;
    const dolares = usd + uyu / finUsdRate.venta;
    const rate = showRate
      ? ` (dólar $${fmtPlain(finUsdRate.compra)}/$${fmtPlain(finUsdRate.venta)})`
      : '';
    el.textContent = `Total ≈ $U ${fmtPlain(pesos)} · U$S ${fmtPlain(dolares)}${rate}`;
    el.title = `USD valuado a compra $${fmtPlain(finUsdRate.compra)} · ` +
               `UYU valuado a venta $${fmtPlain(finUsdRate.venta)}`;
  };
  set('fin-total-conv',     finTotals.uyu, finTotals.usd, true);
  set('fin-sum-conv',       finTotals.uyu, finTotals.usd, true);
  set('fin-exp-total-conv', finSvc.uyu,    finSvc.usd, true);
  set('fin-sum-svc-conv',   finSvc.uyu,    finSvc.usd, true);
}

async function renderFinanzasCharts(accounts, expenses) {
  if (!finChartsEl) return;
  let history = [];
  try { history = await window.api.finances.getHistory(); } catch {}

  const blocks = [];

  // 1) Ahorros en el tiempo (total UYU). Click → modal con el gráfico completo.
  const uyuVals = (history || []).map((p) => p.uyu || 0);
  if (uyuVals.length >= 2) {
    const last = uyuVals[uyuVals.length - 1];
    blocks.push(`
      <div class="fin-chart fin-chart-click js-fin-sav-open" title="Ver gráfico completo con todas las métricas">
        <div class="fin-chart-head">
          <span class="fin-chart-title">Ahorros en el tiempo</span>
          <span class="fin-chart-meta">$U ${finHidden ? FIN_MASK : fmtPlain(last)}</span>
        </div>
        ${finAreaChart(uyuVals)}
        <div class="fin-chart-foot fin-foot-axis">
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
  for (const e of expenses) if (isRecurringGasto(e)) byKind[expKind(e)] += toUyu(e);
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
  const savOpen = finChartsEl.querySelector('.js-fin-sav-open');
  if (savOpen) savOpen.addEventListener('click', openFinSavModal);
  adjustWindowSize();
}

// ── Modal "Ahorros en el tiempo" (gráfico completo) ─────────────
// Multi-serie sobre la línea de tiempo real: total $U, total U$S, consolidado
// en pesos (al dólar compra) y cada cuenta por separado. Leyenda con toggles,
// crosshair con tooltip de valores y fila de estadísticas del total.
const FIN_SAV_PALETTE = ['#60a5fa', '#c4b5fd', '#f472b6', '#34d399', '#fb923c', '#a3e635', '#22d3ee', '#f87171'];
let finSavModalEl = null;
let finSavData = null;     // { allTs, series } mientras el modal está abierto

function closeFinSavModal() {
  if (finSavModalEl) { finSavModalEl.remove(); finSavModalEl = null; }
  finSavData = null;
  document.removeEventListener('keydown', finSavEsc);
}
function finSavEsc(e) { if (e.key === 'Escape') closeFinSavModal(); }

// La selección de series de la leyenda persiste en localStorage (por label),
// así el modal recuerda qué toggles quedaron encendidos al reabrirlo.
function finSavLoadToggles() {
  try { return JSON.parse(localStorage.getItem('finSavToggles')) || {}; } catch { return {}; }
}
function finSavSaveToggles(series) {
  const map = {};
  for (const s of series) map[s.label] = s.on;
  try { localStorage.setItem('finSavToggles', JSON.stringify(map)); } catch {}
}

// Arma las series alineadas a los timestamps del agregado. Las cuentas se
// evalúan con carry-forward (mismo criterio que finances/index.js#getHistory)
// para que todas las líneas sean comparables punto a punto.
function buildFinSavSeries(full) {
  const totalPts = full.total;
  const allTs = totalPts.map((p) => p.ts);
  const series = [];
  series.push({
    label: 'Total $U', color: '#4ade80', unit: 'UYU',
    values: totalPts.map((p) => p.uyu || 0), on: true, bold: true, fill: true,
  });
  const hasUsd = totalPts.some((p) => p.usd);
  if (hasUsd) {
    series.push({
      label: 'Total U$S', color: '#fbbf24', unit: 'USD',
      values: totalPts.map((p) => p.usd || 0), on: false,
    });
    if (finUsdRate && finUsdRate.compra) {
      series.push({
        label: 'Consolidado $U', color: '#93c5fd', unit: 'UYU', dashed: true,
        values: totalPts.map((p) => (p.uyu || 0) + (p.usd || 0) * finUsdRate.compra), on: false,
      });
    }
  }
  let ci = 0;
  for (const a of (full.accounts || [])) {
    const pts = a.points || [];
    const mk = (cur, suffix, unit, on) => {
      if (!pts.some((p) => p[cur])) return;
      let j = 0, lastV = 0;
      const vals = allTs.map((ts) => {
        while (j < pts.length && pts[j].ts <= ts) {
          if (pts[j][cur] != null) lastV = pts[j][cur];
          j++;
        }
        return lastV;
      });
      series.push({ label: a.name + suffix, color: FIN_SAV_PALETTE[ci++ % FIN_SAV_PALETTE.length], unit, values: vals, on });
    };
    mk('uyu', '', 'UYU', true);
    mk('usd', ' (U$S)', 'USD', false);
  }
  // Lo guardado pisa los defaults; series nuevas conservan su estado inicial.
  const saved = finSavLoadToggles();
  for (const s of series) if (typeof saved[s.label] === 'boolean') s.on = saved[s.label];
  return { allTs, series };
}

function renderFinSavChart() {
  if (!finSavModalEl || !finSavData) return;
  const plot = finSavModalEl.querySelector('#fin-sav-plot');
  const legend = finSavModalEl.querySelector('#fin-sav-legend');
  const stats = finSavModalEl.querySelector('#fin-sav-stats');
  if (!plot || !legend || !stats) return;
  const { allTs, series } = finSavData;

  // Leyenda (siempre, así se puede re-activar una serie apagada).
  legend.innerHTML = series.map((s, i) => `
    <button class="fin-sav-chip${s.on ? ' on' : ''}" data-i="${i}" title="${s.on ? 'Ocultar' : 'Mostrar'} ${escapeHtml(s.label)}">
      <span class="fin-sav-dot" style="background:${s.color}"></span>${escapeHtml(s.label)}
    </button>`).join('');
  legend.querySelectorAll('.fin-sav-chip').forEach((b) => {
    b.addEventListener('click', () => {
      series[+b.dataset.i].on = !series[+b.dataset.i].on;
      finSavSaveToggles(series);
      renderFinSavChart();
    });
  });

  const vis = series.filter((s) => s.on);
  if (!vis.length) {
    plot.innerHTML = '<div class="fin-chart-empty">Activá al menos una serie en la leyenda.</div>';
    stats.innerHTML = '';
    return;
  }

  // Escala: X proporcional al tiempo real, Y sobre todas las series visibles.
  const W = 720, H = 260, padY = 10;
  const all = vis.flatMap((s) => s.values);
  const { lo, hi, ticks } = finNiceAxis(Math.min(...all), Math.max(...all), 6);
  const t0 = allTs[0], t1 = allTs[allTs.length - 1];
  const x = (ts) => ((ts - t0) / ((t1 - t0) || 1)) * W;
  const y = (v) => H - padY - ((v - lo) / ((hi - lo) || 1)) * (H - padY * 2);

  const grid = ticks.map((v) =>
    `<line class="fin-grid" x1="0" y1="${y(v).toFixed(1)}" x2="${W}" y2="${y(v).toFixed(1)}"/>`).join('');
  const yLabels = ticks.map((v) =>
    `<span class="fin-yaxis-lbl" style="top:${(y(v) / H * 100).toFixed(2)}%">${escapeHtml(finAxisFmt(v))}</span>`).join('');
  const paths = vis.map((s) => {
    const pts = s.values.map((v, i) => `${x(allTs[i]).toFixed(1)},${y(v).toFixed(1)}`);
    let out = '';
    if (s.fill) {
      const base = y(lo).toFixed(1);
      out += `<path d="M ${x(t0).toFixed(1)},${base} L ${pts.join(' L ')} L ${x(t1).toFixed(1)},${base} Z" fill="${s.color}" opacity="0.08" stroke="none"/>`;
    }
    out += `<path d="M ${pts.join(' L ')}" fill="none" stroke="${s.color}" stroke-width="${s.bold ? 2 : 1.3}"
      ${s.dashed ? 'stroke-dasharray="5 4"' : ''} vector-effect="non-scaling-stroke"/>`;
    return out;
  }).join('');

  // Eje X: ~6 fechas repartidas en el rango real.
  const xn = Math.min(6, allTs.length);
  const xLabels = Array.from({ length: xn }, (_, k) => {
    const f = k / ((xn - 1) || 1);
    return `<span style="left:${(f * 100).toFixed(1)}%">${finDateShort(t0 + f * (t1 - t0))}</span>`;
  }).join('');

  plot.innerHTML = `
    <div class="fin-plot fin-sav-wrap">
      <div class="fin-yaxis fin-sav-yaxis">${yLabels}</div>
      <div class="fin-sav-area" id="fin-sav-area">
        <svg class="fin-chart-svg fin-sav-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid}${paths}</svg>
        <div class="fin-sav-cross" hidden></div>
        <div class="fin-sav-tip" hidden></div>
      </div>
    </div>
    <div class="fin-sav-xaxis">${xLabels}</div>`;

  // Crosshair + tooltip: punto más cercano al cursor en el eje del tiempo.
  const area = plot.querySelector('#fin-sav-area');
  const cross = plot.querySelector('.fin-sav-cross');
  const tip = plot.querySelector('.fin-sav-tip');
  area.addEventListener('mousemove', (ev) => {
    const rect = area.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / (rect.width || 1)));
    const target = t0 + frac * (t1 - t0);
    let bi = 0, bd = Infinity;
    allTs.forEach((ts, i) => {
      const d = Math.abs(ts - target);
      if (d < bd) { bd = d; bi = i; }
    });
    const px = x(allTs[bi]) / W * 100;
    cross.style.left = `${px}%`;
    cross.hidden = false;
    tip.innerHTML = `
      <div class="fin-sav-tip-date">${new Date(allTs[bi]).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' })}</div>` +
      vis.map((s) => `
        <div class="fin-sav-tip-row">
          <span class="fin-sav-dot" style="background:${s.color}"></span>
          <span class="fin-sav-tip-lbl">${escapeHtml(s.label)}</span>
          <b>${finHidden ? FIN_MASK : fmtMoney(s.values[bi], s.unit)}</b>
        </div>`).join('');
    tip.hidden = false;
    if (px < 55) { tip.style.left = `calc(${px}% + 12px)`; tip.style.right = 'auto'; }
    else { tip.style.right = `calc(${100 - px}% + 12px)`; tip.style.left = 'auto'; }
  });
  area.addEventListener('mouseleave', () => { cross.hidden = true; tip.hidden = true; });

  // Estadísticas del total en pesos (la serie principal).
  const tot = series[0].values;
  const v0 = tot[0], vN = tot[tot.length - 1];
  const delta = vN - v0;
  const pct = v0 ? (delta / Math.abs(v0)) * 100 : null;
  const days = Math.max(1, Math.round((t1 - t0) / 86400000));
  const M = (v) => finHidden ? FIN_MASK : fmtMoney(v, 'UYU');
  const deltaTxt = finHidden ? FIN_MASK :
    `${delta >= 0 ? '+' : '−'}$U ${fmtPlain(Math.abs(delta))}${pct != null ? ` (${delta >= 0 ? '+' : '−'}${Math.abs(pct).toLocaleString('es-UY', { maximumFractionDigits: 1 })}%)` : ''}`;
  stats.innerHTML = [
    ['Actual', M(vN), ''],
    [`Δ en ${days} días`, deltaTxt, delta >= 0 ? 'pos' : 'neg'],
    ['Máximo', M(Math.max(...tot)), ''],
    ['Mínimo', M(Math.min(...tot)), ''],
    ['Promedio', M(tot.reduce((a, b) => a + b, 0) / tot.length), ''],
    ['Registros', String(tot.length), ''],
  ].map(([l, v, cls]) => `
    <div class="fin-sav-stat">
      <span class="fin-sav-stat-l">${l}</span>
      <span class="fin-sav-stat-v ${cls}">${v}</span>
    </div>`).join('');
}

async function openFinSavModal() {
  closeFinSavModal();
  const overlay = document.createElement('div');
  overlay.className = 'fin-modal';
  overlay.innerHTML = `
    <div class="fin-modal-box fin-sav-modal-box">
      <div class="fin-exp-modal-head">
        <span class="fin-exp-modal-title">📈 Ahorros en el tiempo</span>
        <button class="fin-modal-x js-sav-x" title="Cerrar">✕</button>
      </div>
      <div id="fin-sav-legend" class="fin-sav-legend"></div>
      <div id="fin-sav-plot" class="fin-sav-plot"><div class="ai-loading">Cargando historial…</div></div>
      <div id="fin-sav-stats" class="fin-sav-stats"></div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFinSavModal(); });
  overlay.querySelector('.js-sav-x').addEventListener('click', closeFinSavModal);
  document.addEventListener('keydown', finSavEsc);
  document.body.appendChild(overlay);
  finSavModalEl = overlay;

  let full = null;
  try { full = await window.api.finances.getHistoryFull(); } catch {}
  if (finSavModalEl !== overlay) return;   // lo cerraron mientras cargaba
  if (!full || !Array.isArray(full.total) || full.total.length < 2) {
    overlay.querySelector('#fin-sav-plot').innerHTML =
      '<div class="fin-chart-empty">Cargá saldos en al menos 2 fechas para ver la evolución.</div>';
    return;
  }
  finSavData = buildFinSavSeries(full);
  renderFinSavChart();
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

  // Locked per-month USD rates (closed months keep their frozen balance). Merge
  // so a rate just recorded this session isn't lost if it hasn't persisted yet.
  finMonthlyFx = Object.assign({}, (state && state.fxMonthly) || {}, finMonthlyFx);

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

  // "Gastos fijos totales" banners: only recurring expenses (con día de cobro),
  // i.e. the fixed monthly burden. Eventual gastos and ingresos are excluded —
  // they belong to the month-by-month balance, not the fixed total.
  const expenses = (state && state.expenses) || [];
  const fijos = expenses.filter(isRecurringGasto);
  let svcUyu = 0, svcUsd = 0;
  for (const e of fijos) {
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
  if (sumSvcCountEl) sumSvcCountEl.textContent = fijos.length
    ? `· ${fijos.length} ${fijos.length === 1 ? 'ítem' : 'ítems'}` : '';
  // Finanzas tab "Gastos totales" banner.
  const expTotUyuEl = $('fin-exp-total-uyu');
  const expTotUsdEl = $('fin-exp-total-usd');
  if (expTotUyuEl) expTotUyuEl.textContent = finHidden ? FIN_MASK : fmtPlain(svcUyu);
  if (expTotUsdEl) expTotUsdEl.textContent = finHidden ? FIN_MASK : fmtPlain(svcUsd);

  if (finExpensesEl) {
    // Inline preview: only the 5 most recently entered movements (newest first).
    // The full month-by-month view lives in the "Balance mensual" modal.
    finExpSorted = expenses.slice()
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || (b.id || 0) - (a.id || 0))
      .slice(0, FIN_EXP_INLINE_LIMIT);

    if (!finExpSorted.length) {
      finExpensesEl.innerHTML = '<div class="fin-exp-empty">Sin movimientos. Agregá un gasto o ingreso arriba.</div>';
    } else {
      finExpensesEl.innerHTML = finExpSorted.map(expenseItemHtml).join('');
      wireExpenseRowActions(finExpensesEl);
    }
  }

  // Monthly income-vs-expense summary + its open modal, if any.
  renderMonthly();
  if (finMonthModalEl) renderMonthModalList();
  if (finBalancesModalEl) renderBalancesModalList();

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

    // Proyección: guardar el monto proyectado del mes (no se suma al ahorro).
    const saveProjBtn = card.querySelector('.js-save-proj');
    if (saveProjBtn) {
      saveProjBtn.addEventListener('click', async () => {
        const payload = { accountId: id, uyu: null, usd: null };
        card.querySelectorAll('.js-proj').forEach((inp) => {
          const v = inp.value.trim();
          if (v !== '') payload[inp.dataset.cur.toLowerCase()] = v.replace(/\./g, '').replace(',', '.');
        });
        if (payload.uyu == null && payload.usd == null) {
          setCardStatus(card, 'Ingresá al menos un monto', 'error');
          return;
        }
        saveProjBtn.disabled = true;
        setCardStatus(card, 'Guardando…');
        try {
          const r = await window.api.finances.saveProjection(payload);
          if (r && r.ok) { await renderFinanzas(); }
          else setCardStatus(card, (r && r.error) || 'Error', 'error');
        } catch { setCardStatus(card, 'Error', 'error'); }
        finally { saveProjBtn.disabled = false; }
      });
    }

    const clearProjBtn = card.querySelector('.js-clear-proj');
    if (clearProjBtn) {
      clearProjBtn.addEventListener('click', async () => {
        clearProjBtn.disabled = true;
        setCardStatus(card, 'Quitando…');
        try {
          const r = await window.api.finances.clearProjection(id);
          if (r && r.ok) { await renderFinanzas(); }
          else setCardStatus(card, (r && r.error) || 'Error', 'error');
        } catch { setCardStatus(card, 'Error', 'error'); }
        finally { clearProjBtn.disabled = false; }
      });
    }

    // Inversiones: guardar la descripción de la lista de inversiones.
    const saveDescBtn = card.querySelector('.js-save-desc');
    if (saveDescBtn) {
      saveDescBtn.addEventListener('click', async () => {
        const text = card.querySelector('.js-desc')?.value || '';
        saveDescBtn.disabled = true;
        setCardStatus(card, 'Guardando…');
        try {
          const r = await window.api.finances.saveDescription({ accountId: id, text });
          if (r && r.ok) { await renderFinanzas(); }
          else setCardStatus(card, (r && r.error) || 'Error', 'error');
        } catch { setCardStatus(card, 'Error', 'error'); }
        finally { saveDescBtn.disabled = false; }
      });
    }
  });

  await renderFinanzasCharts(accounts, expenses);
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

// Movimientos add form: a gasto or an ingreso, dated (lives in the Finanzas tab,
// wired once).
(function wireExpenseAdd() {
  const btn = $('fin-exp-add-btn');
  if (!btn) return;
  const formEl = btn.closest('.fin-exp-add');
  const nameI = $('fin-exp-name'), amtI = $('fin-exp-amount'),
        curI = $('fin-exp-cur'), kindI = $('fin-exp-kind'), dayI = $('fin-exp-day'),
        detailI = $('fin-exp-detail'), dateI = $('fin-exp-date'),
        statusEl = $('fin-exp-status');

  // Default the date to today, and start on the "Gasto" flow.
  if (dateI && !dateI.value) dateI.value = tsToDateInput(Date.now());
  if (formEl) applyFlowFields(formEl, finExpFlow);

  // Keep the name placeholder + (re-)reveal the right fields when toggling flow.
  const setFlow = (flow) => {
    finExpFlow = flow;
    if (formEl) applyFlowFields(formEl, flow);
    if (nameI) nameI.placeholder = flow === 'ingreso'
      ? 'Concepto (ej. Sueldo abril, Aguinaldo)'
      : 'Nombre (ej. Netflix, UTE, Alquiler)';
  };
  document.querySelectorAll('#fin-exp-flow .fin-flow-btn').forEach((b) => {
    b.addEventListener('click', () => setFlow(b.dataset.flow));
  });

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
        flow: finExpFlow,
        detail: finExpFlow === 'ingreso' ? detailI.value.trim() : null,
        txDate: dateInputToTs(dateI.value),
      });
      if (r && r.ok) {
        nameI.value = ''; amtI.value = ''; dayI.value = ''; detailI.value = '';
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
  [nameI, amtI, dayI, detailI].forEach((i) => {
    if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
})();

// ── Settings ───────────────────────────────────────────────────
const autoLaunchCheckbox = $('setting-autolaunch');
const alwaysOnTopCheckbox = $('setting-alwaysontop');
if (alwaysOnTopCheckbox) alwaysOnTopCheckbox.addEventListener('change', async () => {
  const desired = alwaysOnTopCheckbox.checked;
  try {
    const actual = await window.api.setAlwaysOnTop(desired);
    alwaysOnTopCheckbox.checked = !!actual;
  } catch {
    alwaysOnTopCheckbox.checked = !desired;
  }
});
const settingStatus = $('setting-status');

// Toggles de animaciones (barras de AI Usage, fondo de Clima): preferencia
// visual, vive en localStorage y se aplica como clase del body. Sin elegir,
// sigue "reducir movimiento" del sistema.
function bindAnimToggle(checkboxId, storageKey, bodyClass) {
  const checkbox = $(checkboxId);
  let on = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved != null) on = saved === '1';
  } catch {}
  document.body.classList.toggle(bodyClass, on);
  if (!checkbox) return;
  checkbox.checked = on;
  checkbox.addEventListener('change', () => {
    document.body.classList.toggle(bodyClass, checkbox.checked);
    try { localStorage.setItem(storageKey, checkbox.checked ? '1' : '0'); } catch {}
  });
}
bindAnimToggle('setting-baranim', 'barAnim', 'bar-anim');
bindAnimToggle('setting-wxanim', 'wxAnim', 'wx-anim');

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
  // "Siempre adelante" también se puede cambiar desde la bandeja: se relee
  // cada vez que se abre Settings.
  if (alwaysOnTopCheckbox) {
    try { alwaysOnTopCheckbox.checked = !!(await window.api.getAlwaysOnTop()); }
    catch { alwaysOnTopCheckbox.checked = false; }
  }
  loadMongoStatus();
  loadApiStatuses();
  loadArchiveStatus();
}

// ── Settings: verificador de las APIs del sistema ───────────────
// Lista todos los servicios externos (clima, cripto, divisas, pelis, series…)
// con su semáforo en línea / caída y la latencia. Se re-verifica al abrir
// Settings (si pasó >1 min), con el botón global, o por fila.
const apisListEl = $('apis-list');
const apisSummaryEl = $('apis-summary');
const apisCheckBtn = $('btn-check-apis');
let apisLastRun = 0;

function apiRowHtml(d) {
  return `
    <div class="api-row" data-id="${d.id}" title="${escapeHtml(d.host)} — click para re-verificar">
      <span class="api-name">
        <span class="api-name-line">${escapeHtml(d.name)} <span class="mkt-src">· ${escapeHtml(d.provider)}</span></span>
        ${d.url ? `<a class="api-link" data-url="${escapeHtml(d.url)}" title="Abrir en el navegador">${escapeHtml(d.url.replace(/^https?:\/\//, ''))}</a>` : ''}
        ${Array.isArray(d.endpoints) && d.endpoints.length
          ? `<span class="api-endpoints" title="${escapeHtml(d.endpoints.join('\n'))}">${escapeHtml(d.endpoints.join(' · '))}</span>` : ''}
      </span>
      <span class="api-ms" data-ms></span>
      <span class="db-status checking" data-st>
        <span class="db-dot"></span>
        <span data-st-text>Verificando…</span>
      </span>
    </div>`;
}

function paintApiChecking(id) {
  const row = apisListEl.querySelector(`.api-row[data-id="${id}"]`);
  if (!row) return;
  row.querySelector('[data-st]').className = 'db-status checking';
  row.querySelector('[data-st-text]').textContent = 'Verificando…';
  row.querySelector('[data-ms]').textContent = '';
}

function paintApiResult(r) {
  const row = apisListEl.querySelector(`.api-row[data-id="${r.id}"]`);
  if (!row) return;
  const st = row.querySelector('[data-st]');
  const txt = row.querySelector('[data-st-text]');
  const ms = row.querySelector('[data-ms]');
  if (r.ok) {
    st.className = 'db-status connected';
    txt.textContent = r.note || 'En línea';   // status pages: "incidente menor"
    ms.textContent = r.ms != null ? `${r.ms} ms` : '';
    row.title = `${r.host} — click para re-verificar`;
  } else {
    st.className = 'db-status disconnected';
    txt.textContent = r.error === 'no configurado' ? 'No configurado' : 'Caída';
    ms.textContent = '';
    row.title = `${r.host}${r.error ? ` — ${r.error}` : ''} — click para re-verificar`;
  }
}

async function loadApiStatuses(force = false) {
  if (!apisListEl) return;
  if (!force && apisLastRun && Date.now() - apisLastRun < 60 * 1000) return;   // fresco
  apisLastRun = Date.now();
  if (apisCheckBtn) apisCheckBtn.disabled = true;
  if (apisSummaryEl) apisSummaryEl.textContent = '';
  try {
    if (!apisListEl.children.length) {
      // Primera vez: armar las filas desde el registro y cablear el re-check por
      // fila. Dos grupos: las APIs que consume el widget y las status pages de
      // servicios de terceros (statuspage.io).
      const defs = await window.api.apiStatus.defs();
      const apis = (defs || []).filter((d) => d.group !== 'status');
      const statuses = (defs || []).filter((d) => d.group === 'status');
      apisListEl.innerHTML = apis.map(apiRowHtml).join('') +
        (statuses.length ? `<div class="apis-group-title">Status de servicios</div>` + statuses.map(apiRowHtml).join('') : '');
      apisListEl.querySelectorAll('.api-row').forEach((row) => {
        row.addEventListener('click', async () => {
          paintApiChecking(row.dataset.id);
          try {
            const rs = await window.api.apiStatus.check([row.dataset.id]);
            (rs || []).forEach(paintApiResult);
          } catch {}
        });
        // El link abre la API en el navegador sin disparar el re-check de la fila.
        const link = row.querySelector('.api-link');
        if (link) link.addEventListener('click', (e) => {
          e.stopPropagation();
          window.api.openExternal(link.dataset.url);
        });
      });
      adjustWindowSize();
    } else {
      apisListEl.querySelectorAll('.api-row').forEach((row) => paintApiChecking(row.dataset.id));
    }
    const results = await window.api.apiStatus.check();
    (results || []).forEach(paintApiResult);
    if (apisSummaryEl && Array.isArray(results) && results.length) {
      const up = results.filter((r) => r.ok).length;
      apisSummaryEl.textContent = `${up}/${results.length} en línea`;
    }
  } catch {
    if (apisSummaryEl) apisSummaryEl.textContent = 'No se pudo verificar';
  } finally {
    if (apisCheckBtn) apisCheckBtn.disabled = false;
  }
}

if (apisCheckBtn) apisCheckBtn.addEventListener('click', () => loadApiStatuses(true));

// ── Bases de datos: indicador de conexión Mongo + sync automático ──
// La sincronización corre sola en main (arranque + cada 15 min, siempre
// aditiva); acá solo se muestra el estado y la hora del último sync.
const mongoStatusEl = $('mongo-status');
const mongoStatusText = $('mongo-status-text');
const syncStatus = $('sync-status');

function setMongoStatus(kind, text) {
  if (!mongoStatusEl) return;
  mongoStatusEl.className = 'db-status' + (kind ? ` ${kind}` : '');
  mongoStatusText.textContent = text;
}

// Progreso de los archivos históricos: cuántas filas hay guardadas de cada
// fuente y en qué anda el crawler que las llena. Se refresca al abrir Settings.
const archiveStatusEl = $('archive-status');
const NUM = (n) => Number(n || 0).toLocaleString('es-UY');

async function loadArchiveStatus() {
  if (!archiveStatusEl) return;
  let st = null;
  try { st = await window.api.archive.status(); } catch {}
  if (!st || st.error) { archiveStatusEl.textContent = ''; return; }
  // El avance (páginas × 50) solo tiene sentido mientras el crawler recorre el
  // catálogo: ya al día, la última página siempre se pasa un poco del total.
  const part = (label, s, extra = '') =>
    `${label} ${NUM(s.rows)}${extra} (${s.phase}${s.total && s.phase === 'catálogo' ? ` ${NUM(s.page * 50)}/${NUM(s.total)}` : ''})`;
  archiveStatusEl.textContent = 'Archivo: '
    + [part('🎬 YIFY', st.yify),
      part('📺 EZTV', st.eztv, ` en ${NUM(st.eztv.shows)} series`),
      part('🎮 Ofertas', st.games)].join(' · ');
  archiveStatusEl.className = 'setting-status';
}

// Espacio del cluster. Un Atlas lleno deja de aceptar escrituras sin que se
// note (los archivos siguen guardando en SQLite y el widget funciona igual):
// este renglón es el que lo dice. El porcentaje solo aparece si el tope del
// plan está declarado en config.json (`mongoStorageLimitMb`); el driver no lo
// puede averiguar solo.
const mongoSpaceEl = $('mongo-space');
// MB hasta el giga, GB de ahí para arriba: un cluster pago se mide en GB y
// "4300,0 MB" no se lee.
const SIZE = (b) => {
  const n = Number(b || 0);
  return n >= 1024 * 1048576
    ? `${(n / (1024 * 1048576)).toFixed(2).replace('.', ',')} GB`
    : `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
};

function renderMongoSpace(st) {
  if (!mongoSpaceEl) return;
  const quota = (st && st.quota) || null;
  const usage = (st && st.usage) || null;
  if (quota && quota.blocked) {
    const when = new Date(quota.at).toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
    mongoSpaceEl.textContent = `⚠️ MongoDB sin espacio: Atlas rechazó escrituras (${when})`
      + `${usage ? ` — ${SIZE(usage.dataSize ?? usage.bytes)} ocupados` : ''}. Todo se sigue guardando en SQLite;`
      + ' liberá espacio en el cluster y se reintenta al reiniciar.';
    mongoSpaceEl.className = 'setting-status error';
    return;
  }
  if (!usage) { mongoSpaceEl.textContent = ''; mongoSpaceEl.className = 'setting-status'; return; }
  // Se muestra `dataSize` porque es la misma medida que Atlas pone en la ficha
  // del cluster ("Data Size"); ojo que la de Atlas suma TODAS las bases del
  // cluster y esta es solo la del widget, así que el número de acá es menor.
  const used = usage.dataSize ?? usage.bytes;
  const limit = (quota && quota.limit) || 0;
  const near = limit > 0 && used > limit * 0.8;
  const docs = `${Number(usage.objects || 0).toLocaleString('es-UY')} documentos`;
  mongoSpaceEl.textContent = limit > 0
    ? `${near ? '⚠️ ' : ''}Base del widget en MongoDB: ${SIZE(used)} de ${SIZE(limit)} (${Math.round((used / limit) * 100)}%) · ${docs}`
    : `Base del widget en MongoDB: ${SIZE(used)} · ${docs}`;
  mongoSpaceEl.className = `setting-status${near ? ' warn' : ''}`;
}

async function loadMongoStatus() {
  setMongoStatus('checking', 'Verificando…');
  try {
    const st = await window.api.finances.mongoStatus();
    if (!st || !st.enabled) setMongoStatus('disconnected', 'No configurado');
    else if (st.connected) setMongoStatus('connected', 'Conectado a MongoDB');
    else setMongoStatus('disconnected', 'Sin conexión (modo local)');
    renderMongoSpace(st);
  } catch {
    setMongoStatus('disconnected', 'Sin conexión (modo local)');
  }
}

// Aviso de main al terminar cada sync automático: refresca Finanzas con lo
// recién bajado y deja la hora visible en Settings.
window.api.onDbSynced((info) => {
  const when = new Date((info && info.at) || Date.now())
    .toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
  if (info && info.ok) {
    setMongoStatus('connected', 'Conectado a MongoDB');
    // Cada sync es una tanda grande de escrituras: es el momento en el que un
    // cluster lleno se delata, así que se refresca el renglón de espacio.
    loadMongoStatus();
    loadArchiveStatus();
    if (syncStatus) {
      syncStatus.textContent = `Última sincronización: ${when}`;
      syncStatus.className = 'setting-status success';
    }
    renderFinanzas();
  } else {
    setMongoStatus('disconnected', 'Sin conexión (modo local)');
    if (syncStatus) {
      syncStatus.textContent = `Sin conexión con Mongo (último intento ${when}) — reintenta solo cada 15 min`;
      syncStatus.className = 'setting-status';
    }
  }
});

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
  setInterval(() => { updateClock(); tickCountdowns(); updateAINextCountdown(); tickAIWeeklyForecast(); }, 1000);

  await refreshSystem();
  setInterval(refreshSystem, SYS_INTERVAL_MS);

  refreshWeather();
  setInterval(refreshWeather, WEATHER_INTERVAL_MS);

  refreshMarkets();
  setInterval(refreshMarkets, MARKETS_INTERVAL_MS);

  refreshStocks();                                // acciones/ETFs (Finnhub)
  setInterval(refreshStocks, MARKETS_INTERVAL_MS);

  refreshHolidays();                              // feriados: 2 veces al día alcanza
  setInterval(refreshHolidays, 12 * 60 * 60 * 1000);

  refreshAI();
  setInterval(refreshAI, AI_INTERVAL_MS);

  loadSpeedtest();

  initYify();   // health check de la API de YIFY + primeras películas
  initLime();   // ídem para el RSS de LimeTorrents (segunda fuente de Films)
  limeTv.init();     // RSS de series de LimeTorrents (tab Series)
  limeGames.init();  // RSS de juegos de LimeTorrents (tab Juegos)
  initEztv();   // ídem para la API de EZTV (tab Torrents Series)

  refreshEztvDash();                              // mitad derecha del card "Últimos estrenos"
  setInterval(refreshEztvDash, YIFY_INTERVAL_MS);

  refreshTvmaze();                                // próximos episodios (favoritos)
  setInterval(refreshTvmaze, 6 * 60 * 60 * 1000);

  renderFinanzas();

  // Tray "Refresh now" → re-fetch everything except speedtest (manual).
  window.api.onRefresh(() => {
    refreshSystem();
    refreshWeather();
    refreshMarkets();
    refreshStocks();
    refreshHolidays();
    refreshAI();
    refreshTvmaze();
    refreshEztvDash();
    yifyOk ? refreshYifyLatest() : initYify();   // si estaba caída, re-chequea
    limeOk ? refreshLime() : initLime();         // ídem LimeTorrents RSS
    limeTv.ok ? limeTv.refresh() : limeTv.init();          // ídem RSS series
    limeGames.ok ? limeGames.refresh() : limeGames.init(); // ídem RSS juegos
    if (!ezOk) initEztv();                       // ídem EZTV
  });

  adjustWindowSize();
  window.addEventListener('load', adjustWindowSize);
})();
