// Persistencia segura de los espejos SQLite (sql.js) — compartida por todos
// los stores: favoritos, Finanzas, Lime y los archivos históricos.
//
// El 2026-09-06 un apagado inesperado dejó favorites/eztv/games.sqlite con su
// tamaño completo pero 100% en cero: writeFileSync (y el tmp+rename sin fsync
// del archivo histórico) devuelven cuando los datos están en la caché de
// Windows, no en el disco, y NTFS registró el tamaño nuevo sin el contenido.
// Al arrancar, sql.js tiraba "file is not a database", el error quedaba
// cacheado en el ensure() de cada store y las secciones aparecían vacías en
// silencio. Dos defensas:
//   • writeAtomic / writeAtomicSync: volcado a .tmp + fsync (fuerza el flush
//     físico) + rename (publica la base nueva de una sola vez). Un corte deja
//     la base anterior intacta en vez de un archivo en cero o a medio escribir.
//   • openDatabase: valida la cabecera "SQLite format 3\0" y la primera página
//     al abrir; si el archivo no es una base, lo aparta como
//     .corrupt-<fecha> (nunca se borra) y arranca de cero — Mongo, que es
//     autoritativo, repuebla el espejo en el sync de arranque.

const fs = require('fs');
const path = require('path');

const HEADER = Buffer.from('SQLite format 3\0', 'latin1');
const CORRUPT_RE = /not a database|malformed|corrupt/i;

function isSqliteBuffer(buf) {
  return Buffer.isBuffer(buf)
    && buf.length >= HEADER.length
    && buf.subarray(0, HEADER.length).equals(HEADER);
}

// Aparta el archivo dañado con un sufijo fechado (nunca se borra) y avisa.
function quarantine(file, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.corrupt-${stamp}`;
  fs.renameSync(file, dest);
  console.warn(`[sqlite] ${path.basename(file)} ${reason}; apartado como ${path.basename(dest)} — se arranca de cero y Mongo repuebla`);
  return dest;
}

// Abre la base en `file`, o una vacía si no existe o no sirve. `SQL` es el
// módulo sql.js ya inicializado. Los errores de esquema/migración no son
// corrupción y se propagan tal cual.
function openDatabase(SQL, file) {
  if (!fs.existsSync(file)) return new SQL.Database();
  const buf = fs.readFileSync(file);
  if (!isSqliteBuffer(buf)) {
    quarantine(file, buf.length
      ? `no es una base SQLite (${buf.length} bytes, cabecera inválida)`
      : 'está vacío');
    return new SQL.Database();
  }
  const db = new SQL.Database(buf);
  try {
    db.exec('PRAGMA schema_version');   // fuerza la lectura de la página 1
    return db;
  } catch (e) {
    if (!CORRUPT_RE.test(String(e && e.message))) throw e;
    try { db.close(); } catch {}
    quarantine(file, `está dañado (${e.message})`);
    return new SQL.Database();
  }
}

// Volcado atómico sincrónico (stores chicos: favoritos, Finanzas, Lime).
function writeAtomicSync(file, buf) {
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Volcado atómico asincrónico (archivos históricos de decenas de MB: corre en
// el threadpool y no congela la UI).
async function writeAtomic(file, buf) {
  const tmp = `${file}.tmp`;
  const fh = await fs.promises.open(tmp, 'w');
  try {
    let off = 0;
    while (off < buf.length) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.promises.rename(tmp, file);
}

module.exports = { openDatabase, writeAtomic, writeAtomicSync, isSqliteBuffer };
