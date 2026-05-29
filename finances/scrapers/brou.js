// BROU — https://ebanking.brou.com.uy/frontend/loginStep1
// Login is multi-step (document/user first, then password + possible 2FA).
// Selectors are best-effort guesses; recalibrate against the real logged-in DOM.
// The orchestrator falls back to manual entry whenever extract() returns nulls.

const { buildAutofill, buildExtractor, GENERIC_BALANCE_BODY } = require('./_helpers');

const USER_SELECTORS = [
  'input#documento', 'input[name="documento"]',
  'input#usuario', 'input[name="usuario"]',
  'input[name="username"]', 'input[type="text"]',
];
const PASS_SELECTORS = [
  'input#password', 'input[name="password"]',
  'input[name="clave"]', 'input[type="password"]',
];

module.exports = {
  id: 'brou',
  autofill: (creds) => buildAutofill(USER_SELECTORS, PASS_SELECTORS, creds),
  extract: () => buildExtractor(GENERIC_BALANCE_BODY),
};
