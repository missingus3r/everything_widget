// Shared snippets injected into bank pages via webContents.executeJavaScript.
//
// IMPORTANT: the strings below run in the *page* context (no Node, no require).
// They are intentionally defensive — the real DOM of each bank can only be
// calibrated against a logged-in session, so extractors try several strategies
// and return null when unsure. When extraction returns null, the orchestrator
// falls back to manual entry, so the feature works regardless.

// A page-context helper that parses Uruguayan-formatted money like
// "$ 1.234,56", "U$S 1.234,56", "1,234.56", "1234.56" → Number.
const AMOUNT_PARSER_JS = `
  function __parseAmount(raw) {
    if (raw == null) return null;
    let s = String(raw).replace(/[^0-9.,-]/g, '').trim();
    if (!s) return null;
    const hasComma = s.includes(','), hasDot = s.includes('.');
    if (hasComma && hasDot) {
      // Last separator is the decimal one.
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (hasComma) {
      // Comma as decimal if it looks like ,dd at the end; else thousands.
      s = /,\\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
`;

// Helper to set an <input> value and fire the events frameworks listen for.
const SET_INPUT_JS = `
  function __setInput(el, value) {
    if (!el) return false;
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
`;

// Build the autofill script: tries a list of selector candidates for the user
// and password fields. Credentials are embedded safely via JSON.stringify.
function buildAutofill(userSelectors, passSelectors, creds) {
  const u = JSON.stringify(creds && creds.user ? creds.user : '');
  const p = JSON.stringify(creds && creds.pass ? creds.pass : '');
  const us = JSON.stringify(userSelectors);
  const ps = JSON.stringify(passSelectors);
  return `(() => {
    ${SET_INPUT_JS}
    const pick = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el) return el; } return null; };
    const uEl = pick(${us});
    const pEl = pick(${ps});
    let done = 0;
    if (uEl && ${u}) { __setInput(uEl, ${u}); done++; }
    if (pEl && ${p}) { __setInput(pEl, ${p}); done++; }
    return { filledUser: !!(uEl && ${u}), filledPass: !!(pEl && ${p}) };
  })();`;
}

// Build a generic extractor that scans labeled elements for amounts.
// `currencyHints` maps a currency to substrings that, when found near an amount,
// classify it. Returns { uyu, usd } with nulls when not found.
function buildExtractor(bodyJs) {
  return `(() => {
    ${AMOUNT_PARSER_JS}
    try {
      ${bodyJs}
    } catch (e) {
      return { error: String(e && e.message || e) };
    }
  })();`;
}

// A generic, best-effort balance scan used as the default extractor body.
// It walks visible elements, finds those mentioning a currency marker together
// with a number, and keeps the largest amount per currency (typically the
// account total). Returns { uyu, usd } — either may be null. This is a starting
// point; per-bank bodies can override it once the real DOM is known.
const GENERIC_BALANCE_BODY = `
  const usdMarkers = ['U$S', 'USD', 'US$', 'DÓLARES', 'DOLARES'];
  const uyuMarkers = ['$U', 'UYU', 'PESOS', '$ ', 'NOM'];
  let bestUyu = null, bestUsd = null;
  const els = Array.from(document.querySelectorAll('td, span, div, p, strong, b, li'));
  for (const el of els) {
    if (el.children.length > 3) continue; // skip containers, prefer leaf-ish nodes
    const t = (el.innerText || '').trim();
    if (!t || t.length > 40) continue;
    if (!/[0-9]/.test(t) || !/[.,]/.test(t)) continue;
    const amt = __parseAmount(t);
    if (amt == null || amt === 0) continue;
    const up = t.toUpperCase();
    const isUsd = usdMarkers.some((m) => up.includes(m));
    if (isUsd) { if (bestUsd == null || amt > bestUsd) bestUsd = amt; }
    else if (uyuMarkers.some((m) => up.includes(m)) || up.includes('$')) {
      if (bestUyu == null || amt > bestUyu) bestUyu = amt;
    }
  }
  return { uyu: bestUyu, usd: bestUsd };
`;

module.exports = {
  AMOUNT_PARSER_JS,
  SET_INPUT_JS,
  buildAutofill,
  buildExtractor,
  GENERIC_BALANCE_BODY,
};
