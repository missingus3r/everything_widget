// Acciones y ETFs (main process): cotizaciones vía Finnhub (key gratis).
//
// Necesita key guardada en API Keys con el nombre exactamente "Finnhub"
// (finnhub.io → 60 req/min gratis, alcanza de sobra). Los símbolos viven en
// config.json (stockSymbols) y se editan desde el card Mercado.
//   /api/v1/quote?symbol=AAPL → { c: actual, d: cambio, dp: %, pc: cierre }
//   /api/v1/stock/profile2?symbol=AAPL → { name, logo, … } para el logo
// Tira en error — el handler IPC degrada a { error }.

const { getJson } = require('./netJson');

const BASE = 'https://finnhub.io/api/v1';
const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'SPY', 'VOO'];

// El perfil (logo + nombre) casi no cambia, así que se cachea en memoria y se
// pide una sola vez por símbolo. Los ETFs (SPY, VOO) devuelven {} — se cachea
// igual como null para no re-preguntar en cada refresh y quemar rate limit.
const profileCache = new Map();

async function fetchProfile(key, sym) {
  if (profileCache.has(sym)) return profileCache.get(sym);
  let prof = null;
  try {
    const p = await getJson(`${BASE}/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`);
    if (p && (p.logo || p.name)) {
      prof = { logo: p.logo || null, name: p.name || null };
    }
  } catch { /* sin perfil: el renderer cae al monograma */ }
  profileCache.set(sym, prof);
  return prof;
}

async function fetchQuotes(key, symbols) {
  if (!key) return { error: 'sin key' };
  const list = (Array.isArray(symbols) && symbols.length ? symbols : DEFAULT_SYMBOLS)
    .map((s) => String(s || '').trim().toUpperCase())
    .filter((s) => /^[A-Z.\-^]{1,12}$/.test(s))
    .slice(0, 12);   // tope sano para no comerse el rate limit
  const quotes = await Promise.all(list.map(async (sym) => {
    const prof = await fetchProfile(key, sym).catch(() => null);
    const extra = { logo: prof && prof.logo, name: prof && prof.name };
    try {
      const q = await getJson(`${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`);
      // Símbolo inexistente: Finnhub responde 200 con todo en 0.
      if (!q || !q.c) return { symbol: sym, price: null, change: null, changePct: null, ...extra };
      return {
        symbol: sym,
        price: q.c,
        change: typeof q.d === 'number' ? q.d : null,
        changePct: typeof q.dp === 'number' ? q.dp : null,
        prevClose: q.pc ?? null,
        ...extra,
      };
    } catch (e) {
      return { symbol: sym, price: null, change: null, changePct: null, ...extra, error: String(e && e.message || e) };
    }
  }));
  return { quotes, fetchedAt: Date.now() };
}

module.exports = { fetchQuotes, DEFAULT_SYMBOLS };
