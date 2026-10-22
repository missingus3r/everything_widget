// YIFY torrents (main process): latest movies + search via the accel.li mirror.
//
// The API is a community mirror and can die at any moment, so everything here
// is defensive: checkYify() is a cheap health probe run at widget startup, and
// fetchYifyMovies() never throws to the caller — IPC wraps it and returns an
// { error } object the renderer turns into an "API caída" state.

const https = require('https');
const { magnetFor } = require('./magnet');

const YIFY_API = 'https://movies-api.accel.li/api/v2';
const YIFY_BASE = `${YIFY_API}/list_movies.json`;

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'NexusWidget/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch (e) { reject(new Error('respuesta no es JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Forma normalizada que consume el renderer. `titleLong`, `uploadedAt`,
// `downloads` y el `hash` de cada torrent son lo que el archivo histórico
// (yifyArchive.js) necesita para guardar la fila y rearmar los magnets.
function normalizeMovie(m) {
  return {
    id: m.id,
    url: m.url || null,                       // yts page
    imdb: m.imdb_code || null,                // ttXXXXXXX — para buscar subtítulos
    title: m.title_english || m.title || '—',
    titleLong: m.title_long || null,
    year: m.year || null,
    rating: typeof m.rating === 'number' ? m.rating : null,
    runtime: m.runtime || null,
    genres: Array.isArray(m.genres) ? m.genres : [],
    cover: m.medium_cover_image || m.small_cover_image || null,
    synopsis: m.summary || m.synopsis || '',
    trailer: m.yt_trailer_code ? `https://www.youtube.com/watch?v=${m.yt_trailer_code}` : null,
    // list_movies.json no trae download_count (sí movie_details.json): queda
    // en null hasta que se abra la ficha de la película.
    downloads: typeof m.download_count === 'number' ? m.download_count : null,
    uploadedAt: m.date_uploaded_unix ? m.date_uploaded_unix * 1000 : null,
    torrents: (Array.isArray(m.torrents) ? m.torrents : []).map((t) => ({
      quality: t.quality || '?',
      type: t.type || '',
      size: t.size || '',
      seeds: t.seeds ?? null,
      peers: t.peers ?? null,
      hash: t.hash || null,
      url: t.url || null,                     // .torrent file
      magnet: t.hash ? magnetFor(t.hash, `${m.title_long || m.title}`) : null,
    })),
  };
}

// Cheap health probe (limit=1): resolves { ok: true } or { ok: false, error }.
// Never rejects — callers can await it without try/catch.
async function checkYify() {
  try {
    const data = await getJson(`${YIFY_BASE}?limit=1`, 8000);
    const ok = data && data.status === 'ok' && data.data && Array.isArray(data.data.movies);
    return ok ? { ok: true } : { ok: false, error: 'respuesta inesperada' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// List/search movies. Throws on failure — the IPC handler converts to { error }.
async function fetchYifyMovies({
  limit = 12, page = 1, query = '', sort = 'date_added',
  genre = '', quality = '', minRating = 0, order = '',
} = {}) {
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(50, limit))),
    page: String(Math.max(1, page)),
    sort_by: sort,
  });
  if (order) params.set('order_by', order);
  if (query) params.set('query_term', query);
  if (genre) params.set('genre', genre);
  if (quality) params.set('quality', quality);
  if (minRating > 0) params.set('minimum_rating', String(Math.min(9, minRating)));
  const data = await getJson(`${YIFY_BASE}?${params.toString()}`);
  if (!data || data.status !== 'ok' || !data.data) throw new Error('respuesta inesperada');
  return {
    count: data.data.movie_count || 0,
    movies: (data.data.movies || []).map(normalizeMovie),
    fetchedAt: Date.now(),
  };
}

// Full details for one movie (cast included). Throws on failure.
async function fetchYifyDetails(movieId) {
  const data = await getJson(`${YIFY_API}/movie_details.json?movie_id=${encodeURIComponent(movieId)}&with_cast=true`);
  const m = data && data.status === 'ok' && data.data && data.data.movie;
  if (!m || !m.id) throw new Error('respuesta inesperada');
  return {
    ...normalizeMovie(m),
    synopsis: m.description_full || m.description_intro || m.summary || '',
    cast: (Array.isArray(m.cast) ? m.cast : []).slice(0, 6).map((c) => ({
      name: c.name || '',
      character: c.character_name || '',
    })),
  };
}

// 4 related movies for the detail modal. Throws on failure.
async function fetchYifySuggestions(movieId) {
  const data = await getJson(`${YIFY_API}/movie_suggestions.json?movie_id=${encodeURIComponent(movieId)}`);
  if (!data || data.status !== 'ok' || !data.data) throw new Error('respuesta inesperada');
  return { movies: (data.data.movies || []).map(normalizeMovie) };
}

// Película por código IMDb ("tt0111161"): list_movies acepta el tt… como
// query_term y matchea por imdb_code. Devuelve la película normalizada o null
// si YIFY no la tiene (la ficha de una película de LimeTorrents se completa
// con esto). Tira si la API falla — el caller distingue "no está" de "caída".
async function fetchYifyByImdb(imdb) {
  const code = String(imdb || '').trim().toLowerCase();
  if (!/^tt\d+$/.test(code)) return null;
  const data = await getJson(`${YIFY_BASE}?query_term=${code}&limit=5`);
  if (!data || data.status !== 'ok' || !data.data) throw new Error('respuesta inesperada');
  const hit = (data.data.movies || []).find((m) => String(m.imdb_code || '').toLowerCase() === code);
  return hit ? normalizeMovie(hit) : null;
}

module.exports = { checkYify, fetchYifyMovies, fetchYifyDetails, fetchYifySuggestions, fetchYifyByImdb };
