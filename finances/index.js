// Finanzas module (main process).
//
// Tracks account balances over time in SQLite. All values are entered by hand
// from the widget; this module just persists snapshots and computes per-currency
// deltas vs. the previous entry.

const db = require('./db');
const { ACCOUNTS, getAccount } = require('./accounts');

let dbReady = null;
function ensureDb() {
  if (!dbReady) dbReady = db.init();
  return dbReady;
}

// Parse a number tolerantly, accepting both plain ("15000.50") and Uruguayan
// locale ("15.000,50") formats. Returns null when not a finite number.
function numOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[^0-9.,-]/g, '');
  if (!s) return null;
  const hasComma = s.includes(','), hasDot = s.includes('.');
  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  } else if (hasDot) {
    // Only dots: treat as thousands separators when they group digits in 3s
    // (es-UY style "95.000" → 95000); otherwise keep as a decimal point.
    const parts = s.split('.');
    const groupsAfter = parts.slice(1);
    const looksLikeThousands = parts.length > 2
      || (groupsAfter.length === 1 && groupsAfter[0].length === 3 && parts[0].length <= 3);
    if (looksLikeThousands) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}

async function getState() {
  await ensureDb();
  const accounts = ACCOUNTS.map((a) => {
    const st = db.getAccountState(a.id);
    return {
      id: a.id,
      name: a.name,
      url: a.url || null,
      currencies: a.currencies,
      ts: st.ts,
      uyu: st.uyu,
      usd: st.usd,
    };
  });
  return {
    accounts,
    expenses: db.listExpenses(),
    hidden: db.getSetting('hidden') === '1',
  };
}

// Aggregate savings over time: at each distinct snapshot timestamp, sum the
// most recent known value of every account (a running total step series).
// Returns [{ ts, uyu, usd }] oldest first.
async function getHistory() {
  await ensureDb();
  const series = {};
  for (const a of ACCOUNTS) series[a.id] = db.history(a.id); // oldest first

  const allTs = Array.from(
    new Set(Object.values(series).flat().map((r) => r.ts))
  ).sort((a, b) => a - b);

  const idx = {};
  const last = {};
  for (const id of Object.keys(series)) idx[id] = 0;

  const points = [];
  for (const ts of allTs) {
    for (const id of Object.keys(series)) {
      const arr = series[id];
      while (idx[id] < arr.length && arr[idx[id]].ts <= ts) {
        last[id] = arr[idx[id]];
        idx[id] += 1;
      }
    }
    let uyu = 0, usd = 0;
    for (const id of Object.keys(last)) {
      uyu += last[id].uyu || 0;
      usd += last[id].usd || 0;
    }
    points.push({ ts, uyu, usd });
  }
  return points;
}

async function setHidden(hidden) {
  await ensureDb();
  db.setSetting('hidden', hidden ? '1' : '0');
  return { ok: true, hidden: !!hidden };
}

async function saveManual(accountId, uyu, usd, ts) {
  const acc = getAccount(accountId);
  if (!acc) return { ok: false, error: 'cuenta inválida' };
  await ensureDb();

  // Carry forward the last known value for any currency left blank, so updating
  // one currency doesn't wipe the other. Only store currencies the account supports.
  const prev = db.getAccountState(accountId);
  const resolve = (input, cur) => {
    if (!acc.currencies.includes(cur.toUpperCase())) return null;
    const v = numOrNull(input);
    if (v != null) return v;
    return prev && prev[cur] ? prev[cur].value : null;
  };
  const nextUyu = resolve(uyu, 'uyu');
  const nextUsd = resolve(usd, 'usd');
  if (nextUyu == null && nextUsd == null) {
    return { ok: false, error: 'ingresá al menos un monto' };
  }
  db.insertSnapshot(accountId, nextUyu, nextUsd, ts || Date.now());
  return { ok: true };
}

async function clearAccount(accountId) {
  const acc = getAccount(accountId);
  if (!acc) return { ok: false, error: 'cuenta inválida' };
  await ensureDb();
  db.clearAccount(accountId);
  return { ok: true };
}

async function clearAll() {
  await ensureDb();
  db.clearAll();
  return { ok: true };
}

const EXPENSE_CURRENCIES = ['UYU', 'USD'];
const EXPENSE_KINDS = ['servicio', 'gasto', 'suscripcion'];

async function listExpenses() {
  await ensureDb();
  return db.listExpenses();
}

// Validate + normalize the shared expense fields. Returns { value } on success
// or { error } with a user-facing message.
function normalizeExpense({ name, amount, currency, kind, billingDay } = {}) {
  const nm = String(name == null ? '' : name).trim();
  if (!nm) return { error: 'ingresá un nombre' };
  const amt = numOrNull(amount);
  if (amt == null || amt <= 0) return { error: 'ingresá un monto válido' };
  const cur = EXPENSE_CURRENCIES.includes(String(currency).toUpperCase())
    ? String(currency).toUpperCase() : 'UYU';
  const kd = EXPENSE_KINDS.includes(String(kind)) ? String(kind) : 'servicio';
  let day = numOrNull(billingDay);
  day = day == null ? null : Math.min(31, Math.max(1, Math.round(day)));
  return { value: { name: nm, amount: amt, currency: cur, kind: kd, billingDay: day } };
}

async function addExpense(payload = {}) {
  await ensureDb();
  const { value, error } = normalizeExpense(payload);
  if (error) return { ok: false, error };
  db.insertExpense(value.name, value.amount, value.currency, value.kind, value.billingDay, Date.now());
  return { ok: true };
}

async function updateExpense(payload = {}) {
  await ensureDb();
  if (payload.id == null) return { ok: false, error: 'id inválido' };
  const { value, error } = normalizeExpense(payload);
  if (error) return { ok: false, error };
  db.updateExpense(payload.id, value.name, value.amount, value.currency, value.kind, value.billingDay);
  return { ok: true };
}

async function deleteExpense(id) {
  await ensureDb();
  if (id == null) return { ok: false, error: 'id inválido' };
  db.deleteExpense(id);
  return { ok: true };
}

module.exports = {
  getState, getHistory, saveManual, clearAccount, clearAll, setHidden,
  listExpenses, addExpense, updateExpense, deleteExpense,
};
