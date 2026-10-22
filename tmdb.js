// TMDB (main process): ficha en español + "dónde ver" para el modal de series,
// y ficha de película (sinopsis, reparto, similares) para las películas de
// LimeTorrents que YIFY no tiene.
//
// Necesita key guardada en API Keys con el nombre exactamente "TMDB". Acepta
// las dos variantes: la v3 (api_key=… en query) y el read access token v4
// (JWT "eyJ…" → header Bearer). Cruce por imdb id:
//   /3/find/tt…?external_source=imdb_id   → tv_results[0] / movie_results[0]
//   /3/tv/{id}?language=es-ES             → overview/rating/géneros en español
//   /3/tv/{id}/watch/providers            → streamings por país (usamos UY)
//   /3/movie/{id}?append_to_response=…    → ficha + credits + similares + videos
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

// ── Películas ──────────────────────────────────────────────────
// Ficha de película con la forma que consume el modal de Films (la misma que
// arma yify.js): synopsis, cast [{ name, character }], genres, rating, trailer
// y `similar` (recomendaciones + similares de TMDB, sin repetir). Los
// similares llevan tmdbId — el renderer los resuelve a YIFY/Lime al click.
const movieCache = new Map();   // tmdbId → ficha
const imdbToTmdb = new Map();   // imdb → tmdbId | null

function movieYear(d) {
  const y = d && d.release_date ? Number(String(d.release_date).slice(0, 4)) : null;
  return y || null;
}

async function fetchMovieByTmdbId(key, tmdbId) {
  if (!key) return { error: 'sin key' };
  const id = Number(tmdbId);
  if (!id) return { error: 'tmdb id inválido' };
  if (movieCache.has(id)) return movieCache.get(id);

  const det = await req(key, `/movie/${id}`, {
    language: 'es-ES',
    append_to_response: 'credits,similar,recommendations,videos',
    include_video_language: 'es,en,null',
  });
  if (!det || !det.id) return { error: 'sin ficha en TMDB' };
  // Sin sinopsis en español: la versión en inglés antes que nada.
  let overview = det.overview || '';
  if (!overview) {
    try { overview = (await req(key, `/movie/${id}`, { language: 'en-US' })).overview || ''; } catch {}
  }
  const vids = (det.videos && Array.isArray(det.videos.results)) ? det.videos.results : [];
  const trailer = vids.find((v) => v.site === 'YouTube' && v.type === 'Trailer')
    || vids.find((v) => v.site === 'YouTube' && v.type === 'Teaser');
  const seen = new Set([id]);
  const similar = [];
  for (const s of [
    ...((det.recommendations && det.recommendations.results) || []),
    ...((det.similar && det.similar.results) || []),
  ]) {
    if (!s || !s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    similar.push({
      src: 'tmdb',
      id: s.id,
      tmdbId: s.id,
      title: s.title || s.original_title || '—',
      year: movieYear(s),
      rating: typeof s.vote_average === 'number' && s.vote_average > 0 ? Math.round(s.vote_average * 10) / 10 : null,
      cover: IMG(s.poster_path, 'w342'),
    });
    if (similar.length >= 8) break;
  }
  const ficha = {
    source: 'tmdb',
    tmdbId: id,
    imdb: det.imdb_id || null,
    title: det.title || det.original_title || '—',
    year: movieYear(det),
    rating: typeof det.vote_average === 'number' && det.vote_average > 0 ? Math.round(det.vote_average * 10) / 10 : null,
    runtime: det.runtime || null,
    genres: Array.isArray(det.genres) ? det.genres.map((g) => g.name) : [],
    synopsis: overview,
    cover: IMG(det.poster_path, 'w342'),
    trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
    cast: ((det.credits && det.credits.cast) || []).slice(0, 6).map((c) => ({
      name: c.name || '',
      character: c.character || '',
    })),
    suggestions: similar,
    fetchedAt: Date.now(),
  };
  movieCache.set(id, ficha);
  if (ficha.imdb) imdbToTmdb.set(ficha.imdb.toLowerCase(), id);
  return ficha;
}

async function fetchMovieByImdb(key, imdb) {
  if (!key) return { error: 'sin key' };
  const code = String(imdb || '').trim().toLowerCase();
  if (!/^tt\d+$/.test(code)) return { error: 'imdb id inválido' };
  if (!imdbToTmdb.has(code)) {
    const found = await req(key, `/find/${code}`, { external_source: 'imdb_id' });
    const hit = found && Array.isArray(found.movie_results) ? found.movie_results[0] : null;
    imdbToTmdb.set(code, hit ? hit.id : null);
  }
  const id = imdbToTmdb.get(code);
  if (!id) return { error: 'sin ficha en TMDB' };
  return fetchMovieByTmdbId(key, id);
}

module.exports = { fetchTvByImdb, fetchMovieByImdb, fetchMovieByTmdbId };
