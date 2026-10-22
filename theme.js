// Temas del widget (Settings → Tema). Un tema es una paleta base + fuente +
// forma; de ahí se derivan los tokens CSS de styles.css (:root) y se pisan en
// <html>. Encima de cada tema el usuario puede ajustar colores, botones, letra
// y forma por separado; esos ajustes se guardan por tema en localStorage.
// Se carga en <head> para aplicar el tema antes del primer pintado.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NexusTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const STORAGE_KEY = 'nexusTheme';

  // ── Color utils ──────────────────────────────────────────────
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  function parseHex(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const isHex = (hex) => !!parseHex(hex);
  const toHex = (rgb) => '#' + rgb.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  // mix(a, b, t): t = 0 → a, t = 1 → b.
  function mix(a, b, t) {
    const x = parseHex(a), y = parseHex(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * t));
  }
  const triplet = (hex) => parseHex(hex).join(',');
  const rgba = (hex, a) => `rgba(${triplet(hex)},${a})`;
  // Luminancia relativa (WCAG), 0 = negro, 1 = blanco.
  function luminance(hex) {
    const [r, g, b] = parseHex(hex).map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const isDark = (hex) => luminance(hex) < 0.35;
  // Texto legible encima de un color sólido.
  const onColor = (hex) => (luminance(hex) > 0.45 ? '#0b0b0f' : '#ffffff');

  // ── Catálogos ────────────────────────────────────────────────
  // Solo fuentes que vienen con Windows (el widget no empaqueta tipografías).
  const FONTS = [
    { id: 'segoe', label: 'Segoe UI', stack: "'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif" },
    { id: 'bahnschrift', label: 'Bahnschrift', stack: "'Bahnschrift', 'Segoe UI', sans-serif" },
    { id: 'calibri', label: 'Calibri', stack: "'Calibri', 'Segoe UI', sans-serif" },
    { id: 'trebuchet', label: 'Trebuchet MS', stack: "'Trebuchet MS', 'Segoe UI', sans-serif" },
    { id: 'verdana', label: 'Verdana', stack: "'Verdana', 'Segoe UI', sans-serif" },
    { id: 'franklin', label: 'Franklin Gothic', stack: "'Franklin Gothic Medium', 'Arial Narrow', Arial, sans-serif" },
    { id: 'arial', label: 'Arial', stack: "Arial, 'Helvetica Neue', sans-serif" },
    { id: 'georgia', label: 'Georgia (serif)', stack: "Georgia, 'Times New Roman', serif" },
    { id: 'cambria', label: 'Cambria (serif)', stack: "Cambria, Georgia, serif" },
    { id: 'palatino', label: 'Palatino (serif)', stack: "'Palatino Linotype', 'Book Antiqua', Georgia, serif" },
    { id: 'cascadia', label: 'Cascadia Mono', stack: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace" },
    { id: 'consolas', label: 'Consolas (mono)', stack: "Consolas, 'Courier New', monospace" },
    { id: 'comic', label: 'Comic Sans MS', stack: "'Comic Sans MS', 'Segoe UI', sans-serif" },
  ];
  const BTN_STYLES = [
    { id: 'gradient', label: 'Degradado' },
    { id: 'solid', label: 'Sólido' },
    { id: 'outline', label: 'Contorno' },
    { id: 'soft', label: 'Suave' },
  ];
  const COLOR_KEYS = [
    { key: 'bg', label: 'Fondo' },
    { key: 'text', label: 'Texto' },
    { key: 'accent', label: 'Acento' },
    { key: 'accent2', label: 'Acento secundario' },
    { key: 'info', label: 'Info / enlaces' },
    { key: 'ok', label: 'Positivo' },
    { key: 'warn', label: 'Alerta' },
    { key: 'danger', label: 'Error' },
  ];
  const LIMITS = {
    fontScale: [0.85, 1.25], radius: [0, 2], bgAlpha: [0.6, 1], btnRadius: [0, 20],
  };

  // El primero es el look original: sus valores son los de :root en styles.css,
  // así que sin ajustes no se pisa ninguna variable.
  const THEMES = [
    {
      id: 'default', name: 'Nexus', desc: 'El original: violeta y cian sobre gris carbón.',
      palette: { bg: '#14161e', text: '#e4e4e7', accent: '#a855f7', accent2: '#22d3ee', info: '#60a5fa', ok: '#4ade80', warn: '#facc15', danger: '#ef4444' },
      font: 'segoe', fontScale: 1, radius: 1, bgAlpha: 0.94, btnStyle: 'gradient',
    },
    {
      id: 'terminal', name: 'Terminal', desc: 'Fósforo verde, monoespaciada, todo en ángulo recto.',
      palette: { bg: '#040804', text: '#b4f5b8', accent: '#33ff66', accent2: '#ffb000', info: '#4de3c1', ok: '#33ff66', warn: '#ffd24a', danger: '#ff5555' },
      font: 'cascadia', fontScale: 0.95, radius: 0, bgAlpha: 0.97, btnStyle: 'outline',
      extra: {
        '--clock-grad': 'linear-gradient(#33ff66, #33ff66)',
        '--tab-line': 'linear-gradient(#33ff66, #33ff66)',
        '--font-mono': "'Cascadia Mono', Consolas, 'Courier New', monospace",
      },
    },
    {
      id: 'paper', name: 'Papel', desc: 'Claro y cálido, con serif: tinta sobre papel crema.',
      palette: { bg: '#f4efe6', text: '#2a2520', accent: '#b4532a', accent2: '#0f766e', info: '#1d4ed8', ok: '#15803d', warn: '#b45309', danger: '#b91c1c' },
      font: 'georgia', fontScale: 1, radius: 0.6, bgAlpha: 1, btnStyle: 'solid',
      extra: { '--clock-grad': 'linear-gradient(135deg, #2a2520, #b4532a)' },
    },
    {
      id: 'synthwave', name: 'Synthwave', desc: 'Neón rosa y cian sobre violeta profundo, con brillo.',
      palette: { bg: '#160a2b', text: '#f3e8ff', accent: '#ff2e97', accent2: '#00e5ff', info: '#7aa2ff', ok: '#39ffb0', warn: '#ffe14a', danger: '#ff4d6d' },
      font: 'bahnschrift', fontScale: 1.02, radius: 1.5, bgAlpha: 0.96, btnStyle: 'gradient',
      extra: {
        '--widget-bg': 'linear-gradient(160deg, rgba(40,12,72,0.97), rgba(18,8,42,0.97) 55%, rgba(6,22,52,0.97))',
        '--clock-grad': 'linear-gradient(90deg, #ff2e97, #ffb347 50%, #00e5ff)',
      },
    },
    {
      id: 'nord', name: 'Nórdico', desc: 'Azules fríos y apagados, plano y sin brillos.',
      palette: { bg: '#2e3440', text: '#e5e9f0', accent: '#88c0d0', accent2: '#81a1c1', info: '#8fbcbb', ok: '#a3be8c', warn: '#ebcb8b', danger: '#bf616a' },
      font: 'calibri', fontScale: 1.06, radius: 0.7, bgAlpha: 1, btnStyle: 'soft',
      extra: { '--clock-grad': 'linear-gradient(135deg, #eceff4, #88c0d0)' },
    },
    {
      id: 'brutal', name: 'Brutal', desc: 'Claro de alto contraste: bordes gruesos y sombras duras.',
      palette: { bg: '#f2f2ee', text: '#0a0a0a', accent: '#2b3bff', accent2: '#ff3d00', info: '#2b3bff', ok: '#008a3e', warn: '#b86e00', danger: '#d40000' },
      font: 'franklin', fontScale: 1.02, radius: 0, bgAlpha: 1, btnStyle: 'solid',
      extra: {
        '--clock-grad': 'linear-gradient(#0a0a0a, #0a0a0a)',
        '--tab-line': 'linear-gradient(#2b3bff, #2b3bff)',
        '--btn-border': '#0a0a0a',
        '--btn-shadow': '3px 3px 0 #0a0a0a',
        '--btn-shadow-hover': '5px 5px 0 #0a0a0a',
      },
    },
    {
      id: 'ember', name: 'Brasa', desc: 'Naranjas y dorados sobre marrón oscuro, bien redondeado.',
      palette: { bg: '#1a120d', text: '#f3e3d0', accent: '#ff7a1a', accent2: '#ffc145', info: '#e9a56b', ok: '#9bd65b', warn: '#ffc145', danger: '#ff5a4f' },
      font: 'trebuchet', fontScale: 1, radius: 1.3, bgAlpha: 0.96, btnStyle: 'gradient',
      extra: { '--clock-grad': 'linear-gradient(135deg, #ffc145, #ff7a1a 55%, #ff5a4f)' },
    },
  ];
  const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
  const fontById = (id) => FONTS.find((f) => f.id === id) || FONTS[0];

  // ── Estado ───────────────────────────────────────────────────
  // { theme: id, custom: { [themeId]: { bg, text, …, font, fontScale, radius,
  //   bgAlpha, btnStyle, btnColor, btnText, btnRadius } } }
  function sanitizeCustom(c) {
    const out = {};
    if (!c || typeof c !== 'object') return out;
    for (const { key } of COLOR_KEYS) if (isHex(c[key])) out[key] = c[key].toLowerCase();
    for (const key of ['btnColor', 'btnText']) if (isHex(c[key])) out[key] = c[key].toLowerCase();
    if (FONTS.some((f) => f.id === c.font)) out.font = c.font;
    if (BTN_STYLES.some((s) => s.id === c.btnStyle)) out.btnStyle = c.btnStyle;
    for (const key of Object.keys(LIMITS)) {
      const n = Number(c[key]);
      if (c[key] != null && c[key] !== '' && Number.isFinite(n)) out[key] = clamp(n, LIMITS[key][0], LIMITS[key][1]);
    }
    return out;
  }
  function sanitizeState(s) {
    const state = { theme: 'default', custom: {} };
    if (!s || typeof s !== 'object') return state;
    if (THEMES.some((t) => t.id === s.theme)) state.theme = s.theme;
    for (const t of THEMES) {
      const c = sanitizeCustom(s.custom && s.custom[t.id]);
      if (Object.keys(c).length) state.custom[t.id] = c;
    }
    return state;
  }
  // Valor efectivo de un ajuste: el del usuario o, si no tocó nada, el del tema.
  function effective(theme, custom, key) {
    if (custom && custom[key] != null) return custom[key];
    if (key in theme.palette) return theme.palette[key];
    if (key === 'btnColor') return (custom && custom.accent) || theme.palette.accent;
    if (key === 'btnText') return null;
    if (key === 'btnRadius') return null;
    return theme[key];
  }

  // ── Derivación de tokens ─────────────────────────────────────
  // Devuelve { vars, scheme }. En el tema por defecto solo se emiten los
  // grupos que el usuario tocó: lo demás queda con los valores exactos de :root.
  function buildVars(themeId, customIn) {
    const theme = themeById(themeId);
    const custom = sanitizeCustom(customIn);
    const base = theme.id === 'default';
    const p = { ...theme.palette };
    for (const { key } of COLOR_KEYS) if (custom[key]) p[key] = custom[key];
    const need = (key) => !base || custom[key] != null;
    const dark = isDark(p.bg);
    // Hacia "más claro" en temas oscuros y "más oscuro" en claros: variantes de
    // un color pensadas para usarse como texto sobre el fondo.
    const ink = (c, t) => mix(c, dark ? '#ffffff' : '#000000', t);
    const v = {};

    if (need('bg')) {
      v['--bg-rgb'] = triplet(p.bg);
      v['--bg-elev'] = dark ? mix(p.bg, '#ffffff', 0.06) : mix(p.bg, '#ffffff', 0.6);
      v['--fg-rgb'] = dark ? '255,255,255' : triplet(mix(p.text, '#000000', 0.2));
      v['--well-rgb'] = dark ? '0,0,0' : triplet(mix(p.bg, p.text, 0.3));
      v['--text-hi'] = dark ? '#ffffff' : mix(p.text, '#000000', 0.4);
      v['--scheme'] = dark ? 'dark' : 'light';
    }
    if (need('text')) {
      v['--text'] = p.text;
      v['--text-2'] = mix(p.text, p.bg, 0.08);
      v['--text-muted'] = mix(p.text, p.bg, 0.33);
      v['--text-dim'] = mix(p.text, p.bg, dark ? 0.55 : 0.45);
      v['--text-faint'] = mix(p.text, p.bg, 0.7);
    }
    if (need('accent')) {
      const a = p.accent, deep = mix(a, '#000000', 0.2), deeper = mix(a, '#000000', 0.36);
      v['--accent'] = a;
      v['--accent-rgb'] = triplet(a);
      v['--accent-deep'] = deep;
      v['--accent-deep-rgb'] = triplet(deep);
      v['--accent-deeper'] = deeper;
      v['--accent-light'] = dark ? mix(a, '#ffffff', 0.25) : a;
      v['--accent-mid'] = dark ? mix(a, '#ffffff', 0.15) : a;
      v['--accent-mid-rgb'] = triplet(v['--accent-mid']);
      v['--accent-text'] = ink(a, dark ? 0.5 : 0.2);
      v['--accent-text-2'] = ink(a, dark ? 0.6 : 0.3);
      v['--accent-hi'] = ink(a, dark ? 0.8 : 0.45);
      v['--on-accent'] = onColor(deep);
      v['--on-accent-hi'] = onColor(deep);
      v['--brand-grad-hover'] = `linear-gradient(135deg, ${mix(deeper, '#ffffff', 0.1)}, ${mix(deep, '#ffffff', 0.1)} 55%, ${mix(a, '#ffffff', 0.15)})`;
    }
    if (need('accent2')) {
      v['--accent2'] = p.accent2;
      v['--accent2-rgb'] = triplet(p.accent2);
      v['--accent2-deep'] = mix(p.accent2, '#000000', 0.2);
      v['--accent2-light'] = mix(p.accent2, '#ffffff', 0.3);
    }
    if (need('info')) {
      v['--info'] = p.info;
      v['--info-rgb'] = triplet(p.info);
      v['--info-text'] = ink(p.info, dark ? 0.35 : 0.2);
    }
    if (need('ok')) {
      const deep = mix(p.ok, '#000000', 0.15);
      v['--ok'] = p.ok;
      v['--ok-rgb'] = triplet(p.ok);
      v['--ok-deep'] = deep;
      v['--ok-deep-rgb'] = triplet(deep);
      v['--ok-text'] = ink(p.ok, dark ? 0.35 : 0.2);
      v['--ok-text-2'] = ink(p.ok, dark ? 0.6 : 0.35);
      v['--ok-hi'] = ink(p.ok, dark ? 0.88 : 0.45);
    }
    if (need('warn')) {
      v['--warn'] = p.warn;
      v['--warn-rgb'] = triplet(p.warn);
      v['--warn-2'] = p.warn;
      v['--warn-2-rgb'] = triplet(p.warn);
      v['--warn-deep'] = mix(p.warn, '#000000', 0.12);
      v['--warn-text'] = ink(p.warn, dark ? 0.3 : 0.2);
      v['--warn-text-2'] = ink(p.warn, dark ? 0.5 : 0.3);
      v['--warn-hi'] = ink(p.warn, dark ? 0.88 : 0.45);
    }
    if (need('danger')) {
      const d2 = dark ? mix(p.danger, '#ffffff', 0.15) : p.danger;
      v['--danger'] = p.danger;
      v['--danger-rgb'] = triplet(p.danger);
      v['--danger-2'] = d2;
      v['--danger-2-rgb'] = triplet(d2);
      v['--danger-deep'] = mix(p.danger, '#000000', 0.15);
      v['--danger-text'] = ink(p.danger, dark ? 0.45 : 0.2);
      v['--danger-text-hi'] = ink(p.danger, dark ? 0.8 : 0.4);
    }

    if (need('font')) v['--font'] = fontById(effective(theme, custom, 'font')).stack;
    if (need('fontScale')) v['--fs'] = String(effective(theme, custom, 'fontScale'));
    if (need('radius')) v['--rad'] = String(effective(theme, custom, 'radius'));
    if (need('bgAlpha')) v['--bg-alpha'] = String(effective(theme, custom, 'bgAlpha'));

    // Botones primarios. Sin tocar nada, el degradado sale solo del acento
    // (fallbacks de styles.css); el resto de estilos define los --btn-*.
    const style = effective(theme, custom, 'btnStyle');
    const c = effective(theme, custom, 'btnColor');
    const fgUser = custom.btnText || null;
    const btnTouched = custom.btnStyle != null || custom.btnColor != null || custom.btnText != null;
    if (style === 'gradient') {
      if (custom.btnColor) {
        const deep = mix(c, '#000000', 0.2), deeper = mix(c, '#000000', 0.36);
        v['--btn-bg'] = `linear-gradient(135deg, ${deeper}, ${deep} 55%, ${c})`;
        v['--btn-bg-hover'] = `linear-gradient(135deg, ${mix(deeper, '#ffffff', 0.1)}, ${mix(deep, '#ffffff', 0.1)} 55%, ${mix(c, '#ffffff', 0.15)})`;
        v['--btn-border'] = rgba(c, 0.5);
        v['--btn-shadow'] = `0 4px 14px ${rgba(deep, 0.32)}`;
        v['--btn-shadow-hover'] = `0 6px 18px ${rgba(deep, 0.42)}`;
        v['--btn-fg'] = fgUser || onColor(deep);
        v['--btn-fg-hover'] = v['--btn-fg'];
      } else if (fgUser) {
        v['--btn-fg'] = fgUser;
        v['--btn-fg-hover'] = fgUser;
      }
    } else if (style === 'solid') {
      v['--btn-bg'] = c;
      v['--btn-bg-hover'] = mix(c, luminance(c) > 0.45 ? '#000000' : '#ffffff', 0.14);
      v['--btn-border'] = c;
      v['--btn-shadow'] = 'none';
      v['--btn-shadow-hover'] = 'none';
      v['--btn-fg'] = fgUser || onColor(c);
      v['--btn-fg-hover'] = v['--btn-fg'];
    } else if (style === 'outline') {
      v['--btn-bg'] = 'transparent';
      v['--btn-bg-hover'] = rgba(c, 0.16);
      v['--btn-border'] = c;
      v['--btn-shadow'] = 'none';
      v['--btn-shadow-hover'] = `0 0 12px ${rgba(c, 0.35)}`;
      v['--btn-fg'] = fgUser || c;
      v['--btn-fg-hover'] = v['--btn-fg'];
    } else if (style === 'soft') {
      v['--btn-bg'] = rgba(c, 0.18);
      v['--btn-bg-hover'] = rgba(c, 0.3);
      v['--btn-border'] = rgba(c, 0.4);
      v['--btn-shadow'] = 'none';
      v['--btn-shadow-hover'] = 'none';
      v['--btn-fg'] = fgUser || ink(c, dark ? 0.45 : 0.25);
      v['--btn-fg-hover'] = v['--btn-fg'];
    }
    if (custom.btnRadius != null) v['--btn-radius'] = custom.btnRadius + 'px';

    // Extras propios del tema (fondos degradados, reloj…). Los que dependen de
    // algo que el usuario ajustó se descartan para que el ajuste se vea.
    for (const [name, value] of Object.entries(theme.extra || {})) {
      if (name === '--widget-bg' && (custom.bg || custom.bgAlpha != null)) continue;
      if (name.startsWith('--btn-') && btnTouched) continue;
      if ((name === '--clock-grad' || name === '--tab-line') && (custom.accent || custom.accent2)) continue;
      v[name] = value;
    }
    return { vars: v, scheme: dark ? 'dark' : 'light' };
  }

  const api = {
    STORAGE_KEY, THEMES, FONTS, BTN_STYLES, COLOR_KEYS, LIMITS,
    parseHex, toHex, mix, luminance, isDark, onColor,
    themeById, sanitizeState, sanitizeCustom, effective, buildVars,
  };
  if (typeof document === 'undefined') return api;

  // ── Aplicación en el DOM ─────────────────────────────────────
  let state = sanitizeState(null);
  let applied = [];   // variables puestas en <html> por la última aplicación

  function load() {
    try { state = sanitizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
    catch { state = sanitizeState(null); }
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }
  const currentCustom = () => state.custom[state.theme] || {};

  function apply() {
    const el = document.documentElement;
    const { vars, scheme } = buildVars(state.theme, currentCustom());
    for (const name of applied) if (!(name in vars)) el.style.removeProperty(name);
    for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
    applied = Object.keys(vars);
    el.dataset.theme = state.theme;
    el.dataset.scheme = scheme;
    fitTabs();
    // Fuente y tamaños cambian el alto del contenido: la ventana se re-ajusta.
    if (typeof window.adjustWindowSize === 'function') window.adjustWindowSize();
  }

  // Con fuentes anchas o letra grande el menú de pestañas no entra en el ancho
  // del widget: se achica (--tab-fit) lo justo para que entre en una línea.
  function fitTabs() {
    const tabs = document.querySelector('.tabs');
    if (!tabs) return;
    const el = document.documentElement;
    el.style.removeProperty('--tab-fit');
    let fit = 1;
    for (let i = 0; i < 4 && tabs.scrollWidth > tabs.clientWidth + 1; i++) {
      fit = Math.max(0.6, fit * (tabs.clientWidth / tabs.scrollWidth) - 0.01);
      el.style.setProperty('--tab-fit', fit.toFixed(3));
    }
  }

  function setTheme(id) {
    state.theme = themeById(id).id;
    save(); apply(); syncUi();
  }
  function setCustom(key, value) {
    const next = { ...currentCustom() };
    if (value == null) delete next[key]; else next[key] = value;
    const clean = sanitizeCustom(next);
    if (Object.keys(clean).length) state.custom[state.theme] = clean;
    else delete state.custom[state.theme];
    save(); apply(); syncUi();
  }
  function resetCustom() {
    delete state.custom[state.theme];
    save(); apply(); syncUi();
  }

  // ── UI en Settings ───────────────────────────────────────────
  let ui = null;
  const h = (tag, attrs, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, val] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = val;
      else if (k === 'text') el.textContent = val;
      else if (k === 'style') el.style.cssText = val;
      else el.setAttribute(k, val);
    }
    for (const kid of kids) if (kid) el.append(kid);
    return el;
  };

  // Tarjeta de un tema: miniatura pintada con su propia paleta y fuente.
  function themeCard(t) {
    const p = t.palette, dark = isDark(p.bg);
    const font = fontById(t.font).stack;
    const rad = Math.round(6 * t.radius);
    const cardBg = dark ? mix(p.bg, '#ffffff', 0.07) : mix(p.bg, '#ffffff', 0.7);
    const line = rgba(dark ? '#ffffff' : p.text, dark ? 0.12 : 0.2);
    const { vars } = buildVars(t.id, null);
    const btnBg = vars['--btn-bg'] || `linear-gradient(135deg, ${mix(p.accent, '#000000', 0.36)}, ${p.accent})`;
    const btnFg = vars['--btn-fg'] || onColor(mix(p.accent, '#000000', 0.2));
    const btnBorder = vars['--btn-border'] || rgba(p.accent, 0.5);
    const swatch = h('span', { class: 'theme-swatch', style: `background:${p.bg};font-family:${font};border-radius:${rad}px;` },
      h('span', { class: 'theme-swatch-title', style: `color:${p.text};`, text: 'Aa 12:45' }),
      h('span', { class: 'theme-swatch-card', style: `background:${cardBg};border:1px solid ${line};border-radius:${rad}px;` },
        h('span', { class: 'theme-swatch-bar', style: `background:linear-gradient(90deg, ${p.accent}, ${p.accent2});` }),
        h('span', { class: 'theme-swatch-dots' },
          ...[p.ok, p.warn, p.danger, p.info].map((c) => h('i', { style: `background:${c};` })))),
      h('span', { class: 'theme-swatch-btn', style: `background:${btnBg};color:${btnFg};border:1px solid ${btnBorder};border-radius:${rad}px;`, text: 'Botón' }));
    const card = h('button', { class: 'theme-card', type: 'button', 'data-theme-id': t.id, title: t.desc },
      swatch,
      h('span', { class: 'theme-card-name', text: t.name }),
      h('span', { class: 'theme-card-desc', text: t.desc }));
    card.addEventListener('click', () => setTheme(t.id));
    return card;
  }

  // Fila de ajuste: etiqueta + control + ↺ para volver al valor del tema.
  function row(label, key, control) {
    const reset = h('button', { class: 'theme-reset', type: 'button', title: 'Volver al valor del tema', text: '↺' });
    reset.addEventListener('click', () => setCustom(key, null));
    const el = h('div', { class: 'theme-row', 'data-key': key },
      h('span', { class: 'theme-row-label', text: label }), control, reset);
    ui.rows[key] = { el, control, reset };
    return el;
  }
  function colorRow(label, key) {
    const input = h('input', { type: 'color', class: 'theme-color' });
    input.addEventListener('input', () => setCustom(key, input.value));
    return row(label, key, input);
  }
  function rangeRow(label, key, { step, fmt }) {
    const [min, max] = LIMITS[key];
    const input = h('input', { type: 'range', class: 'theme-range', min, max, step });
    const out = h('span', { class: 'theme-range-val' });
    input.addEventListener('input', () => setCustom(key, Number(input.value)));
    const wrap = h('span', { class: 'theme-range-wrap' }, input, out);
    const el = row(label, key, wrap);
    ui.rows[key].input = input; ui.rows[key].out = out; ui.rows[key].fmt = fmt;
    return el;
  }
  const group = (title, ...rows) => h('div', { class: 'theme-group' }, h('div', { class: 'theme-group-title', text: title }), ...rows);

  function buildUi(mount) {
    ui = { rows: {}, cards: [] };
    const grid = h('div', { class: 'theme-grid' });
    for (const t of THEMES) { const c = themeCard(t); ui.cards.push(c); grid.append(c); }

    const fontSel = h('select', { class: 'theme-select fin-select' });
    for (const f of FONTS) fontSel.append(h('option', { value: f.id, text: f.label, style: `font-family:${f.stack};` }));
    fontSel.addEventListener('change', () => setCustom('font', fontSel.value));

    const seg = h('span', { class: 'theme-seg' });
    for (const s of BTN_STYLES) {
      const b = h('button', { type: 'button', class: 'theme-seg-btn', 'data-style': s.id, text: s.label });
      b.addEventListener('click', () => setCustom('btnStyle', s.id));
      seg.append(b);
    }
    ui.seg = seg;

    const pct = (n) => Math.round(n * 100) + '%';
    const sample = h('div', { class: 'theme-sample' },
      h('button', { class: 'fin-btn', type: 'button', text: 'Botón principal' }),
      h('button', { class: 'db-sync-btn', type: 'button', text: 'Secundario' }),
      h('button', { class: 'fin-btn danger', type: 'button', text: 'Peligro' }),
      h('span', { class: 'theme-sample-text' },
        h('b', { text: 'Texto de ejemplo ' }),
        h('span', { style: 'color:var(--text-muted)', text: 'apagado ' }),
        h('span', { style: 'color:var(--ok)', text: '+12,5% ' }),
        h('span', { style: 'color:var(--danger)', text: '−3,1% ' }),
        h('span', { style: 'color:var(--info-text)', text: 'enlace' })));

    const resetAll = h('button', { class: 'db-sync-btn', type: 'button', text: 'Restablecer este tema' });
    resetAll.addEventListener('click', resetCustom);
    ui.resetAll = resetAll;
    ui.status = h('span', { class: 'setting-status' });

    const custom = h('details', { class: 'theme-custom' },
      h('summary', { text: 'Personalizar' }),
      sample,
      h('div', { class: 'theme-groups' },
        group('Colores', ...COLOR_KEYS.map(({ key, label }) => colorRow(label, key))),
        group('Botones',
          row('Estilo', 'btnStyle', seg),
          colorRow('Color', 'btnColor'),
          colorRow('Texto', 'btnText'),
          rangeRow('Redondeo', 'btnRadius', { step: 1, fmt: (n) => n + 'px' })),
        group('Letra',
          row('Fuente', 'font', fontSel),
          rangeRow('Tamaño', 'fontScale', { step: 0.01, fmt: pct })),
        group('Forma',
          rangeRow('Redondeo general', 'radius', { step: 0.05, fmt: pct }),
          rangeRow('Opacidad del fondo', 'bgAlpha', { step: 0.01, fmt: pct }))),
      h('div', { class: 'db-row' }, ui.status, resetAll));
    try { custom.open = localStorage.getItem(STORAGE_KEY + 'Open') === '1'; } catch {}
    custom.addEventListener('toggle', () => {
      try { localStorage.setItem(STORAGE_KEY + 'Open', custom.open ? '1' : '0'); } catch {}
      if (typeof window.adjustWindowSize === 'function') window.adjustWindowSize();
    });
    ui.fontSel = fontSel;

    mount.append(
      h('div', { class: 'setting-text' },
        h('span', { class: 'setting-label', text: 'Tema' }),
        h('span', { class: 'setting-desc', text: 'Elegí un tema y, si querés, ajustá colores, botones, letra y forma por separado. Los ajustes se guardan por tema.' })),
      grid, custom);
    syncUi();
  }

  // Refleja el estado en los controles (tema activo, valores, qué está tocado).
  function syncUi() {
    if (!ui) return;
    const theme = themeById(state.theme), custom = currentCustom();
    for (const c of ui.cards) c.classList.toggle('active', c.dataset.themeId === state.theme);
    const { vars } = buildVars(state.theme, custom);
    for (const [key, r] of Object.entries(ui.rows)) {
      const touched = custom[key] != null;
      r.el.classList.toggle('touched', touched);
      let val = effective(theme, custom, key);
      if (key === 'btnText' && val == null) {
        // Sin elegir: se muestra el color de texto que sale solo.
        const auto = vars['--btn-fg'] || vars['--on-accent'] || '#f5f3ff';
        val = isHex(auto) ? auto : theme.palette.text;
      }
      if (key === 'btnRadius' && val == null) val = Math.round(6 * effective(theme, custom, 'radius'));
      if (r.input) {
        if (document.activeElement !== r.input) r.input.value = val;
        r.out.textContent = r.fmt(Number(val));
      } else if (r.control.type === 'color') {
        if (document.activeElement !== r.control) r.control.value = val;
      }
    }
    ui.fontSel.value = effective(theme, custom, 'font');
    const style = effective(theme, custom, 'btnStyle');
    for (const b of ui.seg.children) b.classList.toggle('active', b.dataset.style === style);
    const n = Object.keys(custom).length;
    ui.resetAll.disabled = n === 0;
    ui.status.textContent = n ? `${n} ajuste${n === 1 ? '' : 's'} sobre «${theme.name}»` : `«${theme.name}» sin modificar`;
  }

  load();
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    const mount = document.getElementById('theme-block');
    if (mount) buildUi(mount);
    fitTabs();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTabs);
    window.addEventListener('resize', fitTabs);
  });

  return { ...api, getState: () => JSON.parse(JSON.stringify(state)), setTheme, setCustom, resetCustom };
});
