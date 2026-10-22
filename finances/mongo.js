// MongoDB Atlas layer for Finanzas — the PRIMARY store.
//
// Mongo is the source of truth; finances/db.js (SQLite) is kept as a local
// mirror so the widget keeps working offline and reads stay instant. Every
// mutation is written to both stores (see finances/index.js); on startup the
// app reconciles local-only rows up to Mongo and then pulls Mongo down into
// SQLite.
//
// Connection details live in config.json (gitignored) under `financesMongoUri`,
// or the FINANCES_MONGO_URI env var. When neither is set the whole layer is a
// no-op and Finanzas runs SQLite-only.
//
// Stable ids keep the two stores aligned:
//   • snapshots  _id = `${account}_${ts}`   (a snapshot is unique per account+ts)
//   • settings   _id = key
//   • expenses   _id = the app-assigned numeric id (see finances/index.js)

const dns = require('dns');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../config');

const DB_NAME = 'system_dashboard_widget';
// How long to wait for a server before giving up and falling back to SQLite-only.
const CONNECT_TIMEOUT_MS = 8000;
// El cluster no expone su límite de almacenamiento por el driver (habría que
// ir a la Admin API de Atlas con credenciales aparte), así que Settings muestra
// lo ocupado a secas. Si querés que además calcule el porcentaje y avise al
// acercarse, poné el tope de tu plan en config.json como `mongoStorageLimitMb`.
// Lo que NO se supone es el aviso rojo: ese sale solo cuando Atlas rechazó
// realmente una escritura por falta de espacio.
const USAGE_TTL_MS = 60 * 1000;

function storageLimitBytes() {
  try {
    const mb = Number(loadConfig().mongoStorageLimitMb);
    return mb > 0 ? mb * 1024 * 1024 : null;
  } catch { return null; }
}

let client = null;       // MongoClient once connected
let database = null;     // Db handle once connected
let connectPromise = null; // in-flight connection, so concurrent callers share it
let warnedNoUri = false;

function getUri() {
  const fromEnv = (process.env.FINANCES_MONGO_URI || '').trim();
  if (fromEnv) return fromEnv;
  try { return String(loadConfig().financesMongoUri || '').trim(); }
  catch { return ''; }
}

function isEnabled() {
  return getUri().length > 0;
}

// `mongodb+srv://` URIs need an SRV/TXT DNS lookup, which Node's c-ares resolver
// performs against whatever servers it was configured with. On some Windows
// setups that list is just the loopback stub (127.0.0.1), which refuses these
// queries (querySrv ECONNREFUSED) even though the OS resolver works fine. When
// we detect a loopback-only resolver, fall back to public DNS so SRV resolves.
// This only touches c-ares (dns.resolve*), not OS getaddrinfo/dns.lookup.
let dnsChecked = false;
function ensureUsableDnsServers() {
  if (dnsChecked) return;
  dnsChecked = true;
  try {
    const servers = dns.getServers();
    const allLoopback = servers.length === 0
      || servers.every((s) => /^(127\.|::1$|0\.0\.0\.0$)/.test(s.replace(/%.*$/, '').replace(/^\[|\]$/g, '')));
    if (allLoopback) {
      dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
      console.warn('[finances/mongo] local DNS resolver unusable for SRV; using public DNS (8.8.8.8/1.1.1.1)');
    }
  } catch { /* leave DNS as-is; connect() will fall back to SQLite-only if it fails */ }
}

// Connect once and cache the handle. Returns null (never throws) when Mongo is
// disabled or unreachable, so callers can degrade to SQLite-only gracefully.
async function connect() {
  if (database) return database;
  if (!isEnabled()) {
    if (!warnedNoUri) { console.warn('[finances/mongo] no URI configured — running SQLite-only'); warnedNoUri = true; }
    return null;
  }
  if (connectPromise) return connectPromise;
  ensureUsableDnsServers();
  connectPromise = (async () => {
    const c = new MongoClient(getUri(), {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
      connectTimeoutMS: CONNECT_TIMEOUT_MS,
    });
    try {
      await c.connect();
      // Force server selection now so an unreachable cluster fails here, not later.
      await c.db(DB_NAME).command({ ping: 1 });
    } catch (err) {
      // A failed client still holds monitor sockets/timers; callers retry
      // (pcPublish every 2 min), so close it instead of leaking one per try.
      c.close().catch(() => {});
      throw err;
    }
    client = c;
    database = watchDb(c.db(DB_NAME));
    console.log('[finances/mongo] connected');
    return database;
  })().catch((err) => {
    console.warn('[finances/mongo] connection failed, SQLite-only this session:', err.message);
    connectPromise = null;
    return null;
  });
  return connectPromise;
}

// ── Espacio del cluster ─────────────────────────────────────────────────────
// Cuando Atlas se queda sin espacio deja de aceptar escrituras y cada módulo
// se entera por su lado (un catch que loguea y sigue en SQLite). Para que el
// widget lo pueda contar en un solo lugar, el rechazo se registra acá.

let quotaState = { blocked: false, at: 0, message: '' };

function isQuotaError(e) {
  const msg = String((e && e.message) || e || '');
  return /over your space quota|space quota|quota exceeded|over its data limit|space limit/i.test(msg);
}

// Lo llama el envoltorio de las colecciones ante CUALQUIER escritura fallida;
// solo deja marca si el motivo fue la falta de espacio.
function noteError(e) {
  if (!isQuotaError(e)) return false;
  if (!quotaState.blocked) {
    console.warn('[finances/mongo] el cluster no tiene más espacio — todo sigue en SQLite:', String(e && e.message || e));
  }
  quotaState = { blocked: true, at: Date.now(), message: String((e && e.message) || e) };
  return true;
}

function getQuotaState() {
  return { ...quotaState, limit: storageLimitBytes() };
}

// Tamaño ocupado (dbStats), cacheado: Settings lo pide cada vez que se abre y
// no tiene sentido preguntarle al cluster en cada pasada.
let usageCache = { at: 0, value: null };
async function usage() {
  if (Date.now() - usageCache.at < USAGE_TTL_MS) return usageCache.value;
  let value = null;
  try {
    const dbh = await connect();
    if (dbh) {
      const st = await dbh.stats();
      value = {
        bytes: (st.storageSize || 0) + (st.indexSize || 0),
        dataSize: st.dataSize || 0,
        objects: st.objects || 0,
      };
    }
  } catch { value = null; }
  usageCache = { at: Date.now(), value };
  return value;
}

// Todas las escrituras del widget pasan por dbh.collection(...), así que
// envolver ese handle alcanza para enterarse de un "sin espacio" venga del
// módulo que venga, sin tener que acordarse de reportarlo en cada catch.
const WRITE_OPS = ['insertOne', 'insertMany', 'updateOne', 'updateMany',
  'replaceOne', 'deleteOne', 'deleteMany', 'bulkWrite', 'findOneAndUpdate'];

function watchWrites(coll) {
  return new Proxy(coll, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || !WRITE_OPS.includes(prop)) return value;
      return (...args) => {
        const out = value.apply(target, args);
        if (out && typeof out.catch === 'function') {
          return out.catch((e) => { noteError(e); throw e; });
        }
        return out;
      };
    },
  });
}

function watchDb(dbh) {
  return new Proxy(dbh, {
    get(target, prop, receiver) {
      if (prop !== 'collection') return Reflect.get(target, prop, receiver);
      return (...args) => watchWrites(target.collection(...args));
    },
  });
}

function snapshotId(account, ts) { return `${account}_${ts}`; }

// Live connectivity check: connects (or reuses the cached connection) and pings
// the server. Returns false when Mongo is disabled or the cluster is unreachable.
async function isConnected() {
  if (!isEnabled()) return false;
  const dbh = await connect();
  if (!dbh) return false;
  try { await dbh.command({ ping: 1 }); return true; }
  catch { return false; }
}

// ── Mutations (best-effort; resolve to false when Mongo is unavailable) ──────

async function upsertSnapshot({ account, ts, uyu, usd }) {
  const dbh = await connect();
  if (!dbh) return false;
  try {
    const _id = snapshotId(account, ts);
    await dbh.collection('snapshots').updateOne(
      { _id },
      { $set: { _id, account, ts, uyu: uyu == null ? null : Number(uyu), usd: usd == null ? null : Number(usd) } },
      { upsert: true }
    );
    return true;
  } catch (e) { console.warn('[finances/mongo] upsertSnapshot failed:', e.message); return false; }
}

async function upsertSetting(key, value) {
  const dbh = await connect();
  if (!dbh) return false;
  try {
    await dbh.collection('settings').updateOne(
      { _id: key }, { $set: { _id: key, value: value == null ? null : String(value) } }, { upsert: true }
    );
    return true;
  } catch (e) { console.warn('[finances/mongo] upsertSetting failed:', e.message); return false; }
}

async function upsertExpense(doc) {
  const dbh = await connect();
  if (!dbh) return false;
  try {
    const _id = Number(doc.id);
    const { id, ...rest } = doc;
    await dbh.collection('expenses').updateOne({ _id }, { $set: { _id, ...rest } }, { upsert: true });
    return true;
  } catch (e) { console.warn('[finances/mongo] upsertExpense failed:', e.message); return false; }
}

async function deleteExpense(id) {
  const dbh = await connect();
  if (!dbh) return false;
  try { await dbh.collection('expenses').deleteOne({ _id: Number(id) }); return true; }
  catch (e) { console.warn('[finances/mongo] deleteExpense failed:', e.message); return false; }
}

async function deleteSnapshotsByAccount(account) {
  const dbh = await connect();
  if (!dbh) return false;
  try { await dbh.collection('snapshots').deleteMany({ account }); return true; }
  catch (e) { console.warn('[finances/mongo] deleteSnapshotsByAccount failed:', e.message); return false; }
}

async function deleteAllSnapshots() {
  const dbh = await connect();
  if (!dbh) return false;
  try { await dbh.collection('snapshots').deleteMany({}); return true; }
  catch (e) { console.warn('[finances/mongo] deleteAllSnapshots failed:', e.message); return false; }
}

// ── Sync helpers ─────────────────────────────────────────────────────────────

// Pull the full data set from Mongo. Returns null when Mongo is unavailable so
// the caller can keep the existing SQLite data untouched.
async function fetchAll() {
  const dbh = await connect();
  if (!dbh) return null;
  try {
    const [snapshots, settings, expenses] = await Promise.all([
      dbh.collection('snapshots').find({}).toArray(),
      dbh.collection('settings').find({}).toArray(),
      dbh.collection('expenses').find({}).toArray(),
    ]);
    return { snapshots, settings, expenses };
  } catch (e) { console.warn('[finances/mongo] fetchAll failed:', e.message); return null; }
}

// Push local rows up, inserting only the ones Mongo doesn't already have
// ($setOnInsert), so Mongo stays authoritative on conflicts while local-only
// rows (e.g. created while offline, or the initial SQLite seed) get preserved.
// Returns the number of rows inserted, or -1 when Mongo is unavailable.
async function seedUpIfMissing({ snapshots = [], settings = [], expenses = [] } = {}) {
  const dbh = await connect();
  if (!dbh) return -1;
  let inserted = 0;
  const runBulk = async (name, ops) => {
    if (!ops.length) return;
    const res = await dbh.collection(name).bulkWrite(ops, { ordered: false });
    inserted += res.upsertedCount || 0;
  };
  try {
    await runBulk('snapshots', snapshots.map((r) => {
      const _id = snapshotId(r.account, r.ts);
      return { updateOne: { filter: { _id }, update: { $setOnInsert: { _id, account: r.account, ts: r.ts, uyu: r.uyu ?? null, usd: r.usd ?? null } }, upsert: true } };
    }));
    await runBulk('settings', settings.map((s) => ({
      updateOne: { filter: { _id: s.key }, update: { $setOnInsert: { _id: s.key, value: s.value == null ? null : String(s.value) } }, upsert: true },
    })));
    await runBulk('expenses', expenses.map((e) => {
      const _id = Number(e.id);
      const { id, ...rest } = e;
      return { updateOne: { filter: { _id }, update: { $setOnInsert: { _id, ...rest } }, upsert: true } };
    }));
    return inserted;
  } catch (e) { console.warn('[finances/mongo] seedUpIfMissing failed:', e.message); return -1; }
}

async function close() {
  if (client) { try { await client.close(); } catch {} client = null; database = null; connectPromise = null; }
}

module.exports = {
  isEnabled, isConnected, connect,
  upsertSnapshot, upsertSetting, upsertExpense,
  deleteExpense, deleteSnapshotsByAccount, deleteAllSnapshots,
  fetchAll, seedUpIfMissing, close,
  isQuotaError, noteError, getQuotaState, usage,
};
