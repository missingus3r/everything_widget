// Transcodificación/remux on-the-fly con ffmpeg para reproducir cualquier
// formato (HEVC/x265, MKV, AC3, etc.) en el <video> de Chromium.
//
// Estrategia híbrida (la decisión la toma prepare()):
//   • Si el archivo ya es reproducible (contenedor mp4/webm + códecs H.264/VP9/
//     AV1 y audio AAC/Opus/MP3) → modo "direct": se sirve el torrent tal cual
//     (cero CPU, seek perfecto).
//   • Si no → ffmpeg lee el stream del torrent y emite HLS (MPEG-TS): copia el
//     video si ya es H.264 (remux, barato, seek completo), o lo transcodifica a
//     H.264 si es HEVC/otro (usa CPU, seek acotado a lo ya generado). El audio
//     se copia si es AAC/MP3, si no se pasa a AAC. hls.js lo reproduce en el
//     renderer manteniendo la barra de progreso.
//
// Todo degrada con gracia: sin ffmpeg, prepare() cae a "direct" y el reproductor
// avisa si el archivo no es reproducible.

const os = require('os');
const path = require('path');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const { spawn, spawnSync } = require('child_process');

const HLS_ROOT = path.join(os.tmpdir(), 'nexus-hls');
const PLAYABLE_CONTAINER = new Set(['mp4', 'm4v', 'mov', 'webm']);
const PLAYABLE_VIDEO = new Set(['h264', 'avc1', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'mp2', 'opus', 'vorbis']);

let FFMPEG = null;    // '' = ya se resolvió y no hay; null = sin resolver
let FFPROBE = null;
let server = null;
let port = 0;
const jobs = new Map();   // infoHash → { proc, dir }

// Resuelve los binarios: primero PATH del sistema, luego los paquetes estáticos
// opcionales (por si algún día se empaqueta la app).
function resolveBins() {
  if (FFMPEG !== null) return;
  const test = (cmd) => { try { const r = spawnSync(cmd, ['-version'], { stdio: 'ignore' }); return !r.error; } catch { return false; } };
  FFMPEG = test('ffmpeg') ? 'ffmpeg' : '';
  FFPROBE = test('ffprobe') ? 'ffprobe' : '';
  if (!FFMPEG) { try { FFMPEG = require('ffmpeg-static') || ''; } catch {} }
  if (!FFPROBE) { try { FFPROBE = require('ffprobe-static').path || ''; } catch {} }
}

function available() { resolveBins(); return !!FFMPEG; }

function probe(url) {
  return new Promise((resolve) => {
    if (!FFPROBE) return resolve(null);
    const args = ['-v', 'error', '-print_format', 'json', '-show_streams',
      '-analyzeduration', '4000000', '-probesize', '4000000', url];
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const p = spawn(FFPROBE, args);
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', () => { try { finish(JSON.parse(out)); } catch { finish(null); } });
    p.on('error', () => finish(null));
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} finish(null); }, 20000);
  });
}

function analyze(info) {
  const streams = info && Array.isArray(info.streams) ? info.streams : null;
  if (!streams) return { known: false, needV: true, needA: true, height: 0 };
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  return {
    known: true,
    needV: !(v && PLAYABLE_VIDEO.has(String(v.codec_name || '').toLowerCase())),
    needA: a ? !PLAYABLE_AUDIO.has(String(a.codec_name || '').toLowerCase()) : false,
    height: v ? (parseInt(v.height, 10) || 0) : 0,
  };
}

// Servidor estático mínimo para el playlist + segmentos HLS (CORS abierto para
// el origen file:// del renderer).
async function ensureServer() {
  if (server) return;
  await fsp.mkdir(HLS_ROOT, { recursive: true }).catch(() => {});
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const rel = decodeURIComponent((req.url || '').split('?')[0]).replace(/^\/+/, '');
    const full = path.normalize(path.join(HLS_ROOT, rel));
    if (!full.startsWith(HLS_ROOT)) { res.statusCode = 403; return res.end(); }
    const type = full.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
      : full.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream';
    fs.readFile(full, (err, buf) => {
      if (err) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'no-cache');
      res.end(buf);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
}

function buildArgs(srcUrl, dir, opts) {
  const { needV, needA, height } = opts;
  const a = ['-hide_banner', '-loglevel', 'error'];
  // Resiliencia leyendo del server del torrent (puede esperar piezas). Estas
  // opciones son del protocolo http; con un input local ffmpeg las rechaza.
  if (/^https?:\/\//i.test(srcUrl)) {
    a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1', '-reconnect_delay_max', '30');
  }
  a.push(
    '-i', srcUrl,
    '-map', '0:v:0?', '-map', '0:a:0?', '-sn',
    '-max_muxing_queue_size', '2048',
  );
  if (needV) {
    a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    if (height > 1440) a.push('-vf', 'scale=-2:1080');   // baja 4K a 1080p para aliviar la CPU
  } else {
    a.push('-c:v', 'copy');
  }
  a.push('-c:a', needA ? 'aac' : 'copy');
  if (needA) a.push('-b:a', '160k', '-ac', '2');
  a.push(
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
    '-hls_flags', 'independent_segments+temp_file', '-hls_playlist_type', 'event',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'), path.join(dir, 'index.m3u8'),
  );
  return a;
}

// Arranca ffmpeg y espera a que aparezca el playlist con al menos un segmento.
async function startHls(srcUrl, infoHash, opts) {
  await ensureServer();
  await stopJob(infoHash);   // por si había uno viejo
  const dir = path.join(HLS_ROOT, infoHash);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(dir, { recursive: true });

  const proc = spawn(FFMPEG, buildArgs(srcUrl, dir, opts));
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString().slice(-2000); });
  const job = { proc, dir };
  jobs.set(infoHash, job);
  proc.on('close', () => { if (jobs.get(infoHash) === job) job.closed = true; });

  const playlist = path.join(dir, 'index.m3u8');
  const hasSegment = async () => { try { return /\.ts/.test(await fsp.readFile(playlist, 'utf8')); } catch { return false; } };
  const started = Date.now();
  while (Date.now() - started < 45000) {
    if (await hasSegment()) break;                 // hay ≥1 segmento (aunque ffmpeg ya haya terminado, en clips cortos)
    if (job.closed) throw new Error('ffmpeg terminó sin generar el stream' + (stderr ? `: ${stderr.trim().split('\n').pop()}` : ''));
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!(await hasSegment())) throw new Error('timeout esperando el primer segmento HLS');
  return `http://127.0.0.1:${port}/${infoHash}/index.m3u8`;
}

// Decide cómo reproducir. Devuelve { mode, url, transcoding, playable, note }.
async function prepare({ srcUrl, name, infoHash }) {
  resolveBins();
  const ext = String(name || '').split('.').pop().toLowerCase();
  const directContainer = PLAYABLE_CONTAINER.has(ext);

  const info = FFPROBE ? await probe(srcUrl) : null;
  const an = analyze(info);
  const canDirect = directContainer && an.known && !an.needV && !an.needA;

  if (canDirect) return { mode: 'direct', url: srcUrl, transcoding: false, playable: true, note: '' };
  if (!FFMPEG) {
    // Sin ffmpeg no hay plan B: se sirve directo y el player avisa si no anda.
    return { mode: 'direct', url: srcUrl, transcoding: false, playable: directContainer, note: directContainer ? '' : 'ffmpeg no está instalado: este formato puede no reproducirse' };
  }

  try {
    const url = await startHls(srcUrl, infoHash, an);
    return {
      mode: 'hls', url, transcoding: an.needV, playable: true,
      note: an.needV ? 'Transcodificando con ffmpeg (usa CPU; adelantar limitado a lo ya procesado)' : 'Remuxeando con ffmpeg',
    };
  } catch (e) {
    // Si ffmpeg falla, último intento directo.
    return { mode: 'direct', url: srcUrl, transcoding: false, playable: directContainer, note: `ffmpeg falló (${String(e && e.message || e)})` };
  }
}

async function stopJob(infoHash) {
  const job = jobs.get(infoHash);
  if (!job) return;
  jobs.delete(infoHash);
  try { job.proc.kill('SIGKILL'); } catch {}
  try { await fsp.rm(job.dir, { recursive: true, force: true }); } catch {}
}

async function stopAll() {
  for (const h of [...jobs.keys()]) { try { await stopJob(h); } catch {} }
  try { await fsp.rm(HLS_ROOT, { recursive: true, force: true }); } catch {}
}

async function sweep() {
  if (jobs.size) return;
  try { await fsp.rm(HLS_ROOT, { recursive: true, force: true }); } catch {}
}

module.exports = { available, prepare, stopJob, stopAll, sweep };
