// Archivo histórico del catálogo de YIFY (main process).
//
// La API de YIFY es un mirror comunitario que puede morir en cualquier
// momento y además solo se puede leer de a páginas: el tab dependía 100% de
// que estuviera viva. Acá se guarda TODO lo que se ve — el crawler baja el
// catálogo entero (~77.000 películas, ver archiveCrawl.js) y cada refresco de
// "recientes" archiva las novedades — en yify.sqlite + Mongo (colección
// yify_movies, la misma base que Finanzas), aditivo y sin borrar nunca nada.
//
// El tab lista SIEMPRE desde acá: el orden, los filtros (género, calidad,
// rating) y la paginación se resuelven en SQL local, así que el listado sigue
// funcionando con la API caída y el pager crece con el archivo en vez de
// depender de lo que el mirror quiera devolver.
//
// Los magnets NO se guardan: se rearman con el hash al leer (ver magnet.js).

const { createStore } = require('./archiveStore');
const { magnetFor } = require('./magnet');

const store = createStore({ file: 'yify.sqlite' });

const json = { enc: (v) => (v == null ? null : JSON.stringify(v)), dec: (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } } };

// Claves de filtro pre-normalizadas ("|action|drama|"): un LIKE sobre esto es
// exacto y usa el índice de la fila, sin tener que parsear el JSON por fila.
const keyOf = (arr) => (Array.isArray(arr) && arr.length ? `|${arr.map((s) => String(s).toLowerCase()).join('|')}|` : null);

const movies = store.table({
  name: 'yify_movies',
  collection: 'yify_movies',
  columns: [
    { col: 'id',          js: 'id',        type: 'INTEGER', key: true },
    { col: 'imdb',        js: 'imdb',      type: 'TEXT',    fill: true },
    { col: 'title',       js: 'title',     type: 'TEXT' },
    { col: 'title_long',  js: 'titleLong', type: 'TEXT',    fill: true },
    { col: 'year',        js: 'year',      type: 'INTEGER' },
    { col: 'rating',      js: 'rating',    type: 'REAL',    mutable: true },
    { col: 'runtime',     js: 'runtime',   type: 'INTEGER', fill: true },
    { col: 'genres',      js: 'genres',    type: 'TEXT',    fill: true, ...json },
    { col: 'genres_key',  js: 'genresKey', type: 'TEXT',    fill: true },
    { col: 'cover',       js: 'cover',     type: 'TEXT',    fill: true },
    { col: 'synopsis',    js: 'synopsis',  type: 'TEXT',    fill: true },
    { col: 'trailer',     js: 'trailer',   type: 'TEXT',    fill: true },
    { col: 'url',         js: 'url',       type: 'TEXT',    fill: true },
    { col: 'torrents',    js: 'torrents',  type: 'TEXT',    mutable: true, ...json },
    { col: 'quals',       js: 'quals',     type: 'TEXT',    mutable: true },
    { col: 'seeds',       js: 'seeds',     type: 'INTEGER', mutable: true },
    { col: 'peers',       js: 'peers',     type: 'INTEGER', mutable: true },
    // download_count solo llega en movie_details.json (la ficha), así que se
    // completa cuando se abre una película, nunca desde el listado.
    { col: 'downloads',   js: 'downloads', type: 'INTEGER', fill: true },
    { col: 'uploaded_at', js: 'uploadedAt', type: 'INTEGER' },
    { col: 'added_at',    js: 'addedAt',   type: 'INTEGER' },
  ],
  indexes: [
    'CREATE INDEX IF NOT EXISTS idx_yify_uploaded ON yify_movies(uploaded_at DESC);',
    'CREATE INDEX IF NOT EXISTS idx_yify_rating ON yify_movies(rating DESC);',
    'CREATE INDEX IF NOT EXISTS idx_yify_year ON yify_movies(year DESC);',
    'CREATE INDEX IF NOT EXISTS idx_yify_seeds ON yify_movies(seeds DESC);',
    'CREATE INDEX IF NOT EXISTS idx_yify_title ON yify_movies(title COLLATE NOCASE);',
    'CREATE INDEX IF NOT EXISTS idx_yify_added ON yify_movies(added_at);',
  ],
});

// Película de la API → fila. Los torrents se guardan sin magnet (se rearma) y
// seeds/peers/calidades suben a columnas propias para poder ordenar y filtrar.
function toRow(m, now) {
  const tors = Array.isArray(m.torrents) ? m.torrents : [];
  const maxOf = (k) => tors.reduce((a, t) => (t[k] != null && t[k] > a ? t[k] : a), 0);
  return {
    id: Number(m.id),
    imdb: m.imdb || null,
    title: m.title || '—',
    titleLong: m.titleLong || null,
    year: m.year ?? null,
    rating: m.rating ?? null,
    runtime: m.runtime ?? null,
    genres: m.genres && m.genres.length ? m.genres : null,
    genresKey: keyOf(m.genres),
    cover: m.cover || null,
    synopsis: m.synopsis || null,
    trailer: m.trailer || null,
    url: m.url || null,
    torrents: tors.map(({ magnet, ...t }) => t),
    quals: keyOf(tors.map((t) => t.quality).filter(Boolean)),
    seeds: maxOf('seeds') || null,
    peers: maxOf('peers') || null,
    downloads: m.downloads ?? null,
    uploadedAt: m.uploadedAt ?? null,
    addedAt: m.addedAt || now,
  };
}

// Fila → película con la forma que espera el renderer (idéntica a la de la
// API viva, magnets incluidos).
function toMovie(r) {
  const tors = Array.isArray(r.torrents) ? r.torrents : [];
  return {
    id: r.id,
    url: r.url || null,
    imdb: r.imdb || null,
    title: r.title || '—',
    titleLong: r.titleLong || null,
    year: r.year ?? null,
    rating: r.rating ?? null,
    runtime: r.runtime ?? null,
    genres: Array.isArray(r.genres) ? r.genres : [],
    cover: r.cover || null,
    synopsis: r.synopsis || '',
    trailer: r.trailer || null,
    downloads: r.downloads ?? null,
    uploadedAt: r.uploadedAt ?? null,
    torrents: tors.map((t) => ({
      ...t,
      magnet: t.hash ? magnetFor(t.hash, r.titleLong || r.title) : null,
    })),
  };
}

async function ingest(list) {
  const now = Date.now();
  return movies.ingest((list || []).filter((m) => m && m.id).map((m) => toRow(m, now)));
}

// ── Listado del tab ────────────────────────────────────────────
// Mismos filtros que tenía la API viva, resueltos en SQL. `query` busca en el
// título (la API además miraba actor/director: eso se resuelve en main, que
// le pregunta al mirror cuando está vivo y cae acá cuando no).
const SORTS = {
  date_added: 'uploaded_at DESC, id DESC',
  rating: 'rating DESC, uploaded_at DESC',
  // El catálogo no trae descargas (solo la ficha): las que se conocen van
  // primero — en SQLite un DESC deja los NULL al final — y el resto por seeds.
  download_count: 'downloads DESC, seeds DESC',
  seeds: 'seeds DESC, uploaded_at DESC',
  year: 'year DESC, uploaded_at DESC',
  title: 'title COLLATE NOCASE ASC',
  like_count: 'rating DESC, uploaded_at DESC',
};

const likeArg = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function whereFor({ query = '', genre = '', quality = '', minRating = 0 }) {
  const where = [];
  const params = [];
  const q = String(query || '').trim();
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR title_long LIKE ? ESCAPE '\\')");
    params.push(likeArg(q), likeArg(q));
  }
  if (genre) {
    where.push("genres_key LIKE ? ESCAPE '\\'");
    params.push(`%|${String(genre).toLowerCase()}|%`);
  }
  if (quality) {
    where.push("quals LIKE ? ESCAPE '\\'");
    params.push(`%|${String(quality).toLowerCase()}|%`);
  }
  if (minRating > 0) {
    where.push('rating >= ?');
    params.push(Number(minRating));
  }
  return { sql: where.length ? where.join(' AND ') : '', params };
}

async function list({ page = 1, limit = 12, query = '', genre = '', quality = '', minRating = 0, sort = 'date_added' } = {}) {
  await store.ensure();
  const { sql, params } = whereFor({ query, genre, quality, minRating });
  const count = movies.count(sql, params);
  const lim = Math.max(1, Math.min(100, Number(limit) || 12));
  const off = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * lim);
  const rows = movies.all(
    `SELECT * FROM yify_movies${sql ? ` WHERE ${sql}` : ''} ORDER BY ${SORTS[sort] || SORTS.date_added} LIMIT ? OFFSET ?`,
    [...params, lim, off]);
  return { count, movies: rows.map(toMovie), fetchedAt: Date.now() };
}

async function byId(id) {
  await store.ensure();
  const r = movies.one('SELECT * FROM yify_movies WHERE id = ?', [Number(id)]);
  return r ? toMovie(r) : null;
}

// Total archivado (el contador del pager cuando no hay filtros).
async function count() {
  await store.ensure();
  return movies.count();
}

module.exports = {
  ingest, list, byId, count,
  ensure: store.ensure,
  flush: store.flush,
  getState: store.getState,
  setState: store.setState,
  syncNow: store.syncAll,
};
