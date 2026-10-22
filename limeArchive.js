// Archivo histórico de los feeds RSS de LimeTorrents (main process).
//
// El RSS solo expone los últimos ~50 releases por categoría: lo que sale del
// feed se pierde. Cada fetch se archiva acá — SQLite local (lime.sqlite) +
// Mongo (colección lime_releases, misma base que Finanzas) — y las vistas del
// widget listan el histórico en vez del feed vivo, así la paginación crece
// con el tiempo. Para películas la fila guarda también el enriquecimiento de
// IMDb (nombre parseado, ficha, poster) para no repetir esos pedidos nunca.
//
// El sync es SIEMPRE aditivo y nunca borra nada de ningún lado: al ingerir se
// sube a Mongo con upsert, y syncNow() (arranque + periódico) sube lo local
// que a Mongo le falte ($setOnInsert) y baja lo remoto que falte acá
// (INSERT OR IGNORE). Una instalación nueva baja todo el histórico en vez de
// arrancar vacía. Incremental por added_at (con margen) para no mover todo
// el archivo en cada pasada.

const path = require('path');
const mongo = require('./finances/mongo');
const sqliteFile = require('./sqliteFile');

const DB_PATH = path.join(__dirname, 'lime.sqlite');
const WASM_PATH = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
const COLLECTION = 'lime_releases';
const SYNC_MARGIN_MS = 6 * 60 * 60 * 1000;   // solapamiento incremental (6 h)

let db = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS lime_releases (
    id          INTEGER PRIMARY KEY,   -- id numérico de la página del torrent (= _id en Mongo)
    cat         TEXT    NOT NULL,      -- movies | tv | games
    title       TEXT    NOT NULL,
    page        TEXT,
    quality     TEXT,
    size        TEXT,
    size_bytes  INTEGER,
    seeds       INTEGER,
    peers       INTEGER,
    hash        TEXT,
    torrent_url TEXT,
    magnet      TEXT,
    released_at INTEGER,
    name        TEXT,                  -- películas: nombre parseado del release
    year        INTEGER,
    imdb        TEXT,                  -- películas: ficha de IMDb (si hubo match)
    imdb_title  TEXT,
    imdb_year   INTEGER,
    cover       TEXT,
    added_at    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lime_cat_rel ON lime_releases(cat, released_at DESC);
  CREATE INDEX IF NOT EXISTS idx_lime_added ON lime_releases(added_at);
  CREATE INDEX IF NOT EXISTS idx_lime_imdb ON lime_releases(imdb);
`;

let readyPromise = null;
function ensure() {
  if (!readyPromise) {
    const p = readyPromise = (async () => {
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs({ locateFile: (f) => path.join(WASM_PATH, f) });
      // Un archivo dañado (p. ej. en cero tras un apagado inesperado) se aparta
      // y se arranca de cero: el sync con Mongo vuelve a bajar todo.
      db = sqliteFile.openDatabase(SQL, DB_PATH);
      db.run(SCHEMA);
      persist();
    })();
    // Un fallo al abrir no queda cacheado para toda la sesión.
    p.catch(() => { if (readyPromise === p) readyPromise = null; });
  }
  return readyPromise;
}

// Volcado atómico (tmp + fsync + rename): nunca deja el archivo a medias.
function persist() {
  if (db) sqliteFile.writeAtomicSync(DB_PATH, Buffer.from(db.export()));
}

async function col() {
  if (!mongo.isEnabled()) return null;
  const dbh = await mongo.connect();   // null si el cluster no responde
  return dbh ? dbh.collection(COLLECTION) : null;
}

function rowToRelease(r) {
  return {
    id: r.id, cat: r.cat, title: r.title,
    page: r.page || null, quality: r.quality || '',
    size: r.size || '', sizeBytes: r.size_bytes ?? null,
    seeds: r.seeds ?? null, peers: r.peers ?? null,
    hash: r.hash || null, torrentUrl: r.torrent_url || null,
    url: r.torrent_url || null,   // alias con la forma de los torrents de YIFY
    magnet: r.magnet || null,
    releasedAt: r.released_at ?? null,
    name: r.name || null, year: r.year ?? null,
    imdb: r.imdb || null, imdbTitle: r.imdb_title || null,
    imdbYear: r.imdb_year ?? null, cover: r.cover || null,
    addedAt: r.added_at,
  };
}

function releaseToDoc(t) {
  return {
    _id: t.id, cat: t.cat, title: t.title,
    page: t.page, quality: t.quality || '',
    size: t.size || '', size_bytes: t.sizeBytes ?? null,
    seeds: t.seeds ?? null, peers: t.peers ?? null,
    hash: t.hash || null, torrent_url: t.torrentUrl || null,
    magnet: t.magnet || null, released_at: t.releasedAt ?? null,
    name: t.name || null, year: t.year ?? null,
    imdb: t.imdb || null, imdb_title: t.imdbTitle || null,
    imdb_year: t.imdbYear ?? null, cover: t.cover || null,
    added_at: t.addedAt,
  };
}

function docToRelease(d) {
  return rowToRelease({
    id: Number(d._id), cat: d.cat, title: d.title,
    page: d.page, quality: d.quality, size: d.size, size_bytes: d.size_bytes,
    seeds: d.seeds, peers: d.peers, hash: d.hash, torrent_url: d.torrent_url,
    magnet: d.magnet, released_at: d.released_at,
    name: d.name, year: d.year, imdb: d.imdb, imdb_title: d.imdb_title,
    imdb_year: d.imdb_year, cover: d.cover,
    added_at: d.added_at || Date.now(),
  });
}

// Upsert local: inserta el release nuevo, o refresca los campos mutables
// (seeds/peers y el enriquecimiento si llegó ahora) de uno ya archivado —
// added_at y el resto quedan como estaban.
function writeRelease(t) {
  db.run(
    `INSERT INTO lime_releases
     (id, cat, title, page, quality, size, size_bytes, seeds, peers, hash, torrent_url, magnet, released_at,
      name, year, imdb, imdb_title, imdb_year, cover, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       seeds = excluded.seeds, peers = excluded.peers,
       name = COALESCE(excluded.name, name), year = COALESCE(excluded.year, year),
       imdb = COALESCE(excluded.imdb, imdb), imdb_title = COALESCE(excluded.imdb_title, imdb_title),
       imdb_year = COALESCE(excluded.imdb_year, imdb_year), cover = COALESCE(excluded.cover, cover)`,
    [
      Number(t.id), String(t.cat), String(t.title),
      t.page || null, t.quality || '', t.size || '',
      t.sizeBytes == null ? null : Number(t.sizeBytes),
      t.seeds == null ? null : Number(t.seeds),
      t.peers == null ? null : Number(t.peers),
      t.hash || null, t.torrentUrl || null, t.magnet || null,
      t.releasedAt == null ? null : Number(t.releasedAt),
      t.name || null, t.year == null ? null : Number(t.year),
      t.imdb || null, t.imdbTitle || null,
      t.imdbYear == null ? null : Number(t.imdbYear), t.cover || null,
      Number(t.addedAt || Date.now()),
    ]
  );
}

// Ids ya archivados de un lote (para enriquecer con IMDb solo los nuevos).
async function existingIds(ids) {
  await ensure();
  const found = new Set();
  if (!ids.length) return found;
  const stmt = db.prepare(`SELECT id FROM lime_releases WHERE id IN (${ids.map(() => '?').join(',')})`);
  stmt.bind(ids.map(Number));
  while (stmt.step()) found.add(stmt.getAsObject().id);
  stmt.free();
  return found;
}

// Filas completas de un lote de ids (para que la búsqueda reuse el
// enriquecimiento ya archivado en vez de repetir los pedidos a las APIs).
async function rowsByIds(ids) {
  await ensure();
  const map = new Map();
  const want = (ids || []).map(Number).filter(Boolean);
  if (!want.length) return map;
  const stmt = db.prepare(`SELECT * FROM lime_releases WHERE id IN (${want.map(() => '?').join(',')})`);
  stmt.bind(want);
  while (stmt.step()) {
    const r = rowToRelease(stmt.getAsObject());
    map.set(r.id, r);
  }
  stmt.free();
  return map;
}

// Archiva un lote del feed (releases con id numérico; los sin id se ignoran).
// Escribe SQLite y sube a Mongo best-effort — el archivo local nunca espera
// por la red.
async function ingest(cat, releases) {
  await ensure();
  const now = Date.now();
  const rows = (releases || []).filter((t) => t && t.id);
  if (!rows.length) return;
  for (const t of rows) writeRelease({ ...t, cat, addedAt: t.addedAt || now });
  persist();
  try {
    const c = await col();
    if (c) {
      await c.bulkWrite(rows.map((t) => {
        const doc = releaseToDoc({ ...t, cat, addedAt: t.addedAt || now });
        const { _id, added_at, ...mut } = doc;
        // added_at solo al insertar (conserva cuándo se vio por primera vez);
        // el resto se refresca (seeds/peers/enriquecimiento).
        return { updateOne: { filter: { _id }, update: { $set: mut, $setOnInsert: { added_at } }, upsert: true } };
      }), { ordered: false });
    }
  } catch (e) { console.warn('[limeArchive] mongo upsert failed:', e.message); }
}

// Histórico de una categoría, más reciente primero (por fecha del release).
// limit <= 0 (default) = todo el archivo. Recortarlo hace que los releases
// más viejos se caigan de la ventana y las películas/series/juegos que solo
// tenían esos releases desaparezcan del listado: el contador del pager bajaba
// solo con actualizar (237 → 233 películas).
async function list(cat, limit = 0) {
  await ensure();
  const cap = Number(limit) > 0;
  const stmt = db.prepare(
    `SELECT * FROM lime_releases WHERE cat = ? ORDER BY released_at DESC, id DESC${cap ? ' LIMIT ?' : ''}`);
  stmt.bind(cap ? [String(cat), Math.floor(Number(limit))] : [String(cat)]);
  const rows = [];
  while (stmt.step()) rows.push(rowToRelease(stmt.getAsObject()));
  stmt.free();
  return rows;
}

// Releases archivados de una película por su ficha de IMDb (cruce con un
// favorito de YIFY de la misma película). Más reciente primero.
async function byImdb(imdb, cat = 'movies') {
  await ensure();
  const code = String(imdb || '').trim().toLowerCase();
  if (!/^tt\d+$/.test(code)) return [];
  const stmt = db.prepare(
    'SELECT * FROM lime_releases WHERE cat = ? AND imdb = ? ORDER BY released_at DESC, id DESC');
  stmt.bind([String(cat), code]);
  const rows = [];
  while (stmt.step()) rows.push(rowToRelease(stmt.getAsObject()));
  stmt.free();
  return rows;
}

async function count(cat) {
  await ensure();
  const stmt = db.prepare('SELECT COUNT(*) AS n FROM lime_releases WHERE cat = ?');
  stmt.bind([String(cat)]);
  const n = stmt.step() ? stmt.getAsObject().n : 0;
  stmt.free();
  return n;
}

function localMaxAddedAt() {
  const stmt = db.prepare('SELECT MAX(added_at) AS m FROM lime_releases');
  const m = stmt.step() ? (stmt.getAsObject().m || 0) : 0;
  stmt.free();
  return m;
}

// Sync bidireccional aditivo con Mongo (arranque + periódico). Incremental:
// sube lo local más nuevo que lo que Mongo ya tiene y baja lo remoto más
// nuevo que lo local, ambos con margen de solapamiento; si un lado está
// vacío, se mueve todo (instalación nueva ← baja el histórico completo).
async function syncNow() {
  await ensure();
  try {
    const c = await col();
    if (!c) return;

    // Push: lo local que Mongo no tiene ($setOnInsert nunca pisa lo remoto).
    const remoteMaxDoc = await c.find({}).sort({ added_at: -1 }).limit(1).project({ added_at: 1 }).toArray();
    const remoteMax = remoteMaxDoc.length ? (remoteMaxDoc[0].added_at || 0) : 0;
    const pushSince = remoteMax > 0 ? remoteMax - SYNC_MARGIN_MS : 0;
    const pushStmt = db.prepare('SELECT * FROM lime_releases WHERE added_at > ?');
    pushStmt.bind([pushSince]);
    const toPush = [];
    while (pushStmt.step()) toPush.push(rowToRelease(pushStmt.getAsObject()));
    pushStmt.free();
    if (toPush.length) {
      await c.bulkWrite(toPush.map((t) => ({
        updateOne: { filter: { _id: t.id }, update: { $setOnInsert: releaseToDoc(t) }, upsert: true },
      })), { ordered: false });
    }

    // Pull: lo remoto que falta acá (INSERT OR IGNORE — lo local no se pisa).
    const localMax = localMaxAddedAt();
    const pullSince = localMax > 0 ? localMax - SYNC_MARGIN_MS : 0;
    const docs = await c.find(pullSince > 0 ? { added_at: { $gt: pullSince } } : {}).toArray();
    if (docs.length) {
      db.run('BEGIN TRANSACTION');
      try {
        for (const d of docs) {
          const t = docToRelease(d);
          db.run(
            `INSERT OR IGNORE INTO lime_releases
             (id, cat, title, page, quality, size, size_bytes, seeds, peers, hash, torrent_url, magnet, released_at,
              name, year, imdb, imdb_title, imdb_year, cover, added_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              Number(t.id), String(t.cat || 'movies'), String(t.title || '—'),
              t.page, t.quality, t.size,
              t.sizeBytes, t.seeds, t.peers,
              t.hash, t.torrentUrl, t.magnet, t.releasedAt,
              t.name, t.year, t.imdb, t.imdbTitle, t.imdbYear, t.cover,
              Number(t.addedAt),
            ]);
        }
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
      persist();
    }
    console.log(`[limeArchive] sync: ${toPush.length} subidos, ${docs.length} bajados`);
  } catch (e) {
    console.warn('[limeArchive] mongo sync failed, SQLite-only:', e.message);
  }
}

module.exports = { ingest, existingIds, rowsByIds, list, byImdb, count, syncNow };
