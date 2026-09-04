// Crawler de los archivos históricos (main process).
//
// Los tabs listan desde la base, así que alguien tiene que llenarla: este
// módulo recorre en segundo plano los catálogos de YIFY, EZTV y CheapShark y
// los archiva. Tres reglas lo gobiernan:
//
//   • Dos ritmos. Mientras una fuente nunca terminó su primera pasada va en
//     modo backfill, pidiendo varias páginas por tick: de a una, las 76.901
//     películas de YIFY eran dos horas de app abierta. Una vez al día pasa a
//     una página por tick, que es todo lo que hacen falta para las novedades.
//   • Todo el avance vive en la base (store_state), así que cerrar la app
//     pausa el crawl y volver a abrirla lo retoma donde iba, no desde cero.
//   • Un tick a la vez y rotando entre fuentes: nunca hay dos tandas
//     encimadas ni una fuente acaparando, son APIs comunitarias y gratuitas.
//     Y cada fuente tiene su propio castigo: que CheapShark conteste 429 no
//     tiene por qué frenar el catálogo de YIFY.
//
// Trucos que impone cada API (medidos, no supuestos):
//   • YIFY pagina el catálogo entero (~77.000 pelis, 50 por página), pero hay
//     que recorrerlo ASCENDENTE por fecha de subida: así las páginas viejas
//     quedan quietas. Descendente, cada novedad corre todo una posición y se
//     saltean películas entre página y página.
//   • EZTV topea la paginación de recientes en la página 100 (~10.000
//     torrents). El histórico profundo solo sale filtrando por imdb_id, así
//     que después de los recientes el crawl sigue serie por serie.
//   • CheapShark corta en 50 páginas por consulta: el catálogo se recorre
//     tienda por tienda, cada una con su propio tope.

const yifyArchive = require('./yifyArchive');
const eztvArchive = require('./eztvArchive');
const gamesArchive = require('./gamesArchive');
const { fetchYifyMovies } = require('./yify');
const { fetchEztvTorrents, imdbMeta } = require('./eztv');
const { fetchDealsPage, fetchStores } = require('./games');

const TICK_MS = 900;                        // separación entre tandas
const START_DELAY_MS = 30 * 1000;           // deja arrancar al widget primero
const ERROR_BACKOFF_MS = [5e3, 15e3, 60e3, 300e3];
// Un 429 no es un error pasajero: CheapShark bloquea la IP por un buen rato
// (probado: después de pasarse, rechaza hasta un pedido suelto en 20 ms).
// Insistir cada 5 segundos solo estira el castigo, así que su escalera arranca
// en un minuto y llega a media hora.
const RATE_LIMIT_BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3];
const isRateLimited = (e) => /429/.test(String(e && e.message || e));
const FRESH_EVERY_MS = 10 * 60 * 1000;      // relectura de novedades por fuente
const REDEAL_EVERY_MS = 6 * 60 * 60 * 1000; // otra vuelta al catálogo de ofertas
const YIFY_PAGE = 50;                       // máximo que acepta la API
const EZ_PAGE = 100;                        // ídem EZTV
const EZ_RECENT_PAGES = 100;                // tope real de la paginación
const GD_PAGE = 60;                         // ídem CheapShark
const GD_MAX_PAGES = 50;                    // tope por consulta (X-Total-Page-Count)
// Páginas por tanda mientras dura el backfill (después, siempre 1). CheapShark
// va de a UNA: es la más celosa de las tres y con tandas en paralelo pasa a
// contestar 429 a todo. Su catálogo es chico (14 tiendas × 50 páginas), así
// que de a una tampoco tarda tanto.
const BATCH = { yify: 6, eztv: 4, games: 1 };

let timer = null;
let running = false;
let turn = 0;
// Castigo por fuente: hasta cuándo se la saltea y cuántas veces seguidas
// falló (para ir estirando la espera).
const cooldown = { yify: 0, eztv: 0, games: 0 };
const errors = { yify: 0, eztv: 0, games: 0 };
const stats = {
  yify: { phase: 'inicio', page: 0, added: 0 },
  eztv: { phase: 'inicio', page: 0, added: 0, show: null },
  games: { phase: 'inicio', page: 0, added: 0, store: null },
};

// Tanda de páginas consecutivas. `cap` es la última página que existe (cuando
// se conoce): pedir más allá del final no devuelve una lista vacía en todas
// las APIs — CheapShark contesta HTTP 400 y EZTV un cuerpo sin `torrents`.
function pages(from, n, cap = Infinity) {
  const out = [];
  for (let i = 0; i < n && from + i <= cap; i++) out.push(from + i);
  return out.length ? out : [from];
}

// Las páginas de una tanda se piden juntas pero se resuelven por separado: que
// una falle (la del borde, un 500 suelto) no tiene por qué tirar toda la tanda
// ni disparar el backoff. Solo si fallan TODAS se propaga el error.
async function fetchBatch(list, fn) {
  const res = await Promise.allSettled(list.map(fn));
  const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw res[0].reason;
  return { ok, failed: res.length - ok.length };
}

// ── YIFY: catálogo ascendente + novedades ──────────────────────
let yifyFreshAt = 0;
let yifyRetries = 0;   // intentos seguidos sobre la misma tanda

async function stepYify() {
  // Novedades primero: una página descendente cada FRESH_EVERY_MS agarra lo
  // que se subió mientras el backfill anda por el 2016.
  if (Date.now() - yifyFreshAt > FRESH_EVERY_MS) {
    yifyFreshAt = Date.now();
    const r = await fetchYifyMovies({ limit: YIFY_PAGE, page: 1, sort: 'date_added' });
    stats.yify.added += await yifyArchive.ingest(r.movies);
    return true;
  }
  const st = (await yifyArchive.getState('backfill')) || { page: 1, caughtUp: false };
  const want = pages(st.page, st.caughtUp ? 1 : BATCH.yify);
  const { ok: res, failed } = await fetchBatch(want, (p) =>
    fetchYifyMovies({ limit: YIFY_PAGE, page: p, sort: 'date_added', order: 'asc' }));
  for (const r of res) stats.yify.added += await yifyArchive.ingest(r.movies);
  stats.yify.page = want[want.length - 1];
  stats.yify.total = res[0].count;
  // Con una página caída no se puede saber si el catálogo siguió, así que se
  // reintenta la misma tanda: el archivo no puede quedar con huecos. Si esa
  // página está rota de verdad, insistir para siempre congelaría el backfill,
  // así que después de unos intentos se sigue de largo y queda en el log.
  if (failed) {
    if (++yifyRetries < 5) return true;
    console.warn(`[archiveCrawl] yify: ${failed} página(s) de ${want[0]}-${want[want.length - 1]} no bajaron; sigo`);
  }
  yifyRetries = 0;
  // Primera página incompleta = fin del catálogo (las siguientes vienen
  // vacías). Se deja el cursor ahí: esa página es la que se va llenando con
  // las próximas subidas.
  const short = res.findIndex((r) => r.movies.length < YIFY_PAGE);
  if (short >= 0) {
    stats.yify.phase = 'al día';
    await yifyArchive.setState('backfill', { page: want[short], caughtUp: true });
  } else {
    stats.yify.phase = 'catálogo';
    await yifyArchive.setState('backfill', { page: want[want.length - 1] + 1, caughtUp: false });
  }
  return true;
}

// ── EZTV: recientes (tope 100 páginas) + histórico por serie ───
let ezFreshAt = 0;

async function stepEztv() {
  const st = (await eztvArchive.getState('backfill')) || { page: 1, recentDone: false };

  // Fase 1 — recientes: las 100 páginas que la API deja ver.
  if (!st.recentDone) {
    const want = pages(st.page, BATCH.eztv, EZ_RECENT_PAGES);
    const { ok: res } = await fetchBatch(want, (p) => fetchEztvTorrents({ limit: EZ_PAGE, page: p }));
    for (const r of res) stats.eztv.added += await eztvArchive.ingest(r.torrents);
    stats.eztv.page = want[want.length - 1];
    stats.eztv.phase = 'recientes';
    const done = res.some((r) => !r.torrents.length) || stats.eztv.page >= EZ_RECENT_PAGES;
    await eztvArchive.setState('backfill', { page: done ? 1 : stats.eztv.page + 1, recentDone: done });
    return true;
  }

  // Novedades: la página 1 cada tanto, aunque el histórico esté a mitad.
  if (Date.now() - ezFreshAt > FRESH_EVERY_MS) {
    ezFreshAt = Date.now();
    const r = await fetchEztvTorrents({ limit: EZ_PAGE, page: 1 });
    stats.eztv.added += await eztvArchive.ingest(r.torrents);
    return true;
  }

  // Fase 2 — ficha de IMDb de las series nuevas (poster + nombre limpio).
  // Una vez por serie en la vida: queda guardada en eztv_shows. De a una eran
  // ~26 minutos para las ~576 series que ya hay archivadas; la suggestion API
  // es un CDN y aguanta la tanda igual que los listados.
  const pending = await eztvArchive.showsMissingMeta(BATCH.eztv);
  if (pending.length) {
    stats.eztv.phase = 'fichas';
    stats.eztv.show = pending[0].name;
    const { ok: metas } = await fetchBatch(pending, (sh) =>
      imdbMeta(sh.imdbNum ? `tt${sh.imdbNum}` : sh.name).then((meta) => ({ sh, meta })));
    for (const { sh, meta } of metas) await eztvArchive.saveShowMeta(sh.key, meta);
    return true;
  }

  // Fase 3 — histórico completo, serie por serie (acá sí la paginación es
  // profunda). El cursor guarda en qué serie y página va.
  const cur = (await eztvArchive.getState('fullShow')) || null;
  const target = cur || (await eztvArchive.showsMissingFull(1))
    .map((s) => ({ key: s.key, imdb: s.imdbNum, name: s.title || s.name, page: 1, total: 0 }))[0];
  if (!target) {
    stats.eztv.phase = 'al día';
    stats.eztv.show = null;
    return false;   // nada que hacer: el turno pasa a otra fuente
  }
  if (!target.imdb) {   // sin tt id no hay filtro posible: se marca y sigue
    await eztvArchive.markShowFull(target.key);
    await eztvArchive.setState('fullShow', null);
    return true;
  }
  stats.eztv.phase = 'series';
  stats.eztv.show = target.name;
  // La primera página va sola porque es la que dice cuántos torrents tiene la
  // serie: recién con ese total se sabe hasta dónde puede llegar la tanda.
  const cap = target.total ? Math.ceil(target.total / EZ_PAGE) : target.page;
  const want = pages(target.page, BATCH.eztv, cap);
  const { ok: res } = await fetchBatch(want, (p) =>
    fetchEztvTorrents({ limit: EZ_PAGE, page: p, imdbId: target.imdb }));
  for (const r of res) stats.eztv.added += await eztvArchive.ingest(r.torrents);
  const total = res[0].count || target.total || 0;
  const last = want[want.length - 1];
  if (res.some((r) => r.torrents.length < EZ_PAGE) || last * EZ_PAGE >= total) {
    await eztvArchive.markShowFull(target.key);
    await eztvArchive.setState('fullShow', null);
  } else {
    await eztvArchive.setState('fullShow', { ...target, page: last + 1, total });
  }
  return true;
}

// ── CheapShark: tienda por tienda ──────────────────────────────
async function stepGames() {
  let st = await gamesArchive.getState('backfill');
  if (!st || !Array.isArray(st.stores) || !st.stores.length) {
    const list = await fetchStores();
    await gamesArchive.ingestStores(list);
    st = { stores: list.map((s) => s.id), idx: 0, page: 0, roundAt: Date.now() };
    await gamesArchive.setState('backfill', st);
    return true;
  }
  // Catálogo recorrido: se espera REDEAL_EVERY_MS y se vuelve a empezar (las
  // ofertas cambian todo el tiempo; los precios viejos quedan archivados).
  if (st.idx >= st.stores.length) {
    stats.games.phase = 'al día';
    if (Date.now() - (st.roundAt || 0) < REDEAL_EVERY_MS) return false;
    await gamesArchive.setState('backfill', { ...st, idx: 0, page: 0, roundAt: Date.now() });
    return false;
  }
  const storeId = st.stores[st.idx];
  // La última página de la tienda es la menor entre su total y el tope duro de
  // la API; pasarse devuelve HTTP 400, no una lista vacía.
  const cap = Math.min(st.total || GD_MAX_PAGES, GD_MAX_PAGES) - 1;
  const want = pages(st.page, BATCH.games, cap);
  const { ok: res } = await fetchBatch(want, (p) =>
    fetchDealsPage({ page: p, storeId, sortBy: 'Recent', pageSize: GD_PAGE }));
  for (const r of res) stats.games.added += await gamesArchive.ingest(r.deals);
  stats.games.phase = 'ofertas';
  stats.games.store = storeId;
  stats.games.page = want[want.length - 1];
  st = { ...st, total: res[0].totalPages || st.total || 0 };
  const last = res.some((r) => !r.deals.length) || stats.games.page >= cap;
  await gamesArchive.setState('backfill', last
    ? { ...st, idx: st.idx + 1, page: 0, total: 0 }
    : { ...st, page: stats.games.page + 1 });
  return true;
}

// ── Bucle ──────────────────────────────────────────────────────
// Una tanda por tick, rotando fuentes. Si una fuente no tiene nada que hacer
// devuelve false y el turno pasa a la siguiente en el mismo tick, así una
// fuente al día no frena a las otras.
const STEPS = [['yify', stepYify], ['eztv', stepEztv], ['games', stepGames]];

async function tick() {
  timer = null;
  if (!running) return;
  const now = Date.now();
  // Todas las fuentes al día: se relaja el ritmo hasta la próxima ventana de
  // novedades en vez de girar en falso cada segundo.
  let delay = FRESH_EVERY_MS / 10;
  for (let i = 0; i < STEPS.length; i++) {
    const [name, step] = STEPS[(turn + i) % STEPS.length];
    if (cooldown[name] > now) continue;   // esta fuente está castigada
    let did = false;
    try {
      did = await step();
      errors[name] = 0;
    } catch (e) {
      // API caída, 429 o sin internet: se castiga SOLO a esa fuente, cada vez
      // por más tiempo, y el turno pasa a la siguiente.
      const ladder = isRateLimited(e) ? RATE_LIMIT_BACKOFF_MS : ERROR_BACKOFF_MS;
      const wait = ladder[Math.min(errors[name], ladder.length - 1)];
      errors[name]++;
      cooldown[name] = Date.now() + wait;
      console.warn(`[archiveCrawl] ${name}:`, String(e && e.message || e), `— se saltea ${Math.round(wait / 1000)}s`);
    }
    if (did) {
      turn = (turn + i + 1) % STEPS.length;
      delay = TICK_MS;
      break;
    }
  }
  if (running) {
    timer = setTimeout(tick, delay);
    if (timer.unref) timer.unref();
  }
}

function start() {
  if (running) return;
  running = true;
  timer = setTimeout(tick, START_DELAY_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

// Resumen para Settings: cuánto hay archivado y en qué anda el crawler.
async function status() {
  const [movies, ez, deals] = await Promise.all([
    yifyArchive.count().catch(() => 0),
    eztvArchive.counts().catch(() => ({ torrents: 0, shows: 0 })),
    gamesArchive.count().catch(() => 0),
  ]);
  const paused = (k) => Math.max(0, Math.round((cooldown[k] - Date.now()) / 1000));
  return {
    running,
    yify: { ...stats.yify, rows: movies, pausedFor: paused('yify') },
    eztv: { ...stats.eztv, rows: ez.torrents, shows: ez.shows, pausedFor: paused('eztv') },
    games: { ...stats.games, rows: deals, pausedFor: paused('games') },
  };
}

module.exports = { start, stop, status };
