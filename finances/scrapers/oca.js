// OCA — https://micuentanuevo.oca.com.uy/trx/login
// OCA tracks pesos only (UYU). Selectors are best-effort guesses; recalibrate
// against the real logged-in DOM.

const { buildAutofill, buildExtractor, GENERIC_BALANCE_BODY } = require('./_helpers');

const USER_SELECTORS = [
  'input#usuario', 'input[name="usuario"]',
  'input[name="documento"]', 'input[name="username"]',
  'input[type="text"]', 'input[type="email"]',
];
const PASS_SELECTORS = [
  'input#password', 'input[name="password"]',
  'input[name="clave"]', 'input[type="password"]',
];

module.exports = {
  id: 'oca',
  autofill: (creds) => buildAutofill(USER_SELECTORS, PASS_SELECTORS, creds),
  extract: () => buildExtractor(GENERIC_BALANCE_BODY),
};
