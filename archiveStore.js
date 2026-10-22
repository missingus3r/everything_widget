// Motor común de los archivos históricos (main process).
//
// limeArchive.js demostró el patrón: SQLite local + Mongo, sync aditivo en los
// dos sentidos, nada se borra nunca. Los archivos de YIFY, EZTV y CheapShark
// usan el mismo contrato, así que la mecánica vive acá una sola vez y cada
// módulo aporta solo su esquema. (limeArchive quedó como estaba: su tabla es
// anterior a este motor y funciona.)
//
// Dos diferencias con limeArchive, por escala: estos catálogos son de decenas
// o cientos de miles de filas, no de ~3.500.
//
//   • Persistencia diferida. sql.js vive en memoria y export() reescribe el
//     archivo ENTERO: hacerlo en cada ingest (como Lime) con 80 MB de base
//     congelaría la UI en cada página del crawler. Acá se marca sucio y se
//     vuelca como mucho cada PERSIST_EVERY_MS, además de al cerrar la app. Lo
//     que se pierda en un cierre forzado vuelve del sync con Mongo.
//   • Escritura atómica (tmp + fsync + rename, ver sqliteFile.js): un corte de
//     luz a mitad de un volcado de 80 MB dejaba el .sqlite truncado — o, sin
//     fsync, entero pero lleno de ceros — y sin recuperación local.
//
// Un store = un archivo .sqlite con N tablas registradas. Cada tabla declara
// sus columnas una sola vez y de ahí salen el CREATE TABLE, el upsert, el
// mapeo a documentos de Mongo y la vuelta.

const path = require('path');
const mongo = require('./finances/mongo');
const sqliteFile = require('./sqliteFile');

const WASM_PATH = path.join(__dirname, 'node_modules', 'sql.js', 'dist');
const PERSIST_EVERY_MS = 30 * 1000;          // volcado a disco, como mucho
const SYNC_MARGIN_MS = 6 * 60 * 60 * 1000;   // solapamiento incremental (6 h)
const PULL_BATCH = 5000;                     // documentos por tanda al bajar
const PUSH_BATCH = 1000;                     // documentos por bulkWrite al subir
const MAX_QUEUED_PUSHES = 20;                // lotes esperando a Mongo antes de saltear

// Si el cluster se queda sin espacio y empieza a rechazar escrituras, no tiene
// sentido reintentar en cada ingest: se apaga el push por lo que queda de
// sesión y todo sigue viviendo en SQLite. El estado lo lleva
// finances/mongo.js (lo comparte con Settings, que lo avisa).
const quotaBlocked = () => mongo.getQuotaState().blocked;

// ── Utilidades de columnas ─────────────────────────────────────
// Cada columna: { col, js, type, key?, mutable?, fill?, enc?, dec? }
//   key      → PRIMARY KEY (y _id en Mongo)
//   mutable  → se refresca al re-ver la fila (seeds, precios, last_seen)
//   fill     → solo completa si estaba en NULL (enriquecimiento: poster, ficha)
//   enc/dec  → serialización a/desde la columna (JSON de géneros, torrents…)

function encode(c, v) {
  const out = c.enc ? c.enc(v) : v;
  if (out === undefined || out === null) return null;
  if (typeof out === 'boolean') return out ? 1 : 0;
  if (typeof out === 'number') return isFinite(out) ? out : null;
  return typeof out === 'string' ? out : String(out);
}

function decode(c, v) {
  return c.dec ? c.dec(v) : (v === undefined ? null : v);
}

function createStore({ file }) {
  const DB_PATH = path.join(__dirname, file);
  const tables = [];
  let db = null;
  let readyPromise = null;
  let dirty = false;
  let persistTimer = null;
  let persisting = null;

  const SCHEMA_STATE = `
    CREATE TABLE IF NOT EXISTS store_state (
      k TEXT PRIMARY KEY,
      v TEXT
    );`;

  function ensure() {
    if (!readyPromise) {
      const p = readyPromise = (async () => {
        const initSqlJs = require('sql.js');
        const SQL = await initSqlJs({ locateFile: (f) => path.join(WASM_PATH, f) });
        // Un archivo dañado (p. ej. en cero tras un apagado inesperado) se
        // aparta y se arranca de cero: el sync con Mongo vuelve a bajar todo.
        db = sqliteFile.openDatabase(SQL, DB_PATH);
        db.run(SCHEMA_STATE);
        for (const t of tables) db.run(t.ddl);
        markDirty();
      })();
      // Un fallo al abrir no queda cacheado para toda la sesión.
      p.catch(() => { if (readyPromise === p) readyPromise = null; });
    }
    return readyPromise;
  }

  // Volcado atómico: export → .tmp → fsync → rename (sqliteFile.writeAtomic).
  // El fsync fuerza los bytes al disco y el rename "publica" la base nueva de
  // una sola vez, así que un corte en el medio deja intacta la anterior en vez
  // de un archivo a medio escribir o lleno de ceros.
  function persistNow() {
    if (!db || !dirty) return Promise.resolve();
    if (persisting) return persisting;
    dirty = false;
    const buf = Buffer.from(db.export());
    persisting = sqliteFile.writeAtomic(DB_PATH, buf)
      .catch((e) => {
        dirty = true;   // reintenta en el próximo ciclo
        console.warn(`[archive:${file}] no se pudo guardar:`, e.message);
      })
      .finally(() => { persisting = null; });
    return persisting;
  }

  function markDirty() {
    dirty = true;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistNow();
    }, PERSIST_EVERY_MS);
    if (persistTimer.unref) persistTimer.unref();
  }

  // Volcado inmediato (cierre de la app / fin de una tanda del crawler).
  async function flush() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    await persistNow();
  }

  // ── Consultas crudas ─────────────────────────────────────────
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function one(sql, params = []) {
    const rows = all(sql, params);
    return rows.length ? rows[0] : null;
  }

  function run(sql, params = []) {
    db.run(sql, params);
    markDirty();
  }

  // ── Estado del crawler (local, no se sincroniza) ─────────────
  // Los cursores del backfill son de esta máquina: otra instalación tiene su
  // propio avance y baja el contenido por el sync, no por el crawl.
  async function getState(key, def = null) {
    await ensure();
    const r = one('SELECT v FROM store_state WHERE k = ?', [String(key)]);
    if (!r || r.v == null) return def;
    try { return JSON.parse(r.v); } catch { return def; }
  }

  async function setState(key, value) {
    await ensure();
    db.run('INSERT INTO store_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      [String(key), JSON.stringify(value ?? null)]);
    markDirty();
  }

  // ── Tablas ───────────────────────────────────────────────────
  function table({ name, collection, columns, indexes = [], sync = true }) {
    const key = columns.find((c) => c.key);
    const cols = columns.map((c) => c.col);
    const ddl = `CREATE TABLE IF NOT EXISTS ${name} (\n  ${
      columns.map((c) => `${c.col} ${c.type}${c.key ? ' PRIMARY KEY' : ''}`).join(',\n  ')
    }\n);\n${indexes.join('\n')}`;

    // Upsert: la fila nueva entra entera; la ya archivada solo mueve lo
    // mutable (seeds, precios) y completa lo que estaba vacío (fill).
    const setters = columns
      .filter((c) => !c.key && (c.mutable || c.fill))
      .map((c) => (c.mutable ? `${c.col} = excluded.${c.col}` : `${c.col} = COALESCE(${c.col}, excluded.${c.col})`));
    const INSERT = `INSERT INTO ${name} (${cols.join(', ')})
      VALUES (${cols.map(() => '?').join(', ')})
      ON CONFLICT(${key.col}) DO UPDATE SET ${setters.join(', ') || `${key.col} = excluded.${key.col}`}`;
    // El pull de Mongo nunca pisa lo local (mismo criterio aditivo que Lime).
    const INSERT_IGNORE = `INSERT OR IGNORE INTO ${name} (${cols.join(', ')})
      VALUES (${cols.map(() => '?').join(', ')})`;

    const t = {
      name, collection, columns, key, ddl,
      sync,
      rowToObj: (r) => Object.fromEntries(columns.map((c) => [c.js, decode(c, r[c.col])])),
      objToVals: (o) => columns.map((c) => encode(c, o[c.js])),
    };
    tables.push(t);
    // Registro tardío (una tabla declarada después de abrir la base): el
    // CREATE TABLE de ensure() ya pasó, así que corre acá.
    if (db) { db.run(ddl); markDirty(); }

    // El push a Mongo de cada ingest va en fila india: durante el backfill
    // entra un lote por segundo y, si el cluster se pone lento, encadenar
    // bulkWrites sin control termina en cientos de promesas vivas. Con la fila
    // llena se saltea el push — el sync periódico (aditivo) lo sube igual.
    let pushChain = Promise.resolve();
    let pushQueued = 0;

    async function ingest(objs) {
      await ensure();
      const rows = (objs || []).filter((o) => o && o[key.js] != null);
      if (!rows.length) return 0;
      const stmt = db.prepare(INSERT);
      db.run('BEGIN TRANSACTION');
      try {
        for (const o of rows) { stmt.run(t.objToVals(o)); stmt.reset(); }
        db.run('COMMIT');
      } catch (e) {
        db.run('ROLLBACK');
        stmt.free();
        throw e;
      }
      stmt.free();
      markDirty();
      // Best effort: lo local nunca espera a la red.
      if (pushQueued < MAX_QUEUED_PUSHES) {
        pushQueued++;
        pushChain = pushChain.then(() => pushMongo(rows)).catch(() => {}).finally(() => { pushQueued--; });
      }
      return rows.length;
    }

    // ── Mongo ──────────────────────────────────────────────────
    async function col() {
      if (quotaBlocked() || !sync || !mongo.isEnabled()) return null;
      const dbh = await mongo.connect();   // null si el cluster no responde
      return dbh ? dbh.collection(collection) : null;
    }

    function toDoc(o) {
      const doc = { _id: encode(key, o[key.js]) };
      for (const c of columns) if (!c.key) doc[c.col] = encode(c, o[c.js]);
      return doc;
    }

    function fromDoc(d) {
      const row = { [key.col]: d._id };
      for (const c of columns) if (!c.key) row[c.col] = d[c.col] ?? null;
      return t.rowToObj(row);
    }

    async function bulk(c, ops) {
      for (let i = 0; i < ops.length; i += PUSH_BATCH) {
        await c.bulkWrite(ops.slice(i, i + PUSH_BATCH), { ordered: false });
      }
    }

    // Sube un lote refrescando lo mutable (seeds/precios) y conservando el
    // added_at original del documento remoto.
    async function pushMongo(rows) {
      try {
        const c = await col();
        if (!c) return;
        await bulk(c, rows.map((o) => {
          const doc = toDoc(o);
          const { _id, added_at, ...mut } = doc;
          return {
            updateOne: {
              filter: { _id },
              update: { $set: mut, ...(added_at != null ? { $setOnInsert: { added_at } } : {}) },
              upsert: true,
            },
          };
        }));
      } catch (e) {
        // El "sin espacio" ya quedó registrado por el envoltorio de mongo.js.
        if (!mongo.isQuotaError(e)) console.warn(`[archive:${name}] mongo upsert falló:`, e.message);
      }
    }

    // Sync aditivo bidireccional, incremental por added_at con margen: sube lo
    // que a Mongo le falta ($setOnInsert, nunca pisa) y baja lo que falta acá
    // (INSERT OR IGNORE). Una instalación nueva baja todo el histórico.
    async function syncNow() {
      await ensure();
      let pushed = 0, pulled = 0;
      const c = await col();
      if (!c) return { pushed, pulled };

      const remoteMaxDoc = await c.find({}).sort({ added_at: -1 }).limit(1).project({ added_at: 1 }).toArray();
      const remoteMax = remoteMaxDoc.length ? (remoteMaxDoc[0].added_at || 0) : 0;
      const pushSince = remoteMax > 0 ? remoteMax - SYNC_MARGIN_MS : 0;
      const toPush = all(`SELECT * FROM ${name} WHERE added_at > ?`, [pushSince]).map(t.rowToObj);
      if (toPush.length) {
        await bulk(c, toPush.map((o) => ({
          updateOne: { filter: { _id: encode(key, o[key.js]) }, update: { $setOnInsert: toDoc(o) }, upsert: true },
        })));
        pushed = toPush.length;
      }

      const localMaxRow = one(`SELECT MAX(added_at) AS m FROM ${name}`);
      const localMax = (localMaxRow && localMaxRow.m) || 0;
      const pullSince = localMax > 0 ? localMax - SYNC_MARGIN_MS : 0;
      const cursor = c.find(pullSince > 0 ? { added_at: { $gt: pullSince } } : {});
      let batch = [];
      const flushBatch = () => {
        if (!batch.length) return;
        const stmt = db.prepare(INSERT_IGNORE);
        db.run('BEGIN TRANSACTION');
        try {
          for (const o of batch) { stmt.run(t.objToVals(o)); stmt.reset(); }
          db.run('COMMIT');
        } catch (e) {
          db.run('ROLLBACK');
          stmt.free();
          throw e;
        }
        stmt.free();
        pulled += batch.length;
        batch = [];
        markDirty();
      };
      for await (const d of cursor) {
        batch.push(fromDoc(d));
        if (batch.length >= PULL_BATCH) flushBatch();
      }
      flushBatch();
      return { pushed, pulled };
    }

    return {
      ingest, syncNow,
      // Consultas: las tablas concretas arman su SQL y mapean con estos.
      all: (sql, params) => all(sql, params).map(t.rowToObj),
      raw: (sql, params) => all(sql, params),
      one: (sql, params) => { const r = one(sql, params); return r ? t.rowToObj(r) : null; },
      value: (sql, params) => { const r = one(sql, params); return r ? Object.values(r)[0] : null; },
      run,
      count: (where = '', params = []) =>
        Number((one(`SELECT COUNT(*) AS n FROM ${name}${where ? ` WHERE ${where}` : ''}`, params) || {}).n || 0),
      // Ids ya archivados de un lote (para no re-enriquecer lo conocido).
      knownIds: (ids) => {
        const want = (ids || []).filter((v) => v != null);
        const found = new Set();
        if (!want.length) return found;
        for (let i = 0; i < want.length; i += 500) {
          const chunk = want.slice(i, i + 500);
          for (const r of all(`SELECT ${key.col} AS k FROM ${name} WHERE ${key.col} IN (${chunk.map(() => '?').join(',')})`, chunk)) {
            found.add(r.k);
          }
        }
        return found;
      },
    };
  }

  async function syncAll() {
    await ensure();
    const out = {};
    for (const t of tables) {
      if (!t.sync) continue;
      try {
        out[t.name] = await t.api.syncNow();
      } catch (e) {
        console.warn(`[archive:${file}] sync de ${t.name} falló:`, e.message);
      }
    }
    await flush();
    return out;
  }

  return {
    ensure, flush, getState, setState, syncAll,
    table: (spec) => {
      const api = table(spec);
      tables[tables.length - 1].api = api;   // syncAll recorre las registradas
      return api;
    },
  };
}

module.exports = { createStore };
