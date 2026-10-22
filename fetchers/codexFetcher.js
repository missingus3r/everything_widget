// Standalone fetcher — runs `codex`, sends /status, prints JSON to stdout.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function findCodex() {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
        path.join(home, 'AppData', 'Roaming', 'npm', 'codex.exe'),
        path.join(home, '.local', 'bin', 'codex.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'codex'),
        '/usr/local/bin/codex',
        '/usr/bin/codex',
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const cmd = process.platform === 'win32' ? 'where codex' : 'which codex';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0].trim();
  } catch {
    return null;
  }
}

function stripAnsi(str) {
  return str
    .replace(/\x1b\[\d+[ABCD]/g, ' ')
    .replace(/\x1b\[\d+;\d+[Hf]/g, ' ')
    .replace(/\x1b\[\??[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[>=<]/g, '')
    .replace(/\x1b\[>[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function parseStatus(raw) {
  const clean = stripAnsi(raw).replace(/\s+/g, ' ');
  const data = {};

  const h5 = clean.match(/5h\s*limit\s*:?\s*\[[█░▌▏\s]*\]\s*(\d+)\s*%\s*left\s*\(\s*resets?\s+([^)]+?)\)/i);
  if (h5) {
    const pctLeft = +h5[1];
    data.session5h = { pct: Math.max(0, Math.min(100, 100 - pctLeft)), pctLeft, resets: h5[2].trim() };
  }

  const wk = clean.match(/Weekly\s*limit\s*:?\s*\[[█░▌▏\s]*\]\s*(\d+)\s*%\s*left\s*\(\s*resets?\s+([^)]+?)\)/i);
  if (wk) {
    const pctLeft = +wk[1];
    data.weekly = { pct: Math.max(0, Math.min(100, 100 - pctLeft)), pctLeft, resets: wk[2].trim() };
  }

  const acc = clean.match(/Account\s*:?\s*(\S+?@\S+?)\s*\(([^)]+)\)/i);
  if (acc) data.account = { email: acc[1].trim(), plan: acc[2].trim() };

  const mdl = clean.match(/Model\s*:?\s*([^\s│()]+)\s+\(([^)]+)\)/i);
  if (mdl) data.model = { name: mdl[1].trim(), detail: mdl[2].trim() };

  // /status didn't print a Model line → fall back to the configured default.
  const cfg = readConfigModel();
  if (!data.model && cfg) data.model = cfg;
  if (data.model && !data.model.effort) {
    const eff = (data.model.detail || '').match(/reasoning\s+(\w+)/i);
    data.model.effort = eff ? eff[1] : (cfg?.effort || null);
  }

  return (data.session5h || data.weekly) ? data : null;
}

// Top-level `model` / `model_reasoning_effort` keys of ~/.codex/config.toml
// (only the part before the first [table], so profile overrides don't leak in).
function readConfigModel() {
  let head;
  try {
    head = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf-8').split(/^\s*\[/m)[0];
  } catch {
    return null;
  }
  const key = (k) => {
    const m = head.match(new RegExp(`^\\s*${k}\\s*=\\s*["']([^"']+)["']`, 'm'));
    return m ? m[1] : null;
  };
  const name = key('model');
  return name ? { name, effort: key('model_reasoning_effort') } : null;
}

async function main() {
  const codexPath = findCodex();
  if (!codexPath) {
    process.stdout.write(JSON.stringify({ error: 'codex not found' }));
    process.exit(1);
  }

  let pty;
  try {
    pty = require('node-pty');
  } catch {
    process.stdout.write(JSON.stringify({ error: 'node-pty not found' }));
    process.exit(1);
  }

  let output = '';
  const proc = pty.spawn(codexPath, [], {
    name: 'xterm-256color',
    cols: 140,
    rows: 60,
    cwd: path.join(os.homedir(), 'Desktop'),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  proc.onData((d) => { output += d; });

  setTimeout(() => proc.write('/status'), 8000);
  setTimeout(() => proc.write('\r'),       9000);
  setTimeout(() => proc.write('\n'),       9500);

  setTimeout(() => {
    const data = parseStatus(output);
    try { proc.kill(); } catch {}
    process.stdout.write(JSON.stringify(data || { error: 'parse failed' }));
    process.exit(0);
  }, 20000);

  setTimeout(() => {
    try { proc.kill(); } catch {}
    const data = parseStatus(output);
    process.stdout.write(JSON.stringify(data || { error: 'timeout' }));
    process.exit(0);
  }, 35000);
}

main();
