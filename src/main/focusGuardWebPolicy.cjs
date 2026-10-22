'use strict';

const dns = require('dns').promises;
const { execFile } = require('child_process');

// ============================================================================
// HARD-CODED STUDY WEB ALLOWLIST (AUTHORITATIVE SOURCE OF TRUTH)
// ============================================================================

const STUDY_CATEGORIES = {
  TOP_STUDY_APPS: {
    name: 'Top Study & Learning Apps (Top 20+)',
    domains: [
      'khanacademy.org',
      'quizlet.com',
      'ankiweb.net',
      'brainly.com',
      'brainly.in',
      'coursera.org',
      'edx.org',
      'udemy.com',
      'byjus.com',
      'byjusweb.com',
      'pw.live',
      'physicswallah.live',
      'allen.ac.in',
      'unacademy.com',
      'vedantu.com',
      'symbolab.com',
      'desmos.com',
      'wolframalpha.com',
      'photomath.com',
      'duolingo.com',
      'sparknotes.com',
      'openstax.org',
      'instructure.com',
      'canvaslms.com',
      'blackboard.com',
      'socratic.org',
      'chegg.com',
      'self-study.com',
      'selfstudy.com',
      'selfstudys.com',
      'self-studysarthak.com',
      'selfstudysarthak.com',
      'sarthaks.com',
      'quizizz.com',
      'kahoot.it',
      'kahoot.com',
      'goconqr.com',
      'studystack.com',
      'cram.com',
      'studysmarter.de',
      'vaia.com'
    ]
  },
  TOP_AI_TOOLS: {
    name: 'Top AI Learning Assistants (Top 20+)',
    domains: [
      'chatgpt.com',
      'openai.com',
      'oaistatic.com',
      'oaiusercontent.com',
      'claude.ai',
      'anthropic.com',
      'claudeusercontent.com',
      'auth0.com',
      'gemini.google.com',
      'aistudio.google.com',
      'generativelanguage.googleapis.com',
      'notebooklm.google.com',
      'perplexity.ai',
      'pplx.ai',
      'perplexity-cdn.com',
      'copilot.microsoft.com',
      'deepseek.com',
      'huggingface.co',
      'poe.com',
      'mistral.ai',
      'grok.com',
      'x.ai',
      'groq.com',
      'phind.com',
      'you.com',
      'tavily.com',
      'kimi.moonshot.cn',
      'kimichat.com',
      'qwen.ai',
      'cohere.com',
      'elevenlabs.io',
      'consensus.app',
      'elicit.com',
      'elicit.org',
      'scite.ai',
      'typeset.io',
      'scispace.com'
    ]
  },
  TOP_WHITEBOARDS: {
    name: 'Top Digital Whiteboards & Diagrams (Top 5+)',
    domains: [
      'excalidraw.com',
      'tldraw.com',
      'miro.com',
      'lucidchart.com',
      'lucid.app',
      'figma.com',
      'figjam.com',
      'boardmix.com',
      'eraser.io',
      'witeboard.com',
      'conceptboard.com',
      'mural.co'
    ]
  },
  ACADEMIC_RESEARCH: {
    name: 'Academic Search & Paper Repositories',
    domains: [
      'google.com',
      'google.co.in',
      'google.co.uk',
      'google.ca',
      'google.com.au',
      'gstatic.com',
      'googleusercontent.com',
      'googleapis.com',
      'accounts.google.com',
      'scholar.google.com',
      'bing.com',
      'bing.net',
      'bingj.com',
      'duckduckgo.com',
      'ddg.gg',
      'arxiv.org',
      'pubmed.ncbi.nlm.nih.gov',
      'ncbi.nlm.nih.gov',
      'jstor.org',
      'researchgate.net',
      'linkedin.com',
      'licdn.com',
      'ieee.org',
      'ieeexplore.ieee.org',
      'semanticscholar.org',
      'sciencedirect.com',
      'elsevier.com',
      'springer.com',
      'link.springer.com',
      'nature.com',
      'ssrn.com',
      'shodhganga.inflibnet.ac.in',
      'inflibnet.ac.in',
      'doaj.org',
      'philpapers.org',
      'academia.edu',
      'academic.oup.com',
      'cambridge.org',
      'acm.org',
      'dl.acm.org',
      'core.ac.uk',
      'base-search.net',
      'plos.org',
      'journals.plos.org',
      'biorxiv.org',
      'medrxiv.org'
    ]
  },
  REFERENCE_DICTIONARY: {
    name: 'Reference & Encyclopedias',
    domains: [
      'wikipedia.org',
      'wikimedia.org',
      'wiktionary.org',
      'wikidata.org',
      'archive.org',
      'britannica.com',
      'plato.stanford.edu',
      'merriam-webster.com',
      'dictionary.cambridge.org',
      'oxfordlearnersdictionaries.com',
      'thesaurus.com',
      'dictionary.com',
      'etymonline.com',
      'gutenberg.org'
    ]
  },
  DEVELOPMENT_CODING: {
    name: 'Developer & Coding Documentation',
    domains: [
      'github.com',
      'github.io',
      'githubassets.com',
      'githubusercontent.com',
      'gitlab.com',
      'bitbucket.org',
      'stackoverflow.com',
      'stackexchange.com',
      'npmjs.com',
      'npmjs.org',
      'pypi.org',
      'pythonhosted.org',
      'docs.python.org',
      'python.org',
      'developer.mozilla.org',
      'w3schools.com',
      'geeksforgeeks.org',
      'freecodecamp.org',
      'leetcode.com',
      'hackerrank.com',
      'codecademy.com',
      'codewars.com',
      'replit.com',
      'codepen.io',
      'jsfiddle.net',
      'crates.io',
      'docs.rs',
      'rust-lang.org',
      'go.dev',
      'golang.org',
      'cppreference.com',
      'devdocs.io',
      'jsdelivr.net',
      'unpkg.com',
      'cdnjs.cloudflare.com',
      'cdnjs.com'
    ]
  },
  PRODUCTIVITY_DOCS: {
    name: 'Study Productivity & Note Tools',
    domains: [
      'notion.so',
      'notion.site',
      'overleaf.com',
      'zotero.org',
      'mendeley.com',
      'drive.google.com',
      'docs.google.com',
      'sheets.google.com',
      'slides.google.com',
      'classroom.google.com',
      'forms.google.com',
      'obsidian.md',
      'craft.do',
      'remnote.com',
      'roamresearch.com',
      'grammarly.com',
      'quillbot.com',
      'deepl.com',
      'scribbr.com',
      'citationmachine.net',
      'bibme.org'
    ]
  },
  YOUTUBE_LEARNING: {
    name: 'YouTube & Video Learning',
    domains: [
      'youtube.com',
      'youtu.be',
      'youtube-nocookie.com',
      'ytimg.com',
      'googlevideo.com',
      'vimeo.com'
    ]
  },
  SYSTEM_EXCEPTIONS: {
    name: 'System & Communication Exceptions (Discord, Wispr Flow & Core)',
    domains: [
      'discord.com',
      'discord.gg',
      'discordapp.com',
      'discordapp.net',
      'wisprflow.ai',
      'flow.wispr.ai',
      'wispr.ai',
      'api.wisprflow.ai'
    ]
  }
};

// Flatten all base allowlist domains
const ALL_STUDY_DOMAINS = Object.values(STUDY_CATEGORIES)
  .flatMap(cat => cat.domains)
  .map(d => d.toLowerCase().trim());

const STUDY_DOMAIN_SET = new Set(ALL_STUDY_DOMAINS);

// DoH Resolver IPs to block during Focus so browsers cannot bypass standard DNS lookup
const DOH_RESOLVER_IPS = [
  '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112',
  '208.67.222.222', '208.67.220.220', '94.140.14.14', '94.140.15.15'
];

/**
 * Normalizes host/domain string
 */
function normalizeDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .split(':')[0]
    .replace(/^\.+|\.+$/g, '');
}
const CUSTOM_DOMAIN_SET = new Set();
const CUSTOM_BLOCKED_DOMAIN_SET = new Set();

function updateCustomDomainSet(domains, customBlockedDomains) {
  CUSTOM_DOMAIN_SET.clear();
  if (Array.isArray(domains)) {
    for (const d of domains) {
      const h = normalizeDomain(d);
      if (h) CUSTOM_DOMAIN_SET.add(h);
    }
  }
  CUSTOM_BLOCKED_DOMAIN_SET.clear();
  if (Array.isArray(customBlockedDomains)) {
    for (const d of customBlockedDomains) {
      const h = normalizeDomain(d);
      if (h) CUSTOM_BLOCKED_DOMAIN_SET.add(h);
    }
  }
}


/**
 * Deterministic domain check against hardcoded allowlist and user custom rules.
 * Matches exact domain or safe subdomain.
 */
function isStudyDomainAllowed(host) {
  const h = normalizeDomain(host);
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;

  // Custom blocked domains take top priority
  if (CUSTOM_BLOCKED_DOMAIN_SET.has(h)) return false;
  for (const badDomain of CUSTOM_BLOCKED_DOMAIN_SET) {
    if (h === badDomain || h.endsWith(`.${badDomain}`)) return false;
  }

  // If it's explicitly in the custom allowlist, always allow it
  if (CUSTOM_DOMAIN_SET.has(h)) return true;
  for (const domain of CUSTOM_DOMAIN_SET) {
    if (h.endsWith(`.${domain}`)) return true;
  }

  // Check if it's explicitly blocked in the distracting list
  for (const badDomain of DEFAULT_DISTRACTING_DOMAINS) {
    if (h === badDomain || h.endsWith(`.${badDomain}`)) {
      return false; // Block distracting sites
    }
  }

  // If it's not a known distracting site, allow it so that apps (WhatsApp, ChatGPT, etc.) can function!
  return true;
}

/**
 * Asynchronously resolves IPs for study domains for Windows firewall allow rules.
 */
async function resolveStudyDomainIps() {
  const ipSet = new Set();
  const domainsToResolve = [
    'google.com', 'wikipedia.org', 'github.com', 'openai.com', 'chatgpt.com',
    'anthropic.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai',
    'excalidraw.com', 'selfstudy.com', 'pw.live', 'brainly.com', 'byjus.com',
    'stackoverflow.com', 'notion.so', 'docs.python.org', 'npmjs.com', 'pypi.org',
    'tldraw.com', 'overleaf.com', 'zotero.org', 'khanacademy.org', 'duckduckgo.com',
    'bing.com', 'wisprflow.ai'
  ];

  await Promise.allSettled(
    domainsToResolve.map(async (d) => {
      try {
        const addresses = await dns.resolve4(d);
        for (const addr of addresses) {
          if (addr && /^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) {
            ipSet.add(addr);
          }
        }
      } catch {}
    })
  );

  return Array.from(ipSet);
}

const fs = require('fs');
const path = require('path');

const DEFAULT_DISTRACTING_DOMAINS = [
  // Social Media & Web Messaging
  'instagram.com', 'www.instagram.com', 'cdninstagram.com',
  'facebook.com', 'www.facebook.com', 'fb.com', 'fbcdn.net', 'messenger.com', 'm.facebook.com',
  'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com', 'twimg.com',
  'tiktok.com', 'www.tiktok.com', 'tiktokcdn.com', 'vm.tiktok.com',
  'pinterest.com', 'www.pinterest.com', 'pinimg.com',
  'snapchat.com', 'www.snapchat.com',
  'reddit.com', 'www.reddit.com', 'redd.it', 'redditmedia.com', 'old.reddit.com',
  'tumblr.com', 'www.tumblr.com',
  '9gag.com', 'www.9gag.com',
  'threads.net', 'www.threads.net',
  'vk.com', 'www.vk.com',
  'weibo.com', 'www.weibo.com',
  'quora.com', 'www.quora.com',
  'medium.com', 'www.medium.com',
  'linkedin.com', 'www.linkedin.com',
  // Streaming & Entertainment
  'netflix.com', 'www.netflix.com', 'nflxext.com', 'nflxso.net',
  'hulu.com', 'www.hulu.com',
  'disneyplus.com', 'www.disneyplus.com',
  'primevideo.com', 'www.primevideo.com',
  'twitch.tv', 'www.twitch.tv', 'ttvnw.net',
  'kick.com', 'www.kick.com',
  'hbo.com', 'hbomax.com', 'max.com',
  'hotstar.com', 'www.hotstar.com',
  'soundcloud.com', 'www.soundcloud.com',
  'dailymotion.com', 'www.dailymotion.com',
  'crunchyroll.com', 'www.crunchyroll.com',
  'funimation.com', 'www.funimation.com',
  '9anime.to', 'aniwatch.to', 'hianime.to',
  // Web Gaming
  'steampowered.com', 'store.steampowered.com', 'steamcommunity.com',
  'epicgames.com', 'store.epicgames.com',
  'roblox.com', 'www.roblox.com',
  'poki.com', 'www.poki.com',
  'crazygames.com', 'www.crazygames.com',
  'miniclip.com', 'www.miniclip.com',
  'chess.com', 'www.chess.com',
  'lichess.org', 'www.lichess.org',
  'y8.com', 'www.y8.com',
  'krunker.io', 'www.krunker.io',
  'slither.io', 'agar.io',
  // Shopping
  'amazon.com', 'www.amazon.com', 'amazon.in', 'amazon.co.uk',
  'ebay.com', 'www.ebay.com',
  'aliexpress.com', 'www.aliexpress.com',
  'flipkart.com', 'www.flipkart.com',
  'myntra.com', 'www.myntra.com',
  'walmart.com', 'www.walmart.com',
  'target.com', 'www.target.com',
  'etsy.com', 'www.etsy.com',
  'shein.com', 'www.shein.com',
  'temu.com', 'www.temu.com',
  // Distracting News & Gossip
  'buzzfeed.com', 'www.buzzfeed.com',
  'dailymail.co.uk', 'www.dailymail.co.uk',
  'tmz.com', 'www.tmz.com',
  'ign.com', 'www.ign.com',
  'kotaku.com', 'www.kotaku.com',
  'gamespot.com', 'www.gamespot.com'
];

const HOSTS_HEADER_MARKER = '# === LifeOS FocusGuard Blocklist ===';
const HOSTS_FOOTER_MARKER = '# === End LifeOS FocusGuard Blocklist ===';
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\drivers\\etc\\hosts');

function focusGuardHostsBackupPath(userDataDir) {
  const dir = userDataDir || process.env.APPDATA || process.cwd();
  return path.join(dir, 'focus-guard-hosts-backup.txt');
}

function flushDnsCache() {
  if (process.platform !== 'win32') return;
  try {
    const { execFileSync } = require('child_process');
    execFileSync('ipconfig.exe', ['/flushdns'], { windowsHide: true, timeout: 5000 });
  } catch {}
}

function generateHostsBlocklistContent() {
  const list = DEFAULT_DISTRACTING_DOMAINS.filter(d => !isStudyDomainAllowed(d));
  const customBlocked = Array.from(CUSTOM_DOMAIN_SET).filter(d => !isStudyDomainAllowed(d));
  const uniqueList = Array.from(new Set([...list, ...customBlocked]));
  const lines = [
    HOSTS_HEADER_MARKER,
    '# Automatic website blocklist for FocusGuard session.'
  ];
  for (const domain of uniqueList) {
    const bare = domain.replace(/^www\./i, '');
    lines.push(`0.0.0.0 ${bare}`);
    lines.push(`0.0.0.0 www.${bare}`);
    lines.push(`127.0.0.1 ${bare}`);
    lines.push(`127.0.0.1 www.${bare}`);
    lines.push(`::1 ${bare}`);
    lines.push(`::1 www.${bare}`);
  }
  lines.push(HOSTS_FOOTER_MARKER);
  return lines.join('\n');
}

function applyHostsBlocklist(userDataDir) {
  if (process.platform !== 'win32') return { ok: true, platform: 'non-windows' };
  try {
    if (!fs.existsSync(HOSTS_PATH)) return { ok: false, error: 'Hosts file not found' };

    const currentHosts = fs.readFileSync(HOSTS_PATH, 'utf8');
    const backupFile = focusGuardHostsBackupPath(userDataDir);

    // Save backup if not present
    if (!fs.existsSync(backupFile)) {
      try { fs.writeFileSync(backupFile, currentHosts, 'utf8'); } catch {}
    }

    // Grant users modify permission on hosts file so cleanup / emergency restore can always succeed
    try {
      const { execFileSync } = require('child_process');
      execFileSync('icacls.exe', [HOSTS_PATH, '/grant', '*S-1-5-32-545:(M)'], { windowsHide: true, timeout: 3000 });
    } catch {}

    // Clean existing blocklist section if present
    const cleanContent = currentHosts.split(HOSTS_HEADER_MARKER)[0].trimEnd();

    // Generate blocklist content
    const blocklistSection = generateHostsBlocklistContent();
    const newHostsContent = `${cleanContent}\n\n${blocklistSection}\n`;

    // Ensure hosts file is writable
    try { fs.chmodSync(HOSTS_PATH, 0o666); } catch {}

    let written = false;
    try {
      fs.writeFileSync(HOSTS_PATH, newHostsContent, 'utf8');
      written = true;
    } catch (err) {
      // Try writing via PowerShell
      try {
        const { execFileSync } = require('child_process');
        const tmpFile = path.join(require('os').tmpdir(), `hosts_fg_${Date.now()}.txt`);
        fs.writeFileSync(tmpFile, newHostsContent, 'utf8');
        execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Copy-Item -LiteralPath '${tmpFile.replace(/'/g, "''")}' -Destination '${HOSTS_PATH.replace(/'/g, "''")}' -Force`], { windowsHide: true, timeout: 5000 });
        try { fs.unlinkSync(tmpFile); } catch {}
        written = true;
      } catch (psErr) {
        console.error('[FocusWeb] PowerShell write failed:', psErr.message);
      }
    }

    flushDnsCache();
    if (written) {
      console.log(`[FocusWeb] Applied hosts blocklist for ${DEFAULT_DISTRACTING_DOMAINS.length} distracting domains.`);
      return { ok: true, count: DEFAULT_DISTRACTING_DOMAINS.length };
    }
    return { ok: false, error: 'Could not write hosts blocklist' };
  } catch (err) {
    console.error('[FocusWeb] Failed to apply hosts blocklist:', err.message);
    return { ok: false, error: err.message };
  }
}

function removeHostsBlocklist(userDataDir) {
  if (process.platform !== 'win32') return { ok: true };
  try {
    const backupFile = focusGuardHostsBackupPath(userDataDir);
    let targetContent = null;

    if (fs.existsSync(backupFile)) {
      try { targetContent = fs.readFileSync(backupFile, 'utf8'); } catch {}
    }

    if (!targetContent && fs.existsSync(HOSTS_PATH)) {
      const currentHosts = fs.readFileSync(HOSTS_PATH, 'utf8');
      if (currentHosts.includes(HOSTS_HEADER_MARKER)) {
        targetContent = currentHosts.split(HOSTS_HEADER_MARKER)[0].trimEnd() + '\r\n';
      }
    }

    if (targetContent !== null) {
      let written = false;
      try {
        try { fs.chmodSync(HOSTS_PATH, 0o666); } catch {}
        fs.writeFileSync(HOSTS_PATH, targetContent, 'utf8');
        written = true;
      } catch (err) {
        // Direct PowerShell write without hanging RunAs
        try {
          const { execFileSync } = require('child_process');
          const script = `[System.IO.File]::WriteAllText('${HOSTS_PATH.replace(/'/g, "''")}', @'\n${targetContent}\n'@, [System.Text.Encoding]::UTF8)`;
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 3000 });
          written = true;
        } catch (psErr) {
          console.warn('[FocusWeb] PowerShell hosts write warning:', psErr.message);
        }
      }

      if (written && fs.existsSync(backupFile)) {
        try { fs.unlinkSync(backupFile); } catch {}
      }
    }

    flushDnsCache();
    console.log('[FocusWeb] Cleaned hosts blocklist and restored original hosts file.');
    return { ok: true };
  } catch (err) {
    console.warn('[FocusWeb] Hosts cleanup warning:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  STUDY_CATEGORIES,
  ALL_STUDY_DOMAINS,
  STUDY_DOMAIN_SET,
  DEFAULT_DISTRACTING_DOMAINS,
  DOH_RESOLVER_IPS,
  normalizeDomain,
  isStudyDomainAllowed,
  resolveStudyDomainIps,
  generateHostsBlocklistContent,
  applyHostsBlocklist,
  removeHostsBlocklist,
  focusGuardHostsBackupPath,
  updateCustomDomainSet,
  CUSTOM_DOMAIN_SET
};
