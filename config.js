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
  apiKeys: [],
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

module.exports = { loadConfig, saveConfig, CONFIG_PATH };
