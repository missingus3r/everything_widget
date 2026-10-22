const test = require('node:test');
const assert = require('node:assert/strict');
const { DAY, HOUR, WEEK, MAX_SAMPLES, normalize, recordSample, project } = require('../aiForecast');
const NOW = Date.UTC(2026, 8, 13, 12);
const sample = (pct, elapsedDays = 2, at = NOW) => ({ at, pct, resetAt: at + WEEK - elapsedDays * DAY });
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('initial weekly average predicts running out before reset and the required slowdown', () => {
  const r = project([sample(40)], NOW);
  assert.equal(r.status, 'risk');
  assert.equal(r.basis, 'week');
  approx(r.projectedPct, 140);
  approx(r.ratePerDay, 20);
  approx(r.budgetPerDay, 12);
  approx(r.exhaustionAt, NOW + 3 * DAY);
  assert.equal(r.reductionPct, 40);
});

test('safe and tight forecasts distinguish the remaining margin', () => {
  const safe = project([sample(20, 4)], NOW);
  assert.equal(safe.status, 'safe');
  approx(safe.projectedPct, 35);
  const tight = project([sample(54, 4)], NOW);
  assert.equal(tight.status, 'tight');
  approx(tight.projectedPct, 94.5);
});

test('recent measured consumption overrides the whole-week average', () => {
  const latest = sample(50, 4);
  const previous = { ...latest, at: NOW - HOUR, pct: 49 };
  const r = project([previous, latest], NOW);
  assert.equal(r.basis, 'recent');
  approx(r.ratePerDay, 24);
  approx(r.projectedPct, 122);
});

test('recent rate ignores old bursts outside the last 24 hours', () => {
  const latest = sample(60, 4);
  const r = project([
    { ...latest, at: NOW - 26 * HOUR, pct: 10 },
    { ...latest, at: NOW - 24 * HOUR, pct: 58 },
    latest,
  ], NOW);
  assert.equal(r.basis, 'recent');
  approx(r.ratePerDay, 2);
  approx(r.projectedPct, 66);
});

test('unchanged readings include idle time without division by zero', () => {
  const latest = sample(25);
  const r = project([{ ...latest, at: NOW - HOUR }, latest], NOW);
  assert.equal(r.status, 'safe');
  assert.equal(r.ratePerDay, 0);
  assert.equal(r.exhaustionAt, null);
  assert.equal(r.projectedPct, 25);
});

test('the first hour of a week waits for a usable measurement span', () => {
  const latest = { at: NOW, pct: 1, resetAt: NOW + WEEK - HOUR / 4 };
  assert.equal(project([latest], NOW).status, 'learning');
});

test('a full quota is reported without needing a rate', () => {
  assert.equal(project([sample(100)], NOW).status, 'exhausted');
});

test('old or failed readings suppress actionable forecasts', () => {
  const history = [sample(40)];
  const old = project(history, NOW + HOUR);
  assert.equal(old.status, 'stale');
  assert.equal(old.projectedPct, undefined);
  assert.equal(project(history, NOW, { available: false }).status, 'stale');
  assert.equal(project(history, NOW + HOUR, { maxAgeMs: 2 * HOUR }).status, 'risk');
});

test('an expired reset waits for confirmation instead of inventing a new week', () => {
  const latest = sample(40);
  assert.equal(project([latest], latest.resetAt).status, 'resetting');
  assert.equal(project([latest], latest.resetAt + DAY).status, 'resetting');
});

test('changing reset or decreasing usage starts a new series', () => {
  const old = sample(60);
  const nextWeek = { at: old.resetAt + HOUR, resetAt: old.resetAt + WEEK, pct: 2 };
  assert.deepEqual(recordSample([old], nextWeek), [nextWeek]);
  const corrected = { ...old, at: NOW + HOUR, pct: 20 };
  assert.deepEqual(recordSample([old], corrected), [corrected]);
});

test('malformed storage and readings never produce a fabricated quota', () => {
  for (const history of [null, {}, 'bad', [null], [{ at: NOW, pct: 50 }]]) {
    assert.equal(project(history, NOW).status, 'unavailable');
  }
  const good = sample(20);
  for (const bad of [
    { ...good, pct: NaN }, { ...good, pct: '20' }, { ...good, pct: -1 },
    { ...good, pct: 101 }, { ...good, resetAt: NOW },
    { ...good, resetAt: NOW + 8 * DAY }, { ...good, at: Infinity },
  ]) assert.deepEqual(recordSample([good], bad), [good]);
});

test('duplicate and late responses cannot distort the rate', () => {
  const initial = sample(20);
  const sameTime = { ...initial, pct: 21 };
  assert.deepEqual(recordSample([initial], sameTime), [sameTime]);
  assert.deepEqual(recordSample([initial], { ...initial, at: NOW - HOUR }), [initial]);
});

test('the history is bounded for frequent manual refreshes', () => {
  const latest = sample(20);
  const history = Array.from({ length: MAX_SAMPLES + 100 }, (_, i) => ({
    ...latest, at: NOW - (MAX_SAMPLES + 100 - i) * 1000,
  }));
  assert.equal(recordSample(history, latest).length, MAX_SAMPLES);
});

test('reloading saved history preserves the rate and separates weekly cycles', () => {
  const latest = sample(30);
  const restored = JSON.parse(JSON.stringify([{ ...latest, at: NOW - HOUR, pct: 28 }, latest]));
  assert.equal(project(restored, NOW).ratePerDay, 48);
  assert.deepEqual(normalize([sample(80), { ...latest, at: NOW + HOUR }]), [{ ...latest, at: NOW + HOUR }]);
});

test('ticking advances countdowns without changing measured rates or projecting past reset', () => {
  const history = [sample(40)];
  const initial = project(history, NOW);
  const tick = project(history, NOW + 60000);
  assert.equal(tick.projectedPct, initial.projectedPct);
  assert.equal(tick.ratePerDay, initial.ratePerDay);
  assert.equal(tick.exhaustionAt, initial.exhaustionAt);
  assert.equal(tick.remainingMs, initial.remainingMs - 60000);
  assert.equal(project(history, NOW - 1).status, 'unavailable');
});

test('an exactly sufficient budget is tight, and over-budget projections remain uncapped', () => {
  const exact = project([sample(100 / 7 * 4, 4)], NOW);
  approx(exact.projectedPct, 100);
  assert.equal(exact.status, 'tight');
  assert.ok(project([sample(90, 1)], NOW).projectedPct > 100);
});
