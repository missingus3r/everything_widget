const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../theme');

// Defaults de :root en styles.css, para comparar contra lo que emite theme.js.
const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const rootBody = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')));
const rootVars = new Set([...rootBody.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
// Variables sin default en :root a propósito: styles.css las usa con fallback.
const FALLBACK_ONLY = /^--(btn-|widget-bg$|accent-hi$|ok-hi$|warn-hi$|danger-text-hi$)/;

test('the default theme without adjustments overrides nothing', () => {
  const { vars, scheme } = T.buildVars('default', null);
  assert.deepEqual(vars, {});
  assert.equal(scheme, 'dark');
});

test('the default palette matches the :root values in styles.css', () => {
  const p = T.themeById('default').palette;
  const def = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(rootBody)[1].trim();
  assert.equal(def('--text'), p.text);
  assert.equal(def('--accent'), p.accent);
  assert.equal(def('--accent2'), p.accent2);
  assert.equal(def('--info'), p.info);
  assert.equal(def('--ok'), p.ok);
  assert.equal(def('--warn'), p.warn);
  assert.equal(def('--danger'), p.danger);
  assert.equal(def('--bg-rgb'), T.parseHex(p.bg).join(','));
});

test('there are at least five themes besides the default, all distinct', () => {
  assert.ok(T.THEMES.length >= 6);
  assert.equal(T.THEMES[0].id, 'default');
  for (const key of ['id', 'name']) assert.equal(new Set(T.THEMES.map((t) => t[key])).size, T.THEMES.length);
  for (const key of ['bg', 'accent']) assert.equal(new Set(T.THEMES.map((t) => t.palette[key])).size, T.THEMES.length);
  assert.equal(new Set(T.THEMES.map((t) => t.font)).size, T.THEMES.length);
});

test('every theme only emits variables that styles.css knows about', () => {
  for (const t of T.THEMES) {
    const { vars } = T.buildVars(t.id, null);
    for (const name of Object.keys(vars)) {
      assert.ok(rootVars.has(name) || FALLBACK_ONLY.test(name), `${t.id}: ${name} is not a known token`);
    }
    if (t.id !== 'default') {
      // Un tema completo redefine toda la paleta base.
      for (const name of ['--bg-rgb', '--text', '--accent', '--accent2', '--info', '--ok', '--warn', '--danger', '--font', '--fs', '--rad']) {
        assert.ok(name in vars, `${t.id} is missing ${name}`);
      }
    }
  }
});

test('light and dark themes get the matching scheme and readable text', () => {
  for (const t of T.THEMES) {
    const { scheme } = T.buildVars(t.id, null);
    assert.equal(scheme, T.isDark(t.palette.bg) ? 'dark' : 'light');
    const [a, b] = [T.luminance(t.palette.bg), T.luminance(t.palette.text)];
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(contrast >= 7, `${t.id}: text contrast ${contrast.toFixed(1)}`);
  }
  assert.equal(T.buildVars('paper', null).scheme, 'light');
  assert.equal(T.buildVars('paper', null).vars['--scheme'], 'light');
});

test('adjusting one color on the default theme only touches that group', () => {
  const { vars } = T.buildVars('default', { accent: '#00ff00' });
  assert.equal(vars['--accent'], '#00ff00');
  assert.equal(vars['--accent-rgb'], '0,255,0');
  assert.ok(Object.keys(vars).every((n) => /^--(accent|on-accent|brand-grad-hover)/.test(n)), Object.keys(vars).join(' '));
});

test('button style, color, text and radius are adjustable on their own', () => {
  const solid = T.buildVars('default', { btnStyle: 'solid', btnColor: '#ff0000' }).vars;
  assert.equal(solid['--btn-bg'], '#ff0000');
  assert.equal(solid['--btn-fg'], '#ffffff');
  assert.equal(solid['--accent'], undefined);
  const outline = T.buildVars('default', { btnStyle: 'outline', btnText: '#00ffff', btnRadius: 12 }).vars;
  assert.equal(outline['--btn-bg'], 'transparent');
  assert.equal(outline['--btn-fg'], '#00ffff');
  assert.equal(outline['--btn-radius'], '12px');
  // Sin color propio, el botón sigue al acento.
  assert.equal(T.buildVars('default', { btnStyle: 'solid', accent: '#123456' }).vars['--btn-bg'], '#123456');
});

test('font, size and shape are adjustable on their own and clamped', () => {
  const { vars } = T.buildVars('default', { font: 'georgia', fontScale: 9, radius: -3, bgAlpha: 0.8 });
  assert.match(vars['--font'], /^Georgia/);
  assert.equal(vars['--fs'], '1.25');
  assert.equal(vars['--rad'], '0');
  assert.equal(vars['--bg-alpha'], '0.8');
});

test('user adjustments win over the extras of a theme', () => {
  assert.ok(T.buildVars('synthwave', null).vars['--widget-bg']);
  assert.equal(T.buildVars('synthwave', { bg: '#000000' }).vars['--widget-bg'], undefined);
  assert.equal(T.buildVars('brutal', null).vars['--btn-shadow'], '3px 3px 0 #0a0a0a');
  assert.equal(T.buildVars('brutal', { btnStyle: 'soft' }).vars['--btn-shadow'], 'none');
});

test('stored state is sanitized', () => {
  const s = T.sanitizeState({ theme: 'nope', custom: { paper: { bg: 'red', accent: '#ABCDEF', font: 'x', junk: 1 }, ghost: { bg: '#000000' } } });
  assert.equal(s.theme, 'default');
  assert.deepEqual(s.custom, { paper: { accent: '#abcdef' } });
  assert.deepEqual(T.sanitizeState('garbage'), { theme: 'default', custom: {} });
});
