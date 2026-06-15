// TMDB (main process): ficha en español + "dónde ver" para el modal de series.
//
// Necesita key guardada en API Keys con el nombre exactamente "TMDB". Acepta
// las dos variantes: la v3 (api_key=… en query) y el read access token v4
// (JWT "eyJ…" → header Bearer). Cruce por imdb id:
//   /3/find/tt…?external_source=imdb_id   → tv_results[0] (id de TMDB)
//   /3/tv/{id}?language=es-ES             → overview/rating/géneros en español
//   /3/tv/{id}/watch/providers            → streamings por país (usamos UY)
// Cache en memoria por imdb id. Tira en error — el handler degrada a { error }.

const { getJson } = require('./netJson');

const BASE = 'https://api.themoviedb.org/3';
const cache = new Map();   // imdbNum → ficha | null

function req(key, path, params = {}) {
  const isBearer = /^eyJ/.test(key);   // token v4 (JWT)
  const qs = new URLSearchParams(params);
  if (!isBearer) qs.set('api_key', key);
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ''}`;
  return getJson(url, { headers: isBearer ? { 'Authorization': `Bearer ${key}` } : {} });
}

const IMG = (p, size) => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);

async function fetchTvByImdb(key, imdbNum, country = 'UY') {
  if (!key) return { error: 'sin key' };
  const num = String(imdbNum || '').replace(/^tt/i, '');
  if (!num) return { error: 'imdb id inválido' };
  if (cache.has(num)) return cache.get(num) || { error: 'sin ficha en TMDB' };

  const found = await req(key, `/find/tt${num}`, { external_source: 'imdb_id' });
  const hit = found && Array.isArray(found.tv_results) ? found.tv_results[0] : null;
  if (!hit) { cache.set(num, null); return { error: 'sin ficha en TMDB' }; }

  const [det, prov] = await Promise.all([
    req(key, `/tv/${hit.id}`, { language: 'es-ES' }),
    req(key, `/tv/${hit.id}/watch/providers`).catch(() => null),
  ]);
  const p = prov && prov.results && (prov.results[country] || prov.results.US);
  const ficha = {
    tmdbId: hit.id,
    title: det.name || hit.name || '—',
    overview: det.overview || hit.overview || '',
    rating: typeof det.vote_average === 'number' ? Math.round(det.vote_average * 10) / 10 : null,
    votes: det.vote_count ?? null,
    genres: Array.isArray(det.genres) ? det.genres.map((g) => g.name) : [],
    firstAir: det.first_air_date || null,
    lastAir: det.last_air_date || null,
    inProduction: !!det.in_production,
    seasons: det.number_of_seasons ?? null,
    episodes: det.number_of_episodes ?? null,
    poster: IMG(det.poster_path || hit.poster_path, 'w342'),
    providers: p && Array.isArray(p.flatrate)
      ? p.flatrate.map((x) => ({ name: x.provider_name, logo: IMG(x.logo_path, 'w45') }))
      : [],
    providersLink: (p && p.link) || null,    // página de TMDB con todas las opciones
    fetchedAt: Date.now(),
  };
  cache.set(num, ficha);
  return ficha;
}

module.exports = { fetchTvByImdb };
