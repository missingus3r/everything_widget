// Feriados (main process): próximos feriados públicos de Uruguay vía Nager.Date
// (gratis, sin key). La lista cambia una vez al año: cache en memoria por 12 h.

const { getJson } = require('./netJson');

const CACHE_MS = 12 * 60 * 60 * 1000;
let cache = null;          // { holidays, fetchedAt }

async function fetchHolidays(countryCode = 'UY') {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  const arr = await getJson(`https://date.nager.at/api/v3/NextPublicHolidays/${countryCode}`);
  const holidays = (Array.isArray(arr) ? arr : []).map((h) => ({
    date: h.date || null,                      // "2026-06-19"
    name: h.localName || h.name || '—',
    // Fecha local a mediodía para que el countdown en días no patine por TZ.
    ts: h.date ? Date.parse(`${h.date}T12:00:00`) : null,
  })).filter((h) => h.ts);
  cache = { holidays, fetchedAt: Date.now() };
  return cache;
}

module.exports = { fetchHolidays };
