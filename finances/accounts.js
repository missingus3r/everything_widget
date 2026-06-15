// Static definition of the accounts tracked in the Finanzas section.
//
// All balances are entered by hand in the widget. Each account lists the
// currencies it can hold; the UI shows an amount + delta per currency.
//
// `invest: true` marks the Inversiones card (formerly "Plata Física"). Its id is
// kept as `plata_fisica` so existing snapshots/history stay linked. Instead of a
// monthly projection it shows a free-text description listing the investments.

const ACCOUNTS = [
  { id: 'brou',         name: 'BROU',        currencies: ['UYU'],        url: 'https://ebanking.brou.com.uy/frontend/loginStep1' },
  { id: 'scotiabank',   name: 'Scotiabank',  currencies: ['UYU', 'USD'], url: 'https://www1.scotiabank.com.uy/scotiaenlinea/login' },
  { id: 'itau',         name: 'Itaú',        currencies: ['UYU', 'USD'], url: 'https://www.itau.com.uy/inst/' },
  { id: 'oca',          name: 'OCA BLUE',    currencies: ['UYU', 'USD'], url: 'https://micuentanuevo.oca.com.uy/trx/login' },
  { id: 'prex',         name: 'PREX',        currencies: ['UYU', 'USD'], url: 'https://www.prex.com.uy' },
  { id: 'plata_fisica', name: 'Inversiones', currencies: ['UYU', 'USD'], url: null, invest: true },
];

const ACCOUNTS_BY_ID = Object.fromEntries(ACCOUNTS.map((a) => [a.id, a]));

function getAccount(id) {
  return ACCOUNTS_BY_ID[id] || null;
}

module.exports = { ACCOUNTS, getAccount };
