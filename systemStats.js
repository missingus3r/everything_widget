const os = require('os');
const { execFile } = require('child_process');
const netUsage = require('./netUsage');

// ── CPU sampling: take two snapshots of cumulative tick counts ───
let prevCpuTimes = sampleCpu();

function sampleCpu() {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  for (const c of cpus) {
    user += c.times.user;
    nice += c.times.nice;
    sys  += c.times.sys;
    idle += c.times.idle;
    irq  += c.times.irq;
  }
  return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq };
}

function cpuUsage() {
  const cur = sampleCpu();
  const totalDiff = cur.total - prevCpuTimes.total;
  const idleDiff  = cur.idle  - prevCpuTimes.idle;
  prevCpuTimes = cur;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDiff / totalDiff) * 100)));
}

// ── Memory ──────────────────────────────────────────────────────
function memory() {
  const total = os.totalmem();
  const free  = os.freemem();
  const used  = total - free;
  return {
    total,
    used,
    pct: Math.round((used / total) * 100),
  };
}

// ── PowerShell helper ──────────────────────────────────────────
function runPS(cmd, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : (stdout || '').toString())
    );
    child.on('error', () => resolve(''));
  });
}

// ── Disks ───────────────────────────────────────────────────────
async function disks() {
  const out = await runPS(
    "Get-PSDrive -PSProvider FileSystem | " +
    "Where-Object { $_.Used -ne $null -and ($_.Used + $_.Free) -gt 0 } | " +
    "Select-Object Name,Used,Free | ConvertTo-Json -Compress"
  );
  if (!out.trim()) return [];
  try {
    const parsed = JSON.parse(out);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr.map(d => {
      const used = Number(d.Used) || 0;
      const free = Number(d.Free) || 0;
      const total = used + free;
      return {
        name: d.Name,
        used,
        free,
        total,
        pct: total > 0 ? Math.round((used / total) * 100) : 0,
      };
    }).filter(d => d.total > 0);
  } catch {
    return [];
  }
}

// ── Network throughput ─────────────────────────────────────────
let prevNet = null;
async function network() {
  const out = await runPS(
    "Get-NetAdapterStatistics | Where-Object { $_.ReceivedBytes -gt 0 -or $_.SentBytes -gt 0 } | " +
    "Select-Object Name,ReceivedBytes,SentBytes | ConvertTo-Json -Compress"
  );
  if (!out.trim()) return { downBps: 0, upBps: 0, adapters: [] };

  let parsed;
  try { parsed = JSON.parse(out); } catch { return { downBps: 0, upBps: 0, adapters: [] }; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];

  let totalRx = 0, totalTx = 0;
  for (const a of arr) {
    totalRx += Number(a.ReceivedBytes) || 0;
    totalTx += Number(a.SentBytes)     || 0;
  }
  const now = Date.now();

  let downBps = 0, upBps = 0;
  if (prevNet) {
    const dt = (now - prevNet.t) / 1000;
    if (dt > 0) {
      downBps = Math.max(0, (totalRx - prevNet.rx) / dt);
      upBps   = Math.max(0, (totalTx - prevNet.tx) / dt);
    }
  }
  prevNet = { rx: totalRx, tx: totalTx, t: now };

  const monthly = netUsage.update(totalRx, totalTx);

  return {
    downBps,
    upBps,
    monthly, // { month, rxBytes, txBytes } accumulated this calendar month
    adapters: arr.map(a => ({ name: a.Name })),
  };
}

// ── Temperature (best effort) ──────────────────────────────────
// GPU via nvidia-smi. CPU is trickier on consumer Windows: the only
// reliable sources are LibreHardwareMonitor (LHM) or OpenHardwareMonitor
// (OHM), which expose WMI namespaces while the app is running. Fall
// back to ACPI thermal zones (often junk on modern AMD/Intel).
async function cpuFromLHM(namespace) {
  const cmd =
    `try { ` +
    `Get-CimInstance -Namespace 'root/${namespace}' -ClassName Sensor -ErrorAction Stop | ` +
    `Where-Object { $_.SensorType -eq 'Temperature' -and $_.Name -match '(?i)cpu' } | ` +
    `Select-Object Name,Value,Parent | ConvertTo-Json -Compress ` +
    `} catch { '' }`;
  const out = await runPS(cmd, 3000);
  if (!out.trim()) return null;
  let parsed;
  try { parsed = JSON.parse(out); } catch { return null; }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  // Prefer "CPU Package" / "Tctl" / "Core (Tctl/Tdie)" / "CPU Total" over individual cores.
  const score = (name) => {
    const n = (name || '').toLowerCase();
    if (n.includes('package'))    return 5;
    if (n.includes('tctl'))       return 4;
    if (n.includes('tdie'))       return 4;
    if (n.includes('total'))      return 3;
    if (n.includes('die average'))return 3;
    return 1;
  };
  arr.sort((a, b) => score(b.Name) - score(a.Name));
  for (const s of arr) {
    const v = Number(s.Value);
    if (Number.isFinite(v) && v > 0 && v < 130) return Math.round(v);
  }
  return null;
}

async function temperature() {
  const out = {};

  const nv = await new Promise(resolve => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=temperature.gpu', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 3000 },
      (err, stdout) => resolve(err ? '' : (stdout || '').toString().trim())
    );
  });
  if (nv) {
    const n = parseInt(nv.split('\n')[0], 10);
    if (Number.isFinite(n)) out.gpu = n;
  }

  // LibreHardwareMonitor / OpenHardwareMonitor (need either running)
  let cpu = await cpuFromLHM('LibreHardwareMonitor');
  if (cpu == null) cpu = await cpuFromLHM('OpenHardwareMonitor');

  // ACPI thermal zone fallback. Many boards return a hard-coded ~290 K
  // (~17 °C) placeholder, so reject values that are implausibly low for
  // an active CPU — a real idle reading sits in the 30s minimum.
  if (cpu == null) {
    const wmi = await runPS(
      "try { (Get-CimInstance -Namespace 'root/wmi' -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop).CurrentTemperature } catch { '' }",
      3000
    );
    const line = (wmi || '').split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (line) {
      const tenthsK = parseInt(line, 10);
      if (Number.isFinite(tenthsK) && tenthsK > 2000) {
        const c = Math.round((tenthsK / 10) - 273.15);
        if (c >= 30 && c < 110) cpu = c;
      }
    }
  }

  if (cpu != null) out.cpu = cpu;
  out.cpuSource = cpu != null ? 'sensor' : 'unavailable';
  return out;
}

// ── Battery (laptops) ──────────────────────────────────────────
async function battery() {
  const out = await runPS(
    "$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; " +
    "if ($b) { @{ pct = [int]$b.EstimatedChargeRemaining; status = [int]$b.BatteryStatus } | ConvertTo-Json -Compress } else { '' }",
    3000
  );
  if (!out.trim()) return null;
  try {
    const o = JSON.parse(out);
    return { pct: o.pct, charging: o.status === 2 || o.status === 6 || o.status === 7 || o.status === 8 || o.status === 9 };
  } catch { return null; }
}

// ── Uptime + OS ────────────────────────────────────────────────
function osInfo() {
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cores: os.cpus().length,
    uptimeSec: os.uptime(),
    cpuModel: (os.cpus()[0] && os.cpus()[0].model) || '',
  };
}

async function snapshot() {
  const [d, n, t, b] = await Promise.all([disks(), network(), temperature(), battery()]);
  return {
    cpu: cpuUsage(),
    mem: memory(),
    disks: d,
    net: n,
    temp: t,
    battery: b,
    os: osInfo(),
    ts: Date.now(),
  };
}

module.exports = { snapshot };
