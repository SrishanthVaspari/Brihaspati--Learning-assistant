'use strict';

const http = require('http');
const net = require('net');
const { execFile } = require('child_process');
const { isStudyDomainAllowed, normalizeDomain } = require('./focusGuardWebPolicy.cjs');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 8899;

// Connection tracking for cleanup
const SOCKET_TIMEOUT_MS = 30000; // 30s idle timeout on forwarded sockets
const MAX_CONNECTIONS = 512;

let proxyServer = null;
let activeConnections = new Set();
let autoRestartEnabled = false;
let restartAttempts = 0;
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 1000;

const BLOCK_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Blocked by FocusGuard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 2.5rem; border-radius: 1rem; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5); text-align: center; max-width: 420px; border: 1px solid #334155; }
    h1 { color: #f43f5e; font-size: 1.75rem; margin-top: 0; }
    p { color: #94a3b8; line-height: 1.6; }
    .badge { display: inline-block; background: #3b82f6; color: white; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.875rem; font-weight: 600; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Focus Session Active</h1>
    <p>This website is blocked to help you stay focused on your study goals.</p>
    <div class="badge">LifeOS FocusGuard Protection</div>
  </div>
</body>
</html>`;

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
      if (error) reject(error);
      else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function runPowerShell(script, timeout = 8000) {
  return execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout, maxBuffer: 1024 * 1024 });
}

/**
 * Safely ends a socket without throwing.
 */
function safeDestroySocket(socket) {
  try {
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
  } catch {}
}

/**
 * Track an active connection for cleanup on shutdown.
 */
function trackSocket(socket) {
  if (!socket || socket.destroyed) return;
  activeConnections.add(socket);
  socket.once('close', () => activeConnections.delete(socket));
  socket.once('error', () => {
    activeConnections.delete(socket);
    safeDestroySocket(socket);
  });
}

/**
 * Starts the FocusGuard universal local HTTP/HTTPS filtering proxy server.
 * Now with comprehensive error handling, auto-restart, and connection management.
 */
function startFocusProxy(port = PROXY_PORT) {
  return new Promise((resolve, reject) => {
    if (proxyServer) return resolve({ port: PROXY_PORT });

    autoRestartEnabled = true;
    restartAttempts = 0;

    _createProxyServer(port, resolve, reject);
  });
}

function _createProxyServer(port, resolve, reject) {
  const server = http.createServer((req, res) => {
    try {
      const hostHeader = req.headers.host || '';
      const domain = normalizeDomain(hostHeader);

      if (!isStudyDomainAllowed(domain)) {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(BLOCK_PAGE_HTML);
        return;
      }

      // Forward allowed HTTP request
      const hostParts = (req.headers.host || '').split(':');
      const options = {
        hostname: hostParts[0],
        port: Number(hostParts[1] || 80),
        path: req.url,
        method: req.method,
        headers: req.headers,
        timeout: SOCKET_TIMEOUT_MS
      };

      const proxyReq = http.request(options, (proxyRes) => {
        try {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res, { end: true });
        } catch {
          safeDestroySocket(req.socket);
        }
      });

      proxyReq.on('error', () => {
        try {
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        } catch {}
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        try {
          if (!res.headersSent) {
            res.writeHead(504);
            res.end('Gateway Timeout');
          }
        } catch {}
      });

      req.on('error', () => { proxyReq.destroy(); });
      req.pipe(proxyReq, { end: true });
    } catch (err) {
      console.error('[FocusProxy] HTTP request handler error:', err.message);
      try {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Proxy Error');
        }
      } catch {}
    }
  });

  // Handle HTTPS CONNECT requests (universal across Brave, Zen, Edge, Chrome, Firefox, etc.)
  server.on('connect', (req, clientSocket, head) => {
    try {
      const parts = req.url.split(':');
      const rawHost = parts[0];
      const targetPort = Number(parts[1] || 443);
      const domain = normalizeDomain(rawHost);

      trackSocket(clientSocket);

      if (!isStudyDomainAllowed(domain)) {
        try {
          clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\n\r\n' + BLOCK_PAGE_HTML);
          clientSocket.end();
        } catch {}
        return;
      }

      // Connect to allowed HTTPS target with timeout
      const serverSocket = net.connect({ port: targetPort, host: rawHost, timeout: SOCKET_TIMEOUT_MS }, () => {
        try {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          serverSocket.write(head);
          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
        } catch {
          safeDestroySocket(clientSocket);
          safeDestroySocket(serverSocket);
        }
      });

      trackSocket(serverSocket);

      // Set idle timeouts to prevent connection leaks
      serverSocket.setTimeout(SOCKET_TIMEOUT_MS, () => {
        safeDestroySocket(serverSocket);
        safeDestroySocket(clientSocket);
      });
      clientSocket.setTimeout(SOCKET_TIMEOUT_MS, () => {
        safeDestroySocket(clientSocket);
        safeDestroySocket(serverSocket);
      });

      serverSocket.on('error', () => {
        try {
          if (clientSocket && !clientSocket.destroyed) {
            clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
            clientSocket.end();
          }
        } catch {
          safeDestroySocket(clientSocket);
        }
      });

      clientSocket.on('error', () => {
        safeDestroySocket(serverSocket);
      });
    } catch (err) {
      console.error('[FocusProxy] CONNECT handler error:', err.message);
      safeDestroySocket(clientSocket);
    }
  });

  // Handle top-level server connection tracking
  server.on('connection', (socket) => {
    trackSocket(socket);
    // Enforce connection limit
    if (activeConnections.size > MAX_CONNECTIONS) {
      const oldest = activeConnections.values().next().value;
      if (oldest) safeDestroySocket(oldest);
    }
  });

  // Critical: handle server-level errors without crashing
  server.on('error', (err) => {
    console.error('[FocusProxy] Proxy server error:', err.message);
    if (err.code === 'EADDRINUSE') {
      // Port is in use — don't auto-restart, it would fail again
      if (reject) reject(err);
      return;
    }
    // For other errors, attempt auto-restart
    _attemptAutoRestart(port);
  });

  // Handle unexpected server close — auto-restart to prevent network blackout
  server.on('close', () => {
    console.warn('[FocusProxy] Proxy server closed unexpectedly');
    proxyServer = null;
    _attemptAutoRestart(port);
  });

  // Handle client errors (malformed requests, etc.) without crashing
  server.on('clientError', (err, socket) => {
    try {
      if (socket && !socket.destroyed) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      }
    } catch {}
  });

  server.listen(port, PROXY_HOST, () => {
    proxyServer = server;
    restartAttempts = 0;
    console.log(`[FocusProxy] Universal filtering proxy running on http://${PROXY_HOST}:${port}`);
    if (resolve) resolve({ port });
  });
}

function _attemptAutoRestart(port) {
  if (!autoRestartEnabled) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(`[FocusProxy] Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached. Disabling system proxy to prevent network blackout.`);
    // CRITICAL SAFETY: If proxy can't restart, disable the system proxy
    // so the user's network isn't blocked by pointing at a dead proxy
    disableSystemProxy().catch(() => {});
    return;
  }
  restartAttempts++;
  console.log(`[FocusProxy] Auto-restart attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS} in ${RESTART_DELAY_MS}ms...`);
  setTimeout(() => {
    if (!autoRestartEnabled) return;
    _createProxyServer(port, null, null);
  }, RESTART_DELAY_MS * restartAttempts);
}

/**
 * Check if the proxy server is currently running and healthy.
 */
function isProxyAlive() {
  return Boolean(proxyServer && proxyServer.listening);
}

function stopFocusProxy() {
  autoRestartEnabled = false;
  return new Promise((resolve) => {
    if (!proxyServer) return resolve();

    // Destroy all active connections first
    for (const socket of activeConnections) {
      safeDestroySocket(socket);
    }
    activeConnections.clear();

    proxyServer.close(() => {
      proxyServer = null;
      console.log('[FocusProxy] Proxy server stopped.');
      resolve();
    });

    // Force-close after 3 seconds if graceful close hangs
    setTimeout(() => {
      if (proxyServer) {
        try { proxyServer.closeAllConnections?.(); } catch {}
        proxyServer = null;
      }
      resolve();
    }, 3000);
  });
}

/**
 * Configures Windows WinINet System Proxy to point to 127.0.0.1:8899.
 * Universal setting across Brave, Zen, Chrome, Edge, Firefox, DuckDuckGo, Opera, Vivaldi.
 */
async function enableSystemProxy(port = PROXY_PORT) {
  if (process.platform !== 'win32') return { ok: true };
  const psScript = `
    $reg = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    Set-ItemProperty -Path $reg -Name ProxyEnable -Value 1 -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $reg -Name ProxyServer -Value '127.0.0.1:${port}' -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $reg -Name ProxyOverride -Value 'localhost;127.0.0.1;<local>' -ErrorAction SilentlyContinue

    # Update all logged-in user profiles under HKEY_USERS
    Get-ChildItem Registry::HKEY_USERS -ErrorAction SilentlyContinue | ForEach-Object {
      $userKey = "$($_.Name)\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
      if (Test-Path "Registry::$userKey") {
        Set-ItemProperty -Path "Registry::$userKey" -Name ProxyEnable -Type DWord -Value 1 -ErrorAction SilentlyContinue
        Set-ItemProperty -Path "Registry::$userKey" -Name ProxyServer -Type String -Value '127.0.0.1:${port}' -ErrorAction SilentlyContinue
        Set-ItemProperty -Path "Registry::$userKey" -Name ProxyOverride -Type String -Value 'localhost;127.0.0.1;<local>' -ErrorAction SilentlyContinue
      }
    }

    # Disable DNS-over-HTTPS (DoH) in Google Chrome, MS Edge, and Brave via registry policies so incognito cannot bypass local proxy/hosts
    $policies = @(
      'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome',
      'HKCU:\\SOFTWARE\\Policies\\Google\\Chrome',
      'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge',
      'HKCU:\\SOFTWARE\\Policies\\Microsoft\\Edge',
      'HKLM:\\SOFTWARE\\Policies\\BraveSoftware\\Brave',
      'HKCU:\\SOFTWARE\\Policies\\BraveSoftware\\Brave'
    )
    foreach ($pol in $policies) {
      if (-not (Test-Path $pol)) { New-Item -Path $pol -Force -ErrorAction SilentlyContinue | Out-Null }
      Set-ItemProperty -Path $pol -Name DnsOverHttpsMode -Type String -Value 'off' -ErrorAction SilentlyContinue
    }

    # Notify WinINet of proxy changes
    try {
      Add-Type -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(int h, int o, int b, int l);' -Name 'WinInet' -Namespace 'Win32' -PassThru -ErrorAction SilentlyContinue | Out-Null
      [Win32.WinInet]::InternetSetOption(0, 39, 0, 0) | Out-Null
      [Win32.WinInet]::InternetSetOption(0, 37, 0, 0) | Out-Null
    } catch {}
  `;
  try {
    await runPowerShell(psScript);
    console.log('[FocusProxy] Enabled Windows System Proxy & enforced Incognito DoH policy.');
    return { ok: true };
  } catch (err) {
    console.warn('[FocusProxy] Failed to enable system proxy:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Disables Windows WinINet System Proxy and restores normal direct network state.
 */
async function disableSystemProxy() {
  if (process.platform !== 'win32') return { ok: true };
  const psScript = `
    # Reset HKCU
    $reg = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    Set-ItemProperty -Path $reg -Name ProxyEnable -Value 0 -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $reg -Name ProxyServer -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $reg -Name ProxyOverride -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $reg -Name AutoConfigURL -ErrorAction SilentlyContinue

    # Reset all logged in users under HKEY_USERS
    Get-ChildItem Registry::HKEY_USERS -ErrorAction SilentlyContinue | ForEach-Object {
      $userKey = "$($_.Name)\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"
      if (Test-Path "Registry::$userKey") {
        Set-ItemProperty -Path "Registry::$userKey" -Name ProxyEnable -Type DWord -Value 0 -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path "Registry::$userKey" -Name ProxyServer -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path "Registry::$userKey" -Name ProxyOverride -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path "Registry::$userKey" -Name AutoConfigURL -ErrorAction SilentlyContinue
      }
    }

    # Notify WinINet of changes and flush DNS
    try {
      Add-Type -MemberDefinition '[DllImport("wininet.dll")] public static extern bool InternetSetOption(int h, int o, int b, int l);' -Name 'WinInet' -Namespace 'Win32' -PassThru -ErrorAction SilentlyContinue | Out-Null
      [Win32.WinInet]::InternetSetOption(0, 39, 0, 0) | Out-Null
      [Win32.WinInet]::InternetSetOption(0, 37, 0, 0) | Out-Null
    } catch {}

    & netsh.exe winhttp reset proxy 2>$null | Out-Null
    & ipconfig.exe /flushdns 2>$null | Out-Null
  `;
  try {
    await runPowerShell(psScript);
    console.log('[FocusProxy] Disabled Windows System Proxy and restored direct internet.');
    return { ok: true };
  } catch (err) {
    console.warn('[FocusProxy] Failed to disable system proxy:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  PROXY_HOST,
  PROXY_PORT,
  startFocusProxy,
  stopFocusProxy,
  enableSystemProxy,
  disableSystemProxy,
  isProxyAlive
};
