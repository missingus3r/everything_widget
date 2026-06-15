// Juegos (main process): ofertas de PC vía CheapShark (gratis, sin key).
//
//   /api/1.0/deals?…        → listado de ofertas (sortBy, storeID, title…)
//   /api/1.0/stores         → catálogo de tiendas (cache: casi nunca cambia)
// El link de compra es el redirect oficial: cheapshark.com/redirect?dealID=…
// Precios siempre en USD. Tira en error — el handler IPC degrada a { error }.

const { getJson } = require('./netJson');

const BASE = 'https://www.cheapshark.com/api/1.0';
let storesCache = null;    // [{ id, name }] solo tiendas activas

async function fetchStores() {
  if (storesCache) return storesCache;
  const arr = await getJson(`${BASE}/stores`);
  storesCache = (Array.isArray(arr) ? arr : [])
    .filter((s) => s.isActive)
    .map((s) => ({ id: String(s.storeID), name: s.storeName }));
  return storesCache;
}

function normalizeDeal(d) {
  const sale = parseFloat(d.salePrice), normal = parseFloat(d.normalPrice);
  return {
    dealId: d.dealID,
    title: d.title || '—',
    storeId: String(d.storeID || ''),
    salePrice: isFinite(sale) ? sale : null,
    normalPrice: isFinite(normal) ? normal : null,
    savings: d.savings != null ? Math.round(parseFloat(d.savings)) : null,
    metacritic: d.metacriticScore ? parseInt(d.metacriticScore, 10) : null,
    steamRating: d.steamRatingPercent ? parseInt(d.steamRatingPercent, 10) : null,
    dealRating: d.dealRating != null ? parseFloat(d.dealRating) : null,
    thumb: d.thumb || null,
    releaseDate: d.releaseDate ? d.releaseDate * 1000 : null,
    url: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(d.dealID)}`,
  };
}

// sortBy de CheapShark: "Deal Rating" | "Savings" | "Price" | "Recent" | "Metacritic".
async function fetchDeals({ page = 0, storeId = '', sortBy = 'Deal Rating', title = '', maxPrice = 0 } = {}) {
  const params = new URLSearchParams({
    pageSize: '24',
    pageNumber: String(Math.max(0, page)),
    sortBy,
    onSale: '1',
  });
  if (storeId) params.set('storeID', storeId);
  if (title) params.set('title', String(title).trim());
  if (maxPrice > 0) params.set('upperPrice', String(maxPrice));
  const [deals, stores] = await Promise.all([
    getJson(`${BASE}/deals?${params}`),
    fetchStores().catch(() => []),
  ]);
  const names = Object.fromEntries(stores.map((s) => [s.id, s.name]));
  return {
    deals: (Array.isArray(deals) ? deals : []).map(normalizeDeal)
      .map((d) => ({ ...d, store: names[d.storeId] || `Tienda ${d.storeId}` })),
    stores,
    fetchedAt: Date.now(),
  };
}

module.exports = { fetchDeals, fetchStores };
