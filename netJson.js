// Helper HTTP compartido por los módulos de APIs nuevas (main process).
// GET → JSON con timeout y User-Agent de browser (algunas APIs — Reddit,
// IMDb — rechazan UAs "raros"). Tira en HTTP >= 400 salvo que okStatus diga
// otra cosa; cada módulo decide cómo degradar.

const https = require('https');

function getJson(url, { timeoutMs = 10000, headers = {} } = {}) {
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
        getJson(new URL(res.headers.location, url).href, { timeoutMs, headers }).then(resolve, reject);
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
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error('respuesta no es JSON')); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

module.exports = { getJson };
