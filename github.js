// GitHub (main process): notificaciones + PRs abiertos + repos recientes.
//
// Necesita un token personal (classic o fine-grained) guardado en API Keys con
// el nombre exactamente "GitHub". Scopes: repo + notifications (classic) o
// read-only equivalente. Sin token el handler devuelve { error: 'sin key' } y
// el tab muestra el hint. Tira en error — el handler IPC degrada a { error }.

const { getJson } = require('./netJson');

const BASE = 'https://api.github.com';

function gh(token, path) {
  return getJson(`${BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
}

// La API de notificaciones apunta al endpoint REST del subject; el HTML real
// se deriva: …api.github.com/repos/o/r/pulls/7 → github.com/o/r/pull/7.
function subjectHtmlUrl(n) {
  const api = n.subject && n.subject.url;
  if (!api) return n.repository && n.repository.html_url || null;
  return api
    .replace('https://api.github.com/repos/', 'https://github.com/')
    .replace('/pulls/', '/pull/')
    .replace('/commits/', '/commit/');
}

const SUBJECT_ICONS = { PullRequest: '⇄', Issue: '◉', Release: '🏷', Discussion: '💬', CheckSuite: '✓', Commit: '⌥' };

async function fetchGithub(token) {
  if (!token) return { error: 'sin key' };
  const [user, notifications, repos] = await Promise.all([
    gh(token, '/user'),
    gh(token, '/notifications?per_page=15').catch(() => []),
    gh(token, '/user/repos?sort=pushed&per_page=8').catch(() => []),
  ]);
  const login = user && user.login;
  // PRs abiertos del usuario (en cualquier repo). El search necesita el login.
  let prs = [];
  if (login) {
    try {
      const r = await gh(token, `/search/issues?q=${encodeURIComponent(`is:open is:pr author:${login}`)}&per_page=10`);
      prs = (r && Array.isArray(r.items)) ? r.items : [];
    } catch {}
  }
  return {
    login: login || null,
    name: (user && user.name) || null,
    notifications: (Array.isArray(notifications) ? notifications : []).map((n) => ({
      id: n.id,
      repo: (n.repository && n.repository.full_name) || '',
      title: (n.subject && n.subject.title) || '—',
      type: (n.subject && n.subject.type) || '',
      icon: SUBJECT_ICONS[(n.subject && n.subject.type)] || '•',
      reason: n.reason || '',
      updatedAt: n.updated_at ? Date.parse(n.updated_at) : null,
      unread: !!n.unread,
      url: subjectHtmlUrl(n),
    })),
    prs: prs.map((p) => ({
      title: p.title || '—',
      number: p.number,
      // "https://api.github.com/repos/o/r/issues/7" → "o/r"
      repo: (p.repository_url || '').replace('https://api.github.com/repos/', ''),
      url: p.html_url || null,
      updatedAt: p.updated_at ? Date.parse(p.updated_at) : null,
      draft: !!p.draft,
    })),
    repos: (Array.isArray(repos) ? repos : []).map((r) => ({
      name: r.full_name || r.name || '—',
      private: !!r.private,
      stars: r.stargazers_count ?? 0,
      language: r.language || '',
      pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : null,
      url: r.html_url || null,
      openIssues: r.open_issues_count ?? 0,
    })),
    fetchedAt: Date.now(),
  };
}

module.exports = { fetchGithub };
