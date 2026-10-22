#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
let isDistractingExecutable = () => false;
try {
  const db = require('./distractingAppsDatabase.cjs');
  if (typeof db.isDistractingExecutable === 'function') {
    isDistractingExecutable = db.isDistractingExecutable;
  }
} catch {}

function norm(p) {
  if (!p) return '';
  return String(p)
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = true;
      }
    }
  }
  return parsed;
}

function emit(type, payload = {}) {
  try {
    process.stdout.write(`${JSON.stringify({ type, timestamp: new Date().toISOString(), ...payload })}\n`);
  } catch {}
}

const args = parseArgs(process.argv.slice(2));

const CONFIG_PATH = args.config;
const RUNTIME_PATH = args.runtime;
const PARENT_PID = Number(args.parentPid || 0);
const PARENT_EXE_PATH = norm(args.parentExePath || '');
const APP_DIR = norm(args.appDir || (process.execPath ? path.dirname(process.execPath) : ''));
const USER_DATA_DIR = norm(args.userData || '');
const SESSION_ID = String(args.sessionId || '');
const POLL_MS = 2200;
const HEARTBEAT_MS = 1500;
const PARENT_TIMEOUT_MS = 60000;
const MAX_SWEEP_FAILURES = 4;

const ALLOWLIST_MODE = true;

let stopping = false;
let sweepBusy = false;
let sweepFailures = 0;
let lastSweepAt = 0;
let lastSweepMatched = 0;
let lastTerminated = [];
let config = null;
let scanTimer = null;
let heartbeatTimer = null;
let parentCheckTimer = null;

const PROTECTED_NAMES = new Set([
  'system','idle','registry','smss.exe','csrss.exe','wininit.exe','winlogon.exe','services.exe','lsass.exe',
  'svchost.exe','dwm.exe','explorer.exe','sihost.exe','ctfmon.exe','fontdrvhost.exe','runtimebroker.exe',
  'searchhost.exe','searchapp.exe','startmenuexperiencehost.exe','shellexperiencehost.exe','applicationframehost.exe',
  'textinputhost.exe','securityhealthsystray.exe','securityhealthservice.exe','smartscreen.exe','taskhostw.exe',
  'backgroundtaskhost.exe','dllhost.exe','spoolsv.exe','audiodg.exe','conhost.exe','openconsole.exe',
  'windowsterminal.exe','msmpeng.exe','mpdefendercoreservice.exe','nissrv.exe','lsaiso.exe','wudfhost.exe',
  // Shells, Runtimes & Dev Infrastructure (CRITICAL: Never kill process enumeration dependencies or dev server)
  'powershell.exe','pwsh.exe','cmd.exe','node.exe','git.exe','bash.exe','zsh.exe','wsl.exe','wslhost.exe','wt.exe','python.exe','python3.exe','py.exe','npm.exe','pnpm.exe','yarn.exe','bun.exe','deno.exe','electron.exe','lifeos.exe','brihaspati.exe','activewindowhelper.exe',
  // Essential Windows Productivity & Utility Tools (Word, Calculator, Snipping Tool, Notepad, Paint, Office)
  'winword.exe','excel.exe','powerpnt.exe','onenote.exe','onenotem.exe','outlook.exe','soffice.exe','soffice.bin',
  'calc.exe','calculator.exe','calculatorapp.exe',
  'snippingtool.exe','screenclippinghost.exe','screensketch.exe','snipandsketch.exe',
  'notepad.exe','notepad++.exe','mspaint.exe','wordpad.exe','write.exe','taskmgr.exe',
  // AI Agents & Coding Assistants (CRITICAL: Never block or kill Antigravity, Gemini, Cursor, Claude, Ollama, etc.)
  'antigravity.exe','gemini.exe','cursor.exe','claude.exe','ollama.exe','copilot.exe','lmstudio.exe','jan.exe','continue.exe','chatgpt.exe','codex.exe','codex-computer-use-swift.exe','openai.exe',
  // Code Editors & IDEs
  'code.exe','code - insiders.exe','vscodium.exe','idea64.exe','pycharm64.exe','webstorm64.exe','rider64.exe','clion64.exe','datagrip64.exe','goland.exe','sublime_text.exe','zed.exe','neovide.exe',
  // Web Browsers (CRITICAL: All browsers allowed by default for study access)
  'zen.exe','chrome.exe','msedge.exe','firefox.exe','brave.exe','opera.exe','vivaldi.exe','arc.exe','waterfox.exe','tor.exe','librewolf.exe','chromium.exe',
  // User Desktop Dock & Communication Essentials (CRITICAL: Never block Discord or MyDockFinder)
  'discord.exe','discordptb.exe','discordcanary.exe','mydockfinder.exe','mydockfinder64.exe','dock_64.exe','dock_32.exe','mydock.exe','dock.exe'
]);

function isWisprFlow(info) {
  const p = norm(info?.path);
  const n = String(info?.name || '').toLowerCase();
  if (/\b(wispr|wisprflow|wispr_flow|flow)\.exe$/i.test(n)) return true;
  if (p && /\b(wispr|wisprflow|wispr-flow)\b/i.test(p)) return true;
  return false;
}

function computeProtectedPids(rows) {
  const set = new Set([process.pid]);
  if (PARENT_PID) set.add(PARENT_PID);

  // Add all descendant PIDs of process.pid and PARENT_PID
  const queue = [process.pid];
  if (PARENT_PID) queue.push(PARENT_PID);

  while (queue.length > 0) {
    const curr = queue.shift();
    for (const row of rows) {
      const parent = Number(row.parentPid || 0);
      if (parent === curr && !set.has(row.pid)) {
        set.add(row.pid);
        queue.push(row.pid);
      }
    }
  }

  // Also protect any process running inside app folder or userData folder or matching app names
  for (const row of rows) {
    const p = norm(row.path);
    const n = String(row.name || '').toLowerCase();
    if ((p && APP_DIR && (p === APP_DIR || p.startsWith(APP_DIR + '/'))) ||
        (p && USER_DATA_DIR && (p === USER_DATA_DIR || p.startsWith(USER_DATA_DIR + '/'))) ||
        (n && /\b(brihaspati|neo coach|lifeos|electron|node|activewindowhelper)\b/i.test(n))) {
      set.add(row.pid);
    }
  }

  return set;
}

function isProtected(info, protectedSet = null) {
  const pid = Number(info?.pid || 0);
  if (!pid || pid <= 100) return true;
  if (pid === process.pid || (PARENT_PID && pid === PARENT_PID)) return true;
  if (protectedSet && protectedSet.has(pid)) return true;

  const p = norm(info?.path);
  const n = String(info?.name || '').toLowerCase();

  // Essential Windows Tools (Word, Calculator, Snip & Sketch, Notepad, etc.) must NEVER be killed
  if (/\b(winword|excel|powerpnt|onenote|onenotem|outlook|soffice|calc|calculator|calculatorapp|snippingtool|screenclippinghost|screensketch|snipandsketch|notepad|notepad\+\+|mspaint|wordpad|write|taskmgr)\.exe$/i.test(n)) return true;

  // UWP apps (Calculator, Snipping Tool, etc.) run with these process names on modern Windows
  if (/\b(microsoft\.windowscalculator|microsoft\.screensketch|microsoft\.windows\.photos|microsoft\.paint|microsoft\.windowsalarms|microsoft\.windows\.notepad|microsoft\.windowsterminal|microsoft\.windowscamera|microsoft\.getstarted|microsoft\.windowssoundrecorder|microsoft\.windowsfeedbackhub|microsoft\.windowsstore|microsoft\.windbg|microsoft\.todos|microsoft\.people|microsoft\.windowsmaps|microsoft\.bingweather|microsoft\.windowscommunicationsapps|microsoft\.mspaint|microsoft\.screensketch)\b/i.test(n)) return true;
  if (/\b(microsoft\.windowscalculator|microsoft\.screensketch|microsoft\.paint|microsoft\.windows\.notepad)\b/i.test(p)) return true;

  // Discord communication & voice helpers must NEVER be killed
  if (/\b(discord|discordptb|discordcanary)\.exe$/i.test(n) || (p && /\bdiscord\b/i.test(p))) return true;

  // WhatsApp must NEVER be protected under any rule
  if (/\b(whatsapp|whatsapp\.root|whatsappdesktop|whatsapphost)\.exe$/i.test(n) || (p && /\bwhatsapp\b/i.test(p))) return false;

  if (isWisprFlow(info)) return true;
  if (PROTECTED_NAMES.has(n)) return true;

  // Brihaspati & LifeOS core processes
  if (/\b(brihaspati|brihaspati\.exe|neo coach|neo coach\.exe|lifeos|lifeos\.exe|electron|electron\.exe|node|node\.exe|activewindowhelper|activewindowhelper\.exe)\b/i.test(n)) return true;

  // Kernel & Special system processes
  if (/\b(registry|memory compression|secure system|idle|system|msedgewebview2\.exe|aggregatorhost\.exe|backgroundtransferhost\.exe)\b/i.test(n)) return true;

  // Essential hardware & infrastructure drivers & AI agents & dev tool & browser path protection
  if (p) {
    if (/\b(nvidia|intel|realtek|lenovo|amd|dts|dolby|synaptics|driverstore|windows defender|programdata\/microsoft|\.gemini|antigravity|cursor|vscode|jetbrains|ollama|claude|lifeos|brihaspati|zen browser|zen-browser|mydockfinder|mydock|openai|chatgpt|codex)\b/i.test(p)) return true;
    if (PARENT_EXE_PATH && p === PARENT_EXE_PATH) return true;
    if (APP_DIR && (p === APP_DIR || p.startsWith(APP_DIR + '/'))) return true;
    if (USER_DATA_DIR && (p === USER_DATA_DIR || p.startsWith(USER_DATA_DIR + '/'))) return true;
  }
  if (/\b(nvsphelper64|defendersessionhelper|antigravity|gemini|cursor|code|node|powershell|pwsh|cmd|git|claude|ollama|collector_service|dsaupdateservice|dtsapo|esrv|ipf_helper|ipf_uf|jhi_service|presentmonservice|nvdisplay|msedgewebview2|zen|chrome|msedge|firefox|brave|opera|vivaldi|arc|mydockfinder|mydockfinder64|dock_64|dock_32|mydock|dock|chatgpt|codex|openai|brihaspati)\b/i.test(n)) return true;

  const win = norm(String(process.env.WINDIR || 'C:\\Windows'));
  const protectedRoots = [
    win,
    `${win}/system32`,
    `${win}/syswow64`,
    `${win}/systemapps`,
    `${win}/winsxs`,
    'c:/program files/common files',
    'c:/program files (x86)/common files',
    'c:/program files/windowsapps'
  ];
  if (p && protectedRoots.some(root => root && (p === root || p.startsWith(`${root}/`)))) return true;
  return false;
}

function ruleName(rule) {
  const explicit = String(rule?.executableName || '').trim().toLowerCase();
  if (explicit) return explicit.endsWith('.exe') ? explicit : `${explicit}.exe`;
  const p = norm(rule?.path || rule?.executablePath);
  if (p) return path.basename(p);
  const display = String(rule?.name || '').trim().toLowerCase();
  return display.endsWith('.exe') ? display : (display ? `${display}.exe` : '');
}

function matchesRoot(info, rule) {
  const p = norm(info?.path || info?.executablePath);
  const n = String(info?.name || '').toLowerCase().endsWith('.exe') ? String(info.name).toLowerCase() : `${String(info?.name || '').toLowerCase()}.exe`;
  const wanted = ruleName(rule);
  const rulePath = norm(rule?.path || rule?.executablePath);
  if (rulePath && p && p === rulePath) return true;
  if (wanted && n === wanted) return true;
  return false;
}

function matches(info, rule) {
  const p = norm(info?.path || info?.executablePath);
  if (matchesRoot(info, rule)) return true;
  const scope = norm(rule?.dirScope);
  return Boolean(scope && p && (p === scope || p.startsWith(`${scope}/`)));
}

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

function matchesLimitEntry(rowOrInfo, key, limitInfo) {
  const n = String(rowOrInfo?.name || '').toLowerCase();
  const cleanProc = n.replace(/\.exe$/i, '');
  const cleanKey = String(key || '').toLowerCase().replace(/\.exe$/i, '');
  const cleanName = String(limitInfo?.name || '').toLowerCase().replace(/\.exe$/i, '');

  const candidates = new Set([cleanKey]);
  if (cleanName) candidates.add(cleanName);

  for (const name of Array.from(candidates)) {
    for (const [canonical, aliases] of Object.entries(PROCESS_ALIAS_MAP)) {
      if (name === canonical || aliases.includes(name)) {
        aliases.forEach(a => candidates.add(a));
      }
    }
  }

  if (candidates.has(cleanProc) || candidates.has(n)) {
    return true;
  }
  for (const cand of candidates) {
    if (!cand) continue;
    if (cleanProc.startsWith(cand + '.') || cleanProc.startsWith(cand + '-') || cleanProc.startsWith(cand + '_') ||
        cand.startsWith(cleanProc + '.') || cand.startsWith(cleanProc + '-') || cand.startsWith(cleanProc + '_')) {
      return true;
    }
  }
  return false;
}

function hasActiveAllowance(info) {
  const limits = (config && typeof config.appTimeLimits === 'object' && config.appTimeLimits !== null) ? config.appTimeLimits : {};

  for (const [key, limitInfo] of Object.entries(limits)) {
    if (!limitInfo || limitInfo.enabled === false || (!limitInfo.limitMinutes && !limitInfo.limitSeconds)) continue;

    if (matchesLimitEntry(info, key, limitInfo)) {
      // Expiry check: if expiryTime passed, allowance is void!
      if (limitInfo.expiryTime) {
        const expMs = new Date(limitInfo.expiryTime).getTime();
        if (Number.isFinite(expMs) && expMs <= Date.now()) {
          return false;
        }
      }

      // Active usage check: if accumulated used seconds >= max allowed seconds, limit is reached!
      const maxSeconds = Number(limitInfo.limitSeconds || Math.round(Number(limitInfo.limitMinutes || 30) * 60));
      const usedSeconds = Number(limitInfo.usedSeconds ?? limitInfo.usedSecondsToday ?? 0);
      if (usedSeconds >= maxSeconds) {
        return false;
      }

      // Has active allowance remaining and not expired
      return true;
    }
  }

  return false;
}

function allowed(info) {
  const list = Array.isArray(config?.allowedApps) ? config.allowedApps : [];
  return list.some(rule => rule?.enabled !== false && matches(info, rule));
}

function blocked(info, protectedSet = null) {
  if (isProtected(info, protectedSet) || allowed(info)) return false;

  // ReGain-style allowance: if app has active unexpired allowance remaining, allow it
  if (hasActiveAllowance(info)) return false;

  // If this process has a time limit configured in Focus Guard, and has reached its limit or expired:
  const limits = (config && typeof config.appTimeLimits === 'object' && config.appTimeLimits !== null) ? config.appTimeLimits : {};
  for (const [key, limitInfo] of Object.entries(limits)) {
    if (!limitInfo || limitInfo.enabled === false) continue;
    if (matchesLimitEntry(info, key, limitInfo)) {
      return true; // limit reached or allowance expired!
    }
  }

  const list = Array.isArray(config?.blockedApps) ? config.blockedApps : [];
  if (list.some(rule => rule?.enabled !== false && matches(info, rule))) return true;

  const n = String(info?.name || '').toLowerCase();
  const p = norm(info?.path);
  if (isDistractingExecutable(n) || (p && isDistractingExecutable(p))) return true;
  if (/\b(whatsapp|whatsapp\.root|whatsappdesktop|whatsapphost)\.exe$/i.test(n) || (p && /\bwhatsapp\b/i.test(p))) return true;
  return Boolean(config?.allowlistApps === true || config?.blockAllApps === true);
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeout || 10000;
    
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Hard timeout: ${file} took longer than ${timeoutMs}ms`));
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs + 1000); // 1s grace period after soft timeout

    const child = execFile(file, args, { encoding: 'utf8', windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        const message = String(stderr || stdout || error.message || error).trim();
        reject(Object.assign(new Error(message || `${file} failed`), { code: error.code }));
      } else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function queryProcesses() {
  const ps = `$ErrorActionPreference='SilentlyContinue';` +
    `$rows=@(Get-Process -ErrorAction SilentlyContinue | ` +
    `Select-Object Id, ParentId, ProcessName, Path | ` +
    `ForEach-Object {[pscustomobject]@{pid=[int]$_.Id;parentPid=[int]$_.ParentId;name=([string]$_.ProcessName + '.exe');path=[string]$_.Path}});` +
    `@($rows)|ConvertTo-Json -Compress`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { timeout: 6000, maxBuffer: 4 * 1024 * 1024 });
    const raw = String(stdout || '').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      return (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
        pid: Number(row?.pid || 0), parentPid: Number(row?.parentPid || 0), name: String(row?.name || '').toLowerCase(), path: String(row?.path || '')
      })).filter(row => row.pid > 0);
    }
  } catch {}

  // High-performance fallback via tasklist.exe if PowerShell is slow or fails
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 3500, maxBuffer: 2 * 1024 * 1024 });
    const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const parts = line.split('","').map(s => s.replace(/^"|"$/g, ''));
      if (parts.length >= 2) {
        const name = parts[0].toLowerCase();
        const pid = parseInt(parts[1], 10);
        if (pid > 0) rows.push({ pid, parentPid: 0, name, path: '' });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function processExists(pid) {
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], { timeout: 1800, maxBuffer: 128 * 1024 });
    const text = String(stdout || '').trim();
    return Boolean(text && !/^INFO:/i.test(text));
  } catch { return false; }
}

async function terminatePid(info, protectedSet = null) {
  const pid = Number(info?.pid || 0);
  if (!pid || isProtected(info, protectedSet) || allowed(info)) return { ok: false, protected: isProtected(info, protectedSet), allowed: allowed(info) };
  try {
    await execFileAsync('taskkill.exe', ['/PID', String(pid), '/F'], { timeout: 3000, maxBuffer: 128 * 1024 });
    emit('TERMINATED', { pid, name: info.name, path: info.path });
    return { ok: true };
  } catch (err) {
    emit('TERMINATE_FAILED', { pid, name: info.name, path: info.path, error: err?.message });
    return { ok: false, reason: 'taskkill-failed' };
  }
}

function descendantsOf(rootPid, rows) {
  const byParent = new Map();
  for (const row of rows) {
    const parent = Number(row.parentPid || 0);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(row);
  }
  const out = [];
  const queue = [...(byParent.get(Number(rootPid)) || [])];
  const seen = new Set([Number(rootPid)]);
  while (queue.length) {
    const row = queue.shift();
    if (!row || seen.has(row.pid)) continue;
    seen.add(row.pid); out.push(row);
    queue.push(...(byParent.get(row.pid) || []));
  }
  return out;
}

async function enforceSweep() {
  if (stopping || sweepBusy) return;
  try {
    config = readConfig();
  } catch {}
  if (!config || config.blockApps === false) {
    lastSweepAt = Date.now(); lastSweepMatched = 0; return;
  }
  sweepBusy = true;
  try {
    const rows = await queryProcesses();
    const protectedSet = computeProtectedPids(rows);
    sweepFailures = 0;
    const matches = rows.filter(r => blocked(r, protectedSet));
    lastSweepMatched = matches.length;
    const terminated = [];

    emit('SWEEP', { processes: rows.length, matches: matches.length });

    const targetsToKill = new Map();

    // App Time Limits tracking & enforcement (ReGain style)
    const appTimeLimits = (config && typeof config.appTimeLimits === 'object' && config.appTimeLimits !== null) ? config.appTimeLimits : {};

    // For each running exe that has a time limit set and has reached/exceeded it or expired, mark for termination & notify
    for (const [exeName, limitInfo] of Object.entries(appTimeLimits)) {
      if (!limitInfo || limitInfo.enabled === false || (!limitInfo.limitMinutes && !limitInfo.limitSeconds)) continue;
      const normExe = String(exeName || '').toLowerCase().endsWith('.exe') ? String(exeName).toLowerCase() : `${String(exeName).toLowerCase()}.exe`;
      const maxSeconds = Number(limitInfo.limitSeconds || Math.round(Number(limitInfo.limitMinutes || 30) * 60));
      const usedSeconds = Number(limitInfo.usedSeconds ?? limitInfo.usedSecondsToday ?? 0);
      let isExpired = false;
      if (limitInfo.expiryTime) {
        const expMs = new Date(limitInfo.expiryTime).getTime();
        if (Number.isFinite(expMs) && expMs <= Date.now()) isExpired = true;
      }

      if (usedSeconds >= maxSeconds || isExpired) {
        // App limit reached or expired! Find matching running processes to kill
        for (const row of rows) {
          if (stopping) break;
          if (matchesLimitEntry(row, exeName, limitInfo)) {
            if (!isProtected(row, protectedSet)) {
              targetsToKill.set(row.pid, row);
              emit('TIME_LIMIT_EXCEEDED', {
                pid: row.pid,
                name: row.name,
                path: row.path,
                exeName: normExe,
                limitMinutes: limitInfo.limitMinutes,
                usedSeconds,
                reason: isExpired ? 'expired' : 'limit_reached'
              });
            }
          }
        }
      }
    }

    for (const root of matches) {
      if (stopping) break;
      if (isProtected(root, protectedSet)) {
        emit('PROTECTED', { pid: root.pid, name: root.name, path: root.path, reason: 'protected-process' });
        continue;
      }
      if (allowed(root)) {
        emit('ALLOW', { pid: root.pid, name: root.name, path: root.path });
        continue;
      }

      emit('BLOCK', { pid: root.pid, name: root.name, path: root.path, reason: config?.allowlistApps === true ? 'not-in-essential-app-allowlist' : 'explicitly-configured' });
      targetsToKill.set(root.pid, root);

      const rootDir = root.path ? norm(path.dirname(root.path)) : '';
      const descendants = descendantsOf(root.pid, rows)
        .filter(child => child.path)
        .filter(child => !isProtected(child, protectedSet))
        .filter(child => !allowed(child))
        .filter(child => {
          if (blocked(child, protectedSet)) return true;
          const childDir = norm(path.dirname(child.path));
          return Boolean(rootDir && childDir === rootDir);
        });

      for (const child of descendants) {
        targetsToKill.set(child.pid, child);
      }
    }

    if (targetsToKill.size > 0 && !stopping) {
      const results = await Promise.allSettled(Array.from(targetsToKill.values()).map(item => terminatePid(item, protectedSet)));
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const item = Array.from(targetsToKill.values())[i];
        if (res.status === 'fulfilled' && res.value?.ok) {
          terminated.push(item);
        }
      }
    }

    lastSweepAt = Date.now();
    lastTerminated = terminated.slice(-30).map(x => ({ pid: x.pid, name: x.name, path: x.path, at: new Date().toISOString() }));
    emit('HEARTBEAT', { state: 'ACTIVE', lastSweepAt, matches: lastSweepMatched, terminatedCount: terminated.length });
  } catch (error) {
    sweepFailures += 1;
    emit('SWEEP_ERROR', { failures: sweepFailures, error: error?.message || String(error) });
    if (sweepFailures >= 15) {
      emit('SWEEP_RESERVE_RESET', { message: 'High sweep failures encountered, resetting failure streak and retrying' });
      sweepFailures = 0;
    }
  } finally {
    sweepBusy = false;
  }
}

function depthOf(pid, rootPid, rows) {
  let depth = 0; let current = Number(pid); const seen = new Set(); const byPid = new Map(rows.map(row => [row.pid, row]));
  while (current && current !== rootPid && !seen.has(current)) {
    seen.add(current); const row = byPid.get(current); if (!row) break; current = Number(row.parentPid || 0); depth += 1;
  }
  return depth;
}

function readConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...value,
      blockedApps: Array.isArray(value?.blockedApps) ? value.blockedApps : [],
      allowedApps: Array.isArray(value?.allowedApps) ? value.allowedApps : [],
      blockApps: value?.blockApps !== false,
      allowlistApps: value?.allowlistApps === true || value?.blockAllApps === true,
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { blockedApps: [], allowedApps: [], blockApps: true, allowlistApps: false };
    }
    throw new Error(`Cannot read Focus Guard policy: ${error.message}`);
  }
}

function parentHeartbeatFresh() {
  try {
    const value = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
    if (PARENT_PID && Number(value?.parentPid || 0) !== PARENT_PID) return false;
    if (SESSION_ID && String(value?.sessionId || '') !== SESSION_ID) return false;
    const ts = Date.parse(value?.lastHeartbeat || '');
    return Number.isFinite(ts) && Date.now() - ts < PARENT_TIMEOUT_MS;
  } catch { return false; }
}

function restoreHostsEmergency() {
  if (process.platform !== 'win32') return;
  try {
    // 1. Disable System Proxy to restore web connectivity instantly
    try {
      execFile('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'], { windowsHide: true }, () => {});
    } catch {}

    // 2. Restore Hosts file
    const backupFile = args.userData ? path.join(args.userData, 'focus-guard-hosts-backup.txt') : (RUNTIME_PATH ? path.join(path.dirname(RUNTIME_PATH), 'focus-guard-hosts-backup.txt') : null);
    const hostsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\drivers\\etc\\hosts');
    if (backupFile && fs.existsSync(backupFile) && fs.existsSync(hostsPath)) {
      const backupContent = fs.readFileSync(backupFile, 'utf8');
      try { fs.chmodSync(hostsPath, 0o666); } catch {}
      fs.writeFileSync(hostsPath, backupContent, 'utf8');
      try { fs.unlinkSync(backupFile); } catch {}
    } else if (fs.existsSync(hostsPath)) {
      const current = fs.readFileSync(hostsPath, 'utf8');
      if (current.includes('# === LifeOS FocusGuard Blocklist ===')) {
        const clean = current.split('# === LifeOS FocusGuard Blocklist ===')[0].trimEnd() + '\r\n';
        try { fs.chmodSync(hostsPath, 0o666); } catch {}
        fs.writeFileSync(hostsPath, clean, 'utf8');
      }
    }

    // 3. Clear any leftover FocusGuard firewall rules
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "Get-NetFirewallRule -DisplayName 'LifeOS-FocusGuard*' | Remove-NetFirewallRule -ErrorAction SilentlyContinue"], { windowsHide: true }, () => {});
    } catch {}
  } catch {}
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(scanTimer); clearInterval(heartbeatTimer); clearInterval(parentCheckTimer);
  emit('STOPPED', { code, lastSweepAt, matches: lastSweepMatched, lastTerminated });
  setTimeout(() => process.exit(code), 30);
}

function start() {
  config = readConfig();
  emit('STARTING', { pid: process.pid, parentPid: PARENT_PID, configBlockedApps: config.blockedApps.length, blockApps: config.blockApps !== false });
  scanTimer = setInterval(() => { enforceSweep(); /* queryProcesses() */ }, POLL_MS);
  heartbeatTimer = setInterval(() => {
    emit('HEARTBEAT', { state: 'ACTIVE', lastSweepAt, matches: lastSweepMatched, terminatedCount: lastTerminated.length });
  }, HEARTBEAT_MS);
  parentCheckTimer = setInterval(async () => {
    if (!parentHeartbeatFresh()) {
      emit('FATAL', { reason: 'parent-heartbeat-lost' });
      restoreHostsEmergency();
      await shutdown(3);
    }
  }, 2000);
  enforceSweep().then(() => emit('READY', { pid: process.pid, lastSweepAt, matches: lastSweepMatched })).catch(error => emit('FATAL', { reason: 'initial-sweep-failed', error: error.message }));
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message?.type === 'stop') shutdown(0);
    if (message?.type === 'ping') {
      try { config = readConfig(); } catch {}
      emit('PONG', { lastSweepAt, matches: lastSweepMatched });
    }
  } catch {}
});
process.stdin.on('end', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

try {
  start();
} catch (error) {
  emit('FATAL', { reason: 'startup-failed', error: error?.message || String(error) });
  setTimeout(() => process.exit(1), 30);
}

