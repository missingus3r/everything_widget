// Finanzas orchestrator (main process).
//
// Coordinates the credential store (creds.js), the SQLite history (db.js) and the
// semi-automatic bank capture flow: open a visible BrowserWindow at the bank's
// login URL, pre-fill credentials, let the user complete 2FA/captcha by hand, then
// read the balance from the page (or accept a manually-typed value as fallback).

const { BrowserWindow } = require('electron');
const path = require('path');

const creds = require('./creds');
const db = require('./db');
const { ACCOUNTS, getAccount } = require('./accounts');

const SCRAPERS = {
  brou: require('./scrapers/brou'),
  scotiabank: require('./scrapers/scotiabank'),
  itau: require('./scrapers/itau'),
  oca: require('./scrapers/oca'),
};

let dbReady = null;
function ensureDb() {
  if (!dbReady) dbReady = db.init();
  return dbReady;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}

// ── Public API (called from IPC) ───────────────────────────────

function status() {
  return {
    unlocked: creds.isUnlocked(),
    credsFileExists: creds.fileExists(),
  };
}

function unlock(masterPass) {
  return creds.unlock(masterPass);
}

function lock() {
  creds.lock();
}

async function getState() {
  if (!creds.isUnlocked()) return { unlocked: false, accounts: [] };
  await ensureDb();
  const credStatus = creds.credsStatus();
  const accounts = ACCOUNTS.map((a) => {
    const st = db.getAccountState(a.id);
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      currencies: a.currencies,
      hasCreds: !!credStatus[a.id],
      ts: st.ts,
      uyu: st.uyu,
      usd: st.usd,
    };
  });
  return { unlocked: true, accounts };
}

function saveCreds(accountId, user, pass) {
  if (!creds.isUnlocked()) return { ok: false, error: 'locked' };
  const acc = getAccount(accountId);
  if (!acc || acc.kind !== 'bank') return { ok: false, error: 'cuenta inválida' };
  creds.setCreds(accountId, user, pass);
  return { ok: true };
}

async function saveManual(accountId, uyu, usd, ts) {
  if (!creds.isUnlocked()) return { ok: false, error: 'locked' };
  const acc = getAccount(accountId);
  if (!acc) return { ok: false, error: 'cuenta inválida' };
  await ensureDb();
  db.insertSnapshot(accountId, numOrNull(uyu), numOrNull(usd), ts || Date.now());
  return { ok: true };
}

// Open the semi-automatic capture window for a bank and store the result.
async function refreshBank(accountId, parentWin) {
  if (!creds.isUnlocked()) return { ok: false, error: 'locked' };
  const acc = getAccount(accountId);
  if (!acc || acc.kind !== 'bank') return { ok: false, error: 'cuenta inválida' };
  const scraper = SCRAPERS[accountId];
  if (!scraper) return { ok: false, error: 'sin scraper' };
  await ensureDb();

  const accountCreds = creds.getCreds(accountId);

  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    title: `Finanzas — ${acc.name}`,
    autoHideMenuBar: true,
    parent: parentWin || undefined,
    webPreferences: {
      partition: 'persist:finanzas',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let autofilled = false;
  const onLoad = async () => {
    // Inject the control bar on every page (survives login navigation).
    try { await win.webContents.executeJavaScript(buildToolbar(acc), true); } catch {}
    // Autofill once, on the first (login) page.
    if (!autofilled && accountCreds) {
      autofilled = true;
      try { await win.webContents.executeJavaScript(scraper.autofill(accountCreds), true); } catch {}
    }
  };
  win.webContents.on('did-finish-load', onLoad);

  try {
    await win.loadURL(acc.url);
  } catch (e) {
    // Navigation errors are common on heavy bank sites; the window still opens.
  }

  const captured = await awaitCapture(win, scraper);

  if (!win.isDestroyed()) { try { win.close(); } catch {} }

  if (!captured) return { ok: false, cancelled: true };

  db.insertSnapshot(accountId, captured.uyu, captured.usd, Date.now());
  return { ok: true, captured };
}

// Poll the control bar for a terminal action; run extraction on demand.
async function awaitCapture(win, scraper) {
  while (true) {
    if (win.isDestroyed()) return null;
    let r = null;
    try {
      r = await win.webContents.executeJavaScript('(window.__finz_result||null)', true);
    } catch {
      return null; // window gone / navigating
    }
    if (r) {
      try { await win.webContents.executeJavaScript('window.__finz_result=null', true); } catch {}
      if (r.action === 'cancel') return null;
      if (r.action === 'manual') {
        return { uyu: numOrNull(r.uyu), usd: numOrNull(r.usd) };
      }
      if (r.action === 'auto') {
        let ext = null;
        try { ext = await win.webContents.executeJavaScript(scraper.extract(), true); } catch {}
        if (ext && !ext.error && (ext.uyu != null || ext.usd != null)) {
          return { uyu: ext.uyu == null ? null : ext.uyu, usd: ext.usd == null ? null : ext.usd };
        }
        try {
          await win.webContents.executeJavaScript(
            'window.__finzNotify && window.__finzNotify("No pude leer el saldo automáticamente. Ingresalo a mano abajo y guardá.")',
            true
          );
        } catch {}
      }
    }
    await sleep(400);
  }
}

// The injected control bar (runs in page context). Exposes window.__finz_result
// and window.__finzNotify, and offers auto-capture + manual-entry + cancel.
function buildToolbar(acc) {
  const hasUyu = acc.currencies.includes('UYU');
  const hasUsd = acc.currencies.includes('USD');
  const cfg = JSON.stringify({ name: acc.name, hasUyu, hasUsd });
  return `(() => {
    if (window.__finzBarInjected) return;
    window.__finzBarInjected = true;
    const cfg = ${cfg};
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0f172a;color:#e2e8f0;font:13px/1.4 system-ui,Segoe UI,sans-serif;padding:8px 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;box-shadow:0 2px 8px rgba(0,0,0,.4);';
    const mk = (tag, css, txt) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (txt != null) e.textContent = txt; return e; };
    const btnCss = 'cursor:pointer;border:0;border-radius:6px;padding:6px 10px;font-weight:600;';
    const inputCss = 'width:120px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;padding:5px 8px;';

    const title = mk('span', 'font-weight:700;color:#93c5fd;', 'Finanzas · ' + cfg.name);
    const hint = mk('span', 'opacity:.85;', '— Logueate y completá el 2FA, después capturá el saldo.');
    const auto = mk('button', btnCss + 'background:#22c55e;color:#06210f;', '⤓ Capturar automático');

    const manualWrap = mk('span', 'display:flex;align-items:center;gap:6px;');
    let inUyu = null, inUsd = null;
    if (cfg.hasUyu) { manualWrap.appendChild(mk('span', '', '$U')); inUyu = mk('input', inputCss); inUyu.placeholder='Pesos'; inUyu.inputMode='decimal'; manualWrap.appendChild(inUyu); }
    if (cfg.hasUsd) { manualWrap.appendChild(mk('span', '', 'U$S')); inUsd = mk('input', inputCss); inUsd.placeholder='Dólares'; inUsd.inputMode='decimal'; manualWrap.appendChild(inUsd); }
    const saveManual = mk('button', btnCss + 'background:#3b82f6;color:#fff;', '✓ Guardar manual');
    const cancel = mk('button', btnCss + 'background:#475569;color:#fff;', '✕ Cancelar');
    const notify = mk('span', 'flex-basis:100%;color:#fca5a5;min-height:0;', '');

    window.__finzNotify = (m) => { notify.textContent = m; };
    const parse = (el) => { if (!el) return null; const v = el.value.trim(); return v === '' ? null : v; };
    auto.onclick = () => { notify.textContent = 'Leyendo saldo…'; window.__finz_result = { action: 'auto' }; };
    saveManual.onclick = () => { window.__finz_result = { action: 'manual', uyu: parse(inUyu), usd: parse(inUsd) }; };
    cancel.onclick = () => { window.__finz_result = { action: 'cancel' }; };

    [title, hint, auto, manualWrap, saveManual, cancel, notify].forEach((e) => bar.appendChild(e));
    document.documentElement.appendChild(bar);
    // Push page content down so the bar never hides anything.
    try { document.body.style.marginTop = (bar.offsetHeight + 4) + 'px'; } catch {}
  })();`;
}

module.exports = {
  status,
  unlock,
  lock,
  getState,
  saveCreds,
  saveManual,
  refreshBank,
};
