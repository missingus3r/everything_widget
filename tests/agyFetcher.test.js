const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScreen, durationMinutes, agyEnv } = require('../fetchers/agyFetcher');

// Pantalla de `agy` → /usage tal como queda reconstruida (cuenta de ejemplo).
const SCREEN = `
      ▄▀▀▄        Antigravity CLI 1.4.10
     ▀▀▀▀▀▀       someone@example.com (Google AI Pro)
    ▀▀▀▀▀▀▀▀      Gemini 4 Argon (High)
   ▄▀▀    ▀▀▄     ~/Desktop
>
└ Models & Quota

  Account: someone@example.com

GEMINI MODELS
  Weekly Limit Remainingup: Gemini Flash, Gemini Pro
    [██████████████████████████████████████████████████] 100.00%
    Quota available

  Five Hour Limit Remaining
    [████████████████████████████████████░░░░░░░░░░░░░░] 72.40%
    Refreshes in 3h 12m


CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit Remaining
    [██████████████████████████████████████████████████] 100.00%
    Quota available

  Five Hour Limit Remaining
    [██████████████████████████████████████████████████] 100.00%
    Quota available


GEMINI 4 ARGON
  For paid Pro plans, Argon quota is separate.

  Gemini 4 Argon Weekly Limit
    [█████████████████████████████████████████████████░] 98.72%
    Refreshes in 167h 53m


  │Within each group, models share a weekly limit and a 5-hour limit. Quota is
  │consumed proportionally to the cost of the tokens.
`;

test('parseScreen lee cuenta, modelo y los cupos por grupo como % usado', () => {
  const d = parseScreen(SCREEN);
  assert.deepEqual(d.account, { email: 'someone@example.com', plan: 'Google AI Pro' });
  assert.deepEqual(d.model, { name: 'Gemini 4 Argon', effort: 'High' });
  assert.deepEqual(d.gemini.weekly, { pct: 0, pctLeft: 100, resets: null, resetInMin: null });
  assert.deepEqual(d.gemini.h5, { pct: 27.6, pctLeft: 72.4, resets: '3h 12m', resetInMin: 192 });
  assert.equal(d.partner.weekly.pct, 0);
  assert.equal(d.partner.h5.pct, 0);
  assert.deepEqual(d.argon.weekly, { pct: 1.3, pctLeft: 98.72, resets: '167h 53m', resetInMin: 10073 });
  assert.equal(d.argon.h5, undefined);
});

test('parseScreen sin la vista de cupos no inventa grupos', () => {
  const d = parseScreen('  someone@example.com (Google AI Pro)\n  Gemini 4 Argon (High)\n>');
  assert.equal(d.gemini, undefined);
  assert.equal(d.account.plan, 'Google AI Pro');
});

test('durationMinutes entiende d/h/m', () => {
  assert.equal(durationMinutes('167h 53m'), 10073);
  assert.equal(durationMinutes('2d 4h'), 3120);
  assert.equal(durationMinutes('45m'), 45);
  assert.equal(durationMinutes('soon'), null);
});

// El actualizador de agy corre fuera de la consola oculta del pty: en Windows abre
// una ventana de terminal. El dashboard lanza agy cada 15 min, justo su intervalo.
test('la sesión del fetcher apaga el autoupdate de agy y conserva el entorno', () => {
  const env = agyEnv({ PATH: 'x', TERM: 'dumb' });
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true'); // agy ignora '1', 'TRUE', 'yes'…
  assert.equal(env.PATH, 'x');
  assert.equal(env.TERM, 'xterm-256color');
});
