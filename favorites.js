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
//
// Una película es UN favorito aunque esté en YIFY y en LimeTorrents con ids
// distintos: se unen por imdb (columna `imdb`). El ♥ desde cualquiera de las
// dos fuentes cae en el mismo registro, y sus torrents llevan el origen de
// cada uno (`source` en cada torrent) para que la ficha muestre ambos. El
// cruce con la otra fuente (archivos locales / API) lo hace favSources.js.

const path = require('path');
const https = require('https');
const mongo = require('./finances/mongo');
const sqliteFile = require('./sqliteFile');
const { FAV_DELETIONS, tombId, tombDoc, splitTombstoned, remoteTombstoned } = require('./favSync');

const DB_PATH = path.join(__dirname, 'favorites.sqlite');
const WASM_PATH = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
const COLLECTION = 'favorites';            // películas (YIFY)
const SERIES_COLLECTION = 'series_favorites';  // episodios (EZTV)
const FOLDERS_COLLECTION = 'fav_folders';  // carpetas de películas favoritas

let db = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS favorites (
    id        INTEGER PRIMARY KEY,        -- id de YIFY, o negativo para LimeTorrents (= _id en Mongo)
    source    TEXT,                       -- 'yify' | 'lime' (NULL = yify, favoritos viejos)
    imdb      TEXT,                       -- ttNNNNNNN en minúscula: une la misma película entre YIFY y Lime
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
    folder_id INTEGER,                    -- carpeta contenedora (NULL = raíz)
    added_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS fav_folders (
    id        INTEGER PRIMARY KEY,        -- = _id en Mongo (Date.now() al crear)
    name      TEXT    NOT NULL,
    parent_id INTEGER,                    -- carpeta contenedora (NULL = raíz)
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
  if (!readyPromise) {
    const p = readyPromise = (async () => {
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs({ locateFile: (f) => path.join(WASM_PATH, f) });
      // Un archivo dañado (p. ej. en cero tras un apagado inesperado) se aparta
      // y se arranca de cero: reconcile() lo vuelve a llenar desde Mongo.
      db = sqliteFile.openDatabase(SQL, DB_PATH);
      db.run(SCHEMA);
      migrate();
      persist();
      await reconcile();   // nunca tira: sin Mongo queda SQLite-only
    })();
    // Un fallo al abrir no queda cacheado para toda la sesión: la próxima
    // llamada reintenta en vez de dejar la sección vacía en silencio.
    p.catch(() => { if (readyPromise === p) readyPromise = null; });
  }
  return readyPromise;
}

// Migraciones sobre bases ya creadas: CREATE TABLE IF NOT EXISTS no agrega
// columnas nuevas a una tabla vieja, así que folder_id se añade a mano.
function migrate() {
  const colsOf = (t) => {
    const res = db.exec(`PRAGMA table_info(${t})`);
    return res.length ? res[0].values.map((r) => r[1]) : [];
  };
  if (!colsOf('favorites').includes('folder_id')) db.run('ALTER TABLE favorites ADD COLUMN folder_id INTEGER');
  if (!colsOf('favorites').includes('source')) db.run('ALTER TABLE favorites ADD COLUMN source TEXT');
  if (!colsOf('favorites').includes('imdb')) db.run('ALTER TABLE favorites ADD COLUMN imdb TEXT');
  if (!colsOf('fav_folders').includes('parent_id')) db.run('ALTER TABLE fav_folders ADD COLUMN parent_id INTEGER');
  db.run('CREATE INDEX IF NOT EXISTS idx_fav_imdb ON favorites(imdb)');
}

// Volcado atómico (tmp + fsync + rename): nunca deja el archivo a medias.
function persist() {
  if (db) sqliteFile.writeAtomicSync(DB_PATH, Buffer.from(db.export()));
}

async function favCols() {
  if (!mongo.isEnabled()) return null;
  const dbh = await mongo.connect();   // null si el cluster no responde
  return dbh
    ? {
        movies: dbh.collection(COLLECTION),
        series: dbh.collection(SERIES_COLLECTION),
        folders: dbh.collection(FOLDERS_COLLECTION),
        deletions: dbh.collection(FAV_DELETIONS),
      }
    : null;
}

// Tombstones (ver favSync.js): un borrado deja su marca para que reconcile()
// no lo resucite desde otro espejo; volver a agregar la quita. Best-effort,
// como el resto de las escrituras a Mongo.
async function tomb(cols, kind, ids) {
  if (!cols || !ids.length) return;
  const now = Date.now();
  await cols.deletions.bulkWrite(ids.map((id) => ({
    replaceOne: { filter: { _id: tombId(kind, id) }, replacement: tombDoc(kind, id, now), upsert: true },
  })), { ordered: false });
}

async function untomb(cols, kind, ids) {
  if (!cols || !ids.length) return;
  await cols.deletions.deleteMany({ _id: { $in: ids.map((id) => tombId(kind, id)) } });
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

// Código IMDb normalizado ("tt0076759") de una película o favorito, o null.
// Sale de `imdb` (YIFY y grupos de Lime) o, en favoritos viejos de Lime que
// solo guardaron la URL, de esa URL.
function imdbOf(m) {
  if (!m) return null;
  const direct = String(m.imdb || '').trim().toLowerCase();
  if (/^tt\d+$/.test(direct)) return direct;
  const mm = /imdb\.com\/title\/(tt\d+)/i.exec(`${m.imdbUrl || ''} ${m.url || ''}`);
  return mm ? mm[1].toLowerCase() : null;
}

const SOURCE_ORDER = ['yify', 'lime'];

// Cada torrent lleva su origen; los guardados antes de existir el campo
// heredan el del favorito.
function tagTorrents(list, source) {
  const def = source === 'lime' ? 'lime' : 'yify';
  return (Array.isArray(list) ? list : [])
    .filter((t) => t && typeof t === 'object')
    .map((t) => ({ ...t, source: SOURCE_ORDER.includes(t.source) ? t.source : def }));
}

// Orígenes presentes en un favorito (el principal + los de sus torrents).
function sourcesOf(f) {
  const s = new Set([f.source === 'lime' ? 'lime' : 'yify']);
  for (const t of f.torrents || []) if (t && t.source) s.add(t.source);
  return SOURCE_ORDER.filter((x) => s.has(x));
}

// Une torrents por origen: los de `fresh` reemplazan a los de `base` del
// mismo origen; los otros orígenes de `base` quedan. Sin repetidos (mismo
// magnet/hash) y ordenados YIFY → Lime.
function overlayTorrents(base, fresh) {
  const inc = Array.isArray(fresh) ? fresh : [];
  const srcs = new Set(inc.map((t) => t.source));
  const all = [...(base || []).filter((t) => t && !srcs.has(t.source)), ...inc];
  const seen = new Set();
  const out = [];
  for (const t of all) {
    const key = `${t.source}|${t.magnet || t.hash || t.url || `${t.quality}|${t.size}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
}

// Primer valor "con contenido" (ni null, ni '', ni array vacío).
const first = (...vals) => vals.find((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length)) ?? null;

function rowToFav(r) {
  const source = r.source === 'lime' ? 'lime' : 'yify';
  return {
    id: r.id, source, imdb: r.imdb || null, title: r.title,
    year: r.year ?? null, rating: r.rating ?? null, runtime: r.runtime ?? null,
    genres: parse(r.genres, []), synopsis: r.synopsis || '',
    trailer: r.trailer || null, url: r.url || null,
    coverUrl: r.cover_url || null, cover: toBuf(r.cover), coverMime: r.cover_mime || null,
    cast: parse(r.cast, []), torrents: tagTorrents(parse(r.torrents, []), source),
    folderId: r.folder_id ?? null,
    addedAt: r.added_at,
  };
}

function docToFav(d) {
  const source = d.source === 'lime' ? 'lime' : 'yify';
  return {
    id: Number(d._id), source, imdb: d.imdb || null, title: d.title,
    year: d.year ?? null, rating: d.rating ?? null, runtime: d.runtime ?? null,
    genres: Array.isArray(d.genres) ? d.genres : [], synopsis: d.synopsis || '',
    trailer: d.trailer || null, url: d.url || null,
    coverUrl: d.cover_url || null, cover: toBuf(d.cover), coverMime: d.cover_mime || null,
    cast: Array.isArray(d.cast) ? d.cast : [], torrents: tagTorrents(d.torrents, source),
    folderId: d.folder_id ?? null,
    addedAt: d.added_at || Date.now(),
  };
}

// Doc Mongo: arrays como arrays de verdad y la portada como BSON Binary
// (el driver serializa el Buffer solo). _id = id de YIFY (o el negativo de Lime).
function favToDoc(f) {
  return {
    _id: f.id, source: f.source || 'yify', imdb: f.imdb || null, title: f.title,
    year: f.year, rating: f.rating, runtime: f.runtime,
    genres: f.genres, synopsis: f.synopsis,
    trailer: f.trailer, url: f.url,
    cover_url: f.coverUrl, cover: f.cover, cover_mime: f.coverMime,
    cast: f.cast, torrents: f.torrents,
    folder_id: f.folderId ?? null,
    added_at: f.addedAt,
  };
}

function writeRow(f) {
  db.run(
    'INSERT OR REPLACE INTO favorites ' +
    '(id, source, imdb, title, year, rating, runtime, genres, synopsis, trailer, url, cover_url, cover, cover_mime, cast, torrents, folder_id, added_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      Number(f.id), f.source || 'yify', f.imdb || null, String(f.title),
      f.year == null ? null : Number(f.year),
      f.rating == null ? null : Number(f.rating),
      f.runtime == null ? null : Number(f.runtime),
      JSON.stringify(f.genres || []), f.synopsis || '',
      f.trailer || null, f.url || null,
      f.coverUrl || null, f.cover, f.coverMime || null,
      JSON.stringify(f.cast || []), JSON.stringify(f.torrents || []),
      f.folderId == null ? null : Number(f.folderId),
      Number(f.addedAt),
    ]
  );
}

function findById(id) {
  const stmt = db.prepare('SELECT * FROM favorites WHERE id = ?');
  stmt.bind([Number(id)]);
  const f = stmt.step() ? rowToFav(stmt.getAsObject()) : null;
  stmt.free();
  return f;
}

function findByImdb(imdb) {
  if (!imdb) return null;
  const stmt = db.prepare('SELECT * FROM favorites WHERE imdb = ? ORDER BY added_at ASC');
  stmt.bind([String(imdb)]);
  const f = stmt.step() ? rowToFav(stmt.getAsObject()) : null;
  stmt.free();
  return f;
}

function readRows() {
  const stmt = db.prepare('SELECT * FROM favorites ORDER BY added_at DESC');
  const rows = [];
  while (stmt.step()) rows.push(rowToFav(stmt.getAsObject()));
  stmt.free();
  return rows;
}

// ── Carpetas de películas ────────────────────────────────────────────────────
// Folder canónico: { id, name, addedAt }. _id en Mongo = id numérico.

function rowToFolder(r) { return { id: r.id, name: r.name, parentId: r.parent_id ?? null, addedAt: r.added_at }; }
function docToFolder(d) { return { id: Number(d._id), name: d.name || '', parentId: d.parent_id ?? null, addedAt: d.added_at || Date.now() }; }
function folderToDoc(f) { return { _id: f.id, name: f.name, parent_id: f.parentId ?? null, added_at: f.addedAt }; }

function writeFolderRow(f) {
  db.run(
    'INSERT OR REPLACE INTO fav_folders (id, name, parent_id, added_at) VALUES (?, ?, ?, ?)',
    [Number(f.id), String(f.name), f.parentId == null ? null : Number(f.parentId), Number(f.addedAt)]
  );
}

function readFolderRows() {
  const stmt = db.prepare('SELECT * FROM fav_folders ORDER BY added_at ASC');
  const rows = [];
  while (stmt.step()) rows.push(rowToFolder(stmt.getAsObject()));
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

// ── Reconciliación (arranque + periódica) ────────────────────────────────────
// Sube los favoritos que Mongo no tiene ($setOnInsert preserva lo creado
// offline sin pisar lo remoto) y baja lo remoto con merge: writeRow es
// INSERT OR REPLACE, así que lo remoto actualiza filas con el mismo id. Lo
// único que se borra es lo que tiene tombstone en `fav_deletions` (borrado
// desde otro dispositivo): esas filas locales se van en vez de resubirse.
// Una base recién instalada baja todo; una Mongo vacía recibe todo lo local.
// Cubre películas (YIFY + LimeTorrents), episodios (EZTV) y carpetas.
//
// Corre al arrancar y cada pocos minutos (main.js), así que baja los docs sin
// portadas y pide aparte solo las que el espejo todavía no tiene. Devuelve
// `changed` para que el renderer repinte solo si algo cambió. Dos llamadas a
// la vez comparten la misma pasada.
let reconciling = null;
function reconcile() {
  if (!reconciling) {
    reconciling = reconcileOnce().finally(() => { reconciling = null; });
  }
  return reconciling;
}

// Firma de las tres tablas sin los binarios: alcanza para saber si cambió algo.
function signature() {
  const lite = (rows, bin) => JSON.stringify(rows.map((r) => ({ ...r, [bin]: r[bin] ? r[bin].length : 0 })));
  return lite(readRows(), 'cover') + lite(readSeriesRows(), 'image') + JSON.stringify(readFolderRows());
}

async function reconcileOnce() {
  try {
    const cols = await favCols();
    if (!cols) return null;
    const before = signature();
    const tombs = await cols.deletions.find({}).toArray();
    const movies = splitTombstoned(readRows(), tombs, 'movie');
    const series = splitTombstoned(readSeriesRows(), tombs, 'series');
    const folders = splitTombstoned(readFolderRows(), tombs, 'folder');
    if (movies.drop.length || series.drop.length || folders.drop.length) {
      movies.drop.forEach((id) => db.run('DELETE FROM favorites WHERE id = ?', [id]));
      series.drop.forEach((id) => db.run('DELETE FROM series_favorites WHERE id = ?', [id]));
      folders.drop.forEach((id) => db.run('DELETE FROM fav_folders WHERE id = ?', [id]));
    }
    // Re-altas posteriores al borrado (p. ej. hechas sin conexión): se quedan,
    // se suben y pierden la marca.
    await untomb(cols, 'movie', movies.revived);
    await untomb(cols, 'series', series.revived);
    await untomb(cols, 'folder', folders.revived);
    const seedUp = async (col, locals, toDoc) => {
      if (!locals.length) return;
      await col.bulkWrite(locals.map((f) => ({
        updateOne: { filter: { _id: f.id }, update: { $setOnInsert: toDoc(f) }, upsert: true },
      })), { ordered: false });
    };
    await seedUp(cols.movies, movies.keep, favToDoc);
    await seedUp(cols.series, series.keep, sfavToDoc);
    await seedUp(cols.folders, folders.keep, folderToDoc);
    const fetched = await Promise.all([
      cols.movies.find({}, { projection: { cover: 0 } }).toArray(),
      cols.series.find({}, { projection: { image: 0 } }).toArray(),
      cols.folders.find({}).toArray(),
    ]);
    // Docs vivos con tombstone (un borrado que se cruzó con un $setOnInsert
    // de otro dispositivo): se terminan de borrar y no bajan al espejo.
    const [movieDocs, seriesDocs, folderDocs] = await Promise.all(
      [[cols.movies, 'movie'], [cols.series, 'series'], [cols.folders, 'folder']].map(async ([col, kind], i) => {
        const { dead, revived } = remoteTombstoned(fetched[i], tombs, kind);
        await untomb(cols, kind, revived);
        if (!dead.length) return fetched[i];
        await col.deleteMany({ _id: { $in: dead } });
        const gone = new Set(dead);
        return fetched[i].filter((d) => !gone.has(Number(d._id)));
      }));
    // Binarios: se conservan los del espejo y se bajan solo los que faltan.
    const localMovies = new Map(readRows().map((f) => [f.id, f]));
    const localSeries = new Map(readSeriesRows().map((f) => [f.id, f]));
    const missingCovers = movieDocs.map((d) => Number(d._id)).filter((id) => !(localMovies.get(id) || {}).cover);
    const missingImages = seriesDocs.map((d) => Number(d._id)).filter((id) => !(localSeries.get(id) || {}).image);
    const [coverDocs, imageDocs] = await Promise.all([
      missingCovers.length
        ? cols.movies.find({ _id: { $in: missingCovers }, cover: { $ne: null } }, { projection: { cover: 1, cover_mime: 1 } }).toArray()
        : [],
      missingImages.length
        ? cols.series.find({ _id: { $in: missingImages }, image: { $ne: null } }, { projection: { image: 1, image_mime: 1 } }).toArray()
        : [],
    ]);
    const covers = new Map(coverDocs.map((d) => [Number(d._id), d]));
    const images = new Map(imageDocs.map((d) => [Number(d._id), d]));
    db.run('BEGIN TRANSACTION');
    try {
      folderDocs.forEach((d) => writeFolderRow(docToFolder(d)));
      movieDocs.forEach((d) => {
        const id = Number(d._id);
        const local = localMovies.get(id);
        const bin = covers.get(id);
        const f = docToFav(bin ? { ...d, cover: bin.cover, cover_mime: bin.cover_mime } : d);
        if (!bin && local && local.cover) { f.cover = local.cover; f.coverMime = local.coverMime; }
        // Un doc remoto sin imdb (guardado antes de la columna) no borra el
        // que ya se completó acá.
        if (!f.imdb) f.imdb = (local && local.imdb) || null;
        writeRow(f);
      });
      seriesDocs.forEach((d) => {
        const id = Number(d._id);
        const local = localSeries.get(id);
        const bin = images.get(id);
        const f = docToSfav(bin ? { ...d, image: bin.image, image_mime: bin.image_mime } : d);
        if (!bin && local && local.image) { f.image = local.image; f.imageMime = local.imageMime; }
        writeSeriesRow(f);
      });
      // Referencias a carpetas que no existen en el conjunto final (local ∪
      // remoto) vuelven a la raíz — evita huérfanos sin borrar películas.
      const ids = readFolderRows().map((f) => Number(f.id));
      const inList = ids.length ? ids.join(',') : '0';
      db.run(`UPDATE favorites SET folder_id = NULL WHERE folder_id IS NOT NULL AND folder_id NOT IN (${inList})`);
      db.run(`UPDATE fav_folders SET parent_id = NULL WHERE parent_id IS NOT NULL AND parent_id NOT IN (${inList})`);
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
    persist();
    const changed = signature() !== before;
    console.log(`[favorites] synced with Mongo: ${movieDocs.length} películas, ${seriesDocs.length} series, ${folderDocs.length} carpetas${changed ? ' (con cambios)' : ''}`);
    return { changed, movies: movieDocs.length, series: seriesDocs.length, folders: folderDocs.length };
  } catch (e) {
    console.warn('[favorites] mongo sync failed, SQLite-only:', e.message);
    return null;
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
// o un grupo de limetorrents.js — idealmente ya enriquecido (ficha completa y
// torrents de la otra fuente, ver favSources.complement); la portada se baja
// acá. Si la misma película ya está guardada (mismo id, o mismo imdb desde la
// otra fuente) se funde en ese registro en vez de duplicarse: conserva id,
// carpeta y fecha; los torrents se unen por origen.
async function add(movie) {
  await ensure();
  if (!movie || !movie.id || !movie.title) throw new Error('película inválida');
  const source = movie.source === 'lime' ? 'lime' : 'yify';
  const imdb = imdbOf(movie);
  const existing = findById(Number(movie.id)) || findByImdb(imdb);
  const sameId = !!existing && existing.id === Number(movie.id);

  const incoming = {
    id: Number(movie.id), source, imdb,
    title: String(movie.title),
    year: movie.year == null ? null : Number(movie.year),
    rating: movie.rating == null ? null : Number(movie.rating),
    runtime: movie.runtime == null ? null : Number(movie.runtime),
    genres: Array.isArray(movie.genres) ? movie.genres : [],
    synopsis: movie.synopsis || '',
    trailer: movie.trailer || null, url: movie.url || null,
    coverUrl: (movie.cover && /^https?:\/\//i.test(movie.cover)) ? movie.cover : null,
    cover: null, coverMime: null,
    cast: Array.isArray(movie.cast) ? movie.cast : [],
    torrents: tagTorrents(movie.torrents, source),
  };

  // Portada: la ya guardada sirve; si no hay, se baja la de la película.
  let cover = existing ? existing.cover : null;
  let coverMime = existing ? existing.coverMime : null;
  if (!cover && incoming.coverUrl) {
    try {
      const img = await getBytes(incoming.coverUrl);
      if (img.buf.length > 0 && img.buf.length < 3 * 1024 * 1024) {
        cover = img.buf;
        coverMime = img.mime;
      }
    } catch {} // sin imagen: el favorito igual se guarda
  }

  // Re-guardar con el mismo id refresca la ficha; fundir por imdb desde la
  // otra fuente respeta la ficha que ya estaba y solo completa huecos.
  const primary = (!existing || sameId) ? incoming : existing;
  const filler = (!existing || sameId) ? (existing || {}) : incoming;
  const fav = {
    id: existing ? existing.id : incoming.id,
    source: existing ? existing.source : source,
    imdb: imdb || (existing && existing.imdb) || null,
    title: first(primary.title, filler.title),
    year: first(primary.year, filler.year),
    rating: first(primary.rating, filler.rating),
    runtime: first(primary.runtime, filler.runtime),
    genres: first(primary.genres, filler.genres) || [],
    synopsis: first(primary.synopsis, filler.synopsis) || '',
    trailer: first(primary.trailer, filler.trailer),
    url: first(primary.url, filler.url),
    coverUrl: first(existing && existing.cover ? existing.coverUrl : null, incoming.coverUrl, existing && existing.coverUrl),
    cover, coverMime,
    cast: first(primary.cast, filler.cast) || [],
    torrents: existing ? overlayTorrents(existing.torrents, incoming.torrents) : incoming.torrents,
    folderId: movie.folderId != null ? Number(movie.folderId) : (existing ? existing.folderId : null),
    addedAt: existing ? existing.addedAt : Date.now(),
  };

  writeRow(fav);
  persist();
  try {
    const cols = await favCols();
    if (cols) {
      await cols.movies.updateOne({ _id: fav.id }, { $set: favToDoc(fav) }, { upsert: true });
      await untomb(cols, 'movie', [...new Set([fav.id, incoming.id])]);
    }
  } catch (e) { console.warn('[favorites] mongo upsert failed:', e.message); }
  // Si además había otro registro con el mismo imdb (duplicado viejo), se funde ya.
  if (fav.imdb) await dedupeByImdb(fav.imdb);
  return { id: fav.id };
}

// Quita la película de favoritos. `key` es el id o `{ id, imdb }`: el ♥ puede
// apretarse desde la otra fuente (otro id) y el favorito se reconoce por imdb.
async function remove(key) {
  await ensure();
  const isObj = key && typeof key === 'object';
  const id = Number(isObj ? key.id : key);
  const imdb = isObj ? imdbOf(key) : null;
  const ids = new Set();
  if (Number.isFinite(id)) ids.add(id);
  const stmt = db.prepare('SELECT id FROM favorites WHERE imdb = ?');
  stmt.bind([imdb || '']);
  while (stmt.step()) ids.add(stmt.getAsObject().id);
  stmt.free();
  for (const x of ids) db.run('DELETE FROM favorites WHERE id = ?', [x]);
  persist();
  try {
    const cols = await favCols();
    if (cols && ids.size) {
      await cols.movies.deleteMany({ _id: { $in: [...ids] } });
      await tomb(cols, 'movie', [...ids]);
    }
  } catch (e) { console.warn('[favorites] mongo delete failed:', e.message); }
}

// Ids e imdb ids de los favoritos — el renderer pinta los corazones con ambos
// (el imdb hace que el ♥ se vea en YIFY y en Lime a la vez).
async function getKeys() {
  await ensure();
  const stmt = db.prepare('SELECT id, imdb FROM favorites');
  const ids = [], imdbs = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    ids.push(r.id);
    if (r.imdb) imdbs.push(r.imdb);
  }
  stmt.free();
  return { ids, imdbs };
}

// Listado completo (espejo local, más reciente primero) en la misma forma
// normalizada que yify.js para que el renderer reuse sus vistas tal cual.
// La portada sale del BLOB como data URL; si no se pudo bajar, queda la URL.
// `sources` dice de qué fuentes hay torrents (YIFY, Lime o ambas).
async function list() {
  await ensure();
  return readRows().map((f) => ({
    id: f.id, source: f.source, sources: sourcesOf(f), imdb: f.imdb,
    title: f.title, year: f.year, rating: f.rating, runtime: f.runtime,
    genres: f.genres, synopsis: f.synopsis, trailer: f.trailer, url: f.url,
    cover: f.cover
      ? `data:${f.coverMime || 'image/jpeg'};base64,${f.cover.toString('base64')}`
      : (f.coverUrl || null),
    cast: f.cast, torrents: f.torrents,
    folderId: f.folderId,
    addedAt: f.addedAt,
  }));
}

// Listado sin portadas (para las pasadas de mantenimiento de favSources.js).
async function listLite() {
  await ensure();
  return readRows().map(({ cover, coverMime, ...f }) => ({ ...f, hasCover: !!cover }));
}

// Actualiza campos sueltos de un favorito (imdb, torrents, ficha) en las dos
// bases. Los torrents se reemplazan tal cual vienen (el caller los une con
// overlayTorrents). La portada no se toca ni se resube.
async function patch(id, changes) {
  await ensure();
  const cur = findById(id);
  if (!cur) return null;
  const fav = { ...cur, ...changes, id: cur.id, cover: cur.cover, coverMime: cur.coverMime };
  if ('torrents' in changes) fav.torrents = tagTorrents(changes.torrents, fav.source);
  writeRow(fav);
  persist();
  try {
    const cols = await favCols();
    if (cols) {
      const doc = favToDoc(fav);
      delete doc._id; delete doc.cover; delete doc.cover_mime;
      await cols.movies.updateOne({ _id: fav.id }, { $set: doc });
    }
  } catch (e) { console.warn('[favorites] mongo patch failed:', e.message); }
  return fav;
}

// Funde favoritos repetidos (la misma película guardada desde YIFY y desde
// Lime con ids distintos, antes de que existiera la unión por imdb). Manda el
// de YIFY (ficha completa); entre iguales, el más antiguo. Se unen los
// torrents por origen, se conserva la carpeta del que la tuviera y el sobrante
// se borra en las dos bases. `onlyImdb` limita la pasada a una película.
async function dedupeByImdb(onlyImdb = null) {
  await ensure();
  const groups = new Map();
  for (const f of readRows()) {
    if (!f.imdb || (onlyImdb && f.imdb !== onlyImdb)) continue;
    if (!groups.has(f.imdb)) groups.set(f.imdb, []);
    groups.get(f.imdb).push(f);
  }
  const removed = [];
  const kept = [];
  for (const favs of groups.values()) {
    if (favs.length < 2) continue;
    favs.sort((a, b) => (a.source === 'yify' ? 0 : 1) - (b.source === 'yify' ? 0 : 1) || a.addedAt - b.addedAt);
    let fav = favs[0];
    for (const r of favs.slice(1)) {
      fav = {
        ...fav,
        title: first(fav.title, r.title), year: first(fav.year, r.year),
        rating: first(fav.rating, r.rating), runtime: first(fav.runtime, r.runtime),
        genres: first(fav.genres, r.genres) || [], synopsis: first(fav.synopsis, r.synopsis) || '',
        trailer: first(fav.trailer, r.trailer), url: first(fav.url, r.url),
        coverUrl: fav.cover ? fav.coverUrl : first(r.coverUrl, fav.coverUrl),
        cover: fav.cover || r.cover, coverMime: fav.cover ? fav.coverMime : r.coverMime,
        cast: first(fav.cast, r.cast) || [],
        torrents: overlayTorrents(r.torrents, fav.torrents),
        folderId: fav.folderId ?? r.folderId ?? null,
        addedAt: Math.min(fav.addedAt, r.addedAt),
      };
      db.run('DELETE FROM favorites WHERE id = ?', [r.id]);
      removed.push(r.id);
    }
    writeRow(fav);
    kept.push(fav);
  }
  if (!removed.length) return { merged: 0, removed: 0 };
  persist();
  try {
    const cols = await favCols();
    if (cols) {
      for (const fav of kept) await cols.movies.updateOne({ _id: fav.id }, { $set: favToDoc(fav) }, { upsert: true });
      await cols.movies.deleteMany({ _id: { $in: removed } });
      await tomb(cols, 'movie', removed);
    }
  } catch (e) { console.warn('[favorites] mongo dedupe failed:', e.message); }
  return { merged: kept.length, removed: removed.length };
}

// ── Carpetas: API pública ────────────────────────────────────────────────────

async function listFolders() {
  await ensure();
  return readFolderRows();
}

// Crea una carpeta (opcionalmente dentro de otra) y devuelve su registro. El id
// es un timestamp (único de sobra para un widget personal) que sirve de _id en
// Mongo. parentId null = carpeta en la raíz.
async function createFolder(name, parentId = null) {
  await ensure();
  const clean = String(name || '').trim();
  if (!clean) throw new Error('nombre vacío');
  const folder = { id: Date.now(), name: clean, parentId: parentId == null ? null : Number(parentId), addedAt: Date.now() };
  writeFolderRow(folder);
  persist();
  try {
    const cols = await favCols();
    if (cols) {
      await cols.folders.updateOne({ _id: folder.id }, { $set: folderToDoc(folder) }, { upsert: true });
      await untomb(cols, 'folder', [folder.id]);
    }
  } catch (e) { console.warn('[favorites] mongo folder create failed:', e.message); }
  return folder;
}

async function renameFolder(folderId, name) {
  await ensure();
  const clean = String(name || '').trim();
  if (!clean) throw new Error('nombre vacío');
  db.run('UPDATE fav_folders SET name = ? WHERE id = ?', [clean, Number(folderId)]);
  persist();
  try {
    const cols = await favCols();
    if (cols) await cols.folders.updateOne({ _id: Number(folderId) }, { $set: { name: clean } });
  } catch (e) { console.warn('[favorites] mongo folder rename failed:', e.message); }
}

// Borra la carpeta y devuelve su contenido a la RAÍZ: las películas que tenía
// adentro y sus subcarpetas quedan sueltas en el nivel superior. Nunca se borra
// una película de favoritos — solo se elimina la carpeta en sí.
async function deleteFolder(folderId) {
  await ensure();
  const fid = Number(folderId);
  db.run('UPDATE favorites SET folder_id = NULL WHERE folder_id = ?', [fid]);
  db.run('UPDATE fav_folders SET parent_id = NULL WHERE parent_id = ?', [fid]);
  db.run('DELETE FROM fav_folders WHERE id = ?', [fid]);
  persist();
  try {
    const cols = await favCols();
    if (cols) {
      await cols.movies.updateMany({ folder_id: fid }, { $set: { folder_id: null } });
      await cols.folders.updateMany({ parent_id: fid }, { $set: { parent_id: null } });
      await cols.folders.deleteOne({ _id: fid });
      await tomb(cols, 'folder', [fid]);
    }
  } catch (e) { console.warn('[favorites] mongo folder delete failed:', e.message); }
}

// Mueve una película a una carpeta (folderId null = raíz).
async function moveToFolder(movieId, folderId) {
  await ensure();
  const mid = Number(movieId);
  const fid = folderId == null ? null : Number(folderId);
  db.run('UPDATE favorites SET folder_id = ? WHERE id = ?', [fid, mid]);
  persist();
  try {
    const cols = await favCols();
    if (cols) await cols.movies.updateOne({ _id: mid }, { $set: { folder_id: fid } });
  } catch (e) { console.warn('[favorites] mongo move failed:', e.message); }
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
    if (cols) {
      await cols.series.updateOne({ _id: fav.id }, { $set: sfavToDoc(fav) }, { upsert: true });
      await untomb(cols, 'series', [fav.id]);
    }
  } catch (e) { console.warn('[favorites] mongo upsert (series) failed:', e.message); }
}

async function removeSeries(torrentId) {
  await ensure();
  db.run('DELETE FROM series_favorites WHERE id = ?', [Number(torrentId)]);
  persist();
  try {
    const cols = await favCols();
    if (cols) {
      await cols.series.deleteOne({ _id: Number(torrentId) });
      await tomb(cols, 'series', [Number(torrentId)]);
    }
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
  return reconcile();
}

module.exports = {
  add, remove, getKeys, list, listLite, patch, dedupeByImdb,
  imdbOf, tagTorrents, overlayTorrents,
  listFolders, createFolder, renameFolder, deleteFolder, moveToFolder,
  addSeries, removeSeries, getSeriesIds, listSeries,
  syncNow,
};
