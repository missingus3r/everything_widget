// Acciones y ETFs (main process): cotizaciones vía Finnhub (key gratis).
//
// Necesita key guardada en API Keys con el nombre exactamente "Finnhub"
// (finnhub.io → 60 req/min gratis, alcanza de sobra). Los símbolos viven en
// config.json (stockSymbols) y se editan desde el card Mercado.
//   /api/v1/quote?symbol=AAPL → { c: actual, d: cambio, dp: %, pc: cierre }
// Tira en error — el handler IPC degrada a { error }.

const { getJson } = require('./netJson');

const BASE = 'https://finnhub.io/api/v1';
const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'SPY', 'VOO'];

async function fetchQuotes(key, symbols) {
  if (!key) return { error: 'sin key' };
  const list = (Array.isArray(symbols) && symbols.length ? symbols : DEFAULT_SYMBOLS)
    .map((s) => String(s || '').trim().toUpperCase())
    .filter((s) => /^[A-Z.\-^]{1,12}$/.test(s))
    .slice(0, 12);   // tope sano para no comerse el rate limit
  const quotes = await Promise.all(list.map(async (sym) => {
    try {
      const q = await getJson(`${BASE}/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`);
      // Símbolo inexistente: Finnhub responde 200 con todo en 0.
      if (!q || !q.c) return { symbol: sym, price: null, change: null, changePct: null };
      return {
        symbol: sym,
        price: q.c,
        change: typeof q.d === 'number' ? q.d : null,
        changePct: typeof q.dp === 'number' ? q.dp : null,
        prevClose: q.pc ?? null,
      };
    } catch (e) {
      return { symbol: sym, price: null, change: null, changePct: null, error: String(e && e.message || e) };
    }
  }));
  return { quotes, fetchedAt: Date.now() };
}

module.exports = { fetchQuotes, DEFAULT_SYMBOLS };
