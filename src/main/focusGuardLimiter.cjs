// focusGuardLimiter.cjs — ReGain-style distracting-app active usage limiter & background monitoring service
// Continuously monitors running processes, accounts for active process time (pauses when closed, resumes on launch),
// terminates & blocks apps when usage limit is reached or expiry time is reached, and persists usage state.

'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function norm(p) {
  if (!p) return '';
  return String(p)
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function normalizeExeName(name) {
  if (!name) return '';
  const trimmed = String(name).trim().toLowerCase();
  const base = path.basename(trimmed);
  return base.endsWith('.exe') ? base : `${base}.exe`;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeout || 6000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Timeout: ${file} took longer than ${timeoutMs}ms`));
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs + 1000);

    const child = execFile(file, args, { encoding: 'utf8', windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        const msg = String(stderr || stdout || error.message || error).trim();
        reject(Object.assign(new Error(msg || `${file} failed`), { code: error.code }));
      } else {
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      }
    });
  });
}

function getElectronDir() {
  if (process.resourcesPath) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'electron');
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return __dirname;
}

const ELECTRON_DIR = getElectronDir();
const HELPER_EXE_PATH = path.join(ELECTRON_DIR, 'activeWindowHelper.exe');
const HELPER_CS_PATH = path.join(ELECTRON_DIR, 'activeWindowHelper.cs');

function ensureActiveWindowHelperCompiled() {
  if (fs.existsSync(HELPER_EXE_PATH)) return true;
  if (!fs.existsSync(HELPER_CS_PATH)) return false;
  try {
    const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
    if (fs.existsSync(cscPath)) {
      execFile(cscPath, ['/nologo', '/optimize', '/target:exe', `/out:${HELPER_EXE_PATH}`, HELPER_CS_PATH], { windowsHide: true }, () => {});
    }
  } catch {}
  return fs.existsSync(HELPER_EXE_PATH);
}

// Fast query of all desktop visible, non-minimized windows and foreground PID/process
async function queryActiveWindows() {
  if (process.platform !== 'win32') return { foregroundPid: 0, foregroundProc: '', foregroundTitle: '', windows: [] };
  if (!fs.existsSync(HELPER_EXE_PATH)) {
    ensureActiveWindowHelperCompiled();
  }
  if (!fs.existsSync(HELPER_EXE_PATH)) {
    return { foregroundPid: 0, foregroundProc: '', foregroundTitle: '', windows: [] };
  }

  try {
    const { stdout } = await execFileAsync(HELPER_EXE_PATH, [], { timeout: 2000, maxBuffer: 1024 * 1024 });
    const trimmed = String(stdout || '').trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const parsed = JSON.parse(trimmed);
      return {
        foregroundPid: Number(parsed.foregroundPid || 0),
        foregroundProc: String(parsed.foregroundProc || ''),
        foregroundTitle: String(parsed.foregroundTitle || ''),
        windows: Array.isArray(parsed.windows) ? parsed.windows : []
      };
    }
  } catch {}
  return { foregroundPid: 0, foregroundProc: '', foregroundTitle: '', windows: [] };
}

// Fast Windows process listing via tasklist CSV output
async function queryRunningProcesses() {
  if (process.platform !== 'win32') {
    return [];
  }

  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 3500, maxBuffer: 3 * 1024 * 1024 });
    const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      // Format: "Image Name","PID","Session Name","Session#","Mem Usage"
      const parts = line.split('","').map(s => s.replace(/^"|"$/g, ''));
      if (parts.length >= 2) {
        const rawName = parts[0].trim();
        const pid = parseInt(parts[1], 10);
        if (pid > 0 && rawName) {
          const normName = normalizeExeName(rawName);
          rows.push({ pid, name: normName, rawName });
        }
      }
    }
    return rows;
  } catch (error) {
    // Fallback: PowerShell Get-Process
    try {
      const ps = `$ErrorActionPreference='SilentlyContinue'; Get-Process | Select-Object Id, ProcessName | ForEach-Object { [pscustomobject]@{ pid=[int]$_.Id; name=([string]$_.ProcessName + '.exe').ToLower() } } | ConvertTo-Json -Compress`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 4000 });
      const raw = String(stdout || '').trim();
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map(item => ({ pid: Number(item.pid || 0), name: normalizeExeName(item.name) })).filter(x => x.pid > 0);
    } catch {
      return [];
    }
  }
}

// Terminate a PID and executable name forcefully
async function terminateProcessPid(pid, name) {
  try {
    if (pid) {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/F'], { timeout: 3000 });
      console.log(`[ReGain Limiter] Terminated process pid=${pid} (${name})`);
    }
  } catch (err) {
    console.warn(`[ReGain Limiter] Failed to terminate pid=${pid} (${name}):`, err?.message);
  }
  try {
    if (name) {
      const norm = normalizeExeName(name);
      await execFileAsync('taskkill.exe', ['/IM', norm, '/F'], { timeout: 3000 });
    }
  } catch {}
  return true;
}

// Known Windows process aliases for popular apps/distractions
const PROCESS_ALIAS_MAP = {
  'whatsapp': ['whatsapp', 'whatsapp.root', 'whatsappdesktop', 'whatsapphost'],
  'instagram': ['instagram', 'instagram.root', 'instagramapp'],
  'spotify': ['spotify', 'spotifylauncher'],
  'discord': ['discord', 'discordptb', 'discordcanary'],
  'steam': ['steam', 'steamservice', 'steamwebhelper'],
  'telegram': ['telegram', 'telegramdesktop'],
  'twitter': ['twitter', 'x'],
  'netflix': ['netflix'],
  'tiktok': ['tiktok'],
  'epicgames': ['epicgameslauncher'],
  'chrome': ['chrome'],
  'zen': ['zen'],
  'edge': ['msedge'],
  'firefox': ['firefox'],
  'brave': ['brave'],
  'opera': ['opera', 'opera_gx']
};

// Known distracting apps catalog for auto-detection and 10-minute default daily allowance
const KNOWN_DISTRACTING_APPS = {
  'whatsapp': { name: 'WhatsApp', category: 'communication', defaultMinutes: 10 },
  'whatsapp.root': { name: 'WhatsApp', category: 'communication', defaultMinutes: 10 },
  'whatsappdesktop': { name: 'WhatsApp Desktop', category: 'communication', defaultMinutes: 10 },
  'instagram': { name: 'Instagram', category: 'social', defaultMinutes: 10 },
  'instagram.root': { name: 'Instagram', category: 'social', defaultMinutes: 10 },
  'spotify': { name: 'Spotify', category: 'entertainment', defaultMinutes: 10 },
  'spotifylauncher': { name: 'Spotify', category: 'entertainment', defaultMinutes: 10 },
  'discord': { name: 'Discord', category: 'communication', defaultMinutes: 10 },
  'discordcanary': { name: 'Discord Canary', category: 'communication', defaultMinutes: 10 },
  'discordptb': { name: 'Discord PTB', category: 'communication', defaultMinutes: 10 },
  'steam': { name: 'Steam', category: 'gaming', defaultMinutes: 10 },
  'steamservice': { name: 'Steam Service', category: 'gaming', defaultMinutes: 10 },
  'telegram': { name: 'Telegram', category: 'communication', defaultMinutes: 10 },
  'telegramdesktop': { name: 'Telegram Desktop', category: 'communication', defaultMinutes: 10 },
  'twitter': { name: 'X (Twitter)', category: 'social', defaultMinutes: 10 },
  'x': { name: 'X (Twitter)', category: 'social', defaultMinutes: 10 },
  'tiktok': { name: 'TikTok', category: 'entertainment', defaultMinutes: 10 },
  'netflix': { name: 'Netflix', category: 'entertainment', defaultMinutes: 10 },
  'epicgameslauncher': { name: 'Epic Games', category: 'gaming', defaultMinutes: 10 },
  'riotclientux': { name: 'Riot Games', category: 'gaming', defaultMinutes: 10 },
  'valorant': { name: 'Valorant', category: 'gaming', defaultMinutes: 10 },
  'leagueoflegends': { name: 'League of Legends', category: 'gaming', defaultMinutes: 10 },
  'robloxplayerbeta': { name: 'Roblox', category: 'gaming', defaultMinutes: 10 },
  'minecraft': { name: 'Minecraft', category: 'gaming', defaultMinutes: 10 },
  'vlc': { name: 'VLC Media Player', category: 'entertainment', defaultMinutes: 10 },
  'zen': { name: 'Zen Browser', category: 'browsing', defaultMinutes: 10 },
};

function getFriendlyAppName(rawExe) {
  const clean = String(rawExe || '').toLowerCase().replace(/\.exe$/i, '').trim();
  if (KNOWN_DISTRACTING_APPS[clean]) return KNOWN_DISTRACTING_APPS[clean].name;
  for (const [canonical, aliases] of Object.entries(PROCESS_ALIAS_MAP)) {
    if (clean === canonical || aliases.includes(clean)) {
      return canonical.charAt(0).toUpperCase() + canonical.slice(1);
    }
  }
  // Title case words
  return clean.split(/[-_.]/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Windows background/system daemons to ignore when surfacing open user apps
const SYSTEM_IGNORES = new Set([
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsaiso', 'lsass', 'svchost',
  'fontdrvhost', 'wudfhost', 'dwm', 'explorer', 'sihost', 'ctfmon', 'runtimebroker', 'searchhost', 'searchapp',
  'startmenuexperiencehost', 'shellexperiencehost', 'applicationframehost', 'textinputhost', 'securityhealthsystray',
  'securityhealthservice', 'smartscreen', 'taskhostw', 'backgroundtaskhost', 'dllhost', 'spoolsv', 'audiodg',
  'conhost', 'openconsole', 'windowsterminal', 'msmpeng', 'mpdefendercoreservice', 'nissrv', 'powershell', 'pwsh',
  'cmd', 'node', 'node.exe', 'git', 'lifeos', 'lifeos.exe', 'brihaspati', 'brihaspati.exe', 'neo coach', 'neo coach.exe', 'electron', 'electron.exe', 'activewindowhelper', 'activewindowhelper.exe', 'antigravity', 'antigravity ide', 'aggregatorhost', 'bravecrashhandler',
  'bravecrashhandler64', 'crashpad_handler', 'crossdeviceresume', 'crossdeviceservice', 'cua-driver',
  'defendersessionhelper', 'dock_64', 'dockmod', 'dsaupdateservice', 'dtsapo4service', 'esbuild', 'esrv', 'esrv_svc',
  'gameinputsvc', 'gamingservices', 'gamingservicesnet', 'geminicrashpadhandler', 'igcc', 'igcctray',
  'intelaudioservice', 'intelgraphicssoftware', 'jhi_service', 'language_server_windows_x64', 'lenovovantageservice',
  'memory compression', 'microsoftstartfeedprovider', 'mscopilot_proxy', 'presentmonservice', 'searchindexer',
  'secure system', 'shellhost', 'sursvc', 'tasklist', 'telemetry_agent', 'useroobebroker', 'vmcompute',
  'widgetboard', 'widgetservice', 'wlanext', 'wmiprvse', 'wmiregistrationservice', 'wslservice', 'ngciso'
]);

function findRunningPidsForLimit(limitKey, limitInfo, runningExesMap) {
  const normKey = String(limitKey || '').toLowerCase().trim();
  const cleanKey = normKey.replace(/\.exe$/i, '');
  const displayName = String(limitInfo?.name || '').toLowerCase().trim().replace(/\.exe$/i, '');

  const candidates = new Set([cleanKey, normKey]);
  if (displayName) candidates.add(displayName);

  for (const name of Array.from(candidates)) {
    for (const [canonical, aliases] of Object.entries(PROCESS_ALIAS_MAP)) {
      if (name === canonical || aliases.includes(name)) {
        aliases.forEach(a => candidates.add(a));
      }
    }
  }

  const pids = [];
  for (const [procExe, procList] of runningExesMap.entries()) {
    const cleanProc = procExe.toLowerCase().replace(/\.exe$/i, '');
    let matched = false;

    if (candidates.has(cleanProc) || candidates.has(procExe.toLowerCase())) {
      matched = true;
    } else {
      for (const cand of candidates) {
        if (!cand) continue;
        if (cleanProc.startsWith(cand + '.') || cleanProc.startsWith(cand + '-') || cleanProc.startsWith(cand + '_') ||
            cand.startsWith(cleanProc + '.') || cand.startsWith(cleanProc + '-') || cand.startsWith(cleanProc + '_')) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      for (const p of procList) {
        pids.push(p);
      }
    }
  }
  return pids;
}

function matchesActiveWindow(rawKey, limitInfo, visibleWindows) {
  if (!Array.isArray(visibleWindows) || visibleWindows.length === 0) return false;
  const normKey = String(rawKey || '').toLowerCase().replace(/\.exe$/i, '').trim();
  const displayName = String(limitInfo?.name || '').toLowerCase().trim();

  for (const win of visibleWindows) {
    const winName = String(win.name || '').toLowerCase().replace(/\.exe$/i, '').trim();
    const winTitle = String(win.title || '').toLowerCase().trim();

    if (winName === normKey || (displayName && winName === displayName)) return true;
    if (winTitle.includes(normKey) || (displayName && winTitle.includes(displayName))) return true;

    for (const [canonical, aliases] of Object.entries(PROCESS_ALIAS_MAP)) {
      if (normKey === canonical || aliases.includes(normKey)) {
        if (winName === canonical || aliases.includes(winName)) return true;
        if (winTitle.includes(canonical)) return true;
      }
    }
  }
  return false;
}

function parseDurationToSeconds(val) {
  if (typeof val === 'number') return Math.max(1, Math.round(val));
  const s = String(val || '').trim();
  if (!s) return 1800;
  // mm:ss (e.g. 1:20 -> 80s)
  const m = s.match(/^(\d+):(\d{1,2})$/);
  if (m) {
    return Math.max(1, parseInt(m[1], 10) * 60 + parseInt(m[2], 10));
  }
  // hh:mm:ss (e.g. 1:20:00 -> 4800s)
  const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2})$/);
  if (hms) {
    return Math.max(1, parseInt(hms[1], 10) * 3600 + parseInt(hms[2], 10) * 60 + parseInt(hms[3], 10));
  }
  const secMatch = s.match(/^(\d+)\s*(s|sec|seconds?)$/i);
  if (secMatch) return Math.max(1, parseInt(secMatch[1], 10));
  const minMatch = s.match(/^(\d+)\s*(m|min|mins|minutes?)$/i);
  if (minMatch) return Math.max(1, parseInt(minMatch[1], 10) * 60);
  const num = Number(s);
  if (!isNaN(num) && num > 0) return Math.max(1, Math.round(num * 60));
  return 1800;
}

function isAppForegroundActive(rawKey, limitInfo, runningPids, activeWinData) {
  if (!activeWinData) return false;
  const fgPid = Number(activeWinData.foregroundPid || 0);
  const fgProc = String(activeWinData.foregroundProc || '').toLowerCase().replace(/\.exe$/i, '').trim();

  const normKey = String(rawKey || '').toLowerCase().replace(/\.exe$/i, '').trim();
  const displayName = String(limitInfo?.name || '').toLowerCase().trim();

  // 1. Check if foreground window PID belongs to this app's running PIDs
  if (fgPid > 0 && Array.isArray(runningPids) && runningPids.length > 0) {
    if (runningPids.some(p => p.pid === fgPid)) {
      return true;
    }
  }

  // 2. Check if foreground process name matches this app or its known aliases
  if (fgProc) {
    if (fgProc === normKey || (displayName && fgProc === displayName)) return true;
    for (const [canonical, aliases] of Object.entries(PROCESS_ALIAS_MAP)) {
      if (normKey === canonical || aliases.includes(normKey)) {
        if (fgProc === canonical || aliases.includes(fgProc)) return true;
      }
    }
  }

  return false;
}

class FocusGuardLimiter {
  constructor(options = {}) {
    this.configPath = options.configPath || null;
    this.readConfigFn = options.readConfigFn || null;
    this.writeConfigFn = options.writeConfigFn || null;
    this.onEvent = options.onEvent || (() => {});
    this.pollIntervalMs = options.pollIntervalMs || 1000; // 1s interval for smooth active second updates

    this.timer = null;
    this.busy = false;
    this.activeExes = new Map();
    this.lastTickTime = Date.now();
    this.dirty = false;
    this.saveThrottleTimer = null;

    // Track recently killed PIDs to avoid log flooding
    this.recentlyKilled = new Map();
  }

  start() {
    if (this.timer) return;
    this.lastTickTime = Date.now();
    console.log('[ReGain Limiter] Background monitoring service started (poll: ' + this.pollIntervalMs + 'ms)');
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    // Initial immediate sweep
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.saveThrottleTimer) {
      clearTimeout(this.saveThrottleTimer);
      this.saveThrottleTimer = null;
    }
    this.flushStateSync();
    console.log('[ReGain Limiter] Background monitoring service stopped');
  }

  getConfig() {
    let base = {};
    if (typeof this.readConfigFn === 'function') {
      try {
        base = this.readConfigFn() || {};
      } catch (e) {
        console.warn('[ReGain Limiter] Config read failed:', e.message);
      }
    } else if (this.configPath && fs.existsSync(this.configPath)) {
      try {
        base = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) || {};
      } catch {}
    }
    if (this.cachedLimits) {
      base.appTimeLimits = { ...(base.appTimeLimits || {}), ...this.cachedLimits };
    } else {
      this.cachedLimits = { ...(base.appTimeLimits || {}) };
    }
    return base;
  }

  saveConfig(cfg) {
    if (cfg && cfg.appTimeLimits) {
      this.cachedLimits = { ...cfg.appTimeLimits };
    }
    if (typeof this.writeConfigFn === 'function') {
      try {
        this.writeConfigFn(cfg);
        return true;
      } catch (e) {
        console.warn('[ReGain Limiter] Config write failed:', e.message);
      }
    }
    if (this.configPath) {
      try {
        const tmp = `${this.configPath}.tmp.${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
        fs.renameSync(tmp, this.configPath);
        return true;
      } catch (e) {
        console.warn('[ReGain Limiter] Config write failed:', e.message);
      }
    }
    return false;
  }

  flushState() {
    if (this.saveThrottleTimer) return;
    this.saveThrottleTimer = setTimeout(() => {
      this.saveThrottleTimer = null;
      this.flushStateSync();
    }, 1500);
  }

  flushStateSync() {
    if (!this.dirty) return;
    try {
      const cfg = this.getConfig();
      if (cfg && cfg.appTimeLimits) {
        this.saveConfig(cfg);
        this.dirty = false;
      }
    } catch (e) {
      console.warn('[ReGain Limiter] flushStateSync error:', e.message);
    }
  }

  // Check if an app has a valid active allowance remaining using robust matching
  hasActiveAllowance(appInfo) {
    const cfg = this.getConfig();
    const limits = (cfg && typeof cfg.appTimeLimits === 'object') ? cfg.appTimeLimits : {};
    const n = normalizeExeName(appInfo?.name || appInfo?.executableName || '');
    if (!n) return false;

    const testMap = new Map([[n, [appInfo]]]);

    for (const [key, limitInfo] of Object.entries(limits)) {
      if (!limitInfo || limitInfo.enabled === false || !limitInfo.limitMinutes) continue;
      const matchedPids = findRunningPidsForLimit(key, limitInfo, testMap);
      if (matchedPids.length > 0) {
        // 1. Expiry check: if expiryTime has passed, allowance is void!
        if (limitInfo.expiryTime) {
          const expiryMs = new Date(limitInfo.expiryTime).getTime();
          if (Number.isFinite(expiryMs) && expiryMs <= Date.now()) {
            return false;
          }
        }

        // 2. Active usage check: if accumulated used seconds >= max seconds, limit reached!
        const maxSeconds = Number(limitInfo.limitMinutes) * 60;
        const usedSeconds = Number(limitInfo.usedSeconds || limitInfo.usedSecondsToday || 0);
        if (usedSeconds >= maxSeconds) {
          return false;
        }

        return true;
      }
    }

    return false;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    const now = Date.now();
    const elapsedSeconds = Math.max(1, Math.min(5, Math.round((now - this.lastTickTime) / 1000)));
    this.lastTickTime = now;

    try {
      const cfg = this.getConfig();
      const limits = (cfg && typeof cfg.appTimeLimits === 'object' && cfg.appTimeLimits !== null) ? cfg.appTimeLimits : {};
      let configChanged = false;

      // 1. Query running processes and active desktop visible windows
      const [processes, activeWinData] = await Promise.all([
        queryRunningProcesses(),
        queryActiveWindows()
      ]);
      const runningExesMap = new Map(); // exeName -> Array of { pid, name }
      const visibleWindowPids = new Set((activeWinData?.windows || []).map(w => w.pid));
      const visibleWindows = activeWinData?.windows || [];

      const detectedOpenApps = [];
      const seenOpen = new Set();

      for (const proc of processes) {
        const normName = proc.name;
        if (!runningExesMap.has(normName)) {
          runningExesMap.set(normName, []);
        }
        runningExesMap.get(normName).push(proc);

        const clean = normName.replace(/\.exe$/i, '').toLowerCase().trim();
        if (SYSTEM_IGNORES.has(clean) || SYSTEM_IGNORES.has(normName.toLowerCase())) continue;

        // Only surface apps in open apps picker that have a visible GUI window or user process
        if (visibleWindows.length > 0 && !visibleWindowPids.has(proc.pid)) {
          continue;
        }

        if (!seenOpen.has(normName)) {
          seenOpen.add(normName);
          detectedOpenApps.push({
            name: getFriendlyAppName(normName),
            executableName: normName,
            pid: proc.pid,
          });
        }
      }

      // 2. If auto-enrollment is enabled in config, auto-detect newly opened distracting apps
      if (cfg.autoEnrollDistractingApps === true) {
        for (const [procExe, _pids] of runningExesMap.entries()) {
          const cleanProc = procExe.toLowerCase().replace(/\.exe$/i, '').trim();
          if (SYSTEM_IGNORES.has(cleanProc) || SYSTEM_IGNORES.has(procExe.toLowerCase())) continue;

          let isDistracting = Boolean(KNOWN_DISTRACTING_APPS[cleanProc]);
          if (!isDistracting) {
            for (const [canonical, aliases] of Object.entries(PROCESS_ALIAS_MAP)) {
              if (cleanProc === canonical || aliases.includes(cleanProc)) {
                isDistracting = true;
                break;
              }
            }
          }

          if (isDistracting) {
            let alreadyTracked = false;
            for (const [rawKey, limitInfo] of Object.entries(limits)) {
              const matchedPids = findRunningPidsForLimit(rawKey, limitInfo, new Map([[procExe, _pids]]));
              if (matchedPids.length > 0) {
                alreadyTracked = true;
                break;
              }
            }

            if (!alreadyTracked) {
              const friendly = getFriendlyAppName(procExe);
              const meta = KNOWN_DISTRACTING_APPS[cleanProc] || {};
              const defMins = meta.defaultMinutes || 10;
              console.log(`[ReGain Limiter] Auto-enrolling opened distracting app: ${procExe} (${friendly}) with ${defMins}m limit`);

              limits[procExe] = {
                id: `limit-${cleanProc}-${Date.now()}`,
                name: friendly,
                executableName: procExe,
                enabled: true,
                limitMinutes: defMins,
                usedSeconds: 0,
                usedSecondsToday: 0,
                expiryTime: null,
                category: meta.category || 'distracting',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                _wasRunning: false,
                _notifiedExceeded: false,
              };
              configChanged = true;
              this.dirty = true;
            }
          }
        }
      }

      const updatesForRenderer = {};

      // 2. Evaluate all configured limits
      for (const rawKey of Object.keys(limits)) {
        const normExe = normalizeExeName(rawKey);
        const limitInfo = limits[rawKey];
        if (!limitInfo) continue;

        const enabled = limitInfo.enabled !== false;
        const maxSeconds = Number(limitInfo.limitSeconds || Math.round(Number(limitInfo.limitMinutes || 30) * 60));
        const limitMinutes = Number((maxSeconds / 60).toFixed(2));
        let usedSeconds = Number(limitInfo.usedSeconds ?? limitInfo.usedSecondsToday ?? 0);

        // Check expiry status
        let isExpired = false;
        if (limitInfo.expiryTime) {
          const expTime = new Date(limitInfo.expiryTime).getTime();
          if (Number.isFinite(expTime) && expTime <= now) {
            isExpired = true;
          }
        }

        // Robust process matching (finds whatsapp.root.exe for whatsapp.exe, etc.)
        const runningPids = findRunningPidsForLimit(rawKey, limitInfo, runningExesMap);
        const hasProcess = runningPids.length > 0;

        // Foreground Active Window Check:
        const isForeground = isAppForegroundActive(rawKey, limitInfo, runningPids, activeWinData);
        const hasVisibleWindow = hasProcess && (
          (visibleWindows.length > 0 && runningPids.some(proc => visibleWindowPids.has(proc.pid))) ||
          matchesActiveWindow(rawKey, limitInfo, visibleWindows)
        );

        // Modified usage rule: Timer counts if the app is in foreground or has any visible window 
        // (including minimized windows, since we modified activeWindowHelper).
        // Apps completely closed to the tray (hidden windows) will pause.
        const isRunning = Boolean(isForeground || hasVisibleWindow);
        let isLimitReached = usedSeconds >= maxSeconds;

        if (enabled) {
          if (isRunning) {
            // APP OPEN DETECTION & NOTIFICATION:
            // When an app transitions from closed to open:
            if (!limitInfo._wasRunning) {
              limitInfo._wasRunning = true;
              const remainingSec = Math.max(0, maxSeconds - usedSeconds);
              const remainingMins = Math.max(0, Math.ceil(remainingSec / 60));
              console.log(`[ReGain Limiter] APP OPENED: ${normExe} (${remainingMins}m remaining)`);

              this.onEvent('app-opened', {
                exeName: normExe,
                name: limitInfo.name || normExe.replace(/\.exe$/i, ''),
                limitMinutes,
                usedSeconds,
                remainingSeconds: remainingSec,
                remainingMinutes: remainingMins,
                maxSeconds,
                isLimitReached,
                isExpired,
              });
            }

            if (!isLimitReached && !isExpired) {
              // Active Process Time Accounting:
              // App starts -> timer starts. App remains running -> increments.
              usedSeconds += elapsedSeconds;
              limitInfo.usedSeconds = usedSeconds;
              limitInfo.usedSecondsToday = usedSeconds;
              limitInfo.lastActiveAt = new Date().toISOString();
              configChanged = true;
              this.dirty = true;

              if (usedSeconds >= maxSeconds) {
                isLimitReached = true;
              }
            }

            // ENFORCEMENT:
            // When accumulated active usage reaches configured limit OR allowance expired:
            // Automatically terminate/close the process and prevent further usage according to Focus Guard rules.
            if (isLimitReached || isExpired) {
              const reason = isExpired ? 'expired' : 'limit_reached';
              console.log(`[ReGain Limiter] ENFORCING BLOCK on ${normExe}: reason=${reason}, usedSeconds=${usedSeconds}, maxSeconds=${maxSeconds}`);

              for (const proc of runningPids) {
                const lastKill = this.recentlyKilled.get(proc.pid) || 0;
                if (now - lastKill > 3000) {
                  this.recentlyKilled.set(proc.pid, now);
                  terminateProcessPid(proc.pid, proc.name).catch(() => {});
                }
              }

              // Fire event only once per transition to limit exceeded / expired
              if (!limitInfo._notifiedExceeded) {
                limitInfo._notifiedExceeded = true;
                configChanged = true;
                this.dirty = true;

                this.onEvent('time-limit-exceeded', {
                  exeName: normExe,
                  name: limitInfo.name || normExe.replace(/\.exe$/i, ''),
                  limitMinutes,
                  usedSeconds,
                  reason,
                  expiryTime: limitInfo.expiryTime || null,
                });
              }
            }
          } else {
            // App is closed / stopped:
            // Timer immediately pauses! Previous accumulated usage is preserved.
            if (limitInfo._wasRunning) {
              limitInfo._wasRunning = false;
              console.log(`[ReGain Limiter] APP CLOSED: ${normExe}. Timer paused at ${usedSeconds}s`);
              this.onEvent('app-closed', {
                exeName: normExe,
                name: limitInfo.name || normExe.replace(/\.exe$/i, ''),
                usedSeconds,
              });
            }

            if (!isLimitReached && !isExpired) {
              limitInfo._notifiedExceeded = false;
            }
          }
        }

        // Clean up recently killed cache
        for (const [pid, ts] of this.recentlyKilled.entries()) {
          if (now - ts > 10000) {
            this.recentlyKilled.delete(pid);
          }
        }

        // Build realtime state for UI
        updatesForRenderer[rawKey] = {
          ...limitInfo,
          executableName: normExe,
          usedSeconds,
          maxSeconds,
          limitMinutes,
          limitSeconds: maxSeconds,
          isRunning,
          isForeground,
          hasVisibleWindow,
          isPaused: !isRunning && usedSeconds > 0 && !isLimitReached && !isExpired,
          isLimitReached,
          isExpired,
          remainingSeconds: Math.max(0, maxSeconds - usedSeconds),
          percentUsed: Math.min(100, Math.round((usedSeconds / maxSeconds) * 100)),
        };
      }

      if (configChanged) {
        cfg.appTimeLimits = limits;
        this.flushState();
      }

      // Enrich detectedOpenApps with real-time tracking status
      for (const app of detectedOpenApps) {
        const norm = app.executableName.toLowerCase();
        const clean = norm.replace(/\.exe$/i, '');
        const matched = Object.values(updatesForRenderer).find(u => {
          const uExe = u.executableName.toLowerCase();
          const uClean = uExe.replace(/\.exe$/i, '');
          return uExe === norm || uClean === clean || u.name?.toLowerCase() === app.name?.toLowerCase();
        });

        if (matched) {
          app.isLimited = true;
          app.limitMinutes = matched.limitMinutes;
          app.limitSeconds = matched.limitSeconds;
          app.usedSeconds = matched.usedSeconds;
          app.remainingSeconds = matched.remainingSeconds;
          app.percentUsed = matched.percentUsed;
          app.isLimitReached = matched.isLimitReached;
          app.isExpired = matched.isExpired;
          app.isRunning = matched.isRunning;
          app.isForeground = matched.isForeground;
          app.category = matched.category || 'distracting';
        } else {
          app.isLimited = false;
          app.usedSeconds = 0;
          app.limitMinutes = null;
          app.limitSeconds = null;
          app.remainingSeconds = null;
          app.percentUsed = 0;
          app.isLimitReached = false;
          app.isExpired = false;
          app.isRunning = true;
          app.isForeground = false;
          app.category = KNOWN_DISTRACTING_APPS[clean]?.category || 'utility';
        }
      }

      // Sort so active limited apps appear first, then alphabetically
      detectedOpenApps.sort((a, b) => {
        if (a.isLimited && !b.isLimited) return -1;
        if (!a.isLimited && b.isLimited) return 1;
        return a.name.localeCompare(b.name);
      });

      // Broadcast live updates to renderer UI
      const activeRunningList = Object.values(updatesForRenderer).filter(x => x.isRunning && x.enabled);

      this.latestRendererLimits = updatesForRenderer;

      this.onEvent('app-limits-update', {
        limits: updatesForRenderer,
        runningCount: activeRunningList.length,
        activeRunningLimits: activeRunningList,
        detectedOpenApps: detectedOpenApps.slice(0, 45),
        timestamp: now,
      });

    } catch (err) {
      console.warn('[ReGain Limiter] Sweep error:', err.message);
    } finally {
      this.busy = false;
    }
  }

  // Public API methods called by IPC handlers
  getAppLimitsState() {
    const cfg = this.getConfig();
    const limits = (cfg && typeof cfg.appTimeLimits === 'object' && cfg.appTimeLimits !== null) ? cfg.appTimeLimits : {};
    const now = Date.now();
    const out = {};

    for (const [key, info] of Object.entries(limits)) {
      if (!info) continue;
      const normExe = normalizeExeName(key);
      const maxSeconds = Number(info.limitSeconds || Math.round(Number(info.limitMinutes || 30) * 60));
      const limitMinutes = Number((maxSeconds / 60).toFixed(2));
      const usedSeconds = Number(info.usedSeconds ?? info.usedSecondsToday ?? 0);
      let isExpired = false;
      if (info.expiryTime) {
        const exp = new Date(info.expiryTime).getTime();
        if (Number.isFinite(exp) && exp <= now) isExpired = true;
      }
      const isLimitReached = usedSeconds >= maxSeconds;

      const latest = this.latestRendererLimits?.[key] || this.latestRendererLimits?.[normExe];
      const isRunning = Boolean(latest?.isRunning);
      const isForeground = Boolean(latest?.isForeground);
      const hasVisibleWindow = Boolean(latest?.hasVisibleWindow);
      const isPaused = !isRunning && usedSeconds > 0 && !isLimitReached && !isExpired;

      out[key] = {
        ...info,
        executableName: normExe,
        usedSeconds,
        maxSeconds,
        limitMinutes,
        limitSeconds: maxSeconds,
        isRunning,
        isForeground,
        hasVisibleWindow,
        isPaused,
        isLimitReached,
        isExpired,
        remainingSeconds: Math.max(0, maxSeconds - usedSeconds),
        percentUsed: Math.min(100, Math.round((usedSeconds / maxSeconds) * 100)),
      };
    }
    return out;
  }

  setAppLimit(payload) {
    if (!payload || !payload.executableName) {
      throw new Error('executableName is required');
    }
    const normExe = normalizeExeName(payload.executableName);
    const cfg = this.getConfig();
    const limits = { ...(cfg.appTimeLimits || {}) };

    const existing = limits[normExe] || {};

    let maxSeconds = 1800;
    if (payload.limitSeconds) {
      maxSeconds = Math.max(1, Math.round(Number(payload.limitSeconds)));
    } else if (payload.durationStr) {
      maxSeconds = parseDurationToSeconds(payload.durationStr);
    } else if (payload.limitMinutes !== undefined) {
      if (typeof payload.limitMinutes === 'string' && payload.limitMinutes.includes(':')) {
        maxSeconds = parseDurationToSeconds(payload.limitMinutes);
      } else {
        const num = Number(payload.limitMinutes);
        maxSeconds = Math.max(1, Math.round(num * 60));
      }
    } else if (existing.limitSeconds) {
      maxSeconds = existing.limitSeconds;
    } else if (existing.limitMinutes) {
      maxSeconds = Math.max(1, Math.round(existing.limitMinutes * 60));
    }
    const limitMinutes = Number((maxSeconds / 60).toFixed(2));
    
    // Parse expiry time
    let expiryTime = payload.expiryTime !== undefined ? payload.expiryTime : (existing.expiryTime || null);
    if (expiryTime && typeof expiryTime === 'string') {
      const parsed = new Date(expiryTime);
      if (isNaN(parsed.getTime())) {
        expiryTime = null;
      } else {
        expiryTime = parsed.toISOString();
      }
    }

    limits[normExe] = {
      id: existing.id || `limit-${normExe}-${Date.now()}`,
      name: payload.name || existing.name || normExe.replace(/\.exe$/i, ''),
      executableName: normExe,
      path: payload.path || existing.path || '',
      category: payload.category || existing.category || 'distracting',
      enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : (existing.enabled !== false),
      limitMinutes,
      limitSeconds: maxSeconds,
      expiryTime,
      usedSeconds: payload.usedSeconds !== undefined ? Number(payload.usedSeconds) : (existing.usedSeconds !== undefined ? existing.usedSeconds : (existing.usedSecondsToday || 0)),
      usedSecondsToday: payload.usedSeconds !== undefined ? Number(payload.usedSeconds) : (existing.usedSecondsToday !== undefined ? existing.usedSecondsToday : 0),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      _notifiedExceeded: false,
    };

    cfg.appTimeLimits = limits;
    this.saveConfig(cfg);
    this.dirty = false;

    // Trigger immediate sweep to check/apply
    setTimeout(() => this.tick().catch(() => {}), 100);

    return { ok: true, limit: limits[normExe], allLimits: limits };
  }

  removeAppLimit(executableName) {
    const normExe = normalizeExeName(executableName);
    const cfg = this.getConfig();
    const limits = { ...(cfg.appTimeLimits || {}) };

    if (limits[normExe]) {
      delete limits[normExe];
      cfg.appTimeLimits = limits;
      this.saveConfig(cfg);
      this.dirty = false;
      setTimeout(() => this.tick().catch(() => {}), 100);
      return { ok: true, removed: normExe };
    }
    return { ok: false, error: 'Limit not found' };
  }

  resetAppLimit(executableName) {
    const normExe = normalizeExeName(executableName);
    const cfg = this.getConfig();
    const limits = { ...(cfg.appTimeLimits || {}) };

    if (limits[normExe]) {
      limits[normExe].usedSeconds = 0;
      limits[normExe].usedSecondsToday = 0;
      limits[normExe]._notifiedExceeded = false;
      limits[normExe].updatedAt = new Date().toISOString();
      cfg.appTimeLimits = limits;
      this.saveConfig(cfg);
      this.dirty = false;
      setTimeout(() => this.tick().catch(() => {}), 100);
      return { ok: true, limit: limits[normExe] };
    }
    return { ok: false, error: 'Limit not found' };
  }

  async getRunningUserProcesses() {
    const [processes, activeWinData] = await Promise.all([
      queryRunningProcesses(),
      queryActiveWindows()
    ]);
    const seen = new Set();
    const userProcs = [];
    const visibleWindows = activeWinData?.windows || [];
    const visiblePids = new Set(visibleWindows.map(w => w.pid));

    const SYSTEM_IGNORES = new Set([
      'system','idle','registry','smss.exe','csrss.exe','wininit.exe','winlogon.exe','services.exe','lsass.exe',
      'svchost.exe','dwm.exe','explorer.exe','sihost.exe','ctfmon.exe','fontdrvhost.exe','runtimebroker.exe',
      'searchhost.exe','searchapp.exe','startmenuexperiencehost.exe','shellexperiencehost.exe','applicationframehost.exe',
      'textinputhost.exe','securityhealthsystray.exe','securityhealthservice.exe','smartscreen.exe','taskhostw.exe',
      'backgroundtaskhost.exe','dllhost.exe','spoolsv.exe','audiodg.exe','conhost.exe','openconsole.exe',
      'windowsterminal.exe','msmpeng.exe','mpdefendercoreservice.exe','nissrv.exe','lsaiso.exe','wudfhost.exe',
      'powershell.exe','pwsh.exe','cmd.exe','node.exe','git.exe','lifeos.exe','brihaspati.exe','antigravity.exe'
    ]);

    for (const p of processes) {
      const n = p.name;
      if (SYSTEM_IGNORES.has(n) || seen.has(n)) continue;

      const hasWin = visiblePids.has(p.pid);
      if (visibleWindows.length > 0 && !hasWin) continue;

      seen.add(n);
      const matchedWin = visibleWindows.find(w => w.pid === p.pid);
      userProcs.push({
        pid: p.pid,
        name: getFriendlyAppName(p.name) || p.name.replace(/\.exe$/i, ''),
        executableName: p.name,
        windowTitle: matchedWin?.title || '',
        isForeground: Boolean(matchedWin?.isForeground),
      });
    }

    userProcs.sort((a, b) => a.name.localeCompare(b.name));
    return userProcs;
  }
}

module.exports = {
  FocusGuardLimiter,
  queryRunningProcesses,
  terminateProcessPid,
  normalizeExeName,
};
