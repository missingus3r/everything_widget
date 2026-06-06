const https = require('https');
const crypto = require('crypto');

// Cloudflare's speed test endpoints (also used by speed.cloudflare.com).
// __down accepts ?bytes=N and streams N bytes; __up accepts arbitrary POST
// bodies and discards them. ping ≈ TTFB on a tiny download.

function timed(req) {
  const started = process.hrtime.bigint();
  return { req, started };
}

function nowMs(startedBigInt) {
  return Number(process.hrtime.bigint() - startedBigInt) / 1e6;
}

function ping() {
  // TTFB on a tiny request. With bytes=0 there is no body, so we measure
  // when response headers arrive (the https.get callback already fires
  // at that point). agent:false forces a fresh socket each attempt so we
  // capture real round-trip time, not keep-alive reuse.
  return new Promise((resolve) => {
    const samples = [];
    let attempts = 0;
    const next = () => {
      if (attempts >= 5) {
        if (!samples.length) return resolve(null);
        samples.sort((a, b) => a - b);
        return resolve(samples[Math.floor(samples.length / 2)]);
      }
      attempts++;
      const startedAt = process.hrtime.bigint();
      const req = https.get(
        'https://speed.cloudflare.com/__down?bytes=0',
        {
          agent: false,
          headers: {
            'User-Agent': 'NexusWidget/1.0',
            'Connection': 'close',
          },
        },
        (res) => {
          const ttfb = nowMs(startedAt);
          res.on('end', () => {
            samples.push(ttfb);
            next();
          });
          res.on('error', () => next());
          res.resume();
        }
      );
      req.setTimeout(4000, () => req.destroy());
      req.on('error', () => next());
    };
    next();
  });
}

function downloadTest(bytes, timeoutMs, skipBytes = 0) {
  // skipBytes: ignore the first N bytes of the response when computing throughput,
  // so TCP slow-start doesn't drag the measurement down on fast links. The timer
  // is reset once skipBytes have arrived. If the response is shorter than skipBytes
  // (or never reaches it), we fall back to whole-response timing so the result is
  // never 0 just because the skip threshold wasn't met.
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const startedAt = process.hrtime.bigint();
    const req = https.get(
      `https://speed.cloudflare.com/__down?bytes=${bytes}`,
      { agent: false, headers: { 'User-Agent': 'NexusWidget/1.0' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return done({ bytes: 0, seconds: 0 });
        }
        let received = 0;
        let measuredBytes = 0;
        let measureStart = null;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (skipBytes > 0 && measureStart === null) {
            if (received >= skipBytes) measureStart = process.hrtime.bigint();
          } else {
            measuredBytes += chunk.length;
          }
        });
        res.on('end', () => {
          if (measureStart !== null && measuredBytes > 1_000_000) {
            const sec = nowMs(measureStart) / 1000;
            done({ bytes: measuredBytes, seconds: sec });
          } else if (received > 0) {
            const sec = nowMs(startedAt) / 1000;
            done({ bytes: received, seconds: sec });
          } else {
            done({ bytes: 0, seconds: 0 });
          }
        });
        res.on('error', () => done({ bytes: 0, seconds: 0 }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => done({ bytes: 0, seconds: 0 }));
  });
}

function uploadTest(bytes, timeoutMs) {
  return new Promise((resolve) => {
    const body = crypto.randomBytes(Math.min(bytes, 8 * 1024 * 1024));
    const reps = Math.ceil(bytes / body.length);
    const startedAt = process.hrtime.bigint();
    const req = https.request(
      'https://speed.cloudflare.com/__up',
      {
        method: 'POST',
        headers: {
          'User-Agent': 'NexusWidget/1.0',
          'Content-Type': 'application/octet-stream',
          'Content-Length': body.length * reps,
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const sec = nowMs(startedAt) / 1000;
          resolve({ bytes: body.length * reps, seconds: sec });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve({ bytes: 0, seconds: 0 }));
    let i = 0;
    const writeNext = () => {
      while (i < reps) {
        const ok = req.write(body);
        i++;
        if (!ok) { req.once('drain', writeNext); return; }
      }
      req.end();
    };
    writeNext();
  });
}

function toMbps({ bytes, seconds }) {
  if (!seconds || seconds <= 0) return 0;
  return (bytes * 8) / seconds / 1e6;
}

async function runSpeedtest({ onProgress } = {}) {
  onProgress && onProgress({ phase: 'ping' });
  const pingMs = await ping();

  onProgress && onProgress({ phase: 'download' });
  // warm-up opens the connection so the main test can start with a hotter window.
  await downloadTest(2_000_000, 5000);
  // 50MB main payload + skip first 2MB to ignore TCP slow-start on fast links.
  const dl = await downloadTest(50_000_000, 45000, 2_000_000);

  onProgress && onProgress({ phase: 'upload' });
  await uploadTest(1_000_000, 5000);
  const ul = await uploadTest(25_000_000, 45000);

  return {
    pingMs: pingMs != null ? Math.round(pingMs) : null,
    downloadMbps: +toMbps(dl).toFixed(1),
    uploadMbps: +toMbps(ul).toFixed(1),
    at: Date.now(),
  };
}

module.exports = { runSpeedtest };
