// Tombstones de favoritos (helpers puros, sin I/O).
//
// Mongo es la copia autoritativa, pero reconcile() sube con $setOnInsert todo
// lo que el espejo SQLite tenga: un favorito borrado desde otro dispositivo
// (Nexus Mobile) volvía a aparecer en el próximo arranque. Cada borrado deja
// un documento en `fav_deletions` y reconcile() borra esas filas locales en
// vez de resubirlas. Volver a agregar el favorito borra su tombstone.

const FAV_DELETIONS = 'fav_deletions';

const tombId = (kind, id) => `${kind}:${Number(id)}`;

function tombDoc(kind, id, now = Date.now()) {
  return { _id: tombId(kind, id), kind, ref_id: Number(id), deleted_at: now };
}

// Un registro es posterior a su tombstone si se (re)agregó después del
// borrado: esa re-alta gana (pudo hacerse sin conexión, antes de poder borrar
// el tombstone). Sin fechas, el borrado manda.
const newerThan = (addedAt, tomb) => Number(addedAt) > 0 && Number(tomb.deleted_at) > 0
  && Number(addedAt) > Number(tomb.deleted_at);

function tombsOf(tombs, kind) {
  const m = new Map();
  for (const t of tombs || []) if (t && typeof t._id === 'string' && t._id.startsWith(`${kind}:`)) m.set(t._id, t);
  return m;
}

// Separa las filas locales de un kind en las que siguen (`keep`), los ids que
// el tombstone borra (`drop`) y los que siguen pese a tener tombstone porque
// son una re-alta posterior (`revived`: a esos hay que quitarles la marca).
function splitTombstoned(rows, tombs, kind) {
  const dead = tombsOf(tombs, kind);
  const keep = [];
  const drop = [];
  const revived = [];
  for (const r of rows || []) {
    const t = dead.get(tombId(kind, r.id));
    if (!t) keep.push(r);
    else if (newerThan(r.addedAt, t)) { keep.push(r); revived.push(Number(r.id)); }
    else drop.push(Number(r.id));
  }
  return { keep, drop, revived };
}

// Docs de Mongo con tombstone. `dead`: un borrado cuyo deleteMany se cruzó con
// un $setOnInsert de otro dispositivo deja el doc vivo junto a su tombstone, y
// hay que terminar de borrarlo en vez de bajarlo al espejo. `revived`: re-altas
// posteriores al borrado cuyo tombstone quedó (el untomb falló): se quedan y
// pierden la marca.
function remoteTombstoned(docs, tombs, kind) {
  const marks = tombsOf(tombs, kind);
  const dead = [];
  const revived = [];
  for (const d of docs || []) {
    const t = marks.get(tombId(kind, d._id));
    if (!t) continue;
    if (newerThan(d.added_at, t)) revived.push(Number(d._id));
    else dead.push(Number(d._id));
  }
  return { dead, revived };
}

module.exports = { FAV_DELETIONS, tombId, tombDoc, splitTombstoned, remoteTombstoned };
