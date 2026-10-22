const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// MongoClient falso: connect() falla y se registra si alguien lo cierra.
const created = [];
class FakeClient {
  constructor() { this.closed = false; created.push(this); }
  async connect() { throw new Error('server selection timed out'); }
  async close() { this.closed = true; }
  db() { throw new Error('no debería usarse'); }
}
const mongodbPath = require.resolve('mongodb');
require.cache[mongodbPath] = { id: mongodbPath, filename: mongodbPath, loaded: true, exports: { MongoClient: FakeClient } };
process.env.FINANCES_MONGO_URI = 'mongodb://127.0.0.1:1/x';
const mongo = require(path.join('..', 'finances', 'mongo'));

test('un connect() fallido cierra su cliente (no deja sockets ni timers colgados)', async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await mongo.connect(), null);
    assert.equal(await mongo.connect(), null);
  } finally { console.warn = warn; }
  assert.equal(created.length, 2);
  assert.ok(created.every((c) => c.closed), 'todos los clientes fallidos quedan cerrados');
});
