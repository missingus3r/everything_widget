// Helper HTTP compartido por los módulos de APIs nuevas (main process).
// GET → JSON con timeout y User-Agent de browser (algunas APIs — Reddit,
// IMDb — rechazan UAs "raros"). Tira en HTTP >= 400 salvo que okStatus diga
// otra cosa; cada módulo decide cómo degradar.
//
// getJsonRes() devuelve además los headers de la respuesta: CheapShark publica
// el total de páginas en X-Total-Page-Count y el crawler del archivo lo
// necesita para saber cuándo terminó una tienda.

const https = require('https');

function getJsonRes(url, { timeoutMs = 10000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) NexusWidget/1.0',
        'Accept': 'application/json',
        ...headers,
      },
    }, (res) => {
      // Redirects (Reddit y Nager los usan a veces): seguir una vez.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        getJsonRes(new URL(res.headers.location, url).href, { timeoutMs, headers }).then(resolve, reject);
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
      res.on('end', () => {
        try { resolve({ data: JSON.parse(buf), headers: res.headers }); }
        catch { reject(new Error('respuesta no es JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

const getJson = (url, opts) => getJsonRes(url, opts).then((r) => r.data);

module.exports = { getJson, getJsonRes };
