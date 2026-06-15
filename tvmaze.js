// TVMaze (main process): próximos episodios de las series favoritas.
//
// API gratis y sin key. El cruce con los favoritos EZTV es por imdb id:
//   /lookup/shows?imdb=tt…   → show de TVMaze (redirect al show)
//   /shows/{id}?embed[]=nextepisode&embed[]=previousepisode → fechas de emisión
// El lookup imdb→show se cachea en memoria (no cambia nunca); el próximo
// episodio se vuelve a pedir en cada refresh. Tira en error — el handler IPC
// degrada a { error }.

const { getJson } = require('./netJson');

const BASE = 'https://api.tvmaze.com';
const lookupCache = new Map();   // imdbNum → show id de TVMaze | null

async function lookupShowId(imdbNum) {
  const num = String(imdbNum || '').replace(/^tt/i, '');
  if (!num) return null;
  if (lookupCache.has(num)) return lookupCache.get(num);
  let id = null;
  try {
    const show = await getJson(`${BASE}/lookup/shows?imdb=tt${num}`);
    if (show && show.id) id = show.id;
  } catch {}
  lookupCache.set(num, id);
  return id;
}

function normalizeEpisode(ep) {
  if (!ep) return null;
  return {
    season: ep.season ?? null,
    episode: ep.number ?? null,
    name: ep.name || '',
    airstamp: ep.airstamp ? Date.parse(ep.airstamp) : null,
  };
}

// Estado de cada serie favorita: próximo episodio (si la serie sigue) y el
// último emitido. `imdbIds` viene de los favoritos guardados en la base.
async function fetchUpcoming(imdbIds) {
  const distinct = [...new Set((imdbIds || []).map((s) => String(s || '').replace(/^tt/i, '')).filter(Boolean))];
  const shows = await Promise.all(distinct.map(async (num) => {
    const id = await lookupShowId(num);
    if (!id) return null;
    try {
      const s = await getJson(`${BASE}/shows/${id}?embed[]=nextepisode&embed[]=previousepisode`);
      return {
        imdbNum: num,
        tvmazeId: id,
        title: s.name || '—',
        status: s.status || '',          // "Running" | "Ended" | "To Be Determined"…
        network: (s.network && s.network.name) || (s.webChannel && s.webChannel.name) || '',
        image: (s.image && (s.image.medium || s.image.original)) || null,
        url: s.url || null,
        next: normalizeEpisode(s._embedded && s._embedded.nextepisode),
        prev: normalizeEpisode(s._embedded && s._embedded.previousepisode),
      };
    } catch {
      return null;
    }
  }));
  const list = shows.filter(Boolean);
  // Primero las que tienen próximo episodio (por fecha), después el resto.
  list.sort((a, b) => {
    const an = a.next && a.next.airstamp, bn = b.next && b.next.airstamp;
    if (an && bn) return an - bn;
    if (an) return -1;
    if (bn) return 1;
    return (b.prev && b.prev.airstamp || 0) - (a.prev && a.prev.airstamp || 0);
  });
  return { shows: list, fetchedAt: Date.now() };
}

module.exports = { fetchUpcoming };
