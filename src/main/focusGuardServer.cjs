// focusGuardServer.cjs - a lightweight HTTP server that continuously enforces the FocusGuard policy
// It loads the same configuration as focusGuardEnforcer.cjs and runs the enforcement sweep on startup
// and then at a regular interval. It also exposes a simple health endpoint on localhost:5555

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Re‑use the norm helper from the enforcer (duplicate to keep this file independent)
function norm(p) {
  if (!p) return '';
  return String(p)
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

// Configuration paths – match what the main process passes via CLI args
function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { parsed[key] = next; i++; } else { parsed[key] = true; }
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const CONFIG_PATH = args.config;
const POLL_MS = 800; // same interval as the original enforcer

function readConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  return {
    ...raw,
    blockedApps: Array.isArray(raw?.blockedApps) ? raw.blockedApps : [],
    allowedApps: Array.isArray(raw?.allowedApps) ? raw.allowedApps : [],
    blockApps: raw?.blockApps !== false,
    allowlistApps: raw?.allowlistApps === true || raw?.blockAllApps === true,
  };
}

// ---- Process enumeration helpers (copied from focusGuardEnforcer.cjs) ----
function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        const msg = String(stderr || stdout || error.message || error).trim();
        reject(Object.assign(new Error(msg || `${file} failed`), { code: error.code }));
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

async function queryProcesses() {
  const ps = `$ErrorActionPreference='SilentlyContinue';` +
    `$rows=@(Get-Process | Select-Object Id, ParentId, ProcessName, Path |` +
    `ForEach-Object {[pscustomobject]@{pid=[int]$_.Id;parentPid=[int]$_.ParentId;name=([string]$_.ProcessName + '.exe');path=[string]$_.Path}});` +
    `@($rows)|ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 3500, maxBuffer: 4 * 1024 * 1024 });
    const raw = String(stdout || '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
      pid: Number(row?.pid || 0),
      parentPid: Number(row?.parentPid || 0),
      name: String(row?.name || ''),
      path: String(row?.path || ''),
    })).filter(r => r.pid > 0);
  } catch { return []; }
}

function isProtected(info) {
  const protectedSet = new Set([
    'system','idle','registry','smss.exe','csrss.exe','wininit.exe','winlogon.exe','services.exe','lsass.exe',
    'svchost.exe','dwm.exe','explorer.exe','sihost.exe','ctfmon.exe','fontdrvhost.exe','runtimebroker.exe',
    'searchhost.exe','searchapp.exe','startmenuexperiencehost.exe','shellexperiencehost.exe','applicationframehost.exe',
    'textinputhost.exe','securityhealthsystray.exe','securityhealthservice.exe','smartscreen.exe','taskhostw.exe',
    'backgroundtaskhost.exe','dllhost.exe','spoolsv.exe','audiodg.exe','conhost.exe','openconsole.exe',
    'windowsterminal.exe','msmpeng.exe','mpdefendercoreservice.exe','nissrv.exe','lsaiso.exe','wudfhost.exe'
  ]);
  const p = norm(info?.path);
  const n = String(info?.name || '').toLowerCase();
  return protectedSet.has(n) || protectedSet.has(p);
}

function matches(info, rule) {
  const p = norm(info?.path || info?.executablePath);
  const scope = norm(rule?.dirScope);
  return Boolean(scope && p && (p === scope || p.startsWith(`${scope}\\`)));
}

function allowed(info, cfg) {
  const list = Array.isArray(cfg?.allowedApps) ? cfg.allowedApps : [];
  return list.some(r => r?.enabled !== false && matches(info, r));
}

function blocked(info, cfg) {
  const list = Array.isArray(cfg?.blockedApps) ? cfg.blockedApps : [];
  if (list.some(r => r?.enabled !== false && matches(info, r))) return true;
  return Boolean(cfg?.allowlistApps === true && !isProtected(info) && !allowed(info, cfg));
}

async function terminatePid(pid, name, pth) {
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/F'], { timeout: 2000, maxBuffer: 128 * 1024 });
    console.log(`TERMINATED ${pid} ${name}`);
  } catch (e) {
    console.warn(`FAILED TO TERMINATE ${pid} ${name}: ${e.message}`);
  }
}

let config = null;
async function enforceSweep() {
  if (!config || config.blockApps === false) return;
  const rows = await queryProcesses();
  const toKill = rows.filter(info => blocked(info, config));
  for (const proc of toKill) {
    await terminatePid(proc.pid, proc.name, proc.path);
  }
}

function startServer() {
  config = readConfig();
  // Immediate sweep to catch any distractors already running
  enforceSweep().catch(console.error);

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(5555, '127.0.0.1', () => {
    console.log('FocusGuard realtime server listening on http://127.0.0.1:5555');
  });

  setInterval(() => enforceSweep().catch(console.error), POLL_MS);
}

startServer();
