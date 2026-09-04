// LimeTorrents RSS (main process): últimas subidas de películas vía el feed
// RSS de limetorrents.fun. Segunda fuente del tab Films junto a YIFY.
//
// El feed filtrado por categoría es /rss/16/ (16 = Movies). Ojo: /rss/movies/
// existe pero ignora el filtro y devuelve todas las categorías mezcladas.
// El RSS no tiene búsqueda, fichas ni covers — solo el listado reciente con
// título de release, tamaño, seeds/leechers y el infohash (en la URL del
// .torrent de itorrents.org), de donde se arma el magnet. El poster y el
// título limpio salen de la suggestion API de IMDb (mismo truco que eztv.js):
// se parsea nombre + año del release, se agrupan los releases por película y
// cada grupo se enriquece con la ficha. Series y juegos también llevan
// miniatura: series por la misma suggestion API (prefiriendo resultados TV) y
// juegos por la búsqueda de la tienda de Steam. Mismo contrato defensivo que
// yify.js/eztv.js: checkLime() es el probe barato de arranque (nunca rechaza)
// y fetchLimeMovies() tira — IPC lo convierte a { error }.

const https = require('https');
const archive = require('./limeArchive');

// El número del feed es la CATEGORÍA (no una página — /rss/16/2/ y ?p=2
// devuelven siempre lo mismo). Mapa sondeado en vivo: 1=Anime, 2-7=Apps,
// 8=Games (9-15 subcategorías), 16=Movies, 17-19=Music, 20=TV, 21-25=Other.
const LIME_RSS_BASE = 'https://www.limetorrents.fun/rss/';
const LIME_CATS = { movies: 16, tv: 20, games: 8, anime: 1 };
const IMDB_SUGGEST = 'https://v3.sg.media-imdb.com/suggestion/x';

// Mismos trackers públicos que yify.js para armar los magnet links.
const TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://torrent.gresille.org:80/announce',
  'udp://p4p.arenabg.com:1337',
  'udp://tracker.leechers-paradise.org:6969',
];

function getText(url, timeoutMs = 12000) {
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
      res.on('end', () => resolve(buf));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function getJson(url, timeoutMs = 8000) {
  return getText(url, timeoutMs).then((buf) => {
    try { return JSON.parse(buf); }
    catch { throw new Error('respuesta no es JSON'); }
  });
}

function tagContent(block, name) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1].trim() : '';
}

function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'");
}

function humanSize(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

// El RSS no expone calidad como campo: se parsea del nombre del release.
function qualityFrom(s) {
  const m = /\b(2160p|1080p|720p|480p)\b/i.exec(s || '');
  return m ? m[1].toLowerCase() : '';
}

function magnetFor(hash, title) {
  const dn = encodeURIComponent(title || 'movie');
  const trs = TRACKERS.map((t) => '&tr=' + encodeURIComponent(t)).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${dn}${trs}`;
}

// Un <item> del feed → objeto normalizado (misma forma de fila que EZTV).
// `category` solo viene en el RSS de búsqueda ("Movies", "TV shows", …).
function parseItem(block) {
  const title = decodeXml(tagContent(block, 'title'));
  const desc = decodeXml(tagContent(block, 'description'));
  const category = decodeXml(tagContent(block, 'category')) || '';
  const seeds = /Seeds:\s*(\d+)/i.exec(desc);
  const peers = /Leechers:\s*(\d+)/i.exec(desc);
  const sizeBytes = Number(tagContent(block, 'size')) || null;
  const pubDate = Date.parse(tagContent(block, 'pubDate'));
  // El infohash viaja en la URL del .torrent de itorrents.org del enclosure.
  const encl = /<enclosure[^>]*url=["']([^"']+)["']/i.exec(block);
  const torrentUrl = encl ? decodeXml(encl[1]) : null;
  const hashM = torrentUrl ? /\/torrent\/([A-F0-9]{32,40})\.torrent/i.exec(torrentUrl) : null;
  const hash = hashM ? hashM[1].toUpperCase() : null;
  const page = decodeXml(tagContent(block, 'link')) || null;
  // Id numérico de la página del torrent: clave del archivo histórico.
  const idM = page ? /torrent-(\d+)\.html/i.exec(page) : null;
  return {
    id: idM ? Number(idM[1]) : null,
    title,
    category,
    page,   // ficha en limetorrents
    quality: qualityFrom(title),
    size: humanSize(sizeBytes),
    sizeBytes,
    seeds: seeds ? Number(seeds[1]) : null,
    peers: peers ? Number(peers[1]) : null,
    hash,
    torrentUrl,
    url: torrentUrl,   // alias con la forma de los torrents de YIFY (.torrent)
    magnet: hash ? magnetFor(hash, title) : null,
    releasedAt: isFinite(pubDate) ? pubDate : null,
  };
}

// Baja y parsea el feed completo de una categoría. Valida la forma (un mirror
// caído puede devolver HTML 200 sin items). Tira en error.
async function fetchFeed(cat = 'movies', timeoutMs = 12000) {
  const id = LIME_CATS[cat] || LIME_CATS.movies;
  const xml = await getText(`${LIME_RSS_BASE}${id}/`, timeoutMs);
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi);
  if (!blocks || !blocks.length) throw new Error('respuesta inesperada (sin items)');
  return blocks.map(parseItem).filter((t) => t.title);
}

// Búsqueda del sitio vía su RSS (/searchrss/<query>/): mismos items que los
// feeds por categoría pero mezclando todas — cada item trae <category>
// ("Movies", "TV shows", "Games - PC", …) y acá se filtra a la pedida.
const SEARCH_CATS = { movies: /^movies/i, tv: /^tv/i, games: /^games/i, anime: /^anime/i };

async function searchFeed(query, cat, timeoutMs = 12000) {
  const q = encodeURIComponent(String(query || '').trim().replace(/\s+/g, ' '));
  const xml = await getText(`https://www.limetorrents.fun/searchrss/${q}/`, timeoutMs);
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const re = SEARCH_CATS[cat];
  return blocks.map(parseItem).filter((t) => t.title && (!re || re.test(t.category)));
}

// Probe barato de arranque (con el feed de Movies; todas las categorías salen
// del mismo generador RSS, así que una alcanza). Nunca rechaza.
async function checkLime() {
  try {
    await fetchFeed('movies', 8000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// Nombre de la serie desde el título del release: corta en el marcador de
// episodio/temporada ("Show S05E03…", "Show 2x07…", "Show Season 2…") o, si
// no hay, en el primer año o tag de calidad/formato. Un año pegado al nombre
// ("Hijack 2023", "… (2020) s01e28") sale del nombre y desambigua la búsqueda.
function tvNameFrom(title) {
  const t = String(title || '').replace(/[._]/g, ' ');
  const clean = (s) => s.replace(/[\s\-:([\]]+$/g, '').trim();
  const em = /^(.*?)\b(S\d{1,2}(?:E\d{1,3})?|Season\s*\d+|\d{1,2}x\d{2})\b/i.exec(t);
  let name = (em && clean(em[1])) || null;
  if (!name) {
    const qm = /^(.*?)\b(2160p|1080p|720p|480p|WEB-?DL|WEBRip|HDTV|BluRay|x264|x265|HEVC)\b/i.exec(t);
    name = clean(qm ? qm[1] : t) || t.trim();
  }
  let year = null;
  const ym = /[\s(]((?:19|20)\d{2})\)?$/.exec(name);
  if (ym) {
    year = Number(ym[1]);
    name = clean(name.slice(0, ym.index)) || name;
  }
  return { name, year };
}

// Temporada/episodio del título del release ("S05E03", "5x03"). Un season
// pack ("Show S05 1080p…") queda con episode null.
function epFrom(title) {
  const t = String(title || '');
  let m = /\bS(\d{1,2})[\s.]?E(\d{1,3})\b/i.exec(t);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /\b(\d{1,2})x(\d{2,3})\b/.exec(t);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = /\bS(\d{1,2})\b/i.exec(t);
  if (m) return { season: Number(m[1]), episode: null };
  return { season: null, episode: null };
}

// Nombre del juego desde el título del release: fuera los tags entre
// corchetes ("[FitGirl Repack]", "[NSZ]", ids de Switch), corta en el primer
// tag de versión/build/repack/plataforma y tira el sufijo del grupo
// ("-TENOKE").
function gameNameFrom(title) {
  const t = String(title || '')
    .replace(/\[[^\]]*\]?/g, ' ')
    .replace(/[._]/g, ' ');
  const clean = (s) => s.replace(/[\s\-–—:([\]]+$/g, '').trim();
  // El grupo `\d+( \d+){2,}` son versiones sueltas sin la "v" ("1 0 29242").
  const m = /^(.*?)\b(v\d[\w.]*|\d+(?:[ .]\d+){2,}|Build\s*\d+|Update\s*v?\d*|Hotfix|REPACK|Repack|FitGirl|ElAmigos|DODI|MULTi\d*|GOG\b|DLC|Early Access|Incl\b|NSW|NSZ|NSP|XCI|7z\b|x64|x86|Win(?:dows)?\b|Linux|macOS)\b/i.exec(t);
  const name = clean((m ? m[1] : t).replace(/[-–][A-Za-z0-9]{2,15}$/, ''));
  return name || t.trim();
}

// Clave de agrupado insensible a puntuación: "Hollow Knight: Silksong" y
// "Hollow Knight - Silksong" son el mismo juego/show.
function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Miniatura del juego vía la búsqueda de la tienda de Steam (sin key). Solo
// se acepta un resultado que se parezca al nombre parseado (mejor sin imagen
// que con la de otro juego). Cache en memoria — null = "no hay match".
const STEAM_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const steamMetaCache = new Map();
async function steamGameMeta(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  if (steamMetaCache.has(key)) return steamMetaCache.get(key);
  let meta = null;
  try {
    const data = await getJson(`${STEAM_SEARCH}?term=${encodeURIComponent(name)}&l=english&cc=US`, 8000);
    const items = (data && Array.isArray(data.items)) ? data.items : [];
    const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean));
    const want = tokens(name);
    let best = null, bestScore = 0;
    for (const it of items) {
      const have = tokens(it.name);
      let common = 0;
      for (const w of want) if (have.has(w)) common++;
      const score = common / Math.max(want.size, have.size, 1);
      if (score > bestScore) { best = it; bestScore = score; }
    }
    if (best && bestScore >= 0.5 && best.tiny_image) {
      meta = { name: best.name, cover: best.tiny_image, appId: best.id };
    }
  } catch {}
  steamMetaCache.set(key, meta);
  return meta;
}

// Enriquecimiento de un release: nombre parseado + ficha/miniatura según la
// categoría (películas y series → suggestion API de IMDb; juegos → capsule
// de Steam). Muta el objeto; el archivo persiste el resultado y no se vuelve
// a pedir.
async function enrichRelease(cat, t) {
  if (cat === 'movies') {
    const { name, year } = movieNameFrom(t.title);
    t.name = name;
    t.year = year;
    const meta = await imdbMeta(name, year, 'movie');
    if (meta) {
      t.imdb = meta.imdbId;
      t.imdbTitle = meta.title;
      t.imdbYear = meta.year;
      t.cover = meta.image;
    }
  } else if (cat === 'tv') {
    const { name, year } = tvNameFrom(t.title);
    t.name = name;
    if (year) t.year = year;
    const meta = await imdbMeta(name, year, 'tv');
    if (meta) {
      t.imdb = meta.imdbId;
      t.imdbTitle = meta.title;
      t.imdbYear = meta.year;
      t.cover = meta.image;
    }
  } else if (cat === 'games') {
    const name = gameNameFrom(t.title);
    t.name = name;
    const meta = await steamGameMeta(name);
    if (meta) t.cover = meta.cover;
  }
}

// Backfill de miniaturas del histórico (releases archivados antes de que
// existiera el enriquecimiento): de a tandas por fetch y un intento por
// sesión por release, para no martillar las APIs con misses permanentes.
const ENRICH_BACKFILL = 40;
const enrichTried = new Map();   // cat → Set de ids ya intentados esta sesión

async function backfillCovers(cat, torrents) {
  const tried = enrichTried.get(cat) || enrichTried.set(cat, new Set()).get(cat);
  const missing = torrents.filter((t) => !t.cover && !tried.has(t.id)).slice(0, ENRICH_BACKFILL);
  if (!missing.length) return;
  missing.forEach((t) => tried.add(t.id));
  await Promise.all(missing.map((t) => enrichRelease(cat, t)));
  const got = missing.filter((t) => t.cover);
  // El upsert (COALESCE) solo completa lo que faltaba; los objetos ya quedaron
  // mutados en memoria, no hace falta re-listar.
  if (got.length) await archive.ingest(cat, got);
}

// Fetch estándar de una categoría: baja el feed vivo, enriquece los releases
// nuevos, archiva (el RSS solo retiene ~50 — el histórico vive en la base),
// backfillea miniaturas y devuelve la ventana reciente del histórico.
// El histórico se lista ENTERO (sin ventana): agrupar solo los N releases más
// recientes hacía que, al llegar subidas nuevas, los releases viejos se
// cayeran de la ventana y con ellos las películas/series/juegos que solo
// tenían esos releases — el total del pager bajaba con cada "actualizar".
async function fetchCatRows(cat) {
  const live = await fetchFeed(cat);
  const known = await archive.existingIds(live.map((t) => t.id).filter(Boolean));
  await Promise.all(live.filter((t) => t.id && !known.has(t.id)).map((t) => enrichRelease(cat, t)));
  await archive.ingest(cat, live);
  const rows = await archive.list(cat);
  await backfillCovers(cat, rows);
  return rows;
}

// Agrupa releases de series por show (ficha de IMDb o nombre parseado): una
// card por serie con sus episodios adentro, como las de EZTV. Cada episodio
// lleva season/episode parseados para la tabla del modal.
function groupTvShows(rows) {
  const groups = new Map();   // orden de inserción = release más reciente primero
  for (const t of rows) {
    // Siempre re-parsear el nombre: usa la versión vigente del parser aunque
    // la fila se haya archivado con una anterior.
    const name = tvNameFrom(t.title).name;
    const key = t.imdb ? `id:${t.imdb}` : `q:${normKey(name)}`;
    let g = groups.get(key);
    if (!g) {
      g = { source: 'lime', title: t.imdbTitle || name, year: t.imdbYear || t.year || null,
            imdb: t.imdb || null,
            imdbNum: t.imdb ? Number(t.imdb.replace(/^tt/, '')) : null,
            cover: t.cover || null, page: t.page, episodes: [], latestAt: 0 };
      g.id = limeFavId(g);
      groups.set(key, g);
    }
    g.episodes.push({ ...t, ...epFrom(t.title) });
    if (!g.cover && t.cover) g.cover = t.cover;
    if (t.releasedAt && t.releasedAt > g.latestAt) g.latestAt = t.releasedAt;
  }
  return [...groups.values()];
}

// Agrupa releases de juegos por nombre parseado: una card por juego (como
// las ofertas de CheapShark) con sus releases (updates/repacks) adentro.
function groupGames(rows) {
  const groups = new Map();
  for (const t of rows) {
    // Ídem series: el nombre sale siempre del parser vigente.
    const name = gameNameFrom(t.title);
    const key = normKey(name);
    let g = groups.get(key);
    if (!g) {
      g = { source: 'lime', title: name, cover: t.cover || null, page: t.page,
            torrents: [], latestAt: 0 };
      groups.set(key, g);
    }
    g.torrents.push(t);
    if (!g.cover && t.cover) g.cover = t.cover;
    if (t.releasedAt && t.releasedAt > g.latestAt) g.latestAt = t.releasedAt;
  }
  return [...groups.values()];
}

// Series agrupadas por show (tab Series) y juegos agrupados (tab Juegos).
async function fetchLimeTvShows() {
  const rows = await fetchCatRows('tv');
  return { count: await archive.count('tv'), shows: groupTvShows(rows), fetchedAt: Date.now() };
}

async function fetchLimeGameGroups() {
  const rows = await fetchCatRows('games');
  return { count: await archive.count('games'), games: groupGames(rows), fetchedAt: Date.now() };
}

// Búsqueda en el sitio, filtrada a la categoría pedida y agrupada igual que
// el listado de su tab (movies → cards de película, tv → shows, games →
// juegos). Reusa el enriquecimiento ya archivado para no repetir APIs, y
// archiva lo nuevo (aditivo). Tira en error del feed.
const SEARCH_LIMIT = 60;

async function searchLime({ cat = 'movies', query = '' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { query: q, movies: [], shows: [], games: [], fetchedAt: Date.now() };
  const found = (await searchFeed(q, cat)).filter((t) => t.id).slice(0, SEARCH_LIMIT);
  const known = await archive.rowsByIds(found.map((t) => t.id));
  await Promise.all(found.map(async (t) => {
    const k = known.get(t.id);
    if (k) {
      t.name = k.name;
      t.year = k.year ?? t.year;
      t.imdb = k.imdb;
      t.imdbTitle = k.imdbTitle;
      t.imdbYear = k.imdbYear;
      t.cover = k.cover;
    }
    if (!t.cover) await enrichRelease(cat, t);
  }));
  await archive.ingest(cat, found);
  const grouped = cat === 'tv' ? { shows: groupTvShows(found) }
    : cat === 'games' ? { games: groupGames(found) }
    : { movies: groupMovies(found) };
  return { query: q, ...grouped, fetchedAt: Date.now() };
}

// Nombre + año de la película desde el título del release: corta en el primer
// año de 4 cifras ("Love Untangled 2025 MULTi…" / "Dead Man's Shoes (2004)…")
// o, si no hay, en el primer tag de calidad/formato.
function movieNameFrom(title) {
  const t = String(title || '').replace(/[._]/g, ' ');
  const clean = (s) => s.replace(/[\s\-:([\]]+$/g, '').trim();
  const ym = /^(.*?)[\s([]+((?:19|20)\d{2})\b/.exec(t);
  if (ym && clean(ym[1])) return { name: clean(ym[1]), year: Number(ym[2]) };
  const qm = /^(.*?)\b(2160p|1080p|720p|480p|WEB-?DL|WEBRip|BluRay|BRRip|HDRip|DVDRip|x264|x265|HEVC|REMUX)\b/i.exec(t);
  const name = clean(qm ? qm[1] : t);
  return { name: name || t.trim(), year: null };
}

// Ficha mínima de IMDb (título limpio + año + poster) vía la suggestion API.
// `kind` decide la preferencia: 'movie' baja las series en el ranking, 'tv'
// las sube (q trae "TV series"/"TV mini-series"). Si el release trae año, se
// prefiere el resultado con ese año (±1). Cache en memoria — null cacheado =
// "no hay ficha".
const imdbMetaCache = new Map();
async function imdbMeta(name, year, kind = 'movie') {
  const key = `${kind}|${String(name || '').trim().toLowerCase()}|${year || ''}`;
  if (!String(name || '').trim()) return null;
  if (imdbMetaCache.has(key)) return imdbMetaCache.get(key);
  let meta = null;
  try {
    const data = await getJson(`${IMDB_SUGGEST}/${encodeURIComponent(name.toLowerCase())}.json`, 8000);
    const items = ((data && Array.isArray(data.d)) ? data.d : [])
      .filter((s) => /^tt\d+$/.test(s.id || ''));
    const wantTv = kind === 'tv';
    const pref = items.filter((s) => /tv/i.test(s.q || '') === wantTv);
    const byYear = (arr) => (year ? arr.find((s) => s.y && Math.abs(s.y - year) <= 1) : null);
    const hit = byYear(pref) || byYear(items) || pref[0] || items[0] || null;
    if (hit) {
      meta = {
        imdbId: hit.id,
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

// Id estable para favoritos: negativo para no chocar nunca con los ids de
// YIFY (positivos). Con match de IMDb es -ttNum (estable entre máquinas);
// sin match, un hash FNV del nombre+año corrido a un rango propio (< -1e10).
function limeFavId(g) {
  if (g.imdb) return -Number(g.imdb.replace(/^tt/, ''));
  const key = `${g.title.toLowerCase()}|${g.year || ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return -(10_000_000_000 + h);
}

// Agrupa releases de películas por ficha de IMDb o nombre+año. La forma
// imita las cards de YIFY (id + cover + url + torrents[]) para que el
// renderer reuse la ficha y los favoritos; source='lime' marca el origen.
function groupMovies(rows) {
  const groups = new Map();   // orden de inserción = release más reciente primero
  for (const t of rows) {
    const name = t.name || movieNameFrom(t.title).name;
    const key = t.imdb ? `id:${t.imdb}` : `q:${name.toLowerCase()}|${t.year || ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { source: 'lime', title: t.imdbTitle || name, year: t.imdbYear || t.year || null,
            imdb: t.imdb || null,
            imdbUrl: t.imdb ? `https://www.imdb.com/title/${t.imdb}/` : null,
            cover: t.cover || null, page: t.page, torrents: [], latestAt: 0 };
      g.id = limeFavId(g);
      g.url = g.imdbUrl || g.page;   // link "ficha" que persiste en favoritos
      groups.set(key, g);
    }
    g.torrents.push(t);
    if (!g.cover && t.cover) g.cover = t.cover;
    if (t.releasedAt && t.releasedAt > g.latestAt) g.latestAt = t.releasedAt;
  }
  return [...groups.values()];
}

// Listado agrupado por película (tab Films), servido desde el histórico.
async function fetchLimeMovies() {
  const rows = await fetchCatRows('movies');
  return { count: await archive.count('movies'), movies: groupMovies(rows), fetchedAt: Date.now() };
}

module.exports = { checkLime, fetchLimeMovies, fetchLimeTvShows, fetchLimeGameGroups, searchLime };
