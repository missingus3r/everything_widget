// ── State ──────────────────────────────────────────────────────
let cfg = null;
let aiData = null;
let weatherData = null;
let lastSystem = null;
let aiFetching = false;
let speedtestRunning = false;
let lastAIRefreshAt = 0;

const SYS_INTERVAL_MS = 2000;
const WEATHER_INTERVAL_MS = 15 * 60 * 1000;
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
tabButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.tab;
    tabButtons.forEach((b) => b.classList.toggle('active', b === btn));
    Object.entries(tabPanels).forEach(([name, el]) => {
      el.classList.toggle('hidden', name !== target);
    });
    if (target === 'finanzas') enterFinanzas();
    if (target === 'keys') loadKeys();
    if (target === 'settings') loadSettings();
    adjustWindowSize();
  });
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
  setBar($('cpu-fill'), $('cpu-val'), s.cpu, `${s.cpu}%`);

  // RAM
  const ramPct = s.mem.pct;
  setBar($('ram-fill'), $('ram-val'), ramPct, `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}`);

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
    <div class="ai-provider">Local Tokens</div>
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

function renderAI() {
  const el = $('ai-content');
  if (!aiData) {
    el.innerHTML = `<div class="ai-loading">Cargando uso de IA…</div>`;
    return;
  }
  if (!aiData.available) {
    el.innerHTML = `<div class="ai-loading">Datos de IA no disponibles</div>`;
    return;
  }

  const blocks = [];
  const c = aiData.claude;
  if (c) {
    const parts = [`<div class="ai-provider">Claude · ${CLAUDE_PLAN}</div>`];
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
    blocks.push(parts.join(''));
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
    blocks.push(parts.join(''));
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
    blocks.push(parts.join(''));
  }

  if (aiData.local) {
    blocks.push(renderLocalTokens(aiData.local));
  }

  if (!blocks.length) {
    el.innerHTML = `<div class="ai-loading">Sin datos de uso (¿logueaste claude/codex?)</div>`;
  } else {
    el.innerHTML = blocks.join('');
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
const finLock      = $('fin-lock');
const finContent   = $('fin-content');
const finMaster    = $('fin-master');
const finUnlockBtn = $('fin-unlock-btn');
const finLockStat  = $('fin-lock-status');
const finAccountsEl = $('fin-accounts');
let finUnlocked = false;

function setFinLockStatus(msg, kind) {
  finLockStat.textContent = msg || '';
  finLockStat.className = 'key-status' + (kind ? ` ${kind}` : '');
}

function fmtMoney(n, cur) {
  const sym = cur === 'USD' ? 'U$S' : '$';
  const v = Number(n).toLocaleString('es-UY', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return `${sym} ${v}`;
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

async function enterFinanzas() {
  try {
    const st = await window.api.finances.status();
    finUnlocked = !!st.unlocked;
  } catch { finUnlocked = false; }

  if (finUnlocked) {
    finLock.classList.add('hidden');
    finContent.classList.remove('hidden');
    await renderFinanzas();
  } else {
    finContent.classList.add('hidden');
    finLock.classList.remove('hidden');
    finMaster.value = '';
    setFinLockStatus('');
    setTimeout(() => finMaster.focus(), 50);
  }
  adjustWindowSize();
}

async function unlockFinanzas() {
  const pass = finMaster.value;
  if (!pass) { setFinLockStatus('Ingresá la master password', 'error'); return; }
  finUnlockBtn.disabled = true;
  setFinLockStatus('Desbloqueando…');
  try {
    const r = await window.api.finances.unlock(pass);
    if (r && r.ok) {
      finUnlocked = true;
      finMaster.value = '';
      finLock.classList.add('hidden');
      finContent.classList.remove('hidden');
      await renderFinanzas();
    } else {
      setFinLockStatus((r && r.error) || 'No se pudo desbloquear', 'error');
    }
  } catch {
    setFinLockStatus('Error al desbloquear', 'error');
  } finally {
    finUnlockBtn.disabled = false;
    adjustWindowSize();
  }
}

function accountCardHtml(a) {
  const rows = a.currencies.map((cur) => {
    const key = cur.toLowerCase();
    const cell = a[key];
    const amount = cell ? fmtMoney(cell.value, cur) : `<span class="fin-amt-empty">—</span>`;
    const delta = cell ? fmtDelta(cell.delta, cur) : '';
    return `
      <div class="fin-row">
        <span class="fin-cur">${cur === 'USD' ? 'U$S' : '$U'}</span>
        <span class="fin-amt">${amount}</span>
        ${delta}
      </div>`;
  }).join('');

  let controls = '';
  if (a.kind === 'manual') {
    const inputs = a.currencies.map((cur) => `
      <input class="fin-input js-manual" data-cur="${cur}" type="text" inputmode="decimal"
             placeholder="${cur === 'USD' ? 'Dólares' : 'Pesos'}" autocomplete="off">`).join('');
    controls = `
      <div class="fin-manual-row">
        ${inputs}
        <button class="fin-btn js-save-manual">Guardar</button>
      </div>`;
  } else {
    const credsBadge = a.hasCreds
      ? '<span class="fin-badge ok">credenciales ✓</span>'
      : '<span class="fin-badge warn">sin credenciales</span>';
    controls = `
      <div class="fin-bank-row">
        ${credsBadge}
        <button class="fin-btn js-creds-toggle">${a.hasCreds ? 'Editar' : 'Configurar'} login</button>
        <button class="fin-btn primary js-refresh">↻ Actualizar</button>
      </div>
      <div class="fin-creds hidden">
        <input class="fin-input js-cred-user" type="text" placeholder="Usuario / documento" autocomplete="off">
        <input class="fin-input js-cred-pass" type="password" placeholder="Contraseña" autocomplete="off">
        <button class="fin-btn js-save-creds">Guardar credenciales</button>
      </div>`;
  }

  return `
    <div class="fin-card" data-id="${a.id}" data-kind="${a.kind}">
      <div class="fin-card-head">
        <span class="fin-card-name">${escapeHtml(a.name)}</span>
        <span class="fin-card-time">${finTimeAgo(a.ts)}</span>
      </div>
      <div class="fin-rows">${rows}</div>
      ${controls}
      <div class="fin-card-status"></div>
    </div>`;
}

function setCardStatus(card, msg, kind) {
  const el = card.querySelector('.fin-card-status');
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'fin-card-status' + (kind ? ` ${kind}` : '');
}

async function renderFinanzas() {
  let state;
  try {
    state = await window.api.finances.getState();
  } catch {
    finAccountsEl.innerHTML = '<div class="keys-empty">Error cargando finanzas.</div>';
    return;
  }
  if (!state || !state.unlocked) { finUnlocked = false; return enterFinanzas(); }

  const accounts = state.accounts || [];

  // Totals per currency across all accounts.
  let totUyu = 0, totUsd = 0;
  for (const a of accounts) {
    if (a.uyu) totUyu += a.uyu.value;
    if (a.usd) totUsd += a.usd.value;
  }
  $('fin-total').innerHTML =
    `${fmtMoney(totUyu, 'UYU')}<span class="fin-total-sep">·</span>${fmtMoney(totUsd, 'USD')}`;

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

    const credsToggle = card.querySelector('.js-creds-toggle');
    if (credsToggle) {
      credsToggle.addEventListener('click', () => {
        card.querySelector('.fin-creds').classList.toggle('hidden');
        adjustWindowSize();
      });
    }

    const saveCredsBtn = card.querySelector('.js-save-creds');
    if (saveCredsBtn) {
      saveCredsBtn.addEventListener('click', async () => {
        const user = card.querySelector('.js-cred-user').value.trim();
        const pass = card.querySelector('.js-cred-pass').value;
        if (!user || !pass) { setCardStatus(card, 'Usuario y contraseña requeridos', 'error'); return; }
        saveCredsBtn.disabled = true;
        setCardStatus(card, 'Guardando…');
        try {
          const r = await window.api.finances.saveCreds({ accountId: id, user, pass });
          if (r && r.ok) { await renderFinanzas(); }
          else setCardStatus(card, (r && r.error) || 'Error', 'error');
        } catch { setCardStatus(card, 'Error', 'error'); }
        finally { saveCredsBtn.disabled = false; }
      });
    }

    const refreshBtn = card.querySelector('.js-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        const orig = refreshBtn.textContent;
        refreshBtn.textContent = '⏳ Capturando…';
        setCardStatus(card, 'Se abrió la ventana del banco. Logueate, completá el 2FA y capturá el saldo.');
        try {
          const r = await window.api.finances.refreshBank(id);
          if (r && r.ok) { setCardStatus(card, 'Saldo guardado ✓', 'success'); await renderFinanzas(); }
          else if (r && r.cancelled) setCardStatus(card, 'Cancelado', '');
          else setCardStatus(card, (r && r.error) || 'No se pudo capturar', 'error');
        } catch { setCardStatus(card, 'Error', 'error'); }
        finally { refreshBtn.disabled = false; refreshBtn.textContent = orig; }
      });
    }
  });
}

finUnlockBtn.addEventListener('click', unlockFinanzas);
finMaster.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockFinanzas(); });
$('fin-lock-now').addEventListener('click', async () => {
  try { await window.api.finances.lock(); } catch {}
  finUnlocked = false;
  enterFinanzas();
});

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

  refreshAI();
  setInterval(refreshAI, AI_INTERVAL_MS);

  loadSpeedtest();

  // Tray "Refresh now" → re-fetch everything except speedtest (manual).
  window.api.onRefresh(() => {
    refreshSystem();
    refreshWeather();
    refreshAI();
  });

  adjustWindowSize();
  window.addEventListener('load', adjustWindowSize);
})();
