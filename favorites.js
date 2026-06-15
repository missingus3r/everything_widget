// Favoritos de películas (main process): MongoDB Atlas primario + espejo SQLite.
//
// La idea es que un favorito sobreviva a la muerte de la API de YIFY: al dar
// like se guarda TODO — portada descargada como bytes, sinopsis, rating, año,
// calidades y magnet links incluidos — así la sección Favoritos funciona 100%
// offline. Mismo patrón que Finanzas: cada mutación escribe en ambos stores
// (Mongo best-effort), al arranque se suben los favoritos solo-locales
// ($setOnInsert) y se baja la copia autoritativa de Mongo al espejo SQLite.
// Las lecturas salen siempre de SQLite (instantáneas, funcionan sin red).
// Reusa la conexión de finances/mongo.js (misma base, colección `favorites`).

const fs = require('fs');
const path = require('path');
const https = require('https');
const mongo = require('./finances/mongo');

const DB_PATH = path.join(__dirname, 'favorites.sqlite');
const WASM_PATH = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
const COLLECTION = 'favorites';            // películas (YIFY)
const SERIES_COLLECTION = 'series_favorites';  // episodios (EZTV)

let db = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS favorites (
    id        INTEGER PRIMARY KEY,        -- id de YIFY (= _id en Mongo)
    title     TEXT    NOT NULL,
    year      INTEGER,
    rating    REAL,
    runtime   INTEGER,
    genres    TEXT,                       -- JSON array
    synopsis  TEXT,                       -- review/descripción completa
    trailer   TEXT,
    url       TEXT,                       -- página en YTS
    cover_url TEXT,
    cover     BLOB,                       -- portada descargada (bytes)
    cover_mime TEXT,
    cast      TEXT,                       -- JSON array [{ name, character }]
    torrents  TEXT NOT NULL,              -- JSON array con calidad/tamaño/magnet
    added_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS series_favorites (
    id        INTEGER PRIMARY KEY,        -- id del torrent en EZTV (= _id en Mongo)
    title     TEXT    NOT NULL,           -- nombre del release
    filename  TEXT,
    imdb_id   TEXT,
    show_title TEXT,                      -- serie (de IMDb, si se buscó)
    season    INTEGER,
    episode   INTEGER,
    quality   TEXT,
    size      TEXT,
    size_bytes INTEGER,
    seeds     INTEGER,
    peers     INTEGER,
    magnet    TEXT NOT NULL,
    image_url TEXT,                       -- screenshot EZTV o poster IMDb
    image     BLOB,                       -- la imagen descargada (bytes)
    image_mime TEXT,
    released_at INTEGER,
    added_at  INTEGER NOT NULL
  );
`;

let readyPromise = null;
function ensure() {
  if (!readyPromise) readyPromise = (async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({ locateFile: (f) => path.join(WASM_PATH, f) });
    db = fs.existsSync(DB_PATH)
      ? new SQL.Database(fs.readFileSync(DB_PATH))
      : new SQL.Database();
    db.run(SCHEMA);
    persist();
    await reconcile();   // nunca tira: sin Mongo queda SQLite-only
  })();
  return readyPromise;
}

function persist() {
  if (db) fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

async function favCols() {
  if (!mongo.isEnabled()) return null;
  const dbh = await mongo.connect();   // null si el cluster no responde
  return dbh
    ? { movies: dbh.collection(COLLECTION), series: dbh.collection(SERIES_COLLECTION) }
    : null;
}

// ── Conversión entre el "fav" canónico, la fila SQLite y el doc Mongo ────────
// Fav canónico: { id, title, year, rating, runtime, genres[], synopsis,
//   trailer, url, coverUrl, cover (Buffer|null), coverMime, cast[],
//   torrents[], addedAt }.

const parse = (s, def) => { try { return JSON.parse(s) ?? def; } catch { return def; } };

// BSON Binary / Buffer / Uint8Array → Buffer (o null).
function toBuf(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v.buffer) return Buffer.from(v.buffer);   // BSON Binary
  if (v instanceof Uint8Array) return Buffer.from(v);
  return null;
}

function rowToFav(r) {
  return {
    id: r.id, title: r.title,
    year: r.year ?? null, rating: r.rating ?? null, runtime: r.runtime ?? null,
    genres: parse(r.genres, []), synopsis: r.synopsis || '',
    trailer: r.trailer || null, url: r.url || null,
    coverUrl: r.cover_url || null, cover: toBuf(r.cover), coverMime: r.cover_mime || null,
    cast: parse(r.cast, []), torrents: parse(r.torrents, []),
    addedAt: r.added_at,
  };
}

function docToFav(d) {
  return {
    id: Number(d._id), title: d.title,
    year: d.year ?? null, rating: d.rating ?? null, runtime: d.runtime ?? null,
    genres: Array.isArray(d.genres) ? d.genres : [], synopsis: d.synopsis || '',
    trailer: d.trailer || null, url: d.url || null,
    coverUrl: d.cover_url || null, cover: toBuf(d.cover), coverMime: d.cover_mime || null,
    cast: Array.isArray(d.cast) ? d.cast : [], torrents: Array.isArray(d.torrents) ? d.torrents : [],
    addedAt: d.added_at || Date.now(),
  };
}

// Doc Mongo: arrays como arrays de verdad y la portada como BSON Binary
// (el driver serializa el Buffer solo). _id = id de YIFY.
function favToDoc(f) {
  return {
    _id: f.id, title: f.title,
    year: f.year, rating: f.rating, runtime: f.runtime,
    genres: f.genres, synopsis: f.synopsis,
    trailer: f.trailer, url: f.url,
    cover_url: f.coverUrl, cover: f.cover, cover_mime: f.coverMime,
    cast: f.cast, torrents: f.torrents,
    added_at: f.addedAt,
  };
}

function writeRow(f) {
  db.run(
    'INSERT OR REPLACE INTO favorites ' +
    '(id, title, year, rating, runtime, genres, synopsis, trailer, url, cover_url, cover, cover_mime, cast, torrents, added_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Number(f.id), String(f.title),
      f.year == null ? null : Number(f.year),
      f.rating == null ? null : Number(f.rating),
      f.runtime == null ? null : Number(f.runtime),
      JSON.stringify(f.genres || []), f.synopsis || '',
      f.trailer || null, f.url || null,
      f.coverUrl || null, f.cover, f.coverMime || null,
      JSON.stringify(f.cast || []), JSON.stringify(f.torrents || []),
      Number(f.addedAt),
    ]
  );
}

function readRows() {
  const stmt = db.prepare('SELECT * FROM favorites ORDER BY added_at DESC');
  const rows = [];
  while (stmt.step()) rows.push(rowToFav(stmt.getAsObject()));
  stmt.free();
  return rows;
}

// ── Lo mismo para episodios de series (EZTV) ─────────────────────────────────
// Sfav canónico: { id, title, filename, imdbId, showTitle, season, episode,
//   quality, size, sizeBytes, seeds, peers, magnet, imageUrl,
//   image (Buffer|null), imageMime, releasedAt, addedAt }.

function rowToSfav(r) {
  return {
    id: r.id, title: r.title, filename: r.filename || '',
    imdbId: r.imdb_id || null, showTitle: r.show_title || null,
    season: r.season ?? null, episode: r.episode ?? null,
    quality: r.quality || '', size: r.size || '', sizeBytes: r.size_bytes ?? null,
    seeds: r.seeds ?? null, peers: r.peers ?? null,
    magnet: r.magnet,
    imageUrl: r.image_url || null, image: toBuf(r.image), imageMime: r.image_mime || null,
    releasedAt: r.released_at ?? null, addedAt: r.added_at,
  };
}

function docToSfav(d) {
  return {
    id: Number(d._id), title: d.title, filename: d.filename || '',
    imdbId: d.imdb_id || null, showTitle: d.show_title || null,
    season: d.season ?? null, episode: d.episode ?? null,
    quality: d.quality || '', size: d.size || '', sizeBytes: d.size_bytes ?? null,
    seeds: d.seeds ?? null, peers: d.peers ?? null,
    magnet: d.magnet,
    imageUrl: d.image_url || null, image: toBuf(d.image), imageMime: d.image_mime || null,
    releasedAt: d.released_at ?? null, addedAt: d.added_at || Date.now(),
  };
}

function sfavToDoc(f) {
  return {
    _id: f.id, title: f.title, filename: f.filename,
    imdb_id: f.imdbId, show_title: f.showTitle,
    season: f.season, episode: f.episode,
    quality: f.quality, size: f.size, size_bytes: f.sizeBytes,
    seeds: f.seeds, peers: f.peers,
    magnet: f.magnet,
    image_url: f.imageUrl, image: f.image, image_mime: f.imageMime,
    released_at: f.releasedAt, added_at: f.addedAt,
  };
}

function writeSeriesRow(f) {
  db.run(
    'INSERT OR REPLACE INTO series_favorites ' +
    '(id, title, filename, imdb_id, show_title, season, episode, quality, size, size_bytes, seeds, peers, magnet, image_url, image, image_mime, released_at, added_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Number(f.id), String(f.title), f.filename || null,
      f.imdbId || null, f.showTitle || null,
      f.season == null ? null : Number(f.season),
      f.episode == null ? null : Number(f.episode),
      f.quality || null, f.size || null,
      f.sizeBytes == null ? null : Number(f.sizeBytes),
      f.seeds == null ? null : Number(f.seeds),
      f.peers == null ? null : Number(f.peers),
      String(f.magnet),
      f.imageUrl || null, f.image, f.imageMime || null,
      f.releasedAt == null ? null : Number(f.releasedAt),
      Number(f.addedAt),
    ]
  );
}

function readSeriesRows() {
  const stmt = db.prepare('SELECT * FROM series_favorites ORDER BY added_at DESC');
  const rows = [];
  while (stmt.step()) rows.push(rowToSfav(stmt.getAsObject()));
  stmt.free();
  return rows;
}

// ── Reconciliación al arranque (espejo del patrón de Finanzas) ───────────────
// Sube los favoritos que Mongo no tiene ($setOnInsert preserva lo creado
// offline sin pisar lo remoto) y baja la copia autoritativa a SQLite.
// Cubre películas (YIFY) y episodios de series (EZTV).
async function reconcile() {
  try {
    const cols = await favCols();
    if (!cols) return;
    const seedUp = async (col, locals, toDoc) => {
      if (!locals.length) return;
      await col.bulkWrite(locals.map((f) => ({
        updateOne: { filter: { _id: f.id }, update: { $setOnInsert: toDoc(f) }, upsert: true },
      })), { ordered: false });
    };
    await seedUp(cols.movies, readRows(), favToDoc);
    await seedUp(cols.series, readSeriesRows(), sfavToDoc);
    const [movieDocs, seriesDocs] = await Promise.all([
      cols.movies.find({}).toArray(),
      cols.series.find({}).toArray(),
    ]);
    db.run('BEGIN TRANSACTION');
    try {
      db.run('DELETE FROM favorites');
      db.run('DELETE FROM series_favorites');
      movieDocs.forEach((d) => writeRow(docToFav(d)));
      seriesDocs.forEach((d) => writeSeriesRow(docToSfav(d)));
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
    persist();
    console.log(`[favorites] synced from Mongo: ${movieDocs.length} películas, ${seriesDocs.length} series`);
  } catch (e) {
    console.warn('[favorites] mongo sync failed, SQLite-only:', e.message);
  }
}

// Descarga binaria (la portada) siguiendo hasta 3 redirects. Rechaza en error;
// el caller la trata como opcional — un favorito sin imagen sigue valiendo.
function getBytes(url, timeoutMs = 15000, redirects = 3) {
  return new Promise((resolve, reject) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      reject(new Error('url inválida'));
      return;
    }
    const req = https.get(url, { headers: { 'User-Agent': 'NexusWidget/1.0' } }, (res) => {
      const sc = res.statusCode || 0;
      if (sc >= 300 && sc < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(getBytes(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1));
        return;
      }
      if (sc >= 400) { res.resume(); reject(new Error(`HTTP ${sc}`)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        buf: Buffer.concat(chunks),
        mime: (res.headers['content-type'] || 'image/jpeg').split(';')[0],
      }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// ── API pública ──────────────────────────────────────────────────────────────

// Guarda (o re-guarda) un favorito. `movie` es el objeto normalizado de yify.js
// — idealmente el de movie_details (sinopsis completa + cast); el handler IPC
// se encarga de enriquecerlo si la API responde. La portada se baja acá.
async function add(movie) {
  await ensure();
  if (!movie || !movie.id || !movie.title) throw new Error('película inválida');

  let cover = null, coverMime = null;
  const coverUrl = (movie.cover && /^https?:\/\//i.test(movie.cover)) ? movie.cover : null;
  if (coverUrl) {
    try {
      const img = await getBytes(coverUrl);
      if (img.buf.length > 0 && img.buf.length < 3 * 1024 * 1024) {
        cover = img.buf;
        coverMime = img.mime;
      }
    } catch {} // sin imagen: el favorito igual se guarda
  }

  const fav = {
    id: Number(movie.id), title: String(movie.title),
    year: movie.year == null ? null : Number(movie.year),
    rating: movie.rating == null ? null : Number(movie.rating),
    runtime: movie.runtime == null ? null : Number(movie.runtime),
    genres: Array.isArray(movie.genres) ? movie.genres : [],
    synopsis: movie.synopsis || '',
    trailer: movie.trailer || null, url: movie.url || null,
    coverUrl, cover, coverMime,
    cast: Array.isArray(movie.cast) ? movie.cast : [],
    torrents: Array.isArray(movie.torrents) ? movie.torrents : [],
    addedAt: Date.now(),
  };

  writeRow(fav);
  persist();
  try {
    const cols = await favCols();
    if (cols) await cols.movies.updateOne({ _id: fav.id }, { $set: favToDoc(fav) }, { upsert: true });
  } catch (e) { console.warn('[favorites] mongo upsert failed:', e.message); }
}

async function remove(movieId) {
  await ensure();
  db.run('DELETE FROM favorites WHERE id = ?', [Number(movieId)]);
  persist();
  try {
    const cols = await favCols();
    if (cols) await cols.movies.deleteOne({ _id: Number(movieId) });
  } catch (e) { console.warn('[favorites] mongo delete failed:', e.message); }
}

// Solo los ids — el renderer los usa para pintar los corazones.
async function getIds() {
  await ensure();
  const stmt = db.prepare('SELECT id FROM favorites');
  const ids = [];
  while (stmt.step()) ids.push(stmt.getAsObject().id);
  stmt.free();
  return ids;
}

// Listado completo (espejo local, más reciente primero) en la misma forma
// normalizada que yify.js para que el renderer reuse sus vistas tal cual.
// La portada sale del BLOB como data URL; si no se pudo bajar, queda la URL.
async function list() {
  await ensure();
  return readRows().map((f) => ({
    id: f.id, title: f.title, year: f.year, rating: f.rating, runtime: f.runtime,
    genres: f.genres, synopsis: f.synopsis, trailer: f.trailer, url: f.url,
    cover: f.cover
      ? `data:${f.coverMime || 'image/jpeg'};base64,${f.cover.toString('base64')}`
      : (f.coverUrl || null),
    cast: f.cast, torrents: f.torrents,
    addedAt: f.addedAt,
  }));
}

// ── Favoritos de series (episodios EZTV) ─────────────────────────────────────

// Guarda un episodio con su magnet y todo el contexto. `t` es el torrent
// normalizado de eztv.js, con showTitle/showImage opcionales (de IMDb cuando
// se buscó). La imagen guardada es el screenshot de EZTV o, si no hay,
// el poster de la serie.
async function addSeries(t) {
  await ensure();
  if (!t || !t.id || !t.title || !t.magnet) throw new Error('torrent inválido');

  const imageUrl = [t.screenshot, t.showImage].find((u) => u && /^https?:\/\//i.test(u)) || null;
  let image = null, imageMime = null;
  if (imageUrl) {
    try {
      const img = await getBytes(imageUrl);
      if (img.buf.length > 0 && img.buf.length < 3 * 1024 * 1024) {
        image = img.buf;
        imageMime = img.mime;
      }
    } catch {} // sin imagen: el favorito igual se guarda
  }

  const fav = {
    id: Number(t.id), title: String(t.title), filename: t.filename || '',
    imdbId: t.imdbId || null, showTitle: t.showTitle || null,
    season: t.season == null ? null : Number(t.season),
    episode: t.episode == null ? null : Number(t.episode),
    quality: t.quality || '', size: t.size || '',
    sizeBytes: t.sizeBytes == null ? null : Number(t.sizeBytes),
    seeds: t.seeds == null ? null : Number(t.seeds),
    peers: t.peers == null ? null : Number(t.peers),
    magnet: String(t.magnet),
    imageUrl, image, imageMime,
    releasedAt: t.releasedAt == null ? null : Number(t.releasedAt),
    addedAt: Date.now(),
  };

  writeSeriesRow(fav);
  persist();
  try {
    const cols = await favCols();
    if (cols) await cols.series.updateOne({ _id: fav.id }, { $set: sfavToDoc(fav) }, { upsert: true });
  } catch (e) { console.warn('[favorites] mongo upsert (series) failed:', e.message); }
}

async function removeSeries(torrentId) {
  await ensure();
  db.run('DELETE FROM series_favorites WHERE id = ?', [Number(torrentId)]);
  persist();
  try {
    const cols = await favCols();
    if (cols) await cols.series.deleteOne({ _id: Number(torrentId) });
  } catch (e) { console.warn('[favorites] mongo delete (series) failed:', e.message); }
}

async function getSeriesIds() {
  await ensure();
  const stmt = db.prepare('SELECT id FROM series_favorites');
  const ids = [];
  while (stmt.step()) ids.push(stmt.getAsObject().id);
  stmt.free();
  return ids;
}

// Listado completo (espejo local, más reciente primero) en la misma forma
// normalizada que eztv.js para que el renderer reuse su vista tal cual.
async function listSeries() {
  await ensure();
  return readSeriesRows().map((f) => ({
    id: f.id, title: f.title, filename: f.filename,
    imdbId: f.imdbId, showTitle: f.showTitle,
    season: f.season, episode: f.episode,
    quality: f.quality, size: f.size, sizeBytes: f.sizeBytes,
    seeds: f.seeds, peers: f.peers,
    magnet: f.magnet,
    screenshot: f.image
      ? `data:${f.imageMime || 'image/jpeg'};base64,${f.image.toString('base64')}`
      : (f.imageUrl || null),
    releasedAt: f.releasedAt, addedAt: f.addedAt,
  }));
}

// Re-reconciliación manual (la dispara "Sincronizar bases" en Settings,
// junto con la de Finanzas). Best-effort: sin Mongo queda como estaba.
async function syncNow() {
  await ensure();
  await reconcile();
}

module.exports = {
  add, remove, getIds, list,
  addSeries, removeSeries, getSeriesIds, listSeries,
  syncNow,
};
