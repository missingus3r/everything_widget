// Market data (main process): crypto prices + USD/ARS/BRL/EUR → UYU rates.
//
// Three free, key-less sources, fetched in parallel (partial failures tolerated):
//   • CoinGecko  /simple/price        → BTC / LTC / XMR / XRP in USD + 24h change
//   • DolarAPI   uy.dolarapi.com      → compra/venta in UYU (Uruguayan market)
//   • ExchangeRate-API open.er-api.com → mid-market rate (computed to UYU)
// We show both FX sources side by side so they can be compared.

const https = require('https');

function getJson(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'NexusWidget/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

const COINS = [
  { id: 'bitcoin',  symbol: 'BTC', name: 'Bitcoin'  },
  { id: 'litecoin', symbol: 'LTC', name: 'Litecoin' },
  { id: 'monero',   symbol: 'XMR', name: 'Monero'   },
  { id: 'ripple',   symbol: 'XRP', name: 'Ripple'   },
];

const FX_CODES = ['USD', 'ARS', 'BRL', 'EUR'];
const FX_NAMES = { USD: 'Dólar', ARS: 'Peso argentino', BRL: 'Real', EUR: 'Euro' };

async function fetchCrypto() {
  const ids = COINS.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}` +
    `&vs_currencies=usd&include_24hr_change=true`;
  const data = await getJson(url);
  return COINS.map((c) => {
    const d = data[c.id] || {};
    return {
      symbol: c.symbol,
      name: c.name,
      usd: typeof d.usd === 'number' ? d.usd : null,
      change24h: typeof d.usd_24h_change === 'number' ? d.usd_24h_change : null,
    };
  });
}

// DolarAPI quotes are already expressed in UYU per unit of foreign currency.
async function fetchDolarApi() {
  const arr = await getJson('https://uy.dolarapi.com/v1/cotizaciones');
  const byCode = {};
  for (const it of (Array.isArray(arr) ? arr : [])) {
    byCode[String(it.moneda).toUpperCase()] = it;
  }
  const out = {};
  for (const code of FX_CODES) {
    const it = byCode[code];
    if (it) out[code] = { compra: it.compra ?? null, venta: it.venta ?? null };
  }
  return out;
}

// ExchangeRate-API is based at USD; convert each currency to "1 unit = N UYU".
// rates[code] is "units of `code` per 1 USD", rates.UYU is "UYU per 1 USD",
// so UYU per 1 `code` = rates.UYU / rates[code].
async function fetchErApi() {
  const data = await getJson('https://open.er-api.com/v6/latest/USD');
  const rates = data && data.rates;
  if (!rates || typeof rates.UYU !== 'number') return {};
  const uyuPerUsd = rates.UYU;
  const out = {};
  for (const code of FX_CODES) {
    const r = rates[code];
    if (typeof r === 'number' && r > 0) out[code] = uyuPerUsd / r;
  }
  return out;
}

async function fetchMarkets() {
  const [crypto, dolarapi, erapi] = await Promise.allSettled([
    fetchCrypto(), fetchDolarApi(), fetchErApi(),
  ]);
  return {
    crypto: crypto.status === 'fulfilled' ? crypto.value : null,
    fx: {
      codes: FX_CODES,
      names: FX_NAMES,
      dolarapi: dolarapi.status === 'fulfilled' ? dolarapi.value : null,
      erapi:    erapi.status === 'fulfilled' ? erapi.value : null,
    },
    fetchedAt: Date.now(),
  };
}

module.exports = { fetchMarkets };
