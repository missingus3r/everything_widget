// Encrypted credential store for the Finanzas section.
//
// The master password is provided by the user at unlock time and is NEVER written
// to disk. From it we derive a 32-byte key with scrypt and use AES-256-GCM to
// encrypt the credentials file (.creds). A fixed "verifier" string is stored
// encrypted so we can tell a correct master password from a wrong one (a wrong
// key makes GCM authentication fail on decrypt).
//
// In-memory state (master key + decrypted store) lives only in the main process
// for the duration of the session; it is cleared on lock() / app quit.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CREDS_PATH = path.join(__dirname, '..', '.creds');
const VERIFIER = 'finanzas-ok';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LEN = 32;

// Session state (main-process memory only).
let masterKey = null;     // Buffer | null
let store = null;         // { verifier, accounts: { [id]: { user, pass } } } | null

function fileExists() {
  return fs.existsSync(CREDS_PATH);
}

function isUnlocked() {
  return masterKey !== null && store !== null;
}

function deriveKey(masterPass, salt) {
  return crypto.scryptSync(masterPass, salt, KEY_LEN, SCRYPT_PARAMS);
}

function encryptStore(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(obj), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), data: data.toString('hex') };
}

function decryptStore(key, iv, tag, data) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const out = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(out.toString('utf8'));
}

function writeFile(salt, key, obj) {
  const { iv, tag, data } = encryptStore(key, obj);
  const payload = { v: 1, salt: salt.toString('hex'), iv, tag, data };
  fs.writeFileSync(CREDS_PATH, JSON.stringify(payload), { mode: 0o600 });
}

// Unlock (or initialize) the credential store.
// Returns { ok: true } on success, { ok: false, error } on wrong password.
function unlock(masterPass) {
  if (!masterPass || typeof masterPass !== 'string') {
    return { ok: false, error: 'Master password vacía' };
  }

  if (!fileExists()) {
    // First run: create the store with this master password.
    const salt = crypto.randomBytes(16);
    const key = deriveKey(masterPass, salt);
    const fresh = { verifier: VERIFIER, accounts: {} };
    writeFile(salt, key, fresh);
    masterKey = key;
    store = fresh;
    return { ok: true, created: true };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    const salt = Buffer.from(raw.salt, 'hex');
    const key = deriveKey(masterPass, salt);
    const decoded = decryptStore(key, raw.iv, raw.tag, raw.data);
    if (decoded.verifier !== VERIFIER) {
      return { ok: false, error: 'Master password incorrecta' };
    }
    masterKey = key;
    store = { verifier: VERIFIER, accounts: decoded.accounts || {} };
    return { ok: true };
  } catch (e) {
    // GCM auth failure (wrong key) or corrupt file.
    return { ok: false, error: 'Master password incorrecta' };
  }
}

function lock() {
  masterKey = null;
  store = null;
}

function persist() {
  if (!isUnlocked()) throw new Error('locked');
  const raw = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const salt = Buffer.from(raw.salt, 'hex');
  writeFile(salt, masterKey, store);
}

function getCreds(accountId) {
  if (!isUnlocked()) return null;
  return store.accounts[accountId] || null;
}

function setCreds(accountId, user, pass) {
  if (!isUnlocked()) throw new Error('locked');
  store.accounts[accountId] = { user: String(user || ''), pass: String(pass || '') };
  persist();
}

// Which accounts currently have stored credentials (no secrets returned).
function credsStatus() {
  if (!isUnlocked()) return {};
  const out = {};
  for (const [id, c] of Object.entries(store.accounts)) {
    out[id] = !!(c && c.user && c.pass);
  }
  return out;
}

module.exports = {
  CREDS_PATH,
  fileExists,
  isUnlocked,
  unlock,
  lock,
  getCreds,
  setCreds,
  credsStatus,
};
