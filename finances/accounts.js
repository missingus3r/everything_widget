// Static definition of the accounts tracked in the Finanzas section.
//
// kind: 'bank'   → balance is captured through a semi-automatic browser window
//                  (user completes 2FA/captcha manually, then the balance is read).
//       'manual' → balance is entered by hand in the widget.
//
// currencies: which currencies this account can hold. The UI shows an amount +
//             delta per currency. A bank scraper may return only the currencies
//             it actually finds.

const ACCOUNTS = [
  {
    id: 'brou',
    name: 'BROU',
    kind: 'bank',
    url: 'https://ebanking.brou.com.uy/frontend/loginStep1',
    currencies: ['UYU', 'USD'],
  },
  {
    id: 'scotiabank',
    name: 'Scotiabank',
    kind: 'bank',
    url: 'https://www1.scotiabank.com.uy/scotiaenlinea/login',
    currencies: ['UYU', 'USD'],
  },
  {
    id: 'itau',
    name: 'Itaú',
    kind: 'bank',
    url: 'https://www.itau.com.uy/inst/',
    currencies: ['UYU', 'USD'],
  },
  {
    id: 'oca',
    name: 'OCA',
    kind: 'bank',
    url: 'https://micuentanuevo.oca.com.uy/trx/login',
    currencies: ['UYU'],
  },
  {
    id: 'prex',
    name: 'PREX',
    kind: 'manual',
    url: null,
    currencies: ['UYU', 'USD'],
  },
  {
    id: 'plata_fisica',
    name: 'Plata Física',
    kind: 'manual',
    url: null,
    currencies: ['UYU', 'USD'],
  },
];

const ACCOUNTS_BY_ID = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a]));

function getAccount(id) {
  return ACCOUNTS_BY_ID[id] || null;
}

module.exports = { ACCOUNTS, getAccount };
