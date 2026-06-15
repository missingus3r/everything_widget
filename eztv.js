// EZTV series torrents (main process): últimos episodios + filtro por serie,
// vía la API JSON de eztvx.to (la misma data que el feed RSS de myrss.org/eztv).
//
// La API solo lista (limit/page) y filtra por imdb_id — no tiene búsqueda por
// texto, ni fichas, ni covers. La búsqueda por nombre se resuelve con la
// suggestion API de IMDb (gratis, sin key): nombre → tt id + poster, y con ese
// id se filtra EZTV. Todo defensivo igual que yify.js: checkEztv() es el probe
// barato de arranque y los fetch tiran — el handler IPC convierte a { error }.

const https = require('https');

// Mirrors funcionales de la misma API (idéntico JSON; eztv.re redirige a
// eztvx.to). Se intentan en orden y el que responde queda fijo (sticky) para
// los próximos pedidos; si falla, se rota al siguiente.
const EZTV_MIRRORS = [
  'https://eztvx.to/api/get-torrents',   // dominio oficial actual
  'https://eztv.wf/api/get-torrents',
  'https://eztv1.xyz/api/get-torrents',
];
let mirrorIdx = 0;
const IMDB_SUGGEST = 'https://v3.sg.media-imdb.com/suggestion/x';

function getJson(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NexusWidget)' } }, (res) => {
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

function humanSize(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

// La API no expone calidad como campo: se parsea del nombre del release.
function qualityFrom(s) {
  const m = /\b(2160p|1080p|720p|480p)\b/i.exec(s || '');
  return m ? m[1].toLowerCase() : '';
}

function normalizeTorrent(t) {
  const title = String(t.title || '').replace(/\s*EZTV\s*$/i, '').trim();
  const season = parseInt(t.season, 10) || 0;
  const episode = parseInt(t.episode, 10) || 0;
  return {
    id: t.id,
    hash: t.hash || null,
    title,
    filename: t.filename || '',
    imdbId: t.imdb_id || null,
    season: season > 0 ? season : null,
    episode: episode > 0 ? episode : null,
    quality: qualityFrom(title) || qualityFrom(t.filename),
    size: humanSize(t.size_bytes),
    sizeBytes: Number(t.size_bytes) || null,
    seeds: t.seeds ?? null,
    peers: t.peers ?? null,
    magnet: t.magnet_url || null,
    // small_screenshot llega protocol-relative ("//ezimg.ch/…") y muchas veces vacío.
    screenshot: t.small_screenshot
      ? (/^https?:/i.test(t.small_screenshot) ? t.small_screenshot : `https:${t.small_screenshot}`)
      : null,
    releasedAt: t.date_released_unix ? t.date_released_unix * 1000 : null,
  };
}

// Pedido a la API probando los mirrors en orden desde el último que funcionó.
// Valida la forma de la respuesta (un mirror muerto puede devolver HTML 200).
// Tira solo si fallan todos.
async function apiGet(params, timeoutMs = 12000) {
  let lastErr = null;
  for (let i = 0; i < EZTV_MIRRORS.length; i++) {
    const idx = (mirrorIdx + i) % EZTV_MIRRORS.length;
    try {
      const data = await getJson(`${EZTV_MIRRORS[idx]}?${params}`, timeoutMs);
      if (!data || !Array.isArray(data.torrents)) throw new Error('respuesta inesperada');
      mirrorIdx = idx;   // sticky: el próximo pedido va directo a este mirror
      return data;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('todos los mirrors caídos');
}

// Probe barato de arranque (limit=1). Nunca rechaza.
async function checkEztv() {
  try {
    await apiGet('limit=1', 7000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Listado de episodios: recientes, o de una serie si viene imdbId (dígitos del
// tt id de IMDb, sin el prefijo). Tira en error — IPC lo convierte a { error }.
async function fetchEztvTorrents({ limit = 30, page = 1, imdbId = '' } = {}) {
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(100, limit))),
    page: String(Math.max(1, page)),
  });
  if (imdbId) params.set('imdb_id', String(imdbId).replace(/^tt/i, ''));
  const data = await apiGet(params.toString());
  return {
    count: data.torrents_count || data.torrents.length,
    torrents: data.torrents.map(normalizeTorrent),
    fetchedAt: Date.now(),
  };
}

// Nombre de la serie desde el título del release: corta en el tag de episodio
// (S01E02 / 1x02 / fecha "2025 06 05") o, si no hay, en el tag de calidad.
function showNameFrom(title) {
  const t = String(title || '');
  const m = /^(.*?)(?:\bS\d{1,2}[\s.]?E\d{1,3}\b|\b\d{1,2}x\d{2,3}\b|\b20\d{2}[ .-]\d{2}[ .-]\d{2}\b|\b(?:2160p|1080p|720p|480p)\b)/i.exec(t);
  const name = (m ? m[1] : t).replace(/[._]/g, ' ').replace(/[\s\-:]+$/, '').trim();
  return name || t.trim();
}

// Ficha mínima de IMDb (título limpio + año + poster) vía la suggestion API.
// Sirve tanto por tt id ("tt0903747") como por nombre. Cache en memoria para
// no repetir el pedido en cada página/refresh; null cacheado = "no hay ficha".
const imdbMetaCache = new Map();
async function imdbMeta(query) {
  const key = String(query || '').trim().toLowerCase();
  if (!key) return null;
  if (imdbMetaCache.has(key)) return imdbMetaCache.get(key);
  let meta = null;
  try {
    const data = await getJson(`${IMDB_SUGGEST}/${encodeURIComponent(key)}.json`, 8000);
    const items = (data && Array.isArray(data.d)) ? data.d : [];
    const hit = items.find((s) => /^tt\d+$/.test(s.id || '') && /tv/i.test(s.q || ''))
      || items.find((s) => /^tt\d+$/.test(s.id || ''));
    if (hit) {
      meta = {
        imdbNum: hit.id.replace(/^tt/, ''),
        title: hit.l || null,
        year: hit.y || null,
        image: (hit.i && hit.i.imageUrl)
          ? hit.i.imageUrl.replace(/\._V1_[^.]*\./i, '._V1_UY300_.')
          : null,
      };
    }
  } catch {}
  imdbMetaCache.set(key, meta);
  return meta;
}

// Listado agrupado por serie (vista de cards): baja una página de torrents y
// los apila por imdb_id (o por nombre parseado cuando la API no trae id).
// Cada grupo se enriquece con la ficha de IMDb — poster + nombre limpio + tt
// id para que el modal pueda buscar el resto de los episodios.
async function fetchEztvShows({ limit = 50, page = 1 } = {}) {
  const { count, torrents, fetchedAt } = await fetchEztvTorrents({ limit, page });
  const groups = new Map();   // insertion order = orden de la API (recientes primero)
  for (const t of torrents) {
    const name = showNameFrom(t.title);
    const key = t.imdbId ? `id:${t.imdbId}` : `q:${name.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = { imdbNum: t.imdbId || null, title: name, year: null, image: null, episodes: [], latestAt: 0 };
      groups.set(key, g);
    }
    g.episodes.push(t);
    if (t.releasedAt && t.releasedAt > g.latestAt) g.latestAt = t.releasedAt;
  }
  await Promise.all([...groups.values()].map(async (g) => {
    const meta = await imdbMeta(g.imdbNum ? `tt${g.imdbNum}` : g.title);
    if (meta) {
      if (!g.imdbNum) g.imdbNum = meta.imdbNum;
      if (meta.title) g.title = meta.title;
      g.year = meta.year;
      g.image = meta.image;
    }
    // Sin poster de IMDb: el screenshot de EZTV es mejor que nada.
    if (!g.image) g.image = (g.episodes.find((e) => e.screenshot) || {}).screenshot || null;
  }));
  return { count, shows: [...groups.values()], fetchedAt };
}

// Búsqueda de series por nombre vía la suggestion API de IMDb. Devuelve solo
// resultados de TV con su tt id (lo que EZTV necesita) y el poster.
async function searchShows(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { shows: [] };
  const data = await getJson(`${IMDB_SUGGEST}/${encodeURIComponent(q)}.json`);
  const items = (data && Array.isArray(data.d)) ? data.d : [];
  const shows = items
    .filter((s) => /^tt\d+$/.test(s.id || '') && /tv/i.test(s.q || ''))
    .slice(0, 8)
    .map((s) => ({
      imdbId: s.id,                       // "tt0903747"
      imdbNum: s.id.replace(/^tt/, ''),   // lo que come la API de EZTV
      title: s.l || '—',
      year: s.y || null,
      // El poster llega en resolución completa (~500 KB): se pide la variante
      // de 300px de alto (los chips son chicos y el favorito no necesita más).
      image: (s.i && s.i.imageUrl)
        ? s.i.imageUrl.replace(/\._V1_[^.]*\./i, '._V1_UY300_.')
        : null,
    }));
  return { shows };
}

module.exports = { checkEztv, fetchEztvTorrents, fetchEztvShows, searchShows };
