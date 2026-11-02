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

module.exports = { renderScreen };
