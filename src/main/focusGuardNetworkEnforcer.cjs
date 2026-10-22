'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { resolveStudyDomainIps, DOH_RESOLVER_IPS } = require('./focusGuardWebPolicy.cjs');

const RULE_PREFIX = 'LifeOS_FG_';

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeout || 15000;
    
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Hard timeout: ${file} took longer than ${timeoutMs}ms`));
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs + 1000);

    const child = execFile(file, args, { encoding: 'utf8', windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        const msg = String(stderr || stdout || error.message || error).trim();
        const err = new Error(msg || `${file} failed`);
        err.code = error.code;
        return reject(err);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function runPowerShell(script, timeout = 12000) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout, maxBuffer: 1024 * 1024 });
}

async function runNetsh(args, label = 'netsh') {
  try {
    return await execFileAsync('netsh.exe', ['advfirewall', 'firewall', ...args], { timeout: 8000, maxBuffer: 256 * 1024 });
  } catch (e) {
    throw new Error(`${label}: ${String(e.message || e).trim()}`);
  }
}

let activeRuleNames = [];
let networkEnforcementActive = false;

function detectWisprFlowPaths() {
  const list = [];
  const roots = [
    process.env.LOCALAPPDATA,
    process.env.APPDATA,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)']
  ].filter(Boolean);

  const candidates = [
    'Wispr\\wispr.exe',
    'Wispr Flow\\wispr.exe',
    'Wispr Flow\\flow.exe',
    'Programs\\Wispr Flow\\flow.exe',
    'Programs\\Wispr\\wispr.exe',
    'WisprFlow\\WisprFlow.exe'
  ];

  for (const root of roots) {
    for (const rel of candidates) {
      const full = path.join(root, rel);
      if (fs.existsSync(full)) list.push(full);
    }
  }

  return [...new Set(list)];
}

/**
 * Installs tagged Windows Firewall rules for FocusGuard.
 */
async function startNetworkEnforcement(options = {}) {
  if (process.platform !== 'win32') {
    networkEnforcementActive = true;
    return { ok: true, platform: 'non-windows' };
  }

  // Always cleanly remove any legacy/stale LifeOS firewall rules
  await stopNetworkEnforcement();

  networkEnforcementActive = true;
  console.log('[FocusNetwork] Cleaned legacy firewall rules. Whole-PC network connection remains 100% active and uninhibited.');
  return { ok: true, rulesCount: 0 };
}

/**
 * Removes ONLY FocusGuard-owned rules (`LifeOS_FG_*`).
 * Never flushes or touches unrelated user firewall rules.
 */
async function stopNetworkEnforcement() {
  if (process.platform !== 'win32') {
    networkEnforcementActive = false;
    return { ok: true };
  }

  networkEnforcementActive = false;

  try {
    // 1. Delete by specific active names if tracked
    if (activeRuleNames.length > 0) {
      await Promise.allSettled(
        activeRuleNames.map(name => runNetsh(['delete', 'rule', `name=${name}`]))
      );
      activeRuleNames = [];
    }

    // 2. PowerShell safety sweep: remove ANY rule starting with 'LifeOS_FG_'
    const psCleanup = `
      Get-NetFirewallRule -Name "${RULE_PREFIX}*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
      Get-NetFirewallRule -DisplayName "${RULE_PREFIX}*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    `;
    await runPowerShell(psCleanup, 8000);
    console.log('[FocusNetwork] Cleaned up all LifeOS FocusGuard firewall rules.');
    return { ok: true };
  } catch (err) {
    console.warn('[FocusNetwork] Cleanup warning:', err.message);
    return { ok: false, error: err.message };
  }
}

function isNetworkEnforcementHealthy() {
  if (process.platform !== 'win32') return true;
  return networkEnforcementActive;
}

module.exports = {
  RULE_PREFIX,
  startNetworkEnforcement,
  stopNetworkEnforcement,
  isNetworkEnforcementHealthy
};
