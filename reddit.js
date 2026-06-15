// Reddit (main process): posts de subreddits vía los feeds RSS/Atom públicos.
//
// La JSON API (/r/x.json) responde 403 desde clientes no-browser desde el
// crackdown de 2023, pero los feeds Atom (/r/x/hot.rss) siguen abiertos: se
// parsean acá con regex (estructura plana y estable, no precisa XML parser).
// Multireddit con `+` (/r/a+b/hot.rss); top acepta ?t=day|week|month.
// El feed no trae score ni cantidad de comentarios — la fila muestra
// título/sub/autor/fecha. Tira en error — el handler IPC degrada a { error }.

const https = require('https');

// Reddit filtra por fingerprint de headers: con UA solo devuelve 403, con el
// set completo de un Chrome navegando deja pasar. No tocar a la ligera.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
};

function getText(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: BROWSER_HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getText(new URL(res.headers.location, url).href, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1].trim() : '';
};
const attr = (xml, name, attrName) => {
  const m = new RegExp(`<${name}\\b[^>]*\\b${attrName}="([^"]*)"`, 'i').exec(xml);
  return m ? m[1] : '';
};

function parseEntry(xml) {
  const contentRaw = decodeEntities(tag(xml, 'content'));   // HTML del post (escapado en el feed)
  // El content trae "[link]" (URL externa del post) y la miniatura si hay.
  const linkM = /<a href="([^"]+)">\s*\[link\]/i.exec(contentRaw);
  const thumbM = /<img src="(https:\/\/[^"]+)"/i.exec(contentRaw);
  const permalink = attr(xml, 'link', 'href') || null;
  const external = linkM ? decodeEntities(linkM[1]) : null;
  return {
    id: tag(xml, 'id') || permalink,
    title: decodeEntities(tag(xml, 'title')),
    sub: attr(xml, 'category', 'term') || '',
    author: decodeEntities(tag(xml, 'name')).replace(/^\/u\//, ''),
    createdAt: Date.parse(tag(xml, 'published') || tag(xml, 'updated')) || null,
    permalink,
    // URL externa solo si difiere del permalink (los self-posts apuntan a sí mismos).
    url: external && external !== permalink ? external : null,
    thumb: thumbM ? decodeEntities(thumbM[1]) : null,
  };
}

// sort: 'hot' | 'new' | 'top' (top usa `t`, default día).
async function fetchRedditPosts({ subs = [], sort = 'hot', t = 'day', limit = 25 } = {}) {
  const multi = (Array.isArray(subs) ? subs : [])
    .map((s) => String(s || '').trim().replace(/^r\//i, ''))
    .filter((s) => /^[A-Za-z0-9_]+$/.test(s));
  if (!multi.length) return { posts: [], fetchedAt: Date.now() };
  const kind = ['hot', 'new', 'top'].includes(sort) ? sort : 'hot';
  const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, limit))) });
  if (kind === 'top') params.set('t', ['hour', 'day', 'week', 'month', 'year', 'all'].includes(t) ? t : 'day');
  const xml = await getText(`https://www.reddit.com/r/${multi.join('+')}/${kind}.rss?${params}`);
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return {
    posts: entries.map(parseEntry).filter((p) => p.id && p.title),
    fetchedAt: Date.now(),
  };
}

// Probe barato para el semáforo de Settings (los headers de browser son
// obligatorios: el probe genérico de apiStatus da 403). Nunca rechaza.
async function checkReddit() {
  try {
    await getText('https://www.reddit.com/r/programming/hot.rss?limit=1', 8000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { fetchRedditPosts, checkReddit };
