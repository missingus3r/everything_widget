// Verificador de las APIs externas del sistema (main process).
//
// Un registro central de todos los servicios que alimentan el widget, cada uno
// con un check barato (endpoint mínimo o probe HTTP HEAD-like). Settings lo usa
// para mostrar el semáforo en línea / caída de cada API. Los checks corren en
// paralelo y nunca rechazan — devuelven { ok, ms, error } por servicio.

const https = require('https');
const { checkYify } = require('./yify');
const { checkEztv } = require('./eztv');
const { checkReddit } = require('./reddit');
const { checkNews } = require('./news');
const mongo = require('./finances/mongo');

// Probe HTTP genérico: ok si el status pasa `okStatus` (default < 400).
// Mide latencia y descarta el body (alcanza con que el server responda bien).
function probe(url, { timeoutMs = 8000, okStatus = (s) => s > 0 && s < 400 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NexusWidget)' } }, (res) => {
      res.resume();
      const ok = okStatus(res.statusCode || 0);
      resolve({ ok, ms: Date.now() - started, error: ok ? null : `HTTP ${res.statusCode}` });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - started, error: String(e && e.message || e) }));
  });
}

// Adapta los health checks existentes ({ ok, error }) agregando latencia.
const timed = (fn) => async () => {
  const started = Date.now();
  const r = await fn();
  return { ok: !!(r && r.ok), ms: Date.now() - started, error: (r && r.ok) ? null : (r && r.error) || 'sin respuesta' };
};

// Status pages estándar (statuspage.io v2): el JSON trae status.indicator
// ("none" = todo bien, "minor"/"major"/"critical" = incidente). Acá "ok" es
// que no haya incidente serio; un minor sale como en línea con la nota.
function probeStatusPage(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NexusWidget)' } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        const ms = Date.now() - started;
        try {
          const data = JSON.parse(buf);
          const ind = data && data.status && data.status.indicator;
          if (ind === 'none' || ind === 'minor') {
            resolve({ ok: true, ms, error: null, note: ind === 'minor' ? 'incidente menor' : null });
          } else {
            resolve({ ok: false, ms, error: `incidente: ${ind || 'desconocido'}` });
          }
        } catch {
          resolve({ ok: false, ms, error: 'respuesta inesperada' });
        }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, ms: Date.now() - started, error: String(e && e.message || e) }));
  });
}

// `url` es el link clickeable de la fila; `endpoints` son las rutas que la app
// realmente consume de ese servicio (se muestran debajo del link en Settings).
// `group` separa las secciones en Settings (APIs del widget / status pages).
const CHECKS = [
  { id: 'weather', name: 'Clima', provider: 'Open-Meteo', host: 'api.open-meteo.com',
    url: 'https://api.open-meteo.com/v1/forecast',
    endpoints: ['/v1/forecast'],
    run: () => probe('https://api.open-meteo.com/v1/forecast?latitude=-34.9&longitude=-56.16&current=temperature_2m') },
  { id: 'crypto', name: 'Cripto', provider: 'CoinGecko', host: 'api.coingecko.com',
    url: 'https://api.coingecko.com/api/v3',
    endpoints: ['/api/v3/simple/price', '/api/v3/ping'],
    run: () => probe('https://api.coingecko.com/api/v3/ping') },
  { id: 'fx_uy', name: 'Divisas UY', provider: 'DolarAPI', host: 'uy.dolarapi.com',
    url: 'https://uy.dolarapi.com/v1/cotizaciones',
    endpoints: ['/v1/cotizaciones'],
    run: () => probe('https://uy.dolarapi.com/v1/cotizaciones') },
  { id: 'fx_world', name: 'Divisas globales', provider: 'ExchangeRate-API', host: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    endpoints: ['/v6/latest/USD'],
    run: () => probe('https://open.er-api.com/v6/latest/USD') },
  { id: 'movies', name: 'Películas', provider: 'YIFY', host: 'movies-api.accel.li',
    url: 'https://movies-api.accel.li/api/v2',
    endpoints: ['/list_movies.json', '/movie_details.json', '/movie_suggestions.json'],
    run: timed(checkYify) },
  { id: 'series', name: 'Series', provider: 'EZTV', host: 'eztvx.to + mirrors',
    url: 'https://eztvx.to/api/get-torrents',
    endpoints: ['/api/get-torrents (eztvx.to · eztv.wf · eztv1.xyz)'],
    run: timed(checkEztv) },
  { id: 'imdb', name: 'Búsqueda de series', provider: 'IMDb', host: 'v3.sg.media-imdb.com',
    url: 'https://v3.sg.media-imdb.com/suggestion/x',
    endpoints: ['/suggestion/x/{query}.json'],
    run: () => probe('https://v3.sg.media-imdb.com/suggestion/x/a.json') },
  { id: 'speedtest', name: 'Speedtest', provider: 'Cloudflare', host: 'speed.cloudflare.com',
    url: 'https://speed.cloudflare.com',
    endpoints: ['/__down', '/__up'],
    run: () => probe('https://speed.cloudflare.com/__down?bytes=0') },
  { id: 'eleven', name: 'Uso ElevenLabs', provider: 'ElevenLabs', host: 'api.elevenlabs.io',
    url: 'https://api.elevenlabs.io/v1',
    endpoints: ['/v1/user/subscription'],
    // Sin API key devuelve 401: también cuenta como "en línea" (el server responde).
    run: () => probe('https://api.elevenlabs.io/v1/models', { okStatus: (s) => s > 0 && s < 500 }) },
  { id: 'mongo', name: 'Base de datos', provider: 'MongoDB Atlas', host: 'cluster Atlas (Finanzas + favoritos)',
    url: 'https://cloud.mongodb.com',
    endpoints: ['mongodb+srv (driver, URI en config.json)'],
    run: async () => {
      const started = Date.now();
      if (!mongo.isEnabled()) return { ok: false, ms: null, error: 'no configurado' };
      const ok = await mongo.isConnected();
      return { ok, ms: Date.now() - started, error: ok ? null : 'sin conexión' };
    } },
  { id: 'tvmaze', name: 'Próximos episodios', provider: 'TVMaze', host: 'api.tvmaze.com',
    url: 'https://api.tvmaze.com',
    endpoints: ['/lookup/shows?imdb=…', '/shows/{id}?embed=nextepisode'],
    run: () => probe('https://api.tvmaze.com/shows/1') },
  { id: 'tmdb', name: 'Fichas de series', provider: 'TMDB', host: 'api.themoviedb.org',
    url: 'https://api.themoviedb.org/3',
    endpoints: ['/3/find/{imdb}', '/3/tv/{id}', '/3/tv/{id}/watch/providers'],
    // Sin key devuelve 401: también cuenta como "en línea" (el server responde).
    run: () => probe('https://api.themoviedb.org/3/configuration', { okStatus: (s) => s > 0 && s < 500 }) },
  { id: 'reddit', name: 'Reddit', provider: 'feeds RSS', host: 'www.reddit.com',
    url: 'https://www.reddit.com',
    endpoints: ['/r/{subs}/{hot|new|top}.rss'],
    run: timed(checkReddit) },
  { id: 'news', name: 'Noticias UY', provider: 'feeds RSS', host: 'montevideo.com.uy · elpais · elobservador…',
    url: 'https://www.montevideo.com.uy',
    endpoints: ['RSS de Montevideo Portal, El País, El Observador, Telemundo, la diaria, La Red 21, Ámbito'],
    run: timed(checkNews) },
  { id: 'holidays', name: 'Feriados', provider: 'Nager.Date', host: 'date.nager.at',
    url: 'https://date.nager.at',
    endpoints: ['/api/v3/NextPublicHolidays/UY'],
    run: () => probe('https://date.nager.at/api/v3/NextPublicHolidays/UY') },
  { id: 'games', name: 'Ofertas de juegos', provider: 'CheapShark', host: 'www.cheapshark.com',
    url: 'https://www.cheapshark.com/api/1.0',
    endpoints: ['/api/1.0/deals', '/api/1.0/stores'],
    run: () => probe('https://www.cheapshark.com/api/1.0/stores') },
  { id: 'github_api', name: 'GitHub', provider: 'GitHub API', host: 'api.github.com',
    url: 'https://api.github.com',
    endpoints: ['/notifications', '/search/issues', '/user/repos'],
    // Sin token responde 401/403: el server está vivo igual.
    run: () => probe('https://api.github.com/zen', { okStatus: (s) => s > 0 && s < 500 }) },
  { id: 'finnhub', name: 'Acciones y ETFs', provider: 'Finnhub', host: 'finnhub.io',
    url: 'https://finnhub.io/api/v1',
    endpoints: ['/api/v1/quote?symbol=…'],
    run: () => probe('https://finnhub.io/api/v1/quote?symbol=AAPL', { okStatus: (s) => s > 0 && s < 500 }) },

  // ── Status pages de servicios (statuspage.io) ────────────────
  // status.anthropic.com redirige (302) a status.claude.com: se apunta directo.
  { id: 'st_anthropic', group: 'status', name: 'Anthropic / Claude', provider: 'status page', host: 'status.claude.com',
    url: 'https://status.claude.com',
    run: () => probeStatusPage('https://status.claude.com/api/v2/status.json') },
  { id: 'st_openai', group: 'status', name: 'OpenAI', provider: 'status page', host: 'status.openai.com',
    url: 'https://status.openai.com',
    run: () => probeStatusPage('https://status.openai.com/api/v2/status.json') },
  { id: 'st_github', group: 'status', name: 'GitHub', provider: 'status page', host: 'www.githubstatus.com',
    url: 'https://www.githubstatus.com',
    run: () => probeStatusPage('https://www.githubstatus.com/api/v2/status.json') },
  { id: 'st_cloudflare', group: 'status', name: 'Cloudflare', provider: 'status page', host: 'www.cloudflarestatus.com',
    url: 'https://www.cloudflarestatus.com',
    run: () => probeStatusPage('https://www.cloudflarestatus.com/api/v2/status.json') },
  { id: 'st_mongodb', group: 'status', name: 'MongoDB Atlas', provider: 'status page', host: 'status.mongodb.com',
    url: 'https://status.mongodb.com',
    run: () => probeStatusPage('https://status.mongodb.com/api/v2/status.json') },
  { id: 'st_elevenlabs', group: 'status', name: 'ElevenLabs', provider: 'status page', host: 'status.elevenlabs.io',
    url: 'https://status.elevenlabs.io',
    run: () => probeStatusPage('https://status.elevenlabs.io/api/v2/status.json') },
];

// Registro estático (sin correr nada): el renderer arma las filas con esto.
function listApiDefs() {
  return CHECKS.map(({ id, name, provider, host, url, endpoints, group }) =>
    ({ id, name, provider, host, url, endpoints, group: group || 'api' }));
}

// Corre los checks (todos, o solo los ids pedidos) en paralelo. Nunca rechaza.
async function checkApis(ids) {
  const wanted = (Array.isArray(ids) && ids.length)
    ? CHECKS.filter((c) => ids.includes(c.id))
    : CHECKS;
  return Promise.all(wanted.map(async (c) => {
    let r;
    try { r = await c.run(); }
    catch (e) { r = { ok: false, ms: null, error: String(e && e.message || e) }; }
    return { id: c.id, name: c.name, provider: c.provider, host: c.host, ...r };
  }));
}

module.exports = { listApiDefs, checkApis };
