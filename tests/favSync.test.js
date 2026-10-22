const test = require('node:test');
const assert = require('node:assert/strict');
const { tombId, tombDoc, splitTombstoned, remoteTombstoned, FAV_DELETIONS } = require('../favSync');

test('tombId arma "<kind>:<id>"', () => {
  assert.equal(tombId('movie', -42), 'movie:-42');
  assert.equal(FAV_DELETIONS, 'fav_deletions');
});

test('tombDoc lleva kind, ref_id y deleted_at', () => {
  assert.deepEqual(tombDoc('series', 7, 1000), { _id: 'series:7', kind: 'series', ref_id: 7, deleted_at: 1000 });
});

test('splitTombstoned separa solo los del mismo kind', () => {
  const r = splitTombstoned([{ id: 1 }, { id: 2 }, { id: 3 }], [{ _id: 'movie:2' }, { _id: 'series:3' }], 'movie');
  assert.deepEqual(r.keep.map((x) => x.id), [1, 3]);
  assert.deepEqual(r.drop, [2]);
});

test('splitTombstoned compara ids numéricamente', () => {
  const r = splitTombstoned([{ id: '2' }, { id: 5 }], [{ _id: 'movie:2' }], 'movie');
  assert.deepEqual(r.drop, [2]);
  assert.deepEqual(r.keep.map((x) => Number(x.id)), [5]);
});

test('splitTombstoned conserva una re-alta posterior al borrado y la marca como revivida', () => {
  const tombs = [{ _id: 'movie:2', deleted_at: 100 }, { _id: 'movie:3', deleted_at: 100 }];
  const r = splitTombstoned([{ id: 2, addedAt: 50 }, { id: 3, addedAt: 150 }], tombs, 'movie');
  assert.deepEqual(r.drop, [2]);
  assert.deepEqual(r.keep.map((x) => x.id), [3]);
  assert.deepEqual(r.revived, [3]);
});

test('remoteTombstoned devuelve los docs de Mongo que el tombstone tapa (no las re-altas)', () => {
  const tombs = [{ _id: 'series:1', deleted_at: 100 }, { _id: 'series:2', deleted_at: 100 }, { _id: 'movie:3', deleted_at: 100 }];
  const docs = [{ _id: 1, added_at: 90 }, { _id: 2, added_at: 120 }, { _id: 3, added_at: 10 }, { _id: 4 }];
  assert.deepEqual(remoteTombstoned(docs, tombs, 'series'), { dead: [1], revived: [2] });
});

test('remoteTombstoned trata un doc sin added_at como anterior al borrado', () => {
  assert.deepEqual(remoteTombstoned([{ _id: 5 }], [{ _id: 'folder:5', deleted_at: 1 }], 'folder'), { dead: [5], revived: [] });
});
