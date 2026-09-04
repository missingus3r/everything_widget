// Archivo histórico de EZTV (main process).
//
// La API de EZTV lista recientes con limit/page, pero la paginación está
// topeada: de la página 100 en adelante devuelve siempre lo mismo (~10.000
// torrents, cosa de un mes). O sea que lo que se cae de esa ventana se pierde,
// igual que el RSS de LimeTorrents. Acá se archiva todo lo que pasa por el
// widget en eztv.sqlite + Mongo (colecciones eztv_torrents y eztv_shows), y
// el crawler completa el histórico serie por serie: filtrando por imdb_id la
// paginación SÍ es profunda (probado: 2.425 episodios de The Simpsons).
//
// Dos tablas:
//   • eztv_torrents — un episodio por fila. Sin magnet: se rearma con el hash.
//   • eztv_shows    — una fila por serie, con el agregado (último subido,
//     cantidad de episodios) y la ficha de IMDb. Guardar la ficha acá es lo
//     que evita repetir la suggestion API en cada listado, y el agregado es lo
//     que permite paginar por serie sin un GROUP BY sobre cientos de miles de
//     filas en cada pedido.

const { createStore } = require('./archiveStore');
const { magnetFor } = require('./magnet');
const { showNameFrom } = require('./eztv');

const store = createStore({ file: 'eztv.sqlite' });

function humanSize(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

// Clave de la serie: el imdb_id cuando la API lo trae (lo normal) y, si no,
// el nombre parseado normalizado — insensible a puntuación y mayúsculas.
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function showKeyOf(t) {
  return t.imdbId ? `id:${String(t.imdbId).replace(/^tt/i, '')}` : `q:${normKey(showNameFrom(t.title))}`;
}

const torrents = store.table({
  name: 'eztv_torrents',
  collection: 'eztv_torrents',
  columns: [
    { col: 'id',          js: 'id',        type: 'INTEGER', key: true },
    { col: 'hash',        js: 'hash',      type: 'TEXT' },
    { col: 'title',       js: 'title',     type: 'TEXT' },
    { col: 'filename',    js: 'filename',  type: 'TEXT' },
    { col: 'imdb_id',     js: 'imdbId',    type: 'TEXT',    fill: true },
    { col: 'show_key',    js: 'showKey',   type: 'TEXT' },
    { col: 'season',      js: 'season',    type: 'INTEGER', fill: true },
    { col: 'episode',     js: 'episode',   type: 'INTEGER', fill: true },
    { col: 'quality',     js: 'quality',   type: 'TEXT',    fill: true },
    { col: 'size_bytes',  js: 'sizeBytes', type: 'INTEGER', fill: true },
    { col: 'seeds',       js: 'seeds',     type: 'INTEGER', mutable: true },
    { col: 'peers',       js: 'peers',     type: 'INTEGER', mutable: true },
    { col: 'screenshot',  js: 'screenshot', type: 'TEXT',   fill: true },
    { col: 'released_at', js: 'releasedAt', type: 'INTEGER' },
    { col: 'added_at',    js: 'addedAt',   type: 'INTEGER' },
  ],
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_ez_show ON eztv_torrents(show_key, released_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_ez_rel ON eztv_torrents(released_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_ez_added ON eztv_torrents(added_at);',
  ],
});

const shows = store.table({
  name: 'eztv_shows',
  collection: 'eztv_shows',
  columns: [
    { col: 'key',       js: 'key',      type: 'TEXT', key: true },
    { col: 'imdb_num',  js: 'imdbNum',  type: 'TEXT', fill: true },
    { col: 'name',      js: 'name',     type: 'TEXT' },           // nombre parseado del release
    { col: 'title',     js: 'title',    type: 'TEXT', mutable: true },   // el de IMDb cuando hay ficha
    { col: 'year',      js: 'year',     type: 'INTEGER', fill: true },
    { col: 'image',     js: 'image',    type: 'TEXT', fill: true },
    { col: 'latest_at', js: 'latestAt', type: 'INTEGER', mutable: true },
    { col: 'eps',       js: 'eps',      type: 'INTEGER', mutable: true },
    { col: 'meta_at',   js: 'metaAt',   type: 'INTEGER', mutable: true },   // ficha de IMDb resuelta
    { col: 'full_at',   js: 'fullAt',   type: 'INTEGER', mutable: true },   // histórico completo bajado
    { col: 'added_at',  js: 'addedAt',  type: 'INTEGER' },
  ],
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_ezshow_latest ON eztv_shows(latest_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_ezshow_added ON eztv_shows(added_at);',
  ],
});

function toRow(t, now) {
  return {
    id: Number(t.id),
    hash: t.hash || null,
    title: t.title || '—',
    filename: t.filename || null,
    imdbId: t.imdbId ? String(t.imdbId).replace(/^tt/i, '') : null,
    showKey: showKeyOf(t),
    season: t.season ?? null,
    episode: t.episode ?? null,
    quality: t.quality || null,
    sizeBytes: t.sizeBytes ?? null,
    seeds: t.seeds ?? null,
    peers: t.peers ?? null,
    screenshot: t.screenshot || null,
    releasedAt: t.releasedAt ?? null,
    addedAt: t.addedAt || now,
  };
}

// Fila → episodio con la forma que espera el renderer (magnet incluido).
function toTorrent(r) {
  return {
    id: r.id,
    hash: r.hash || null,
    title: r.title || '—',
    filename: r.filename || '',
    imdbId: r.imdbId || null,
    season: r.season ?? null,
    episode: r.episode ?? null,
    quality: r.quality || '',
    size: humanSize(r.sizeBytes),
    sizeBytes: r.sizeBytes ?? null,
    seeds: r.seeds ?? null,
    peers: r.peers ?? null,
    magnet: magnetFor(r.hash, r.title),
    screenshot: r.screenshot || null,
    releasedAt: r.releasedAt ?? null,
  };
}

// Recalcula el agregado de las series tocadas por un lote (último subido y
// cantidad de episodios). Se hace con SQL sobre las claves del lote, así que
// el costo va con el tamaño del lote y no con el del archivo.
function refreshShows(keys, now) {
  for (const key of keys) {
    const agg = torrents.raw(
      'SELECT MAX(released_at) AS latest, COUNT(*) AS n, MAX(imdb_id) AS imdb FROM eztv_torrents WHERE show_key = ?',
      [key])[0] || {};
    const sample = torrents.one(
      'SELECT * FROM eztv_torrents WHERE show_key = ? ORDER BY released_at DESC, id DESC LIMIT 1', [key]);
    shows.run(
      `INSERT INTO eztv_shows (key, imdb_num, name, title, year, image, latest_at, eps, meta_at, full_at, added_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET
         latest_at = excluded.latest_at, eps = excluded.eps,
         imdb_num = COALESCE(imdb_num, excluded.imdb_num),
         name = COALESCE(name, excluded.name)`,
      [key, agg.imdb || null, sample ? showNameFrom(sample.title) : key.replace(/^q:/, ''),
        sample ? showNameFrom(sample.title) : key.replace(/^q:/, ''),
        agg.latest || null, Number(agg.n) || 0, now]);
  }
}

async function ingest(list) {
  const now = Date.now();
  const rows = (list || []).filter((t) => t && t.id).map((t) => toRow(t, now));
  if (!rows.length) return 0;
  await torrents.ingest(rows);
  refreshShows([...new Set(rows.map((r) => r.showKey))], now);
  // El agregado se recalcula local; a Mongo suben las series (con su ficha)
  // aparte para que otra máquina no tenga que re-pedirle a IMDb.
  await shows.ingest(showsByKeys([...new Set(rows.map((r) => r.showKey))]));
  return rows.length;
}

function showsByKeys(keys) {
  if (!keys.length) return [];
  const out = [];
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    out.push(...shows.all(`SELECT * FROM eztv_shows WHERE key IN (${chunk.map(() => '?').join(',')})`, chunk));
  }
  return out;
}

// ── Listado del tab: una card por serie, más reciente primero ──
// `episodes` son los últimos EPS_PER_SHOW de cada serie (los que se ven en el
// modal como "subidos recientemente"); `epCount` es el total archivado.
const EPS_PER_SHOW = 12;

async function listShows({ page = 1, limit = 24, query = '' } = {}) {
  await store.ensure();
  const q = String(query || '').trim();
  const where = q ? "WHERE (title LIKE ? OR name LIKE ?)" : '';
  const params = q ? [`%${q}%`, `%${q}%`] : [];
  const count = shows.count(q ? '(title LIKE ? OR name LIKE ?)' : '', params);
  const lim = Math.max(1, Math.min(100, Number(limit) || 24));
  const off = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * lim);
  const rows = shows.all(
    `SELECT * FROM eztv_shows ${where} ORDER BY latest_at DESC, key LIMIT ? OFFSET ?`,
    [...params, lim, off]);
  return {
    count,
    shows: rows.map((s) => ({
      key: s.key,
      imdbNum: s.imdbNum || null,
      title: s.title || s.name || '—',
      year: s.year ?? null,
      image: s.image || null,
      latestAt: s.latestAt ?? null,
      epCount: s.eps ?? 0,
      episodes: torrents.all(
        'SELECT * FROM eztv_torrents WHERE show_key = ? ORDER BY released_at DESC, id DESC LIMIT ?',
        [s.key, EPS_PER_SHOW]).map(toTorrent),
    })),
    fetchedAt: Date.now(),
  };
}

// Episodios de una serie (modal) o recientes de todas, paginados.
async function listTorrents({ page = 1, limit = 50, imdbId = '' } = {}) {
  await store.ensure();
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * lim);
  const id = String(imdbId || '').replace(/^tt/i, '');
  const where = id ? 'WHERE imdb_id = ?' : '';
  const params = id ? [id] : [];
  const count = torrents.count(id ? 'imdb_id = ?' : '', params);
  const rows = torrents.all(
    `SELECT * FROM eztv_torrents ${where} ORDER BY released_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, lim, off]);
  return { count, torrents: rows.map(toTorrent), fetchedAt: Date.now() };
}

// ── Soporte del crawler ────────────────────────────────────────
// Series sin ficha de IMDb resuelta (para pedirla una única vez) y series a
// las que todavía no se les bajó el histórico completo.
async function showsMissingMeta(limit = 20) {
  await store.ensure();
  return shows.all('SELECT * FROM eztv_shows WHERE meta_at IS NULL ORDER BY latest_at DESC LIMIT ?', [limit]);
}

// Solo las series identificadas por tt id (key "id:…"): son las que la API
// sabe filtrar. Las que llegaron sin imdb_id (key "q:nombre", raras) se
// quedan con lo que aparezca en recientes.
async function showsMissingFull(limit = 5) {
  await store.ensure();
  return shows.all(
    "SELECT * FROM eztv_shows WHERE full_at IS NULL AND imdb_num IS NOT NULL AND key LIKE 'id:%' ORDER BY latest_at DESC LIMIT ?",
    [limit]);
}

async function saveShowMeta(key, meta) {
  await store.ensure();
  shows.run(
    `UPDATE eztv_shows SET meta_at = ?, title = COALESCE(?, title), year = COALESCE(?, year),
       image = COALESCE(?, image), imdb_num = COALESCE(imdb_num, ?) WHERE key = ?`,
    [Date.now(), (meta && meta.title) || null, (meta && meta.year) || null,
      (meta && meta.image) || null, (meta && meta.imdbNum) || null, String(key)]);
  const row = shows.one('SELECT * FROM eztv_shows WHERE key = ?', [String(key)]);
  if (row) await shows.ingest([row]);
}

async function markShowFull(key) {
  await store.ensure();
  shows.run('UPDATE eztv_shows SET full_at = ? WHERE key = ?', [Date.now(), String(key)]);
  const row = shows.one('SELECT * FROM eztv_shows WHERE key = ?', [String(key)]);
  if (row) await shows.ingest([row]);
}

async function counts() {
  await store.ensure();
  return { torrents: torrents.count(), shows: shows.count() };
}

// ¿Ya tenemos el histórico de esta serie? (el modal pide a la API solo cuando
// falta).
async function showFor(imdbId) {
  await store.ensure();
  const id = String(imdbId || '').replace(/^tt/i, '');
  if (!id) return null;
  return shows.one('SELECT * FROM eztv_shows WHERE imdb_num = ? ORDER BY eps DESC LIMIT 1', [id]);
}

module.exports = {
  ingest, listShows, listTorrents, counts, showFor,
  showsMissingMeta, showsMissingFull, saveShowMeta, markShowFull,
  ensure: store.ensure,
  flush: store.flush,
  getState: store.getState,
  setState: store.setState,
  syncNow: store.syncAll,
};
