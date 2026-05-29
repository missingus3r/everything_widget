// Scotiabank UY — https://www1.scotiabank.com.uy/scotiaenlinea/login
// Selectors are best-effort guesses; recalibrate against the real logged-in DOM.

const { buildAutofill, buildExtractor, GENERIC_BALANCE_BODY } = require('./_helpers');

const USER_SELECTORS = [
  'input#usuario', 'input[name="usuario"]',
  'input[name="username"]', 'input[name="user"]',
  'input[type="text"]',
];
const PASS_SELECTORS = [
  'input#clave', 'input[name="clave"]',
  'input[name="password"]', 'input[type="password"]',
];

module.exports = {
  id: 'scotiabank',
  autofill: (creds) => buildAutofill(USER_SELECTORS, PASS_SELECTORS, creds),
  extract: () => buildExtractor(GENERIC_BALANCE_BODY),
};
