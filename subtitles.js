// Subtítulos vía OpenSubtitles (gateway REST legacy, sin API key).
//
// El endpoint https://rest.opensubtitles.org/search/... no requiere registro ni
// key, solo un User-Agent válido (se usa el de VLSub, aceptado por el gateway).
// Se busca por imdb id (preciso) o por nombre (fallback para favoritos que no
// guardan el imdb). Ojo: un idioma por request — la coma en sublanguageid da
// error 400, así que se consulta cada idioma y se fusiona.
//
// El link de descarga es un .srt gzipeado (encoding CP1252/UTF-8 según el sub);
// se descomprime, se decodifica y se convierte a WebVTT para el <track> del
// reproductor, o se entrega el .srt tal cual para el botón "descargar".

const https = require('https');
const zlib = require('zlib');

const UA = 'VLSub 0.10.2';                       // UA aceptado por el gateway
const HOST = 'https://rest.opensubtitles.org';
const LANG_NAMES = { spa: 'Español', eng: 'Inglés', por: 'Português', fre: 'Francés', ita: 'Italiano', ger: 'Alemán' };
const TIMEOUT_MS = 12000;

function reqJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, 'X-User-Agent': UA } }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error('respuesta no es JSON')); } });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Descarga binaria siguiendo redirects (el .gz vive en dl.opensubtitles.org).
function reqBuf(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error('demasiados redirects'));
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(reqBuf(new URL(res.headers.location, url).href, depth + 1));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// Gunzip (si viene comprimido) + decodifica respetando el encoding del sub.
// CP1252 y latin1 comparten los code points de las tildes/ñ del español, así
// que latin1 es un fallback seguro cuando no es UTF-8.
function decodeSrt(buf, encoding) {
  let data = buf;
  if (buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { data = zlib.gunzipSync(buf); } catch {}
  }
  const enc = /utf-?8/i.test(encoding || '') ? 'utf8' : 'latin1';
  return data.toString(enc).replace(/^﻿/, '');
}

function srtToVtt(srt) {
  const body = (srt || '')
    .replace(/\r+/g, '')
    .replace(/^﻿/, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');   // coma → punto en los timestamps
  return 'WEBVTT\n\n' + body;
}

async function searchOne(kind, value, lang) {
  const seg = kind === 'imdb' ? `imdbid-${value}` : `query-${encodeURIComponent(value)}`;
  const arr = await reqJson(`${HOST}/search/${seg}/sublanguageid-${lang}`);
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => ({
    id: String(s.IDSubtitleFile || s.IDSubtitle || ''),
    lang: s.SubLanguageID || lang,
    langName: LANG_NAMES[s.SubLanguageID] || s.LanguageName || s.SubLanguageID || lang,
    name: s.SubFileName || 'subtitulo.srt',
    downloads: parseInt(s.SubDownloadsCnt, 10) || 0,
    rating: parseFloat(s.SubRating) || 0,
    format: (s.SubFormat || 'srt').toLowerCase(),
    encoding: s.SubEncoding || '',
    link: s.SubDownloadLink || '',
  })).filter((s) => s.link && s.format === 'srt');
}

// Busca subtítulos. { imdbId?, query?, langs? } → { subs: [...] } ordenados por
// descargas, top 8 por idioma. Prefiere imdb; si no hay, cae al nombre.
async function search({ imdbId, query, langs } = {}) {
  const wanted = (Array.isArray(langs) && langs.length ? langs : ['spa', 'eng']).slice(0, 4);
  const id = imdbId ? String(imdbId).replace(/^tt/i, '').replace(/\D/g, '') : '';
  const jobs = [];
  for (const lang of wanted) {
    if (id) jobs.push(searchOne('imdb', id, lang).catch(() => []));
    else if (query) jobs.push(searchOne('query', query, lang).catch(() => []));
  }
  const groups = await Promise.all(jobs);
  const byLang = {};
  for (const s of [].concat(...groups)) (byLang[s.lang] = byLang[s.lang] || []).push(s);
  const subs = [];
  for (const lang of wanted) {
    subs.push(...(byLang[lang] || []).sort((a, b) => b.downloads - a.downloads).slice(0, 8));
  }
  return { subs };
}

// Descarga un sub y devuelve { srt, vtt }. El caller elige cuál usar (track o
// descarga a disco).
async function fetchSub({ link, encoding } = {}) {
  if (!link) throw new Error('link de subtítulo inválido');
  const srt = decodeSrt(await reqBuf(link), encoding);
  return { srt, vtt: srtToVtt(srt) };
}

module.exports = { search, fetchSub, decodeSrt, srtToVtt };
