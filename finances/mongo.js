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
    await c.connect();
    // Force server selection now so an unreachable cluster fails here, not later.
    await c.db(DB_NAME).command({ ping: 1 });
    client = c;
    database = c.db(DB_NAME);
    console.log('[finances/mongo] connected');
    return database;
  })().catch((err) => {
    console.warn('[finances/mongo] connection failed, SQLite-only this session:', err.message);
    connectPromise = null;
    return null;
  });
  return connectPromise;
}

function snapshotId(account, ts) { return `${account}_${ts}`; }

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
  isEnabled, connect,
  upsertSnapshot, upsertSetting, upsertExpense,
  deleteExpense, deleteSnapshotsByAccount, deleteAllSnapshots,
  fetchAll, seedUpIfMissing, close,
};
