const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
  weather: { latitude: -34.9011, longitude: -56.1645, label: 'Montevideo, UY' },
  refreshMinutesAI: 15,
  elevenLabsApiKey: '',
  // MongoDB Atlas connection string for Finanzas. When set, Mongo is the primary
  // store and SQLite is kept as a local mirror; leave empty to run SQLite-only.
  // Kept out of git (config.json is gitignored); can also be set via the
  // FINANCES_MONGO_URI environment variable.
  financesMongoUri: '',
  // Zoom factor for the widget window (corner-drag scaling). 1 = 100%.
  widgetZoom: 1,
  // Mantener la ventana siempre por encima de las demás. Apagado por defecto:
  // así se puede tapar con cualquier otra app (Settings / menú de la bandeja).
  alwaysOnTop: false,
  apiKeys: [],
  // Símbolos del bloque "Acciones y ETFs" del card Mercado (Finnhub).
  stockSymbols: ['AAPL', 'MSFT', 'NVDA', 'SPY', 'VOO'],
  pricing: {
    claude: {
      perMillionInput: 3,
      perMillionOutput: 15,
      perMillionCacheRead: 0.30,
      perMillionCacheCreate: 3.75,
    },
    planWeeklyEquivalent: {
      'Pro': 80,
      'MAX 5x': 400,
      'MAX 20x': 1500,
      'Plus': 50,
      'Pro+': 200,
      'Business': 200,
      'Enterprise': 500,
    },
  },
};

function mergePricing(parsed) {
  const userPricing = (parsed && parsed.pricing) || {};
  return {
    claude: { ...DEFAULTS.pricing.claude, ...(userPricing.claude || {}) },
    planWeeklyEquivalent: {
      ...DEFAULTS.pricing.planWeeklyEquivalent,
      ...(userPricing.planWeeklyEquivalent || {}),
    },
  };
}

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULTS,
      ...parsed,
      weather: { ...DEFAULTS.weather, ...(parsed.weather || {}) },
      pricing: mergePricing(parsed),
    };
  } catch {
    return { ...DEFAULTS, pricing: mergePricing(null) };
  }
}

function saveConfig(patch) {
  const cur = loadConfig();
  const next = { ...cur, ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

// Key del tab API Keys por nombre de servicio. Match tolerante: se comparan
// los nombres normalizados (minúsculas, sin espacios ni signos), se aceptan
// los alias de cada servicio ("The Movie Database" → TMDB) y, como último
// recurso, un nombre que contenga al buscado ("ElevenLabs Api", "Finnhub key").
// Lo usan main.js (getApiKey) y los fetchers standalone (ElevenLabs).
const KEY_ALIASES = {
  tmdb: ['themoviedatabase', 'themoviedb', 'moviedatabase', 'moviedb', 'themovedatabase'],
  github: ['githubtoken', 'gh'],
  elevenlabs: ['elevenlabsapi', 'eleven', '11labs'],
};
const normKeyName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function findApiKey(list, name) {
  const keys = Array.isArray(list) ? list : [];
  const want = normKeyName(name);
  if (!want) return '';
  const names = [want, ...(KEY_ALIASES[want] || [])];
  const hit = keys.find((k) => names.includes(normKeyName(k.name)))
    || keys.find((k) => normKeyName(k.name).includes(want));
  return (hit && hit.key) || '';
}

module.exports = { loadConfig, saveConfig, findApiKey, CONFIG_PATH };
