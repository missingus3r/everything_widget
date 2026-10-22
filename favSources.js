// Cruce YIFY ↔ LimeTorrents para Favoritos (main process).
//
// La misma película puede aparecer en las dos fuentes con ids distintos (YIFY
// usa su id positivo; Lime, -ttNum del match de IMDb). El favorito es uno solo
// — favorites.js lo une por imdb — y acá se completa con lo que la OTRA fuente
// tenga de esa película, así la ficha en Favoritos muestra los torrents de
// ambas:
//   • complement(m): al dar ♥, agrega los torrents de la otra fuente (y, si el
//     ♥ fue en Lime, la ficha de YIFY: sinopsis, rating, géneros, trailer).
//   • refreshAll(): pasada de mantenimiento en cada sync de bases — completa el
//     imdb de favoritos anteriores a la columna, funde duplicados y agrega a
//     cada favorito los torrents nuevos de la otra fuente. Nunca tira.
// Las búsquedas van contra los archivos locales (yify.sqlite / lime.sqlite);
// la API de YIFY solo entra si el archivo no tiene la película, con un tope
// por pasada para no demorar el arranque con la API caída.

const favorites = require('./favorites');
const yifyArchive = require('./yifyArchive');
const limeArchive = require('./limeArchive');
const { fetchYifyDetails, fetchYifyByImdb } = require('./yify');

const API_BUDGET_PER_PASS = 5;

// Torrents de YIFY con la forma de la ficha: cada uno lleva la página de YTS
// (para el botón "Ver en YTS" de un favorito cuyo origen principal es Lime).
function yifyTorrents(y) {
  return favorites.tagTorrents(
    (y.torrents || []).map((t) => ({ ...t, page: y.url || t.page || null })), 'yify');
}

// Película de YIFY por imdb: archivo local primero, API si queda presupuesto.
async function yifyByImdb(imdb, budget) {
  let y = null;
  try { y = await yifyArchive.byImdb(imdb); } catch {}
  if (!y && budget.left > 0) {
    budget.left--;
    try { y = await fetchYifyByImdb(imdb); } catch {}
  }
  return y && y.id ? y : null;
}

async function limeByImdb(imdb) {
  try { return favorites.tagTorrents(await limeArchive.byImdb(imdb, 'movies'), 'lime'); }
  catch { return []; }
}

// Ficha de YIFY volcada sobre una película de Lime: lo que Lime ya sabe manda.
function fillFromYify(m, y) {
  return {
    synopsis: m.synopsis || y.synopsis || '',
    cast: (m.cast && m.cast.length) ? m.cast : (y.cast || []),
    genres: (m.genres && m.genres.length) ? m.genres : (y.genres || []),
    rating: m.rating ?? y.rating ?? null,
    runtime: m.runtime ?? y.runtime ?? null,
    trailer: m.trailer || y.trailer || null,
  };
}

function needsFicha(m) {
  return !m.synopsis || !(m.genres && m.genres.length) || m.rating == null;
}

// Película que se va a guardar como favorita, completada con la otra fuente.
async function complement(m, budget = { left: API_BUDGET_PER_PASS }) {
  const source = m.source === 'lime' ? 'lime' : 'yify';
  const imdb = favorites.imdbOf(m);
  const own = favorites.tagTorrents(m.torrents, source);
  if (!imdb) return { ...m, torrents: own };
  if (source === 'lime') {
    const y = await yifyByImdb(imdb, budget);
    if (!y) return { ...m, imdb, torrents: own };
    return {
      ...m, ...fillFromYify(m, y), imdb,
      cover: m.cover || y.cover || null,
      torrents: favorites.overlayTorrents(own, yifyTorrents(y)),
    };
  }
  return { ...m, imdb, torrents: favorites.overlayTorrents(own, await limeByImdb(imdb)) };
}

// Firma de un conjunto de torrents (origen + magnet/hash): decide si vale la
// pena reescribir el favorito. Seeds y peers cambian todo el tiempo y no
// justifican un write en las dos bases.
function torrentKeys(list) {
  return (list || [])
    .map((t) => `${t.source || ''}|${t.magnet || t.hash || t.url || `${t.quality}|${t.size}`}`)
    .sort()
    .join('\n');
}

let running = false;
async function refreshAll() {
  if (running) return;
  running = true;
  const budget = { left: API_BUDGET_PER_PASS };
  try {
    // 1) imdb faltante (favoritos anteriores a la columna): Lime lo trae en su
    //    URL de IMDb; YIFY sale del archivo (o de la API, con tope).
    for (const f of await favorites.listLite()) {
      if (f.imdb) continue;
      let imdb = favorites.imdbOf(f);
      if (!imdb && f.source === 'yify' && f.id > 0) {
        let y = null;
        try { y = await yifyArchive.byId(f.id); } catch {}
        if (!y && budget.left > 0) {
          budget.left--;
          try { y = await fetchYifyDetails(f.id); } catch {}
        }
        imdb = favorites.imdbOf(y);
      }
      if (imdb) await favorites.patch(f.id, { imdb });
    }

    // 2) La misma película guardada desde las dos fuentes → un solo favorito.
    const dd = await favorites.dedupeByImdb();
    if (dd.removed) console.log(`[favSources] ${dd.removed} favorito(s) duplicado(s) fundido(s) por imdb`);

    // 3) Torrents (y ficha) de la otra fuente.
    let updated = 0;
    for (const f of await favorites.listLite()) {
      if (!f.imdb) continue;
      let fresh = [], fill = null;
      if (f.source === 'lime') {
        const y = await yifyByImdb(f.imdb, budget);
        if (!y) continue;
        fresh = yifyTorrents(y);
        if (needsFicha(f)) fill = fillFromYify(f, y);
      } else {
        fresh = await limeByImdb(f.imdb);
      }
      if (!fresh.length && !fill) continue;
      const merged = fresh.length ? favorites.overlayTorrents(f.torrents, fresh) : f.torrents;
      const changed = torrentKeys(merged) !== torrentKeys(f.torrents);
      if (!changed && !fill) continue;
      await favorites.patch(f.id, { ...(fill || {}), torrents: merged });
      updated++;
    }
    if (updated) console.log(`[favSources] ${updated} favorito(s) completado(s) con la otra fuente`);
  } catch (e) {
    console.warn('[favSources] refresh failed:', e.message);
  } finally {
    running = false;
  }
}

module.exports = { complement, refreshAll };
