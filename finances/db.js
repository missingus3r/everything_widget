// SQLite persistence for balance snapshots, backed by sql.js (WASM).
//
// sql.js keeps the whole database in memory; we persist by writing the exported
// byte buffer to finances.sqlite after every mutation. The data set here is tiny
// (a handful of accounts × snapshots over time), so this is more than fast enough
// and avoids any native build step on Windows.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'finances.sqlite');
const WASM_PATH = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist');

let SQL = null;   // initialized sql.js module
let db = null;    // Database instance

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS snapshots (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT    NOT NULL,
    ts      INTEGER NOT NULL,
    uyu     REAL,
    usd     REAL
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_account_ts ON snapshots(account, ts);
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    amount      REAL    NOT NULL,
    currency    TEXT    NOT NULL,
    kind        TEXT    NOT NULL DEFAULT 'servicio',
    billing_day INTEGER,
    created_at  INTEGER NOT NULL,
    flow        TEXT    NOT NULL DEFAULT 'gasto',
    detail      TEXT,
    tx_date     INTEGER
  );
`;

// Add columns introduced after the first release to pre-existing databases.
// SQLite's ALTER TABLE only supports ADD COLUMN, which is all we need here.
function migrate() {
  const cols = new Set();
  const stmt = db.prepare('PRAGMA table_info(expenses)');
  while (stmt.step()) cols.add(stmt.getAsObject().name);
  stmt.free();
  if (!cols.has('flow'))   db.run("ALTER TABLE expenses ADD COLUMN flow TEXT NOT NULL DEFAULT 'gasto'");
  if (!cols.has('detail')) db.run('ALTER TABLE expenses ADD COLUMN detail TEXT');
  if (!cols.has('tx_date')) {
    db.run('ALTER TABLE expenses ADD COLUMN tx_date INTEGER');
    // Backfill the transaction date from the row's creation time so existing
    // items land in the month they were added.
    db.run('UPDATE expenses SET tx_date = created_at WHERE tx_date IS NULL');
  }
}

async function init() {
  if (db) return;
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs({ locateFile: (f) => path.join(WASM_PATH, f) });
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(SCHEMA);
  migrate();
  save();
}

function save() {
  if (!db) return;
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// Insert a balance snapshot. uyu/usd may be null when not applicable.
function insertSnapshot(account, uyu, usd, ts) {
  if (!db) throw new Error('db not initialized');
  db.run('INSERT INTO snapshots (account, ts, uyu, usd) VALUES (?, ?, ?, ?)', [
    account,
    ts,
    uyu == null ? null : Number(uyu),
    usd == null ? null : Number(usd),
  ]);
  save();
}

// Key-value settings (e.g. the "hide values" toggle), persisted in the same db.
function getSetting(key) {
  if (!db) throw new Error('db not initialized');
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  stmt.bind([key]);
  const v = stmt.step() ? stmt.getAsObject().value : null;
  stmt.free();
  return v;
}

function setSetting(key, value) {
  if (!db) throw new Error('db not initialized');
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, String(value)]);
  save();
}

// Locked monthly USD buy rate, so a closed month's balance stays put even when
// the live rate moves. Stored as a single JSON setting { "YYYY-MM": rate }.
function getFxMonthly() {
  try { return JSON.parse(getSetting('fx_monthly') || '{}') || {}; }
  catch { return {}; }
}

// Record the rate for one month, overwriting only that month. Returns the full
// map. No-op (no disk write) when the value is unchanged.
function setFxMonth(ym, rate) {
  const map = getFxMonthly();
  if (map[ym] === rate) return map;
  map[ym] = rate;
  setSetting('fx_monthly', JSON.stringify(map));
  return map;
}

// Delete all snapshots for a single account (resets its balance to empty).
function clearAccount(account) {
  if (!db) throw new Error('db not initialized');
  db.run('DELETE FROM snapshots WHERE account = ?', [account]);
  save();
}

// Delete every snapshot (resets the whole Finanzas history).
function clearAll() {
  if (!db) throw new Error('db not initialized');
  db.run('DELETE FROM snapshots');
  save();
}

// Returns the last two snapshots for an account, newest first.
function lastTwo(account) {
  if (!db) throw new Error('db not initialized');
  const stmt = db.prepare(
    'SELECT ts, uyu, usd FROM snapshots WHERE account = ? ORDER BY ts DESC LIMIT 2'
  );
  stmt.bind([account]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Per-account latest value + delta vs the previous run, for each currency.
// Shape: { ts, uyu: { value, delta }, usd: { value, delta } } (delta null if no prior run).
function getAccountState(account) {
  const rows = lastTwo(account);
  if (rows.length === 0) return { ts: null, uyu: null, usd: null };
  const latest = rows[0];
  const prev = rows[1] || null;
  const fld = (cur) => {
    const v = latest[cur];
    if (v == null) return null;
    const pv = prev ? prev[cur] : null;
    return { value: v, delta: pv == null ? null : v - pv };
  };
  return { ts: latest.ts, uyu: fld('uyu'), usd: fld('usd') };
}

// Full time series for an account (oldest first) — used for future charts.
function history(account) {
  if (!db) throw new Error('db not initialized');
  const stmt = db.prepare(
    'SELECT ts, uyu, usd FROM snapshots WHERE account = ? ORDER BY ts ASC'
  );
  stmt.bind([account]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ── Movimientos: gastos, servicios e ingresos ────────────────────
// Each row is one dated movement. `flow` is 'gasto' (money out) or 'ingreso'
// (money in); `tx_date` is the date it belongs to (used for the month-by-month
// summary); `detail` is a free-text label for incomes (salario, aguinaldo…).
// billing_day stays optional (1–31) for recurring expenses.
function listExpenses() {
  if (!db) throw new Error('db not initialized');
  const stmt = db.prepare(
    'SELECT id, name, amount, currency, kind, billing_day, flow, detail, tx_date, created_at ' +
    'FROM expenses ORDER BY name COLLATE NOCASE ASC'
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function insertExpense(name, amount, currency, kind, billingDay, createdAt, flow, detail, txDate) {
  if (!db) throw new Error('db not initialized');
  db.run(
    'INSERT INTO expenses (name, amount, currency, kind, billing_day, created_at, flow, detail, tx_date) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [name, Number(amount), currency, kind, billingDay == null ? null : Number(billingDay), createdAt,
     flow || 'gasto', detail == null ? null : String(detail), txDate == null ? createdAt : Number(txDate)]
  );
  save();
}

function updateExpense(id, name, amount, currency, kind, billingDay, flow, detail, txDate) {
  if (!db) throw new Error('db not initialized');
  db.run(
    'UPDATE expenses SET name = ?, amount = ?, currency = ?, kind = ?, billing_day = ?, ' +
    'flow = ?, detail = ?, tx_date = ? WHERE id = ?',
    [name, Number(amount), currency, kind, billingDay == null ? null : Number(billingDay),
     flow || 'gasto', detail == null ? null : String(detail), txDate == null ? null : Number(txDate), Number(id)]
  );
  save();
}

function deleteExpense(id) {
  if (!db) throw new Error('db not initialized');
  db.run('DELETE FROM expenses WHERE id = ?', [Number(id)]);
  save();
}

module.exports = {
  init, insertSnapshot, getAccountState, history,
  clearAccount, clearAll, getSetting, setSetting, DB_PATH,
  getFxMonthly, setFxMonth,
  listExpenses, insertExpense, updateExpense, deleteExpense,
};
