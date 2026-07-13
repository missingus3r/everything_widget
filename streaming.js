// Streaming de torrents en tiempo real para el reproductor (WebTorrent).
//
// WebTorrent 3.x es ESM puro, así que se importa dinámicamente desde este
// módulo CommonJS. Se mantiene UN cliente y UN servidor HTTP en 127.0.0.1: al
// abrir el reproductor se agrega el magnet, se espera la metadata, se elige el
// archivo de video más grande y se devuelve una URL local que el <video>
// consume con soporte de Range (permite adelantar/buscar sin bajar todo). Al
// cerrar el modal se destruye el torrent y se borran del disco las partes ya
// descargadas. Nada de esto tira hacia el caller: main.js envuelve todo y
// degrada a { error }, igual que yify.js.

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');

const DL_ROOT = path.join(os.tmpdir(), 'nexus-stream');
const VIDEO_RE = /\.(mp4|m4v|webm|mkv|avi|mov|ogv|ogg)$/i;
const PLAYABLE_RE = /\.(mp4|m4v|webm|ogv|ogg)$/i;   // lo que Chromium reproduce nativo
const META_TIMEOUT_MS = 60000;                       // sin seeds/peers → cortar

let WebTorrentClass = null;   // cache del import ESM
let client = null;
let server = null;
let port = 0;
let starting = null;          // promesa de arranque (evita crear dos clientes)

// Crea (una sola vez) el cliente WebTorrent y su servidor HTTP local.
async function ready() {
  if (client && server) return;
  if (!starting) starting = (async () => {
    if (!WebTorrentClass) WebTorrentClass = (await import('webtorrent')).default;
    client = new WebTorrentClass();
    client.on('error', () => {});   // errores del swarm no deben tumbar la app
    server = client.createServer();
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    port = server.address().port;
  })();
  await starting;
}

function infoHashFromMagnet(magnet) {
  const m = /xt=urn:btih:([0-9a-fA-F]{40}|[a-zA-Z2-7]{32})/i.exec(magnet || '');
  return m ? m[1].toLowerCase() : null;
}

// Elige el archivo de video más grande (descarta samples, .nfo, subs sueltos).
function pickFile(files) {
  const vids = (files || []).filter((f) => VIDEO_RE.test(f.name));
  const pool = vids.length ? vids : (files || []);
  return pool.slice().sort((a, b) => b.length - a.length)[0] || null;
}

function existing(hash) {
  return (client && hash) ? client.torrents.find((t) => t.infoHash === hash) : null;
}

// Agrega el magnet (o reutiliza si ya está), espera metadata y devuelve la URL
// local + datos del archivo. Prioriza el archivo elegido para no gastar ancho
// de banda en el resto del pack.
async function start(magnet) {
  if (typeof magnet !== 'string' || !/^magnet:\?/i.test(magnet)) throw new Error('magnet inválido');
  await ready();

  const hash = infoHashFromMagnet(magnet);
  let torrent = existing(hash);

  if (!torrent) {
    torrent = await new Promise((resolve, reject) => {
      let t;
      const timer = setTimeout(() => reject(new Error('sin metadata (¿el torrent no tiene seeds?)')), META_TIMEOUT_MS);
      try {
        t = client.add(magnet, { path: DL_ROOT }, (tt) => { clearTimeout(timer); resolve(tt); });
      } catch (e) { clearTimeout(timer); return reject(e); }
      t.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  } else if (!torrent.ready) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('sin metadata')), META_TIMEOUT_MS);
      torrent.once('ready', () => { clearTimeout(timer); resolve(); });
      torrent.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  const file = pickFile(torrent.files);
  if (!file) throw new Error('el torrent no contiene ningún archivo de video');
  // Descargar solo el archivo elegido (el server re-selecciona el rango pedido).
  try { torrent.files.forEach((f) => { if (f !== file) f.deselect(); }); file.select(); } catch {}

  return {
    infoHash: torrent.infoHash,
    url: `http://127.0.0.1:${port}${file.streamURL}`,
    name: file.name,
    length: file.length,
    playable: PLAYABLE_RE.test(file.name),   // false → mkv/avi: puede no reproducir en Chromium
  };
}

// Progreso de buffering para el HUD del reproductor (peers, velocidad, %).
function stats(hash) {
  const t = existing(hash);
  if (!t) return { active: false };
  const file = pickFile(t.files);
  return {
    active: true,
    progress: (file && typeof file.progress === 'number') ? file.progress : t.progress,
    downloaded: t.downloaded,
    downloadSpeed: t.downloadSpeed,
    numPeers: t.numPeers,
    length: file ? file.length : t.length,
    done: t.done,
  };
}

// Detiene el torrent y borra del disco lo descargado (destroyStore + barrido).
async function stop(hash) {
  if (!client || !hash) return { ok: true };
  const t = existing(hash);
  if (!t) return { ok: true };
  const name = t.name;
  await new Promise((resolve) => {
    try { client.remove(hash, { destroyStore: true }, () => resolve()); }
    catch { resolve(); }
  });
  try { if (name) await fsp.rm(path.join(DL_ROOT, name), { recursive: true, force: true }); } catch {}
  return { ok: true };
}

// Borra restos huérfanos (p. ej. de un cierre forzado anterior). Se llama al
// arrancar la app, cuando seguro no hay nada reproduciéndose.
async function sweep() {
  if (client && client.torrents.length) return;   // no barrer si hay streams vivos
  try { await fsp.rm(DL_ROOT, { recursive: true, force: true }); } catch {}
}

// Cierre ordenado al salir: para todos los torrents (borrando datos) y destruye
// el cliente. Best-effort.
async function stopAll() {
  if (!client) return;
  try {
    for (const h of client.torrents.map((t) => t.infoHash)) { try { await stop(h); } catch {} }
    await new Promise((res) => { try { client.destroy(() => res()); } catch { res(); } });
  } catch {}
  try { await fsp.rm(DL_ROOT, { recursive: true, force: true }); } catch {}
  client = null; server = null; starting = null; port = 0;
}

module.exports = { start, stop, stats, sweep, stopAll };
