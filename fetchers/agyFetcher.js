// Standalone fetcher — runs `agy` (Antigravity CLI), sends /usage, prints JSON to stdout.
//
// /usage prints "Models & Quota" as groups (GEMINI MODELS, CLAUDE AND GPT MODELS,
// GEMINI 4 ARGON), each with a "Weekly" and/or "Five Hour" limit shown as the
// percentage REMAINING, followed by "Quota available" (untouched) or
// "Refreshes in 167h 53m". Rows are placed with absolute cursor moves, so it is
// parsed from the reconstructed screen, like claudeFetcher.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { renderScreen } = require('./vtScreen');

const COLS = 120;
const ROWS = 60;

// agy starts its updater (at most every 15 min, the dashboard's own refresh rate)
// outside this pty's hidden console, so on Windows it pops a terminal window for
// a moment. Off for this session only: agy run by hand still updates itself.
// agy takes exactly 'true' here; '1', 'TRUE', 'yes' and 'on' are silently ignored.
function agyEnv(base = process.env) {
  return { ...base, TERM: 'xterm-256color', AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };
}

function findAgy() {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'),
        path.join(home, '.local', 'bin', 'agy.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'agy'),
        '/usr/local/bin/agy',
        '/usr/bin/agy',
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const cmd = process.platform === 'win32' ? 'where agy' : 'which agy';
    return execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0].trim();
  } catch {
    return null;
  }
}

// "GEMINI MODELS" → gemini, "CLAUDE AND GPT MODELS" → partner, "GEMINI 4 ARGON" → argon.
function groupKey(header) {
  if (/ARGON/.test(header)) return 'argon';
  if (/CLAUDE|GPT/.test(header)) return 'partner';
  if (/GEMINI/.test(header)) return 'gemini';
  return null;
}

// "167h 53m" / "2d 4h" / "45m" → minutes.
function durationMinutes(str) {
  const unit = (u) => { const m = str.match(new RegExp(`(\\d+)\\s*${u}\\b`, 'i')); return m ? +m[1] : 0; };
  const total = unit('d') * 1440 + unit('h') * 60 + unit('m');
  return total > 0 ? total : null;
}

function parseScreen(screen) {
  const lines = screen.split('\n');
  const data = {};

  // Banner: "<email> (Google AI Pro)", next line "Gemini 4 Argon (High)".
  for (let i = 0; i < lines.length; i++) {
    const acc = lines[i].match(/(\S+@\S+)\s+\(([^)]+)\)/);
    if (!acc) continue;
    data.account = { email: acc[1], plan: acc[2].trim() };
    const next = (lines[i + 1] || '').replace(/^[^A-Za-z0-9]+/, '').trim();
    const mdl = next.match(/^(.*?)\s*\(([^)]+)\)$/);
    if (next) data.model = mdl ? { name: mdl[1], effort: mdl[2] } : { name: next };
    break;
  }

  const start = lines.findIndex((l) => /Models\s*&\s*Quota/i.test(l));
  if (start < 0) return data;

  let group = null;
  for (let i = start + 1; i < lines.length; i++) {
    const ln = lines[i];
    if (/^[A-Z][A-Z0-9 .&-]+$/.test(ln.trim()) && /^\S/.test(ln)) {
      group = groupKey(ln.trim());
      continue;
    }
    if (!group) continue;
    // Case-sensitive: the footnote ("share a weekly limit and a 5-hour limit") must not match.
    const kind = /Five\s*Hour\s*Limit/.test(ln) ? 'h5' : /Weekly\s*Limit/.test(ln) ? 'weekly' : null;
    if (!kind) continue;

    let pctLeft = null, resets = null;
    for (let k = i + 1; k < Math.min(lines.length, i + 4); k++) {
      if (pctLeft == null) {
        const m = lines[k].match(/([\d.]+)\s*%/);
        if (m) { pctLeft = parseFloat(m[1]); continue; }
      }
      const r = lines[k].match(/Refreshes\s+in\s+(.+?)\s*$/i);
      if (r) { resets = r[1]; break; }
      if (/Quota\s+available/i.test(lines[k])) break;
    }
    if (pctLeft == null || !isFinite(pctLeft)) continue;
    const pct = Math.round(Math.max(0, Math.min(100, 100 - pctLeft)) * 10) / 10;
    data[group] = data[group] || {};
    if (!data[group][kind]) {
      data[group][kind] = { pct, pctLeft, resets, resetInMin: resets ? durationMinutes(resets) : null };
    }
  }
  return data;
}

function parseUsage(raw) {
  const data = parseScreen(renderScreen(raw, COLS, ROWS));
  return (data.gemini || data.partner || data.argon) ? data : null;
}

async function main() {
  const agyPath = findAgy();
  if (!agyPath) {
    process.stdout.write(JSON.stringify({ error: 'agy not found' }));
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
  const proc = pty.spawn(agyPath, [], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: path.join(os.homedir(), 'Desktop'),
    env: agyEnv(),
  });

  proc.onData((d) => { output += d; });

  setTimeout(() => proc.write('/usage'), 8000);
  setTimeout(() => proc.write('\r'),     9000);

  setTimeout(() => {
    const data = parseUsage(output);
    try { proc.kill(); } catch {}
    process.stdout.write(JSON.stringify(data || { error: 'parse failed' }));
    process.exit(0);
  }, 20000);

  setTimeout(() => {
    try { proc.kill(); } catch {}
    const data = parseUsage(output);
    process.stdout.write(JSON.stringify(data || { error: 'timeout' }));
    process.exit(0);
  }, 35000);
}

if (require.main === module) main();

module.exports = { parseScreen, durationMinutes, agyEnv };
