// Estado del PC y keys compartidas para Nexus Mobile (main process).
//
// El teléfono no puede leer CPU/RAM/red de esta máquina ni correr `claude` o
// `codex` para el AI Usage, así que el widget publica un snapshot en Mongo
// cada pocos minutos (`pc_status`, un solo documento que se reemplaza). Las
// keys que el teléfono necesita (TMDB, GitHub, Finnhub) van en `app_keys`
// para no cargarlas dos veces. También crea los índices de EZTV que el
// teléfono usa para listar episodios por serie (el widget lista desde SQLite
// y no los necesita). Todo best-effort: sin Mongo, o con el cluster lleno, no
// hace nada.

const mongo = require('./finances/mongo');
const { findApiKey } = require('./config');

const STATUS_COLLECTION = 'pc_status';
const KEYS_COLLECTION = 'app_keys';

function buildPcStatus({ system, net, speedtest, ai, forecast, stockSymbols, now = Date.now() } = {}) {
  const a = ai || {};
  return {
    _id: 'pc',
    updated_at: now,
    system: system || null,
    net: { usage: net || null, speedtest: speedtest || null },
    ai: {
      claude: a.claude || null,
      codex: a.codex || null,
      eleven: a.eleven || null,
      local: a.local || null,
      forecast: forecast || null,
    },
    stockSymbols: Array.isArray(stockSymbols) ? stockSymbols : [],
  };
}

function buildAppKeys(apiKeys, now = Date.now()) {
  return {
    _id: 'keys',
    tmdb: findApiKey(apiKeys, 'TMDB') || null,
    github: findApiKey(apiKeys, 'GitHub') || null,
    finnhub: findApiKey(apiKeys, 'Finnhub') || null,
    updated_at: now,
  };
}

// Handle de la base o null si no corresponde escribir.
async function writableDb() {
  if (!mongo.isEnabled() || mongo.getQuotaState().blocked) return null;
  return mongo.connect();
}

async function publishStatus(state) {
  try {
    const db = await writableDb();
    if (!db) return;
    const doc = buildPcStatus(state);
    await db.collection(STATUS_COLLECTION).replaceOne({ _id: doc._id }, doc, { upsert: true });
  } catch (e) {
    mongo.noteError && mongo.noteError(e);
    console.warn('[pcPublish] pc_status:', e.message);
  }
}

async function publishKeys(apiKeys) {
  try {
    const db = await writableDb();
    if (!db) return;
    const doc = buildAppKeys(apiKeys);
    await db.collection(KEYS_COLLECTION).replaceOne({ _id: doc._id }, doc, { upsert: true });
  } catch (e) {
    console.warn('[pcPublish] app_keys:', e.message);
  }
}

async function ensureIndexes() {
  try {
    const db = await writableDb();
    if (!db) return;
    const ez = db.collection('eztv_torrents');
    await ez.createIndex({ show_key: 1, released_at: -1 });
    await ez.createIndex({ imdb_id: 1 });
  } catch (e) {
    console.warn('[pcPublish] índices:', e.message);
  }
}

// Publica una vez al arrancar y después cada `intervalMs`. `getState` arma el
// estado del momento (async); si tira, ese ciclo se saltea.
function start({ getState, intervalMs = 2 * 60 * 1000 }) {
  const tick = async () => {
    let state;
    try { state = await getState(); } catch (e) { console.warn('[pcPublish] estado:', e.message); return; }
    await publishStatus(state);
  };
  tick();
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = { buildPcStatus, buildAppKeys, publishStatus, publishKeys, ensureIndexes, start };
