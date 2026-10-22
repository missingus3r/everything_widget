const test = require('node:test');
const assert = require('node:assert/strict');
const { ENRICH_FIELDS, enrichmentPatch } = require('../limeEnrich');

test('completa en Mongo solo los campos de enriquecimiento que le faltan', () => {
  const local = { _id: 1, name: 'Neglected', year: 2025, imdb: 'tt35224721', imdb_title: 'Neglected', imdb_year: 2025, cover: 'https://x/p.jpg', seeds: 9 };
  const remote = { _id: 1, name: null, year: null, imdb: null, imdb_title: null, imdb_year: null, cover: null };
  assert.deepEqual(enrichmentPatch(local, remote),
    { name: 'Neglected', year: 2025, imdb: 'tt35224721', imdb_title: 'Neglected', imdb_year: 2025, cover: 'https://x/p.jpg' });
});

test('nunca pisa un valor que Mongo ya tiene ni sube nulos', () => {
  const local = { name: 'Local', year: null, imdb: 'tt1', cover: null };
  const remote = { name: 'Remoto', imdb: null };
  assert.deepEqual(enrichmentPatch(local, remote), { imdb: 'tt1' });
});

test('sin nada que completar devuelve null', () => {
  assert.equal(enrichmentPatch({ name: null }, { name: null }), null);
  assert.deepEqual(ENRICH_FIELDS, ['name', 'year', 'imdb', 'imdb_title', 'imdb_year', 'cover']);
});
