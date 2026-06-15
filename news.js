// Noticias UY (main process): feeds RSS/Atom de diarios uruguayos.
//
// Cada fuente es RSS 2.0 (<item>) o Atom (<entry>); el parser cubre ambos con
// regex (estructura plana y estable, no precisa XML parser). Algunos sitios
// (El País) cortan UAs no-browser, así que se mandan headers de Chrome. Los
// feeds se piden en paralelo, se mezclan y se ordenan por fecha. Tira/degrada
// suave — el handler IPC convierte a { error }.

const https = require('https');

// Catálogo de fuentes (URLs verificadas). id = clave del chip/filtro.
const SOURCES = [
  { id: 'mvdportal',    name: 'Montevideo Portal', url: 'https://www.montevideo.com.uy/anxml.aspx?59' },
  { id: 'elpais',       name: 'El País',           url: 'https://www.elpais.com.uy/rss/latest' },
  { id: 'elobservador', name: 'El Observador',     url: 'https://www.elobservador.com.uy/rss/pages/uruguay.xml' },
  { id: 'telemundo',    name: 'Telemundo',         url: 'https://www.telemundo.com.uy/feed/' },
  { id: 'ladiaria',     name: 'la diaria',         url: 'https://ladiaria.com.uy/feeds/articulos/' },
  { id: 'lr21',         name: 'La Red 21',         url: 'https://www.lr21.com.uy/feed' },
  { id: 'ambito',       name: 'Ámbito',            url: 'https://www.ambito.com/rss/pages/uruguay.xml' },
];
const BY_ID = Object.fromEntries(SOURCES.map((s) => [s.id, s]));

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/rss+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

function getText(url, timeoutMs = 12000, depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: BROWSER_HEADERS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < 4) {
        res.resume();
        getText(new URL(res.headers.location, url).href, timeoutMs, depth + 1).then(resolve, reject);
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
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
}

const stripCdata = (s) => String(s || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Catálogo de temas + sus pistas. El tema sale primero de la sección en la URL
// (señal fuerte: /policiales/…, /deportes/…) y de las <category> del feed; si
// no, por keywords en título+resumen. Acentos ya normalizados (sin tildes).
const TOPIC_RULES = [
  { id: 'politica', label: 'Política', kw: ['gobierno', 'presidente', 'orsi', 'frente amplio', 'partido nacional', 'lacalle', 'senad', 'diputad', 'ministr', 'eleccion', 'parlament', 'intendencia', 'sindicato', 'pit-cnt', 'oposicion'] },
  { id: 'policiales', label: 'Policiales', kw: ['policia', 'homicidio', 'rapina', 'delito', 'crimen', 'detenid', 'asalt', 'tiroteo', 'femicidio', 'narco', 'incautac', 'fiscal', 'imputad', 'allanamiento', 'preso', 'carcel', 'apunalad', 'balear', 'operativo'] },
  { id: 'deportes', label: 'Deportes', kw: ['penarol', 'futbol', 'seleccion', 'celeste', 'mundial', 'libertadores', 'sudamericana', 'tenis', 'basquet', 'formula 1', ' f1 ', 'bielsa', 'goleo', 'goles', 'campeonato'] },
  { id: 'economia', label: 'Economía', kw: ['economia', 'dolar', 'inflacion', 'salario', 'impuesto', 'ute', 'antel', 'ancap', 'pib', 'combustible', 'nafta', 'exportac', 'importac', 'banco central', 'presupuesto', 'inversion'] },
  { id: 'mundo', label: 'Mundo', kw: ['internacional', 'eeuu', 'estados unidos', 'argentina', 'brasil', 'trump', 'milei', 'gaza', 'israel', 'ucrania', 'rusia', 'china', 'venezuela', 'papa leon'] },
  { id: 'espectaculos', label: 'Espectáculos', kw: ['espectaculo', 'famoso', 'farandula', 'cantante', 'actriz', 'actor', 'pelicula', 'estreno', 'carnaval', 'teatro', 'festival', 'influencer'] },
  { id: 'tecnologia', label: 'Tecnología', kw: ['inteligencia artificial', 'tecnologia', 'software', 'aplicacion movil', 'google', 'apple', 'microsoft', 'ciberataque', 'startup', 'criptomoneda'] },
  { id: 'salud', label: 'Salud', kw: ['hospital', 'asse', 'enfermedad', 'vacuna', 'dengue', 'epidemia', 'mutualista', 'sarampion', 'medicament'] },
];
const TOPICS = TOPIC_RULES.map(({ id, label }) => ({ id, label }));

// Slug de sección/categoría → tema. Varias secciones caen en el mismo tema.
const SECTION_MAP = {
  politica: 'politica', policiales: 'policiales', policial: 'policiales',
  deportes: 'deportes', deporte: 'deportes',
  economia: 'economia', 'economia-y-mercado': 'economia', mercado: 'economia',
  mundo: 'mundo', internacional: 'mundo', internacionales: 'mundo',
  espectaculos: 'espectaculos', cultura: 'espectaculos', farandula: 'espectaculos',
  tecnologia: 'tecnologia', tecno: 'tecnologia', ciencia: 'tecnologia',
  salud: 'salud',
};

function classifyTopics(title, summary, url, categories) {
  // 1) Sección de la URL + <category> del feed: señal autoritativa. Si hay,
  //    se usa sola (evita el ruido de matchear keywords por todo el resumen).
  const section = new Set();
  try {
    const path = norm(new URL(url).pathname);
    for (const seg in SECTION_MAP) if (path.includes('/' + seg)) section.add(SECTION_MAP[seg]);
  } catch {}
  for (const c of (categories || [])) {
    const cn = norm(c);
    for (const seg in SECTION_MAP) if (cn === seg || cn.includes(seg)) section.add(SECTION_MAP[seg]);
  }
  if (section.size) return [...section].slice(0, 2);
  // 2) Sin sección clara: keywords en título+resumen (máx. 2, por prioridad).
  const hay = ` ${norm(title)} ${norm(summary)} `;
  const kw = [];
  for (const rule of TOPIC_RULES) if (rule.kw.some((k) => hay.includes(k))) kw.push(rule.id);
  return kw.slice(0, 2);
}

function tagText(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? decodeEntities(stripCdata(m[1])) : '';
}

// Texto plano de un fragmento HTML (para el resumen): saca tags y colapsa espacios.
function plainText(html, max = 160) {
  const t = decodeEntities(stripCdata(html)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// Primera imagen del ítem: enclosure / media:* / <img> embebido (raw o escapado).
function firstImage(itemXml) {
  let m = /<enclosure\b[^>]*\burl="([^"]+)"[^>]*>/i.exec(itemXml);
  if (m && (/image/i.test(m[0]) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(m[1]))) return m[1];
  m = /<media:(?:content|thumbnail)\b[^>]*\burl="([^"]+)"/i.exec(itemXml);
  if (m) return m[1];
  m = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(itemXml);
  if (m) return m[1];
  // content:encoded / description con <img> escapado (&lt;img …)
  const dec = decodeEntities(itemXml);
  m = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(dec);
  return m ? m[1] : null;
}

function itemLink(itemXml) {
  // Atom: <link href="…"/>. RSS: <link>…</link> (a veces hay self/alternate).
  let m = /<link\b[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/i.exec(itemXml)
       || /<link\b[^>]*\bhref="([^"]+)"/i.exec(itemXml);
  if (m) return m[1];
  m = /<link>([\s\S]*?)<\/link>/i.exec(itemXml);
  if (m) return decodeEntities(stripCdata(m[1]));
  m = /<guid\b[^>]*>([\s\S]*?)<\/guid>/i.exec(itemXml);
  return m ? decodeEntities(stripCdata(m[1])) : null;
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const title = tagText(b, 'title');
    const link = itemLink(b);
    if (!title || !link) return null;
    const dateRaw = tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated') || tagText(b, 'dc:date');
    const ts = dateRaw ? Date.parse(dateRaw) : null;
    const desc = tagText(b, 'description') || tagText(b, 'summary') || tagText(b, 'content:encoded');
    const summary = desc ? plainText(desc) : '';
    const categories = (b.match(/<category\b[^>]*>([\s\S]*?)<\/category>/gi) || [])
      .map((c) => decodeEntities(stripCdata(c.replace(/<\/?category[^>]*>/gi, ''))).trim())
      .filter(Boolean);
    return {
      id: link,
      title,
      url: /^https?:/i.test(link) ? link : null,
      sourceId: source.id,
      source: source.name,
      summary,
      image: firstImage(b),
      topics: classifyTopics(title, summary, link, categories),
      createdAt: isFinite(ts) ? ts : null,
    };
  }).filter(Boolean);
}

async function fetchFromSource(source, perFeed) {
  const xml = await getText(source.url);
  return parseFeed(xml, source).slice(0, perFeed);
}

// Mezcla las fuentes pedidas (default todas), ordena por fecha desc.
async function fetchNews({ sources = [], limit = 40, perFeed = 15 } = {}) {
  const wanted = (Array.isArray(sources) && sources.length)
    ? sources.map((id) => BY_ID[id]).filter(Boolean)
    : SOURCES;
  const settled = await Promise.allSettled(wanted.map((s) => fetchFromSource(s, perFeed)));
  const posts = [];
  settled.forEach((r) => { if (r.status === 'fulfilled') posts.push(...r.value); });
  posts.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return {
    posts: posts.slice(0, Math.max(1, Math.min(120, limit))),
    sources: SOURCES.map(({ id, name }) => ({ id, name })),
    topics: TOPICS,
    fetchedAt: Date.now(),
  };
}

function listSources() {
  return SOURCES.map(({ id, name }) => ({ id, name }));
}

// Probe barato para el semáforo de Settings. Nunca rechaza.
async function checkNews() {
  try {
    const xml = await getText(SOURCES[0].url, 8000);
    return { ok: /<(item|entry)[\s>]/i.test(xml) };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { fetchNews, listSources, checkNews };
