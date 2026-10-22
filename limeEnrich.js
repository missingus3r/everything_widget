// Enriquecimiento de releases de Lime que Mongo no tiene (helper puro).
//
// El sync de limeArchive sube cada release con $setOnInsert: lo que se
// enriquece después (nombre parseado, ficha de IMDb, poster) queda solo en el
// espejo SQLite. Otra máquina — o Nexus Mobile, que lista directo desde Mongo
// — veía esos releases sin poster y sin poder agruparlos por película.
// pushEnrichment (limeArchive.js) completa esos campos en Mongo, sin pisar
// nunca un valor que ya esté.

const ENRICH_FIELDS = ['name', 'year', 'imdb', 'imdb_title', 'imdb_year', 'cover'];

// `local` y `remote` con las claves del documento de Mongo. Devuelve el $set
// con lo que el local tiene y el remoto no, o null si no falta nada.
function enrichmentPatch(local, remote) {
  const patch = {};
  for (const k of ENRICH_FIELDS) {
    const v = local && local[k];
    if (v != null && v !== '' && (remote == null || remote[k] == null)) patch[k] = v;
  }
  return Object.keys(patch).length ? patch : null;
}

// El $set del ingest refresca seeds/peers de releases ya archivados, que no se
// vuelven a enriquecer: sin esto mandaba name/imdb/cover en null y borraba en
// Mongo la ficha (en SQLite no, ahí el upsert usa COALESCE).
function withoutNullEnrichment(mut) {
  const out = { ...mut };
  for (const k of ENRICH_FIELDS) if (out[k] == null) delete out[k];
  return out;
}

module.exports = { ENRICH_FIELDS, enrichmentPatch, withoutNullEnrichment };
