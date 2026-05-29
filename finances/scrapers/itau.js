// Itaú UY — https://www.itau.com.uy/inst/
// The institutional home links into the online-banking login; selectors are
// best-effort guesses; recalibrate against the real logged-in DOM.

const { buildAutofill, buildExtractor, GENERIC_BALANCE_BODY } = require('./_helpers');

const USER_SELECTORS = [
  'input#usuario', 'input[name="usuario"]',
  'input[name="documento"]', 'input[name="username"]',
  'input[type="text"]',
];
const PASS_SELECTORS = [
  'input#password', 'input[name="password"]',
  'input[name="clave"]', 'input[type="password"]',
];

module.exports = {
  id: 'itau',
  autofill: (creds) => buildAutofill(USER_SELECTORS, PASS_SELECTORS, creds),
  extract: () => buildExtractor(GENERIC_BALANCE_BODY),
};
