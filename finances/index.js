// Finanzas module (main process).
//
// Tracks account balances over time in SQLite. All values are entered by hand
// from the widget; this module just persists snapshots and computes per-currency
// deltas vs. the previous entry.

const db = require('./db');
const mongo = require('./mongo');
const { ACCOUNTS, getAccount } = require('./accounts');

// Mongo is the primary store; SQLite is a local mirror. On the first access we
// initialize SQLite, then reconcile with Mongo (push local-only rows up, pull
// the authoritative copy down). Everything is wrapped so that an unreachable
// cluster degrades to SQLite-only instead of breaking Finanzas.
let readyPromise = null;
function ensureDb() {
  if (!readyPromise) readyPromise = (async () => {
    await db.init();
    await syncOnStartup();
  })();
  return readyPromise;
}

// Core reconciliation between SQLite and Mongo: push local-only rows up
// ($setOnInsert keeps Mongo authoritative while preserving the initial seed and
// anything created offline), then pull the authoritative copy down and overwrite
// SQLite. Returns a status object; never throws on a Mongo problem.
async function reconcile() {
  if (!mongo.isEnabled()) return { ok: false, enabled: false, connected: false, error: 'MongoDB no configurado' };
  const seeded = await mongo.seedUpIfMissing({
    snapshots: db.getAllSnapshots(),
    settings: db.getAllSettings(),
    expenses: db.listExpenses(),
  });
  if (seeded < 0) return { ok: false, enabled: true, connected: false, error: 'No se pudo conectar a MongoDB' };

  const remote = await mongo.fetchAll();
  if (!remote) return { ok: false, enabled: true, connected: false, error: 'No se pudieron leer los datos de MongoDB' };

  db.replaceAll({
    snapshots: remote.snapshots.map((s) => ({ account: s.account, ts: s.ts, uyu: s.uyu, usd: s.usd })),
    settings: remote.settings.map((s) => ({ key: s._id, value: s.value })),
    expenses: remote.expenses.map((e) => ({
      id: e._id, name: e.name, amount: e.amount, currency: e.currency, kind: e.kind,
      billing_day: e.billing_day, created_at: e.created_at, flow: e.flow, detail: e.detail, tx_date: e.tx_date,
    })),
  });
  // Keep id generation ahead of any id already present.
  for (const e of remote.expenses) if (Number(e._id) > lastExpenseId) lastExpenseId = Number(e._id);
  return {
    ok: true, enabled: true, connected: true, pushed: seeded,
    snapshots: remote.snapshots.length, expenses: remote.expenses.length, settings: remote.settings.length,
  };
}

// One-shot startup reconciliation (best-effort; logs and degrades to SQLite-only).
async function syncOnStartup() {
  if (!mongo.isEnabled()) return;
  try {
    const r = await reconcile();
    if (r.ok) {
      console.log(`[finances] synced from Mongo: ${r.snapshots} snapshots, ${r.expenses} expenses, ` +
        `${r.settings} settings (${r.pushed} pushed up)`);
    } else {
      console.warn('[finances] startup sync:', r.error);
    }
  } catch (e) {
    console.warn('[finances] startup sync failed, using local SQLite:', e.message);
  }
}

// Manual "Sincronizar bases" action from Settings. Same reconcile, but the
// result is surfaced to the UI.
async function syncNow() {
  await ensureDb();
  try { return await reconcile(); }
  catch (e) { return { ok: false, enabled: mongo.isEnabled(), connected: false, error: e.message }; }
}

// Connectivity probe for the Settings indicator.
async function getMongoStatus() {
  return { enabled: mongo.isEnabled(), connected: await mongo.isConnected() };
}

// App-assigned expense ids, shared verbatim by SQLite and Mongo. Millisecond
// timestamps are unique enough for hand entry; the guard prevents same-ms and
// post-sync collisions.
let lastExpenseId = 0;
function nextExpenseId() {
  const t = Date.now();
  lastExpenseId = t > lastExpenseId ? t : lastExpenseId + 1;
  return lastExpenseId;
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
  const projections = db.getProjections();
  const accounts = ACCOUNTS.map((a) => {
    const st = db.getAccountState(a.id);
    const proj = projections[a.id] || {};
    return {
      id: a.id,
      name: a.name,
      url: a.url || null,
      currencies: a.currencies,
      invest: !!a.invest,
      ts: st.ts,
      uyu: st.uyu,
      usd: st.usd,
      // Forecast (not part of the saved balance): { uyu, usd } amounts for the
      // regular accounts, or a free-text `description` for the Inversiones card.
      projection: { uyu: proj.uyu == null ? null : proj.uyu, usd: proj.usd == null ? null : proj.usd },
      description: proj.desc || null,
    };
  });
  return {
    accounts,
    expenses: db.listExpenses(),
    hidden: db.getSetting('hidden') === '1',
    fxMonthly: db.getFxMonthly(),
  };
}

// Lock in the USD buy rate for a given month ("YYYY-MM"). Called as the live rate
// arrives; the current month keeps updating while past months stay frozen.
async function recordFx(ym, rate) {
  await ensureDb();
  const r = Number(rate);
  if (!/^\d{4}-\d{2}$/.test(String(ym)) || !isFinite(r) || r <= 0) {
    return { ok: false, error: 'datos de cotización inválidos' };
  }
  const map = db.setFxMonth(ym, r);
  await mongo.upsertSetting('fx_monthly', JSON.stringify(map));
  return { ok: true, fxMonthly: map };
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

// Detailed history for the savings modal chart: the aggregate series plus the
// raw per-account series (oldest first), so the renderer can plot every metric.
async function getHistoryFull() {
  await ensureDb();
  return {
    total: await getHistory(),
    accounts: ACCOUNTS.map((a) => ({
      id: a.id,
      name: a.name,
      points: db.history(a.id),   // [{ ts, uyu, usd }]
    })),
  };
}

async function setHidden(hidden) {
  await ensureDb();
  db.setSetting('hidden', hidden ? '1' : '0');
  await mongo.upsertSetting('hidden', hidden ? '1' : '0');
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
  const usedTs = ts || Date.now();
  db.insertSnapshot(accountId, nextUyu, nextUsd, usedTs);
  await mongo.upsertSnapshot({ account: accountId, ts: usedTs, uyu: nextUyu, usd: nextUsd });
  return { ok: true };
}

async function clearAccount(accountId) {
  const acc = getAccount(accountId);
  if (!acc) return { ok: false, error: 'cuenta inválida' };
  await ensureDb();
  db.clearAccount(accountId);
  await mongo.deleteSnapshotsByAccount(accountId);
  return { ok: true };
}

async function clearAll() {
  await ensureDb();
  db.clearAll();
  await mongo.deleteAllSnapshots();
  return { ok: true };
}

// ── Proyección mensual / descripción de inversiones ──────────────
// A per-account forecast that is intentionally NOT added to the saved balances.
// Saving overwrites the account's entry (it never accumulates); clearing removes
// it. Persisted as the single `fin_projections` JSON setting, mirrored to Mongo.

// Persist the current map to both stores.
async function persistProjections(map) {
  db.setProjections(map);
  await mongo.upsertSetting('fin_projections', JSON.stringify(map));
}

// Set the projected pesos/dollars for an account. Blank currencies are left
// untouched so updating one currency doesn't wipe the other; a currency the
// account can't hold is ignored.
async function saveProjection(accountId, uyu, usd) {
  const acc = getAccount(accountId);
  if (!acc) return { ok: false, error: 'cuenta inválida' };
  if (acc.invest) return { ok: false, error: 'esta cuenta usa descripción, no proyección' };
  await ensureDb();
  const map = db.getProjections();
  const prev = map[accountId] || {};
  const entry = {};
  if (acc.currencies.includes('UYU')) {
    const u = numOrNull(uyu);
    if (u != null) entry.uyu = u;
    else if (prev.uyu != null) entry.uyu = prev.uyu;
  }
  if (acc.currencies.includes('USD')) {
    const d = numOrNull(usd);
    if (d != null) entry.usd = d;
    else if (prev.usd != null) entry.usd = prev.usd;
  }
  if (entry.uyu == null && entry.usd == null) {
    return { ok: false, error: 'ingresá al menos un monto' };
  }
  map[accountId] = entry;
  await persistProjections(map);
  return { ok: true };
}

// Remove an account's projection entirely.
async function clearProjection(accountId) {
  const acc = getAccount(accountId);
  if (!acc) return { ok: false, error: 'cuenta inválida' };
  await ensureDb();
  const map = db.getProjections();
  if (!(accountId in map)) return { ok: true };
  delete map[accountId];
  await persistProjections(map);
  return { ok: true };
}

// Free-text description for the Inversiones card (the list of investments).
// Empty text clears the entry.
async function saveDescription(accountId, text) {
  const acc = getAccount(accountId);
  if (!acc) return { ok: false, error: 'cuenta inválida' };
  await ensureDb();
  const map = db.getProjections();
  const t = String(text == null ? '' : text).trim();
  if (t) map[accountId] = { desc: t };
  else delete map[accountId];
  await persistProjections(map);
  return { ok: true };
}

const EXPENSE_CURRENCIES = ['UYU', 'USD'];
const EXPENSE_KINDS = ['servicio', 'gasto', 'suscripcion'];
const EXPENSE_FLOWS = ['gasto', 'ingreso'];

async function listExpenses() {
  await ensureDb();
  return db.listExpenses();
}

// Validate + normalize the shared expense fields. Returns { value } on success
// or { error } with a user-facing message.
function normalizeExpense({ name, amount, currency, kind, billingDay, flow, detail, txDate } = {}) {
  const nm = String(name == null ? '' : name).trim();
  if (!nm) return { error: 'ingresá un nombre' };
  const amt = numOrNull(amount);
  if (amt == null || amt <= 0) return { error: 'ingresá un monto válido' };
  const cur = EXPENSE_CURRENCIES.includes(String(currency).toUpperCase())
    ? String(currency).toUpperCase() : 'UYU';
  const fl = EXPENSE_FLOWS.includes(String(flow)) ? String(flow) : 'gasto';
  // `kind` and `billing_day` only apply to gastos; incomes ignore both.
  const kd = fl === 'ingreso'
    ? 'gasto'
    : (EXPENSE_KINDS.includes(String(kind)) ? String(kind) : 'servicio');
  let day = fl === 'ingreso' ? null : numOrNull(billingDay);
  day = day == null ? null : Math.min(31, Math.max(1, Math.round(day)));
  const det = String(detail == null ? '' : detail).trim() || null;
  let td = Number(txDate);
  if (!isFinite(td) || td <= 0) td = Date.now();
  return { value: { name: nm, amount: amt, currency: cur, kind: kd, billingDay: day, flow: fl, detail: det, txDate: td } };
}

async function addExpense(payload = {}) {
  await ensureDb();
  const { value, error } = normalizeExpense(payload);
  if (error) return { ok: false, error };
  const id = nextExpenseId();
  const createdAt = Date.now();
  db.insertExpense(id, value.name, value.amount, value.currency, value.kind, value.billingDay,
    createdAt, value.flow, value.detail, value.txDate);
  await mongo.upsertExpense({
    id, name: value.name, amount: value.amount, currency: value.currency, kind: value.kind,
    billing_day: value.billingDay, created_at: createdAt, flow: value.flow, detail: value.detail, tx_date: value.txDate,
  });
  return { ok: true };
}

async function updateExpense(payload = {}) {
  await ensureDb();
  if (payload.id == null) return { ok: false, error: 'id inválido' };
  const { value, error } = normalizeExpense(payload);
  if (error) return { ok: false, error };
  const id = Number(payload.id);
  db.updateExpense(id, value.name, value.amount, value.currency, value.kind, value.billingDay,
    value.flow, value.detail, value.txDate);
  // No created_at here on purpose: $set leaves Mongo's existing value untouched.
  await mongo.upsertExpense({
    id, name: value.name, amount: value.amount, currency: value.currency, kind: value.kind,
    billing_day: value.billingDay, flow: value.flow, detail: value.detail, tx_date: value.txDate,
  });
  return { ok: true };
}

async function deleteExpense(id) {
  await ensureDb();
  if (id == null) return { ok: false, error: 'id inválido' };
  db.deleteExpense(id);
  await mongo.deleteExpense(id);
  return { ok: true };
}

module.exports = {
  getState, getHistory, getHistoryFull, saveManual, clearAccount, clearAll, setHidden, recordFx,
  saveProjection, clearProjection, saveDescription,
  listExpenses, addExpense, updateExpense, deleteExpense,
  getMongoStatus, syncNow,
};
