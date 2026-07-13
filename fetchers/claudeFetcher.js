// Standalone fetcher — runs with system Node.js + node-pty.
// Outputs JSON to stdout, then exits.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

function findClaude() {
  const home = os.homedir();
  const candidates = process.platform === 'win32'
    ? [
        path.join(home, '.local', 'bin', 'claude.exe'),
        path.join(home, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
      ]
    : [
        path.join(home, '.local', 'bin', 'claude'),
        path.join(home, '.claude', 'local', 'claude'),
        '/usr/local/bin/claude',
        '/usr/bin/claude',
      ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
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

// Reconstruct the actual terminal SCREEN from raw pty output by applying cursor
// movements to a virtual grid. The /usage TUI draws each row with absolute cursor
// positioning (ESC[row;colH) and partial-cell diffs, so labels like
// "Current week (Fable)" are NEVER a contiguous byte sequence in the stream —
// they only exist once laid out on screen. A flat stripAnsi() can't see them.
function renderScreen(raw, cols = 120, rows = 50) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let cr = 0, cc = 0;
  const clampR = (r) => Math.max(0, Math.min(rows - 1, r));
  const clampC = (c) => Math.max(0, Math.min(cols - 1, c));
  const n = raw.length;
  let i = 0;
  while (i < n) {
    const ch = raw[i];
    if (ch === '\x1b') {
      if (raw[i + 1] === '[') {
        let j = i + 2, params = '';
        while (j < n && /[0-9;?]/.test(raw[j])) { params += raw[j]; j++; }
        const fin = raw[j];
        const nums = params.replace('?', '').split(';').map((x) => (x === '' ? null : parseInt(x, 10)));
        switch (fin) {
          case 'H': case 'f': cr = clampR((nums[0] || 1) - 1); cc = clampC((nums[1] || 1) - 1); break;
          case 'A': cr = clampR(cr - (nums[0] || 1)); break;
          case 'B': cr = clampR(cr + (nums[0] || 1)); break;
          case 'C': cc = clampC(cc + (nums[0] || 1)); break;
          case 'D': cc = clampC(cc - (nums[0] || 1)); break;
          case 'G': cc = clampC((nums[0] || 1) - 1); break;
          case 'd': cr = clampR((nums[0] || 1) - 1); break;
          case 'J': {
            const mode = nums[0] || 0;
            if (mode === 2 || mode === 3) { for (let r = 0; r < rows; r++) grid[r].fill(' '); }
            else if (mode === 0) { for (let c = cc; c < cols; c++) grid[cr][c] = ' '; for (let r = cr + 1; r < rows; r++) grid[r].fill(' '); }
            else if (mode === 1) { for (let r = 0; r < cr; r++) grid[r].fill(' '); for (let c = 0; c <= cc; c++) grid[cr][c] = ' '; }
            break;
          }
          case 'K': {
            const mode = nums[0] || 0;
            if (mode === 0) { for (let c = cc; c < cols; c++) grid[cr][c] = ' '; }
            else if (mode === 1) { for (let c = 0; c <= cc; c++) grid[cr][c] = ' '; }
            else grid[cr].fill(' ');
            break;
          }
          default: break; // SGR (m) and other CSI ignored
        }
        i = j + 1;
        continue;
      }
      if (raw[i + 1] === ']') { // OSC ... BEL/ST
        let j = i + 2;
        while (j < n && raw[j] !== '\x07' && !(raw[j] === '\x1b' && raw[j + 1] === '\\')) j++;
        i = (raw[j] === '\x1b') ? j + 2 : j + 1;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '\r') { cc = 0; i++; continue; }
    if (ch === '\n') { cr = clampR(cr + 1); i++; continue; }
    if (ch === '\b') { cc = clampC(cc - 1); i++; continue; }
    if (ch === '\t') { cc = clampC((Math.floor(cc / 8) + 1) * 8); i++; continue; }
    if (ch.charCodeAt(0) < 0x20) { i++; continue; }
    grid[cr][cc] = ch;
    if (++cc >= cols) { cc = 0; cr = clampR(cr + 1); }
    i++;
  }
  return grid.map((row) => row.join('').replace(/\s+$/, '')).join('\n');
}

// Parse the reconstructed screen line-by-line. Each usage entry spans two visual
// lines: the label ("Current week (Fable)") then the bar + "N% used", then "Resets …".
function parseScreen(screen) {
  const lines = screen.split('\n');
  const data = {};
  const findPct = (i) => {
    for (let k = i; k < Math.min(lines.length, i + 3); k++) {
      const m = lines[k].match(/(\d+)\s*%\s*used/i);
      if (m) return +m[1];
    }
    return null;
  };
  const findResets = (i) => {
    for (let k = i; k < Math.min(lines.length, i + 4); k++) {
      const m = lines[k].match(/Rese?ts?\s+(.+?)\s*$/i);
      if (m) return m[1].trim();
    }
    return null;
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/Current\s*session/i.test(ln) && !data.session) {
      const pct = findPct(i); if (pct != null) data.session = { pct, resets: findResets(i) };
    } else if (/Current\s*week\s*\(all\s*models?\)/i.test(ln) && !data.weekAll) {
      const pct = findPct(i); if (pct != null) data.weekAll = { pct, resets: findResets(i) };
    } else if (/Current\s*week\s*\(Sonnet/i.test(ln) && !data.weekSonnet) {
      const pct = findPct(i); if (pct != null) data.weekSonnet = { pct };
    } else if (/Current\s*week\s*\(Fable/i.test(ln) && !data.weekFable) {
      const pct = findPct(i); if (pct != null) data.weekFable = { pct };
    } else if (/Extra\s*usage/i.test(ln) && !data.extra) {
      const pct = findPct(i);
      let spent, total;
      for (let k = i; k < Math.min(lines.length, i + 3); k++) {
        const m = lines[k].match(/\$?\s*([\d.]+)\s*\/\s*\$?\s*([\d.]+)\s*spent/i);
        if (m) { spent = m[1]; total = m[2]; break; }
      }
      if (pct != null) data.extra = { pct, spent, total, resets: findResets(i) };
    } else if (/(\d+)\s*%\s*of\s*your\s*usage\s*was\s*while/i.test(ln) && !data.insight) {
      const m = ln.match(/(\d+)\s*%\s*of\s*your\s*usage\s*was\s*while\s*(\d+\+?\s*sessions?\s*ran\s*in\s*parallel)/i);
      if (m) data.insight = `${m[1]}% of your usage was while ${m[2]}`;
    }
  }
  return data;
}

// Legacy flat-stream parser — kept as a per-field fallback so a screen-reconstruction
// miss never regresses the fields that already worked (session / weekAll / extra).
function parseStream(raw) {
  const clean = stripAnsi(raw).replace(/\s+/g, ' ');
  const data = {};

  const sm = clean.match(/Current\s*session\s*[█▌░\s]*(\d+)\s*%\s*used\s*Rese?t?s?\s*s?\s*(.+?)(?=Current|Extra|Esc|What|$)/i);
  if (sm) data.session = { pct: +sm[1], resets: sm[2].trim() };

  const wm = clean.match(/Current\s*week\s*\(all\s*models?\)\s*[█▌░\s]*(\d+)\s*%\s*used\s*Rese?t?s?\s*(.+?)(?=Current|Extra|Esc|What|$)/i);
  if (wm) data.weekAll = { pct: +wm[1], resets: wm[2].trim() };

  const ws = clean.match(/Current\s*week\s*\(Sonnet\s*only\)\s*[█▌░\s]*(\d+)\s*%\s*used/i);
  if (ws) data.weekSonnet = { pct: +ws[1] };

  const wf = clean.match(/Current\s*week\s*\(Fable(?:\s*only)?\)\s*[█▌░\s]*(\d+)\s*%\s*used/i);
  if (wf) data.weekFable = { pct: +wf[1] };

  const em = clean.match(/Extra\s*usage\s*[█▌░▏\s]*(\d+)\s*%\s*used\s*\$?\s*([\d.]+)\s*\/\s*\$?\s*([\d.]+)\s*spent\s*·?\s*Rese?t?s?\s*(.+?)(?=Esc|Last|$)/i);
  if (em) data.extra = { pct: +em[1], spent: em[2], total: em[3], resets: em[4].trim() };

  const im = clean.match(/(\d+)\s*%\s*of\s*your\s*usage\s*was\s*while\s*(\d+\+?\s*sessions?\s*ran\s*in\s*parallel)/i);
  if (im) data.insight = `${im[1]}% of your usage was while ${im[2]}`;

  return data;
}

function parseUsage(raw) {
  const fromScreen = parseScreen(renderScreen(raw));
  const fromStream = parseStream(raw);
  const data = {};
  for (const k of ['session', 'weekAll', 'weekSonnet', 'weekFable', 'extra', 'insight']) {
    const v = fromScreen[k] != null ? fromScreen[k] : fromStream[k];
    if (v != null) data[k] = v;
  }
  return (data.session || data.weekAll || data.extra) ? data : null;
}

async function main() {
  const claudePath = findClaude();
  if (!claudePath) {
    process.stdout.write(JSON.stringify({ error: 'claude not found' }));
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
  const proc = pty.spawn(claudePath, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 50,
    cwd: path.join(os.homedir(), 'Desktop'),
    env: { ...process.env, TERM: 'xterm-256color' },
  });

  proc.onData((d) => { output += d; });

  setTimeout(() => proc.write('/usage\r'), 8000);

  setTimeout(() => {
    const data = parseUsage(output);
    proc.write('\x1b');
    setTimeout(() => {
      proc.write('/exit\r');
      setTimeout(() => {
        try { proc.kill(); } catch {}
        process.stdout.write(JSON.stringify(data || { error: 'parse failed' }));
        process.exit(0);
      }, 2000);
    }, 1000);
  }, 20000);

  setTimeout(() => {
    try { proc.kill(); } catch {}
    const data = parseUsage(output);
    process.stdout.write(JSON.stringify(data || { error: 'timeout' }));
    process.exit(0);
  }, 35000);
}

main();
