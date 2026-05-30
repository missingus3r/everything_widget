// Monthly network consumption tracker (main process).
//
// Get-NetAdapterStatistics exposes cumulative byte counters that reset on
// reboot / adapter restart, so we can't just diff against a month-start value.
// Instead we accumulate the positive deltas between samples into a running
// monthly total, ignore negative jumps (counter resets), and zero the total
// when the calendar month rolls over. State is persisted to netUsage.json.

const fs = require('fs');
const path = require('path');

const USAGE_PATH = path.join(__dirname, 'netUsage.json');
const WRITE_THROTTLE_MS = 15000; // cap disk writes; in-memory state stays current

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function load() {
  try {
    const p = JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'));
    return {
      month:   p.month || monthKey(),
      rxBytes: Number(p.rxBytes) || 0,
      txBytes: Number(p.txBytes) || 0,
      lastRx:  p.lastRx == null ? null : Number(p.lastRx),
      lastTx:  p.lastTx == null ? null : Number(p.lastTx),
    };
  } catch {
    return { month: monthKey(), rxBytes: 0, txBytes: 0, lastRx: null, lastTx: null };
  }
}

let state = load();
let lastWrite = 0;

function write(force = false) {
  const now = Date.now();
  if (!force && now - lastWrite < WRITE_THROTTLE_MS) return;
  lastWrite = now;
  try { fs.writeFileSync(USAGE_PATH, JSON.stringify(state)); } catch {}
}

// Feed the current cumulative counters (summed across adapters). Returns the
// monthly totals so far: { month, rxBytes, txBytes }.
function update(totalRx, totalTx) {
  const mk = monthKey();
  if (state.month !== mk) {
    state.month = mk;
    state.rxBytes = 0;
    state.txBytes = 0;
    write(true);
  }
  // Only add when the counter advanced; a drop means a reboot/adapter reset,
  // so we just re-baseline without subtracting.
  if (state.lastRx != null && totalRx >= state.lastRx) state.rxBytes += totalRx - state.lastRx;
  if (state.lastTx != null && totalTx >= state.lastTx) state.txBytes += totalTx - state.lastTx;
  state.lastRx = totalRx;
  state.lastTx = totalTx;
  write();
  return { month: state.month, rxBytes: state.rxBytes, txBytes: state.txBytes };
}

function read() {
  return { month: state.month, rxBytes: state.rxBytes, txBytes: state.txBytes };
}

module.exports = { update, read, USAGE_PATH };
