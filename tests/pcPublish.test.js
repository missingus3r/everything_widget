const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPcStatus, buildAppKeys } = require('../pcPublish');

test('buildAppKeys resuelve las keys por nombre tolerante y deja null las que faltan', () => {
  const doc = buildAppKeys([{ name: 'TheMovieDatabase', key: 't' }, { name: 'GitHub', key: 'g' }], 5);
  assert.deepEqual(doc, { _id: 'keys', tmdb: 't', github: 'g', finnhub: null, updated_at: 5 });
});

test('buildPcStatus arma el documento del PC con lo que recibe', () => {
  const forecast = { claude: { pct: 40 } };
  const speedtest = { last: { downloadMbps: 300 } };
  const doc = buildPcStatus({
    system: { cpu: { pct: 12 } }, net: { rxBytes: 1 }, speedtest,
    ai: { claude: { session: {} }, codex: null, eleven: null, local: null }, forecast,
    stockSymbols: ['AAPL'], now: 9,
  });
  assert.equal(doc._id, 'pc');
  assert.equal(doc.updated_at, 9);
  assert.deepEqual(doc.system, { cpu: { pct: 12 } });
  assert.deepEqual(doc.net, { usage: { rxBytes: 1 }, speedtest });
  assert.equal(doc.ai.forecast, forecast);
  assert.deepEqual(doc.ai.claude, { session: {} });
  assert.deepEqual(doc.stockSymbols, ['AAPL']);
});

test('buildPcStatus sin datos de AI deja todo en null', () => {
  const doc = buildPcStatus({ now: 1 });
  assert.deepEqual(doc.ai, { claude: null, codex: null, agy: null, eleven: null, local: null, forecast: null });
  assert.deepEqual(doc.net, { usage: null, speedtest: null });
  assert.equal(doc.system, null);
  assert.deepEqual(doc.stockSymbols, []);
});
