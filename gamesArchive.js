// Archivo histórico de las ofertas de juegos de CheapShark (main process).
//
// La API solo devuelve la foto de ahora y en tandas de 60, con tope de 50
// páginas por consulta: no hay forma de pedirle "todo" ni de ver lo que pasó.
// Acá queda todo lo que se vio — el crawler recorre tienda por tienda (ver
// archiveCrawl.js) y cada carga del tab archiva lo que trae — en
// games.sqlite + Mongo (colecciones game_deals y game_stores).
//
// El tab lista desde esta base: el orden, el filtro por tienda/precio y la
// búsqueda salen de SQL local, así que el listado funciona con CheapShark
// caído y el pager muestra el catálogo archivado completo, no la página que
// la API quiso mandar. Como la fila guarda `min_price`, además queda el
// mínimo histórico de cada oferta (la API no lo da).

const { createStore } = require('./archiveStore');

const store = createStore({ file: 'games.sqlite' });

const deals = store.table({
  name: 'game_deals',
  collection: 'game_deals',
  columns: [
    { col: 'deal_id',      js: 'dealId',      type: 'TEXT', key: true },
    { col: 'game_id',      js: 'gameId',      type: 'TEXT', fill: true },
    { col: 'title',        js: 'title',       type: 'TEXT' },
    { col: 'store_id',     js: 'storeId',     type: 'TEXT' },
    { col: 'steam_app_id', js: 'steamAppId',  type: 'TEXT', fill: true },
    { col: 'sale_price',   js: 'salePrice',   type: 'REAL', mutable: true },
    { col: 'normal_price', js: 'normalPrice', type: 'REAL', mutable: true },
    { col: 'min_price',    js: 'minPrice',    type: 'REAL', mutable: true },
    { col: 'savings',      js: 'savings',     type: 'INTEGER', mutable: true },
    { col: 'on_sale',      js: 'onSale',      type: 'INTEGER', mutable: true },
    { col: 'metacritic',   js: 'metacritic',  type: 'INTEGER', fill: true },
    { col: 'steam_rating', js: 'steamRating', type: 'INTEGER', fill: true },
    { col: 'deal_rating',  js: 'dealRating',  type: 'REAL', mutable: true },
    { col: 'thumb',        js: 'thumb',       type: 'TEXT', fill: true },
    { col: 'release_date', js: 'releaseDate', type: 'INTEGER', fill: true },
    { col: 'last_change',  js: 'lastChange',  type: 'INTEGER', mutable: true },
    { col: 'last_seen',    js: 'lastSeen',    type: 'INTEGER', mutable: true },
    { col: 'added_at',     js: 'addedAt',     type: 'INTEGER' },
  ],
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_gd_rating ON game_deals(deal_rating DESC);',
    'CREATE INDEX IF NOT EXISTS idx_gd_savings ON game_deals(savings DESC);',
    'CREATE INDEX IF NOT EXISTS idx_gd_price ON game_deals(sale_price);',
    'CREATE INDEX IF NOT EXISTS idx_gd_change ON game_deals(last_change DESC);',
    'CREATE INDEX IF NOT EXISTS idx_gd_store ON game_deals(store_id);',
    'CREATE INDEX IF NOT EXISTS idx_gd_title ON game_deals(title COLLATE NOCASE);',
    'CREATE INDEX IF NOT EXISTS idx_gd_added ON game_deals(added_at);',
  ],
});

// El catálogo de tiendas también se archiva: sin él, con CheapShark caído el
// filtro por tienda quedaba vacío y las cards no sabían de qué tienda eran.
const stores = store.table({
  name: 'game_stores',
  collection: 'game_stores',
  columns: [
    { col: 'id',       js: 'id',      type: 'TEXT', key: true },
    { col: 'name',     js: 'name',    type: 'TEXT', mutable: true },
    { col: 'added_at', js: 'addedAt', type: 'INTEGER' },
  ],
});

function toRow(d, now) {
  return {
    dealId: d.dealId,
    gameId: d.gameId || null,
    title: d.title || '—',
    storeId: String(d.storeId || ''),
    steamAppId: d.steamAppId || null,
    salePrice: d.salePrice ?? null,
    normalPrice: d.normalPrice ?? null,
    minPrice: d.salePrice ?? null,   // se ajusta abajo con el mínimo ya visto
    savings: d.savings ?? null,
    onSale: d.onSale ? 1 : 0,
    metacritic: d.metacritic ?? null,
    steamRating: d.steamRating ?? null,
    dealRating: d.dealRating ?? null,
    thumb: d.thumb || null,
    releaseDate: d.releaseDate ?? null,
    lastChange: d.lastChange ?? null,
    lastSeen: now,
    addedAt: d.addedAt || now,
  };
}

function toDeal(r, storeNames) {
  return {
    dealId: r.dealId,
    gameId: r.gameId || null,
    title: r.title || '—',
    storeId: r.storeId || '',
    store: storeNames[r.storeId] || `Tienda ${r.storeId}`,
    steamAppId: r.steamAppId || null,
    salePrice: r.salePrice ?? null,
    normalPrice: r.normalPrice ?? null,
    minPrice: r.minPrice ?? null,
    savings: r.savings ?? null,
    onSale: !!r.onSale,
    metacritic: r.metacritic ?? null,
    steamRating: r.steamRating ?? null,
    dealRating: r.dealRating ?? null,
    thumb: r.thumb || null,
    releaseDate: r.releaseDate ?? null,
    lastChange: r.lastChange ?? null,
    lastSeen: r.lastSeen ?? null,
    url: `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(r.dealId)}`,
  };
}

async function ingest(list) {
  const now = Date.now();
  const rows = (list || []).filter((d) => d && d.dealId).map((d) => toRow(d, now));
  if (!rows.length) return 0;
  await deals.ingest(rows);
  // min_price es un mínimo acumulado: el upsert genérico solo sabe pisar o
  // completar, así que el piso histórico se ajusta acá después de insertar.
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    deals.run(
      `UPDATE game_deals SET min_price = MIN(COALESCE(min_price, sale_price), sale_price)
       WHERE deal_id IN (${chunk.map(() => '?').join(',')}) AND sale_price IS NOT NULL`,
      chunk.map((r) => r.dealId));
  }
  return rows.length;
}

async function ingestStores(list) {
  const now = Date.now();
  return stores.ingest((list || []).filter((s) => s && s.id)
    .map((s) => ({ id: String(s.id), name: s.name || `Tienda ${s.id}`, addedAt: now })));
}

async function listStores() {
  await store.ensure();
  return stores.all('SELECT * FROM game_stores ORDER BY name COLLATE NOCASE')
    .map((s) => ({ id: s.id, name: s.name }));
}

const SORTS = {
  'Deal Rating': 'deal_rating DESC, savings DESC',
  Savings: 'savings DESC, deal_rating DESC',
  Price: 'sale_price ASC, deal_rating DESC',
  Recent: 'last_change DESC, added_at DESC',
  Metacritic: 'metacritic DESC, deal_rating DESC',
};

const likeArg = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

async function list({ page = 0, limit = 24, storeId = '', sortBy = 'Deal Rating', title = '', maxPrice = 0 } = {}) {
  await store.ensure();
  const where = [];
  const params = [];
  if (storeId) { where.push('store_id = ?'); params.push(String(storeId)); }
  if (title) { where.push("title LIKE ? ESCAPE '\\'"); params.push(likeArg(title)); }
  if (maxPrice > 0) { where.push('sale_price <= ?'); params.push(Number(maxPrice)); }
  const sql = where.join(' AND ');
  const count = deals.count(sql, params);
  const lim = Math.max(1, Math.min(100, Number(limit) || 24));
  const off = Math.max(0, Math.max(0, Number(page) || 0) * lim);
  const rows = deals.all(
    `SELECT * FROM game_deals${sql ? ` WHERE ${sql}` : ''} ORDER BY ${SORTS[sortBy] || SORTS['Deal Rating']} LIMIT ? OFFSET ?`,
    [...params, lim, off]);
  const names = Object.fromEntries((await listStores()).map((s) => [s.id, s.name]));
  return { count, deals: rows.map((r) => toDeal(r, names)), fetchedAt: Date.now() };
}

async function count() {
  await store.ensure();
  return deals.count();
}

module.exports = {
  ingest, ingestStores, listStores, list, count,
  ensure: store.ensure,
  flush: store.flush,
  getState: store.getState,
  setState: store.setState,
  syncNow: store.syncAll,
};
