const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, 'speedtest.json');

const EMPTY = {
  last: null,
  best: {
    downloadMbps: null,
    uploadMbps: null,
    pingMs: null, // lower is better
  },
};

function read() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      last: parsed.last || null,
      best: {
        downloadMbps: parsed.best?.downloadMbps || null,
        uploadMbps:   parsed.best?.uploadMbps   || null,
        pingMs:       parsed.best?.pingMs       || null,
      },
    };
  } catch {
    return JSON.parse(JSON.stringify(EMPTY));
  }
}

function write(state) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(state, null, 2));
}

// Merge a fresh result into history, returning the updated state.
function record(result) {
  if (!result || result.error) return read();
  const state = read();
  state.last = result;

  const better = (curr, val, lowerIsBetter = false) => {
    if (val == null || !isFinite(val)) return curr;
    if (!curr || curr.value == null) return { value: val, at: result.at };
    return (lowerIsBetter ? val < curr.value : val > curr.value)
      ? { value: val, at: result.at }
      : curr;
  };

  state.best.downloadMbps = better(state.best.downloadMbps, result.downloadMbps, false);
  state.best.uploadMbps   = better(state.best.uploadMbps,   result.uploadMbps,   false);
  state.best.pingMs       = better(state.best.pingMs,       result.pingMs,       true);

  write(state);
  return state;
}

function reset() {
  write(JSON.parse(JSON.stringify(EMPTY)));
  return read();
}

module.exports = { read, record, reset, HISTORY_PATH };
