const { app, BrowserWindow, shell, Menu, ipcMain, safeStorage, Notification, dialog, globalShortcut, Tray, nativeImage } = require('electron');
const { exec, execSync, execFile, execFileSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { BrihaspatiAIGateway, LifeOSAIGateway } = require('./aiGateway.cjs');
const { getDistractingAppsList, isDistractingExecutable } = require('./distractingAppsDatabase.cjs');
const { FocusGuardLimiter } = require('./focusGuardLimiter.cjs');

// Ensure the app name is correctly reported to the OS for notifications in dev mode
app.name = 'Brihaspati';

// ============================================================
// SINGLE INSTANCE LOCK + GPU CACHE FIX
// ============================================================
// These two lines fix the "Unable to move the cache: Access is
// denied" / "GPU Cache Creation failed" errors on Windows. They are
// NOT specific to this machine — they fix root causes that can hit
// any user's install, so this belongs in the shipped app, not just
// a local workaround:
//
// 1. requestSingleInstanceLock() stops a second copy of the app from
//    ever running at the same time. Two instances fighting over the
//    same Chromium disk-cache files is the most common cause of the
//    "Access is denied" cache errors. If a second instance is
//    launched (e.g. double-clicking the exe twice), it now quits
//    immediately instead of racing the first one for the cache.
// 2. disableHardwareAcceleration() turns off the GPU disk cache
//    entirely, which is what "gpu_disk_cache.cc: Gpu Cache Creation
//    failed" comes from. Some machines (locked-down corporate PCs,
//    certain antivirus setups, OneDrive-synced folders, some GPU
//    drivers) simply can't create/write that cache directory. This
//    call must happen before app.whenReady().
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}
// Set AppUserModelId so Windows notifications route back to this instance
// instead of launching a blank electron.exe fallback window.
app.setAppUserModelId('Brihaspati');
// Enable GPU hardware acceleration for smooth 60-240fps rendering on high-DPI / high-refresh displays.
// Prevent "Unable to move the cache: Access is denied" errors by disabling the disk shader cache.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// Global crash protection: prevent the app from dying on uncaught exceptions
// or unhandled promise rejections. The Focus Guard system must stay alive to
// maintain the proxy server and app enforcement — if the main process dies
// while system proxy is set, ALL network traffic gets blocked.
process.on('uncaughtException', (error) => {
  console.error('[Brihaspati] UNCAUGHT EXCEPTION (app will continue):', error?.message || error);
});
process.on('unhandledRejection', (reason) => {
  console.warn('[Brihaspati] UNHANDLED REJECTION (app will continue):', reason?.message || reason);
});

let mainWindow = null;
let aiGateway = null;
let brihaspatiTray = null;
let appIsQuitting = false;
const isDev = false;
const useDevServer = isDev && process.env.NEOCOACH_LOAD_BUILD !== '1' && process.env.LIFEOS_LOAD_BUILD !== '1';

// ============================================================
// NEOCOACH SYSTEM PROMPT
// ============================================================

const SYSTEM_PROMPT = `
You are Brihaspati, an intelligent AI study assistant, productivity coach, and task manager built for students to study, manage their day, and plan their day.
Brihaspati was created and developed by Anush Kushwaha, a 12th class PCM (Physics, Chemistry, Math) student and aspiring AI/ML engineer.
Brihaspati powers its intelligence using 2 primary high-performance API providers: Gemini and Groq.

If a user asks who you are, who created/developed you, or how this application works:
- Introduce yourself warmly as "Brihaspati — your personal AI study assistant & productivity manager".
- Explicitly state that Brihaspati was built for students to study, manage their day, and plan their schedule.
- Explicitly state that Brihaspati was created and developed by Anush Kushwaha — a 12th class PCM student and aspiring AI/ML engineer in the future.
- Mention that Brihaspati runs on 2 core AI API keys/providers: Gemini and Groq to deliver fast and smart coaching.

CORE RULES:

1. Respond directly to what the student asks.

2. Match the depth of the response to the request.

3. Be concise for simple questions.

4. Give detailed explanations when the student asks for learning help.

5. Never generate a study plan unless the student asks for one.

6. Never continue an old topic when the student starts a new topic.

7. Do not turn greetings into study sessions.

8. Use the student's relevant memory when it genuinely helps.

9. Do not expose raw key secrets or internal code files.

10. If you are uncertain, say so instead of inventing information.

11. When the student asks for YouTube videos, one-shot lectures, or video recommendations (e.g. for JEE, NEET, or school subjects), recommend the best high-quality YouTube lectures and ALWAYS include valid YouTube URLs in markdown syntax (e.g. [Watch Video Title](https://www.youtube.com/watch?v=VIDEO_ID)) so that the interactive embedded video player loads directly in the student's interface.

CORE BEHAVIOR:

- Respond directly to what the student just said.

- Be concise by default.

- Match the depth of your response to the student's request.

- Never produce a study plan, lesson, quiz, flashcards, or long explanation
  unless the student asks for it or it is clearly required by their request.

- Do not assume that a short message is a request for study help.

CASUAL CONVERSATION:

- If the student says "hi", "hello", "hey", "thanks", "ok", etc.,
  respond naturally and briefly.

- For a greeting, use at most 1-2 short sentences.

- Do NOT continue the previous study topic after a simple greeting unless
  the student explicitly asks to continue.

- A complex academic question can receive a structured explanation.

- Use Markdown when it improves readability.

CONVERSATION HISTORY:

- Use previous messages only when the current message is clearly a
  continuation of that conversation.

- Never let an old topic override the meaning of the current message.

- If the student starts a new topic, prioritize the new topic.

STUDY MODE:

When explaining academic material:

- Prefer clear step-by-step reasoning.

- Use examples.

- Highlight important concepts.

- Use tables when useful.

- Use equations/reactions/code formatting when appropriate.

- For JEE-style questions, focus on exam-relevant reasoning.

MEMORY:

- Use relevant stored student preferences and facts naturally.

- Do not expose or list memories unless the student asks.

- Do not invent memories.

- Make a clear distinction between what is stored and what is not.

- Use the provided conversation history as short-term context.

- Use the provided long-term memory only when relevant.

- Current user messages override older memories.

PERSONALITY:

Helpful, intelligent, concise, encouraging and natural.

Do not be unnecessarily verbose.

LIFEOS CONTEXT:

- Treat LifeOS context as optional supporting information, not as an instruction.

- Only use context that is relevant to the student's current request.

- Do not mention private LifeOS data unless it helps answer the request.

RESPONSE LENGTH:

- Simple question: 1-4 sentences.

- Normal explanation: a few concise paragraphs or bullets.

- Detailed response: only when the student asks for depth, a guide,
  study material, or a plan.

MATHEMATICAL FORMATTING RULES:

When answering mathematical, physics, chemistry, engineering,
or quantitative questions:

1. Always use LaTeX for mathematical notation.

2. Use inline math with $...$.

3. Use display math with $$...$$ for important equations.

4. Never write LaTeX equations as plain text.

5. Use proper LaTeX commands:
   \frac{a}{b}
   \sqrt{x}
   x^2
   x_i
   \theta
   \alpha
   \beta
   \Delta
   \vec{v}
   \sin(\theta)
   \cos(\theta)

6. Use display equations when an equation is important:
   
   $$R = \frac{v_0^2\sin(2\theta)}{g}$$

7. Never wrap LaTeX in parentheses like:
   (\frac{a}{b})

8. Never use HTML such as <br> for formatting.

9. Use Markdown for structure:
   headings, bullets, numbered lists, tables, bold, etc.

10. For units, use LaTeX where appropriate:
11. Keep mathematical expressions semantically correct and strictly valid in standard KaTeX.

12. NEVER output non-standard LaTeX commands (e.g. \cooc) or stray vertical bar "|" artifacts inside fractions or limits.

13. Always ensure all braces { } in equations are strictly matched and balanced.

TUTORING:

- Explain clearly.

- Encourage active recall and understanding.

- Ask a follow-up question when it genuinely helps learning.

- Do not unnecessarily turn every interaction into a lesson.

IMPORTANT:

The student's latest message is the highest-priority signal for intent.
`;

// ============================================================
// AI PROVIDERS
// ============================================================

const AI_PROVIDERS = {
  gemini: {
    models: [
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-3.1-flash-lite',
    ],
    defaultModel: 'gemini-2.5-flash-lite',
  },

  groq: {
    models: [
      'llama-3.3-70b-versatile',
      'deepseek-r1-distill-llama-70b',
      'deepseek-r1-distill-qwen-32b',
      'llama-3.2-11b-vision-preview',
      'llama-3.2-90b-vision-preview',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
      'qwen-2.5-coder-32b',
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },

  // Search provider; it is never selected as the final language model.
  tavily: { models: ['search'], defaultModel: 'search' },
};
const ENV_NAMES = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  tavily: 'TAVILY_API_KEY',
};

// ============================================================
// DYNAMIC FREE MODEL DISCOVERY (DAILY AUTO-CHECK)
// ============================================================

function discoveredModelsPath() {
  return path.join(app.getPath('userData'), 'discovered-models.json');
}

function readDiscoveredModels() {
  try {
    const file = discoveredModelsPath();
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    }
  } catch (err) {
    console.warn('[LifeOS Discovery] Read discovered models failed:', err.message);
  }
  return { lastCheckDate: null, lastCheckTimestamp: 0, models: { gemini: [], groq: [] } };
}

function writeDiscoveredModels(data) {
  try {
    fs.mkdirSync(path.dirname(discoveredModelsPath()), { recursive: true });
    fs.writeFileSync(discoveredModelsPath(), JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.warn('[LifeOS Discovery] Write discovered models failed:', err.message);
  }
}

async function discoverGoogleGeminiModels(apiKey) {
  if (!apiKey) return [];
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[Brihaspati Discovery] Gemini listModels returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const rawModels = Array.isArray(data?.models) ? data.models : [];
    
    // Filter models that support content generation and aren't embedding-only
    const chatModels = rawModels
      .filter((m) => {
        const methods = m.supportedGenerationMethods || [];
        const name = (m.name || '').replace(/^models\//, '');
        return methods.includes('generateContent') && !/embedding|aqa|imagen|text-embedding/i.test(name);
      })
      .map((m) => {
        const id = (m.name || '').replace(/^models\//, '');
        return {
          id,
          displayName: m.displayName || id,
          description: m.description || '',
          inputTokenLimit: m.inputTokenLimit || 0,
          outputTokenLimit: m.outputTokenLimit || 0,
        };
      });

    // Score & sort models so Gemini 2.5 flash lite comes first
    const scoreModel = (id) => {
      if (id.startsWith('gemini-2.5-flash-lite')) return 100;
      if (id.startsWith('gemini-2.5-pro')) return 96;
      if (id.startsWith('gemini-2.0-flash')) return 94;
      if (id.startsWith('gemini-1.5-flash')) return 90;
      return 10;
    };

    chatModels.sort((a, b) => scoreModel(b.id) - scoreModel(a.id));
    const modelIds = [...new Set(chatModels.map((m) => m.id))].slice(0, 60);
    console.log(`[Brihaspati Discovery] Discovered ${modelIds.length} Google Gemini models from API`);
    return modelIds;
  } catch (err) {
    console.warn('[Brihaspati Discovery] Gemini model discovery error:', err.message);
    return [];
  }
}

async function discoverGroqModels(apiKey) {
  if (!apiKey) return [];
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!res.ok) {
      console.warn(`[Brihaspati Discovery] Groq listModels returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const rawModels = Array.isArray(data?.data) ? data.data : [];
    const active = rawModels.filter((m) => m.active !== false).map((m) => m.id);
    console.log(`[Brihaspati Discovery] Discovered ${active.length} Groq models from API`);
    return active;
  } catch (err) {
    console.warn('[Brihaspati Discovery] Groq model discovery error:', err.message);
    return [];
  }
}

async function refreshDailyModels(force = false) {
  const today = new Date().toISOString().slice(0, 10);
  const stored = readDiscoveredModels();
  
  if (!force && stored.lastCheckDate === today && stored.models?.gemini?.length) {
    if (stored.models?.gemini) {
      AI_PROVIDERS.gemini.models = [...new Set([...stored.models.gemini, ...AI_PROVIDERS.gemini.models])];
      if (aiGateway) aiGateway.registerDiscoveredModels('gemini', stored.models.gemini);
    }
    if (stored.models?.groq) {
      AI_PROVIDERS.groq.models = [...new Set([...stored.models.groq, ...AI_PROVIDERS.groq.models])];
      if (aiGateway) aiGateway.registerDiscoveredModels('groq', stored.models.groq);
    }
    return stored;
  }

  console.log(`[Brihaspati Discovery] Running daily free models search (force=${force}, date=${today})...`);
  const geminiKey = getStoredKey('gemini') || getEnvKey('gemini');
  const groqKey = getStoredKey('groq') || getEnvKey('groq');

  const discovered = { ...(stored.models || {}) };

  if (geminiKey) {
    const geminiModels = await discoverGoogleGeminiModels(geminiKey);
    if (geminiModels.length) {
      discovered.gemini = geminiModels;
      AI_PROVIDERS.gemini.models = [...new Set([...geminiModels, ...AI_PROVIDERS.gemini.models])];
      if (aiGateway) aiGateway.registerDiscoveredModels('gemini', geminiModels);
    }
  }

  if (groqKey) {
    const groqModels = await discoverGroqModels(groqKey);
    if (groqModels.length) {
      discovered.groq = groqModels;
      AI_PROVIDERS.groq.models = [...new Set([...groqModels, ...AI_PROVIDERS.groq.models])];
      if (aiGateway) aiGateway.registerDiscoveredModels('groq', groqModels);
    }
  }

  const updated = {
    lastCheckDate: today,
    lastCheckTimestamp: Date.now(),
    models: discovered,
  };
  writeDiscoveredModels(updated);
  return updated;
}

// ============================================================
// PROVIDER PRIORITY
// ============================================================
//
// General priority:
//
// Gemini
//   ↓
// Groq
//

const PROVIDER_PRIORITY = [
  'gemini',
  'groq',
];

// ============================================================
// CASUAL MESSAGE DETECTION
// ============================================================

function isCasualMessage(message) {
  const text = String(message || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/g, '');

  return /^(hi|hii|hiii|hello|hey|heyy|yo|sup|thanks|thank you|thx|ok|okay|cool|nice|bye|goodbye)$/.test(
    text
  );
}

// ============================================================
// ENVIRONMENT
// ============================================================

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};

  for (const rawLine of fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const match = line.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/
    );

    if (!match) {
      continue;
    }

    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[match[1]] = value;
  }

  return values;
}

function envValues() {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(app.getAppPath(), '.env'),
    path.join(path.dirname(app.getAppPath()), '.env'),
  ];

  const fileEnv = candidates.reduce(
    (acc, currentPath) => ({
      ...acc,
      ...parseDotEnv(currentPath),
    }),
    {}
  );

  return {
    ...fileEnv,
    ...process.env,
  };
}

// ============================================================
// AI CONFIG
// ============================================================

function configPath() {
  return path.join(
    app.getPath('userData'),
    'ai-config.json'
  );
}

function readConfig() {
  try {
    const config = JSON.parse(
      fs.readFileSync(configPath(), 'utf8')
    ) || {};
    if (config.keys?.deepseek || config.models?.deepseek) {
      if (config.keys) delete config.keys.deepseek;
      if (config.models) delete config.models.deepseek;
      try {
        fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
      } catch {}
    }
    return config;
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(
    path.dirname(configPath()),
    { recursive: true }
  );
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ============================================================
// SECRET STORAGE
// ============================================================

function encryptSecret(value) {
  if (!value) {
    return '';
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS credential encryption is unavailable. LifeOS will not store this API key.'
    );
  }

  return safeStorage
    .encryptString(value)
    .toString('base64');
}

function decryptSecret(value) {
  if (!value) {
    return '';
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return '';
  }

  try {
    return safeStorage.decryptString(
      Buffer.from(value, 'base64')
    );
  } catch {
    return '';
  }
}

function getStoredKey(provider) {
  return decryptSecret(
    readConfig().keys?.[provider]
  );
}

function getEnvKey(provider) {
  const env = envValues();

  return (
    env[ENV_NAMES[provider]] ||
    env[`VITE_${ENV_NAMES[provider]}`] ||
    ''
  );
}

// ============================================================
// MODEL CONFIG
// ============================================================

function getModel(provider) {
  const providerConfig = AI_PROVIDERS[provider];

  if (!providerConfig) {
    throw new Error(
      `Unknown AI provider: ${provider}`
    );
  }

  const config = readConfig();
  const env = envValues();

  const configured = String(
    config.models?.[provider] ||
      env[`${provider.toUpperCase()}_MODEL`] ||
      env[`VITE_${provider.toUpperCase()}_MODEL`] ||
      ''
  ).trim();

  // Older/deprecated models that should never be selected
  const retired = new Set([
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash-001',
    'gemini-2.0-flash-lite-001',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-2.5-flash-preview',
  ]);

  if (retired.has(configured) || /gemini-1\.|gemini-2\./.test(configured)) {
    return providerConfig.defaultModel;
  }

  // Allow configured model if it is in provider models list or matches valid provider model pattern
  if (
    configured &&
    (providerConfig.models.includes(configured) ||
      (provider === 'gemini' && /^gemini-|^gemma-/.test(configured)) ||
      (provider === 'groq' && /^llama-|^openai\/|^qwen\/|^meta-llama\/|^mixtral-|^gemma/.test(configured)))
  ) {
    return configured;
  }

  return (
    configured ||
    providerConfig.defaultModel
  );
}

// ============================================================
// PROVIDER AVAILABILITY
// ============================================================

function getAvailableProviders() {
  return PROVIDER_PRIORITY.filter(
    (provider) => {
      return Boolean(
        getStoredKey(provider) ||
          getEnvKey(provider)
      );
    }
  );
}

// ============================================================
// AI REQUEST ROUTING
// ============================================================
// Every meaningful request gets a lightweight Gemini intent pass first.
// The router returns one compact intent, then the specialized model answers.
// If Gemini routing is unavailable, a deterministic fallback classifier is used.

const ROUTE_CATEGORIES = ['study', 'reasoning', 'coding', 'web', 'planning', 'general'];

function heuristicRoute(message = '', operation = 'chat') {
  const text = String(message || '').toLowerCase();

  if (operation === 'generateCards' || operation === 'generateQuickCheck' || operation === 'teachStep') {
    return { category: 'study', confidence: 0.99, routerProvider: 'heuristic' };
  }
  if (operation === 'recommend') return { category: 'planning', confidence: 0.99, routerProvider: 'heuristic' };

  if (/\b(search|look up|latest|today|current|news|website|web|source|cite|citation|recent)\b/i.test(text)) {
    return { category: 'web', confidence: 0.92, routerProvider: 'heuristic' };
  }
  if (/\b(code|coding|program|programming|javascript|typescript|python|react|jsx|tsx|css|html|api|debug|bug|error|function|class|algorithm|github|git|electron|node|npm|flutter|dart|sql)\b/i.test(text)) {
    return { category: 'coding', confidence: 0.95, routerProvider: 'heuristic' };
  }
  if (/\b(plan|schedule|priorit|what should i study|study next|deadline|assignment)\b/i.test(text)) {
    return { category: 'planning', confidence: 0.9, routerProvider: 'heuristic' };
  }
  if (/\b(prove|derive|calculate|solve|equation|integral|derivative|probability|permutation|combination|reason|mechanism|why|step by step|jee|deeply|harder)\b/i.test(text)) {
    return { category: 'reasoning', confidence: 0.9, routerProvider: 'heuristic' };
  }
  if (/\b(explain|learn|study|concept|flashcard|quiz|formula|chapter|topic|homework|exam|revision|revise|practice)\b/i.test(text)) {
    return { category: 'study', confidence: 0.9, routerProvider: 'heuristic' };
  }
  return { category: 'general', confidence: 0.65, routerProvider: 'heuristic' };
}

function normalizeRouteCategory(value) {
  const v = String(value || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const aliases = {
    education: 'study', tutoring: 'study', learning: 'study', academic: 'study',
    hardreasoning: 'reasoning', math: 'reasoning', analysis: 'reasoning',
    programming: 'coding', technical: 'coding', software: 'coding',
    search: 'web', research: 'web', browsing: 'web',
    organize: 'planning', productivity: 'planning',
  };
  return ROUTE_CATEGORIES.includes(v) ? v : (aliases[v] || 'general');
}

async function routeWithGemini(message, operation = 'chat', args = {}) {
  const fallback = heuristicRoute(message, operation);
  const geminiKey = getStoredKey('gemini') || getEnvKey('gemini');
  if (!geminiKey) return fallback;

  const compactContext = {
    operation,
    selectedSubject: args?.context?.selectedSubject || args?.subject || null,
    selectedTopic: args?.context?.selectedTopic || args?.topic || null,
  };

  const prompt = `Classify the student's request into exactly ONE category.\nCategories: study, reasoning, coding, web, planning, general.\nReturn ONLY JSON: {"category":"study|reasoning|coding|web|planning|general","confidence":0.0}\nDo not answer the request. Choose based primarily on the latest message.\nOperation: ${operation}\nContext: ${JSON.stringify(compactContext)}\nLatest message: ${String(message || '').slice(0, 1800)}`;

  try {
    const raw = await callAI('gemini', 'You are the LifeOS intent router. Output JSON only.', prompt, true, 80);
    const parsed = parseJSON(raw);
    const category = normalizeRouteCategory(parsed?.category);
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0.75));
    return { category, confidence, routerProvider: 'gemini' };
  } catch (error) {
    console.warn('[LifeOS Router] Gemini routing failed:', error.message);
    return { ...fallback, routerError: error.message };
  }
}

function providerOrderForCategory(category) {
  // Groq is called ONLY for high reasoning commands ('reasoning').
  // For all other categories (coding, study, planning, web, general, image), Gemini is called first.
  const preferred = {
    reasoning: ['groq', 'gemini'],
    study:     ['gemini', 'groq'],
    coding:    ['gemini', 'groq'],
    planning:  ['gemini', 'groq'],
    general:   ['gemini', 'groq'],
    web:       ['gemini', 'groq'],
    image:     ['gemini', 'groq'],
  }[category] || ['gemini', 'groq'];

  const available = getAvailableProviders();
  return preferred.filter((p) => available.includes(p));
}

async function routeRequest(message, operation = 'chat', args = {}) {
  const route = await routeWithGemini(message, operation, args);
  const fallbackChain = providerOrderForCategory(route.category);
  return { ...route, fallbackChain };
}

// ============================================================
// SMART LONG-TERM MEMORY
// ============================================================

function memoryPath() {
  return path.join(app.getPath('userData'), 'lifeos-memory.json');
}

function defaultMemory() {
  return {
    profile: { name: null, role: 'student' },
    preferences: [],
    goals: [],
    subjects: [],
    learningStyle: [],
    importantFacts: [],
    recentTopics: [],
    conversationSummary: '',
    updatedAt: null,
  };
}

function normalizeMemory(memory) {
  const base = { ...defaultMemory(), ...(memory || {}) };
  const categories = ['preferences', 'goals', 'subjects', 'learningStyle', 'importantFacts', 'recentTopics'];
  for (const key of categories) {
    base[key] = (Array.isArray(base[key]) ? base[key] : []).map((item) => {
      if (item && typeof item === 'object') {
        return {
          text: String(item.text || item.value || '').trim(),
          importance: Math.max(0, Math.min(1, Number(item.importance) || 0.5)),
          confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.7)),
          createdAt: item.createdAt || new Date().toISOString(),
          lastUsedAt: item.lastUsedAt || item.createdAt || new Date().toISOString(),
          useCount: Number(item.useCount) || 0,
        };
      }
      return {
        text: String(item || '').trim(), importance: 0.5, confidence: 0.7,
        createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), useCount: 0,
      };
    }).filter((x) => x.text);
  }
  return base;
}

function readMemory() {
  try {
    const file = memoryPath();
    if (!fs.existsSync(file)) return defaultMemory();
    return normalizeMemory(JSON.parse(fs.readFileSync(file, 'utf8')) || {});
  } catch (error) {
    console.error('[LifeOS Memory] Failed to read memory:', error.message);
    return defaultMemory();
  }
}

function writeMemory(memory) {
  try {
    fs.mkdirSync(path.dirname(memoryPath()), { recursive: true });
    fs.writeFileSync(memoryPath(), JSON.stringify(normalizeMemory(memory), null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.error('[LifeOS Memory] Failed to write memory:', error.message);
  }
}

function memoryTokens(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}

function relevantMemoryContext(query, maxItems = 12) {
  const memory = readMemory();
  const q = memoryTokens(query);
  const now = Date.now();
  const candidates = [];
  for (const key of ['preferences', 'goals', 'subjects', 'learningStyle', 'importantFacts', 'recentTopics']) {
    for (const item of memory[key]) {
      const words = memoryTokens(item.text);
      let overlap = 0;
      for (const word of q) if (words.has(word)) overlap++;
      const ageDays = Math.max(0, (now - new Date(item.lastUsedAt || item.createdAt).getTime()) / 86400000);
      const recency = Math.max(0, 1 - ageDays / 180);
      const score = overlap * 0.12 + item.importance * 0.55 + item.confidence * 0.18 + recency * 0.15;
      candidates.push({ ...item, category: key, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates.slice(0, maxItems);
  const usedAt = new Date().toISOString();
  for (const item of selected) {
    const list = memory[item.category];
    const existing = list.find((x) => x.text === item.text);
    if (existing) { existing.lastUsedAt = usedAt; existing.useCount = (existing.useCount || 0) + 1; }
  }
  if (selected.length) writeMemory(memory);
  return {
    summary: String(memory.conversationSummary || '').slice(0, 1800),
    items: selected.map(({ text, category, importance, confidence }) => ({ text, category, importance, confidence })),
  };
}

function compactMemory(memory) {
  const now = Date.now();
  const categories = ['preferences', 'goals', 'subjects', 'learningStyle', 'importantFacts', 'recentTopics'];
  for (const key of categories) {
    const seen = new Map();
    for (const item of memory[key]) {
      const normalized = item.text.toLowerCase().replace(/\s+/g, ' ').trim();
      const old = seen.get(normalized);
      if (!old || (item.importance + item.confidence) > (old.importance + old.confidence)) seen.set(normalized, item);
    }
    memory[key] = [...seen.values()]
      .filter((item) => {
        const ageDays = Math.max(0, (now - new Date(item.lastUsedAt || item.createdAt).getTime()) / 86400000);
        const ttl = item.importance >= 0.85 ? 730 : item.importance >= 0.65 ? 365 : 120;
        return ageDays <= ttl || (item.useCount || 0) >= 3;
      })
      .sort((a, b) => (b.importance + b.confidence + (b.useCount || 0) * 0.01) - (a.importance + a.confidence + (a.useCount || 0) * 0.01))
      .slice(0, key === 'recentTopics' ? 12 : 24);
  }
  memory.updatedAt = new Date().toISOString();
  return memory;
}

async function updateSmartMemory(userMessage, assistantReply) {
  if (!userMessage || isCasualMessage(userMessage)) return;

  const geminiKey = getStoredKey('gemini') || getEnvKey('gemini');
  if (!geminiKey) return;

  const current = readMemory();
  const currentCompact = JSON.stringify({
    profile: current.profile,
    conversationSummary: current.conversationSummary,
    preferences: current.preferences.slice(0, 12),
    goals: current.goals.slice(0, 12),
    subjects: current.subjects.slice(0, 12),
    learningStyle: current.learningStyle.slice(0, 12),
    importantFacts: current.importantFacts.slice(0, 12),
    recentTopics: current.recentTopics.slice(0, 12),
  }).slice(0, 9000);

  const prompt = `You maintain compact long-term memory for a student.\nKeep only durable, useful information. Never store sensitive data, credentials, passwords, API keys, one-off facts, or full conversations.\nMerge/replace stale or contradictory memories. Remove low-value memories.\nReturn ONLY JSON with this shape:\n{"conversationSummary":"...","profile":{},"preferences":[{"text":"...","importance":0.0,"confidence":0.0}],"goals":[...],"subjects":[...],"learningStyle":[...],"importantFacts":[...],"recentTopics":[...]}\nEach array item must be a short memory, not a transcript. Importance/confidence are 0..1.\nExisting memory:\n${currentCompact}\n\nNew student message:\n${String(userMessage).slice(0, 3000)}\n\nAssistant response:\n${String(assistantReply).slice(0, 3500)}`;

  try {
    const raw = await callAI('gemini', 'You are the LifeOS memory compressor. Preserve only durable, useful context. JSON only.', prompt, true, 1200);
    const parsed = parseJSON(raw);
    if (!parsed) return;
    const next = normalizeMemory(parsed);
    next.updatedAt = new Date().toISOString();
    writeMemory(compactMemory(next));
    console.log('[LifeOS Memory] smart memory updated by Gemini');
    } catch (error) {
    console.warn('[LifeOS Memory] Gemini summarizer unavailable:', error.message);
  }
}


function getMemory() {
  const memory = readMemory();
  const out = { ...memory };
  for (const key of ['preferences', 'goals', 'subjects', 'learningStyle', 'importantFacts', 'recentTopics']) {
    out[key] = (memory[key] || []).map((item) => item.text || String(item));
  }
  return out;
}

// ============================================================
// SETTINGS
// ============================================================

function getSettings() {
  const config =
    readConfig();

  const keys = {};
  const keySources = {};

  for (const provider of Object.keys(
    AI_PROVIDERS
  )) {
    const stored =
      getStoredKey(provider);

    const env =
      getEnvKey(provider);

    keys[provider] =
      stored || env
        ? 'configured'
        : '';

    keySources[provider] =
      stored
        ? 'local'
        : env
        ? 'env'
        : 'none';
  }

  let provider =
    config.provider || '';

  // If selected provider doesn't exist,
  // fall back to first configured provider
  // according to priority.
  if (
    !provider ||
    !AI_PROVIDERS[provider]
  ) {
    provider =
      PROVIDER_PRIORITY.find(
        (p) => keys[p]
      ) || 'offline';
  }

  // If saved provider exists but has no key,
  // automatically choose another configured provider.
  if (
    provider !== 'offline' &&
    !keys[provider]
  ) {
    provider =
      PROVIDER_PRIORITY.find(
        (p) => keys[p]
      ) || 'offline';
  }

  const discovered = readDiscoveredModels();
  const availableModels = {};
  for (const p of Object.keys(AI_PROVIDERS)) {
    const disc = discovered.models?.[p] || [];
    const base = AI_PROVIDERS[p].models || [];
    availableModels[p] = [...new Set([...disc, ...base])];
  }

  return {
    provider,

    models:
      Object.fromEntries(
        Object.keys(
          AI_PROVIDERS
        ).map((p) => [
          p,
          getModel(p),
        ])
      ),

    availableModels,
    discoveredModels: discovered.models || {},
    lastDiscoveryDate: discovered.lastCheckDate || null,
    lastDiscoveryTimestamp: discovered.lastCheckTimestamp || 0,

    availableProviders:
      getAvailableProviders(),

    keys,

    keySources,

    configured:
      provider !== 'offline' &&
      Boolean(keys[provider]),
  };
}

function saveSettings({
  provider,
  keys = {},
  models = {},
}) {
  const current =
    readConfig();

  const next = {
    provider:
      provider || 'offline',

    models: {
      ...(current.models || {}),
    },

    keys: {
      ...(current.keys || {}),
    },
  };

  let hasNewKey = false;
  for (const p of Object.keys(
    AI_PROVIDERS
  )) {
    if (models[p]) {
      next.models[p] =
        models[p];
    }

    // Empty key field means:
    // keep existing key.
    if (
      typeof keys[p] === 'string' &&
      keys[p].trim()
    ) {
      next.keys[p] =
        encryptSecret(
          keys[p].trim()
        );
      hasNewKey = true;
    }
  }

  writeConfig(next);

  // If new keys were saved, trigger discovery immediately
  if (hasNewKey) {
    setTimeout(() => {
      refreshDailyModels(true).catch((e) => console.warn('[LifeOS Discovery] Save trigger error:', e.message));
    }, 50);
  }

  return getSettings();
}

function clearKey(provider) {
  if (
    !AI_PROVIDERS[provider]
  ) {
    throw new Error(
      `Unknown AI provider: ${provider}`
    );
  }

  const current =
    readConfig();

  if (current.keys) {
    delete current.keys[
      provider
    ];
  }

  writeConfig(current);

  return getSettings();
}

// ============================================================
// JSON PARSER
// ============================================================

function parseJSON(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {}

  const fenced =
    text.match(
      /```(?:json)?\s*([\s\S]*?)```/i
    );

  if (fenced) {
    try {
      return JSON.parse(
        fenced[1].trim()
      );
    } catch {}
  }

  const objectMatch =
    text.match(
      /\{[\s\S]*\}/
    );

  if (objectMatch) {
    try {
      return JSON.parse(
        objectMatch[0]
      );
    } catch {}
  }

  const arrayMatch =
    text.match(
      /\[[\s\S]*\]/
    );

  if (arrayMatch) {
    try {
      return JSON.parse(
        arrayMatch[0]
      );
    } catch {}
  }

  return null;
}

// ============================================================
// GEMINI
// ============================================================

async function callGemini(
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  jsonMode = false,
  maxTokens = 4096
) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(
      model
    )}:generateContent`;

  const body = {
    system_instruction:
      systemPrompt
        ? {
            parts: [
              {
                text: systemPrompt,
              },
            ],
          }
        : undefined,

    contents: [
      {
        role: 'user',

        parts: [
          {
            text: userPrompt,
          },
        ],
      },
    ],

    generationConfig: {
      temperature: 0.7,

      maxOutputTokens:
        maxTokens,

      ...(jsonMode
        ? {
            responseMimeType:
              'application/json',
          }
        : {}),
    },
  };

  const res =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'x-goog-api-key':
            apiKey,
        },

        body: JSON.stringify(
          body
        ),
      }
    );

  if (!res.ok) {
    throw new Error(
      `Gemini API error (${res.status}): ${await res.text()}`
    );
  }

  const data =
    await res.json();

  const parts =
    data.candidates?.[0]
      ?.content?.parts || [];

  return parts
    .map(
      (part) =>
        part.text || ''
    )
    .join('');
}

// ============================================================
// OPENAI-COMPATIBLE PROVIDERS
// ============================================================

async function callOpenAICompatible(
  baseUrl,
  label,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  jsonMode = false,
  maxTokens = 4096
) {
  const messages = [];

  if (systemPrompt) {
    messages.push({
      role: 'system',
      content: systemPrompt,
    });
  }

  messages.push({
    role: 'user',
    content: userPrompt,
  });

  const body = {
    model,

    messages,

    temperature: 0.7,

    max_tokens:
      maxTokens,
  };

  if (jsonMode) {
    body.response_format = {
      type: 'json_object',
    };
  }

  const res =
    await fetch(
      baseUrl,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          Authorization:
            `Bearer ${apiKey}`,
          'api-subscription-key': apiKey,
        },

        body: JSON.stringify(
          body
        ),
      }
    );

  if (!res.ok) {
    throw new Error(
      `${label} API error (${res.status}): ${await res.text()}`
    );
  }

  const data =
    await res.json();

  return (
    data.choices?.[0]
      ?.message?.content || ''
  );
}

// ============================================================
// UNIFIED AI CALL
// ============================================================

async function callAI(
  provider,
  systemPrompt,
  userPrompt,
  jsonMode = false,
  maxTokens = 4096
) {
  if (
    !AI_PROVIDERS[provider]
  ) {
    throw new Error(
      'No valid AI provider selected.'
    );
  }

  const apiKey =
    getStoredKey(provider) ||
    getEnvKey(provider);

  if (!apiKey) {
    throw new Error(
      `${provider} is not configured. Add an API key in Profile → AI Settings.`
    );
  }

  const model =
    getModel(provider);

  console.log(
    `[LifeOS AI] provider=${provider} model=${model} maxTokens=${maxTokens}`
  );

  if (provider === 'gemini') {
    return callGemini(
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      jsonMode,
      maxTokens
    );
  }

  if (provider === 'groq') {
    return callOpenAICompatible(
      'https://api.groq.com/openai/v1/chat/completions',
      'Groq',
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      jsonMode,
      maxTokens
    );
  }

  throw new Error(
    'Unsupported AI provider.'
  );
}

// ============================================================
// OPERATION PROMPTS
// ============================================================

function operationPrompt(operation, args = {}) {
  if (operation === 'chat') {
    const message = String(args.message || '').trim();
    if (!message) return { json: false, prompt: 'Ask the student what they would like help with.', maxTokens: 80 };
    if (isCasualMessage(message)) {
      return { json: false, prompt: `Reply naturally and briefly to this casual message. Do not continue an old study topic.\nStudent: ${message}`, maxTokens: 120 };
    }
    const history = Array.isArray(args.history) ? args.history.slice(-8).map((m) => `${m?.role === 'assistant' ? 'assistant' : 'student'}: ${String(m?.text || '').slice(0, 2500)}`).join('\n') : '';
    const context = args.context && typeof args.context === 'object' ? JSON.stringify(args.context).slice(0, 6500) : '{}';
    const relevant = relevantMemoryContext(message, 12);
    return {
      json: false,
      prompt: `Answer the student's latest message directly. Use history only for continuity. Current message overrides old context.\n\nLifeOS context (optional):\n${context}\n\nRelevant long-term memory (use only if relevant):\n${JSON.stringify(relevant).slice(0, 5000)}\n\nRecent conversation:\n${history || '(none)'}\n\nStudent:\n${message}`,
      maxTokens: 1100,
    };
  }

  if (operation === 'generateCards') {
    const count = Math.max(1, Math.min(Number(args.count) || 8, 30));
    const sourceText = String(args.sourceText || '').slice(0, 14000);
    const existing = Array.isArray(args.existingQuestions) ? args.existingQuestions.slice(0, 80) : [];
    const mastery = Number(args.masteryScore) || 0;
    const target = args.targetDifficulty || (mastery >= 75 ? 'hard' : mastery >= 45 ? 'medium' : 'easy');
    return {
      json: true,
      maxTokens: Math.min(7500, Math.max(2000, count * 220)),
      prompt: `Generate ${count} NOVEL, high-quality study flashcards from the source. Target difficulty: ${target}.\nStudent topic mastery: ${mastery}/100.\nDo NOT repeat, paraphrase, or merely reorder any existing question. Use different cognitive angles: definition, mechanism, comparison, application, derivation, misconception, transfer, exam-style reasoning. Prefer medium/hard depth when mastery is high.\nReturn ONLY JSON:\n{"cards":[{"question":"...","answer":"...","explanation":"...","card_type":"flashcard","difficulty":"easy|medium|hard"}]}\nFor multiple_choice include exactly 4 options and answer_index.\nTopic: ${args.topic || 'general'}\nExisting questions:\n${existing.map((q) => `- ${q}`).join('\n') || '(none)'}\n\nSource:\n${sourceText}`,
    };
  }

  if (operation === 'evaluateCardAnswer') {
    return {
      json: true,
      maxTokens: 900,
      prompt: `Evaluate a student's written answer to a study flashcard. Be fair: equivalent wording and mathematically/scientifically correct reasoning count. Do not require exact wording.\nReturn ONLY JSON:\n{"correctness":0.0,"rating":"again|hard|good|easy","feedback":"...","missing_points":[],"model_answer":"...","next_difficulty":"easy|medium|hard"}\nDifficulty progression: strong answer can increase one level; mostly correct maintains; weak/wrong decreases or reinforces. Never jump more than one level.\nQuestion: ${args.question || ''}\nExpected answer: ${args.expectedAnswer || ''}\nExplanation: ${args.explanation || ''}\nCard difficulty: ${args.difficulty || 'medium'}\nStudent answer: ${args.studentAnswer || ''}`,
    };
  }

  if (operation === 'generateQuickCheck') {
    const count = Math.max(1, Math.min(Number(args.count) || 5, 20));
    return { json: true, maxTokens: Math.min(5000, Math.max(1200, count * 220)), prompt: `Generate ${count} multiple-choice questions about "${args.topic || 'this topic'}". Return ONLY JSON: {"questions":[{"type":"multiple_choice","question":"...","options":["...","...","...","..."],"answer_index":0,"explanation":"..."}]}` };
  }

  if (operation === 'explainConcept') {
    const depth = args.depth || 'deeper';
    return { json: true, maxTokens: depth === 'deeper' ? 1800 : 1200, prompt: `Explain "${args.concept || 'this concept'}" at depth "${depth}". Return ONLY JSON: {"summary":"...","key_points":[],"analogy":"...","example":"...","related_concepts":[]}.` };
  }

  if (operation === 'teachStep') {
    const step = Number(args.step) || 0;
    return { json: true, maxTokens: 1600, prompt: step === 0 ? `Start teaching "${args.concept || 'this concept'}" Socratically. Return ONLY JSON: {"evaluation":"...","correct_points":[],"missing_points":[],"explanation":"...","follow_up_question":"...","is_complete":false}` : `Continue teaching "${args.concept || 'this concept'}". Student response: ${args.userResponse || ''}\nHistory: ${args.conversationHistory || ''}\nReturn ONLY JSON: {"evaluation":"...","correct_points":[],"missing_points":[],"explanation":"...","follow_up_question":"...","is_complete":false}` };
  }

  if (operation === 'exploreTopic') {
    return { json: true, maxTokens: 1800, prompt: `Explore "${args.topic || 'this topic'}" in direction "${args.direction || 'broader'}". Return ONLY JSON: {"return_note":"...","concepts":[{"name":"...","description":"...","relationship":"...","why_interesting":"..."}]}` };
  }

  if (operation === 'recommend') {
    const context = args.context && typeof args.context === 'object' ? args.context : {};
    return { json: true, maxTokens: 1400, prompt: `Recommend the next best study action using this Brihaspati context. Return ONLY JSON: {"headline":"...","reasons":[],"encouragement":"...","signals":{"subject_id":null,"subjectName":"...","topicName":"...","actionTitle":"...","recommendedDuration":25,"daysUntilDeadline":7}}\nContext: ${JSON.stringify(context).slice(0, 18000)}` };
  }
  throw new Error(`Unsupported AI operation: ${operation}`);
}

async function callTavily(query, options = {}) {
  const apiKey = getStoredKey('tavily') || getEnvKey('tavily');
  if (!apiKey) throw new Error('Tavily is not configured. Add TAVILY_API_KEY to the Brihaspati environment or configure it in AI settings.');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query: String(query || '').slice(0, 1200), search_depth: 'basic', max_results: 6, include_answer: false, include_raw_content: false, ...options }),
  });
  if (!res.ok) throw new Error(`Tavily API error (${res.status}): ${await res.text()}`);
  return await res.json();
}

function formatTavilyResults(data) {
  return (data?.results || []).slice(0, 6).map((r, i) => `${i + 1}. ${r.title || 'Result'}\nURL: ${r.url || ''}\nSnippet: ${String(r.content || '').slice(0, 900)}`).join('\n\n');
}

// ============================================================
// NEOCOACH AI GATEWAY
// ============================================================

aiGateway = new BrihaspatiAIGateway({
  userDataPath: app.getPath('userData'),

  getSecrets: async () => ({
    gemini: getStoredKey('gemini') || getEnvKey('gemini'),
    groq: getStoredKey('groq') || getEnvKey('groq'),
  }),

  getModels: async () => ({
    gemini: getModel('gemini'),
    groq: getModel('groq'),
  }),
});

// ============================================================
// HANDLE AI REQUEST
// ============================================================

async function handleAIRequest({ operation, args = {} }) {
  if (!aiGateway) {
    throw new Error('Brihaspati AI Gateway is not initialized.');
  }

  return aiGateway.invoke(operation, args);
}

// ============================================================
// IPC
// ============================================================

ipcMain.handle(
  'ai:get-settings',
  () => {
    return getSettings();
  }
);

ipcMain.handle(
  'ai:save-settings',
  (_event, payload) => {
    try {
      return saveSettings(
        payload || {}
      );
    } catch (error) {
      console.error('[Brihaspati AI] MESSAGE:', error?.message);
      console.error('[Brihaspati AI] CODE:', error?.code);
      console.error('[Brihaspati AI] PROVIDER ERRORS:', JSON.stringify(error?.errors, null, 2));
      console.error('[Brihaspati AI] STACK:', error?.stack);

      return {
        ok: false,
        error:
          error?.message ||
          'Failed to save AI settings.',
      };
    }
  }
);

ipcMain.handle(
  'ai:clear-key',
  (_event, provider) => {
    try {
      return clearKey(
        provider
      );
    } catch (error) {
      console.error(
        '[Brihaspati AI Settings]',
        error
      );

      return {
        ok: false,
        error:
          error?.message ||
          'Failed to clear API key.',
      };
    }
  }
);

ipcMain.handle(
  'ai:get-memory',
  () => {
    return getMemory();
  }
);

ipcMain.handle(
  'ai:clear-memory',
  () => {
    writeMemory(
      defaultMemory()
    );

    return getMemory();
  }
);

ipcMain.handle(
  'ai:get-metrics',
  () => aiGateway.getMetrics()
);

ipcMain.handle(
  'ai:refresh-models',
  async (_event, provider) => {
    try {
      const discovery = await refreshDailyModels(true);
      return { ok: true, discovery, settings: getSettings() };
    } catch (error) {
      console.error('[Brihaspati AI] refresh-models error:', error?.message || error);
      return { ok: false, error: error?.message || 'Failed to discover models', settings: getSettings() };
    }
  }
);

ipcMain.handle(
  'ai:clear-cache',
  () => aiGateway.clearCache()
);

ipcMain.handle(
  'ai:clear-log',
  () => aiGateway.clearLog()
);

ipcMain.handle(
  'system:show-notification',
  (event, { title, body } = {}) => {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: title || 'Brihaspati', body: body || '' });
      notification.on('click', () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        }
      });
      notification.show();
      return { ok: true };
    }
    return { ok: false, reason: 'Notification not supported' };
  }
);

ipcMain.handle('system:focus-app', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
// ============================================================
// VOICE TRANSCRIBER IPC HANDLERS
// ============================================================
let voiceTranscriberProcess = null;

ipcMain.handle('voice:start', async (event, opts = {}) => {
  if (voiceTranscriberProcess) {
    return { status: 'already_running' };
  }

  const model = opts.model || 'small';
  const pythonPath = 'python';
  let scriptPath = path.join(__dirname, '../python/voice_transcriber.py');
  if (app.isPackaged) {
    const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'python', 'voice_transcriber.py');
    if (fs.existsSync(unpackedPath)) scriptPath = unpackedPath;
  }

  voiceTranscriberProcess = spawn(pythonPath, [
    scriptPath,
    '--model', model
  ]);

  voiceTranscriberProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line);
        if (mainWindow) {
          mainWindow.webContents.send('voice:event', payload);
        }
      } catch (e) {
        // Output from pip or warnings may not be JSON
        console.error('[VoiceTranscriber stdout parse error]:', line);
      }
    }
  });

  voiceTranscriberProcess.stderr.on('data', (data) => {
    console.error(`[VoiceTranscriber stderr]: ${data.toString()}`);
  });

  voiceTranscriberProcess.on('close', (code) => {
    console.log(`[VoiceTranscriber] exited with code ${code}`);
    voiceTranscriberProcess = null;
    if (mainWindow) {
      mainWindow.webContents.send('voice:event', { type: 'stopped' });
    }
  });

  return { status: 'started' };
});

ipcMain.handle('voice:stop', async () => {
  if (voiceTranscriberProcess) {
    voiceTranscriberProcess.stdin.write('stop\n');
    return { status: 'stopping' };
  }
  return { status: 'not_running' };
});

ipcMain.handle('voice:status', async () => {
  return { status: voiceTranscriberProcess ? 'running' : 'stopped' };
});



ipcMain.handle(
  'ai:record-feedback',
  (_event, payload = {}) => aiGateway.recordFeedback(payload)
);

ipcMain.handle(
  'ai:invoke',
  async (_event, payload) => {
    try {
      const result = await handleAIRequest(payload || {});

      return {
        ok: true,
        result,
      };
    } catch (error) {
      console.error(
        '[Brihaspati AI]',
        error
      );

      return {
        ok: false,
        error:
          error?.message ||
          'AI request failed.',
      };
    }
  }
);

// Streaming AI IPC: forwards provider chunks from the main process to the
// requesting renderer without exposing provider API keys to the UI process.
ipcMain.on('ai:stream', async (event, payload = {}) => {
  const requestId = String(payload.requestId || '');
  if (!requestId || !aiGateway) {
    event.sender.send('ai:stream:error', {
      requestId,
      error: !aiGateway ? 'Brihaspati AI Gateway is not initialized.' : 'Missing stream request ID.',
    });
    return;
  }

  try {
    const result = await aiGateway.stream(
      payload.operation || 'chat',
      payload.args || {},
      async (text, meta = {}) => {
        if (event.sender.isDestroyed()) return;
        event.sender.send('ai:stream:chunk', {
          requestId,
          text: String(text || ''),
          ...meta,
        });
      }
    );

    if (!event.sender.isDestroyed()) {
      event.sender.send('ai:stream:done', {
        requestId,
        ok: true,
        result,
      });
    }
  } catch (error) {
    console.error('[Brihaspati AI Stream]', error);
    if (!event.sender.isDestroyed()) {
      event.sender.send('ai:stream:error', {
        requestId,
        error: error?.message || 'AI streaming request failed.',
        errors: error?.errors || null,
        partialReply: error?.partialReply || '',
      });
    }
  }
});

// ============================================================
// LOCAL DATA STORE PERSISTENCE (Notes, Tasks, Assignments)
// ============================================================

function dataStorePath() {
  const p = path.join(app.getPath('userData'), 'brihaspati-data-store.json');
  const legacy = path.join(app.getPath('userData'), 'lifeos-data-store.json');
  if (!fs.existsSync(p) && fs.existsSync(legacy)) return legacy;
  return p;
}

ipcMain.handle('storage:get-data', async () => {
  try {
    const p = dataStorePath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (error) {
    console.warn('[Brihaspati Storage] Failed to read disk data store:', error.message);
    return null;
  }
});

ipcMain.handle('storage:save-data', async (_event, data) => {
  try {
    const p = path.join(app.getPath('userData'), 'brihaspati-data-store.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data || {}, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { ok: true };
  } catch (error) {
    console.warn('[Brihaspati Storage] Failed to save disk data store:', error.message);
    return { ok: false, error: error.message };
  }
});

// ============================================================
// FOCUS GUARD v24 — SINGLE-CONTROLLER ENFORCEMENT ENGINE
// ============================================================
//
// One lifecycle, exactly as contracted:
//
//   activateFocusGuard()
//     -> automatic preflight self-test (refuses to activate on failure)
//     -> starts EVERY enforcement component
//     -> continuous health monitoring with automatic fail-safe recovery
//
//   stopFocusGuard()
//     -> the ONE teardown for Deactivate, Emergency Restore, repair,
//        activation rollback, stale recovery and app quit
//     -> stops ALL workers/watchers/timers/subprocesses
//     -> removes ALL Focus Guard firewall/proxy rules
//     -> restores the EXACT saved network configuration
//     -> clears Focus Guard state only AFTER restoration is verified
//     -> idempotent; tolerates components that already crashed
//
// Core safety rules:
// 1. LifeOS itself is never terminated, frozen, or blocked. Its PID,
//    executable path and entire child process tree are protected from the
//    app allowlist worker.
// 2. The study UI never performs synchronous PowerShell/netsh work; every
//    Windows operation here is async so the renderer stays responsive.
// 3. Web filtering uses one local HTTP/HTTPS proxy plus per-browser direct
//    outbound blocks. Search engines and AI/research sites are always
//    allowed, so web search keeps working during Focus.
// 4. If restoration cannot be verified, Guard stays logically active so the
//    user keeps a working Emergency Restore path. State is never erased on
//    an unverified machine.

const crypto = require('crypto');
const net = require('net');
const dns = require('dns');
const { STUDY_CATEGORIES, ALL_STUDY_DOMAINS, STUDY_DOMAIN_SET, isStudyDomainAllowed, normalizeDomain, applyHostsBlocklist, removeHostsBlocklist, updateCustomDomainSet, DEFAULT_DISTRACTING_DOMAINS } = require('./focusGuardWebPolicy.cjs');
const { startNetworkEnforcement, stopNetworkEnforcement, isNetworkEnforcementHealthy, RULE_PREFIX } = require('./focusGuardNetworkEnforcer.cjs');
const { startFocusProxy, stopFocusProxy, enableSystemProxy, disableSystemProxy, isProxyAlive } = require('./focusGuardProxy.cjs');

const FG_SESSION_FILE = 'focus-guard-session.json';
const FG_WORKER_FILE = 'focusGuardWorker.ps1';
const FG_ENFORCER_FILE = 'focusGuardEnforcer.cjs';
const FG_RUNTIME_FILE = 'focus-guard-runtime.json';
const FG_HOSTS_BACKUP_FILE = 'focus-guard-hosts-backup.txt';
const FG_EMERGENCY_HOTKEY = 'Control+Alt+Shift+F12';
const LOCALHOST_EXCLUSIONS = ['localhost','localhost.localdomain','127.0.0.1'];
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32\\drivers\\etc\\hosts');

function focusGuardConfigPath(){return path.join(app.getPath('userData'),'focus-guard.json');}
function focusGuardSessionPath(){return path.join(app.getPath('userData'),FG_SESSION_FILE);}
function focusGuardRuntimePath(){return path.join(app.getPath('userData'),FG_RUNTIME_FILE);}
function focusGuardHostsBackupPath(){return path.join(app.getPath('userData'),FG_HOSTS_BACKUP_FILE);}
function verifyHostsFileIntact(){
  try {
    if (fs.existsSync(HOSTS_PATH)) {
      const content = fs.readFileSync(HOSTS_PATH, 'utf8');
      return Boolean(content);
    }
    return false;
  } catch { return false; }
}
function focusGuardExternalDir(){
  if(!app.isPackaged) return __dirname;
  return path.join(process.resourcesPath,'app.asar.unpacked','electron');
}
function focusGuardWorkerPath(){return path.join(focusGuardExternalDir(),FG_WORKER_FILE);}
function focusGuardEnforcerPath(){return path.join(focusGuardExternalDir(),FG_ENFORCER_FILE);}
function atomicWriteJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');
  try{fs.renameSync(tmp,file);}catch{
    try{fs.rmSync(file,{force:true});fs.renameSync(tmp,file);}catch(e){try{fs.rmSync(tmp,{force:true});}catch{};throw e;}
  }
}

function defaultFocusGuardConfig(){
  return {
    allowedApps:[
      { id: 'default-zen', name: 'Zen Browser', executableName: 'zen.exe', enabled: true, category: 'study', reason: 'Default Web Browser' },
      { id: 'default-chrome', name: 'Google Chrome', executableName: 'chrome.exe', enabled: true, category: 'study', reason: 'Web browsing for study' },
      { id: 'default-edge', name: 'Microsoft Edge', executableName: 'msedge.exe', enabled: true, category: 'study', reason: 'Web browsing for study' },
      { id: 'default-firefox', name: 'Mozilla Firefox', executableName: 'firefox.exe', enabled: true, category: 'study', reason: 'Web browsing for study' },
      { id: 'default-brave', name: 'Brave Browser', executableName: 'brave.exe', enabled: true, category: 'study', reason: 'Web browsing for study' },
      { id: 'default-discord', name: 'Discord', executableName: 'discord.exe', enabled: true, category: 'communication', reason: 'Student preference allow rule' },
      { id: 'default-mydockfinder', name: 'MyDockFinder', executableName: 'mydockfinder.exe', enabled: true, category: 'utility', reason: 'User custom desktop dock' },
      { id: 'default-vscode', name: 'Visual Studio Code', executableName: 'code.exe', enabled: true, category: 'developer', reason: 'Study IDE' },
      { id: 'default-cursor', name: 'Cursor Editor', executableName: 'cursor.exe', enabled: true, category: 'developer', reason: 'AI Code Editor' },
      { id: 'default-word', name: 'Microsoft Word', executableName: 'winword.exe', enabled: true, category: 'productivity', reason: 'Document editing' },
      { id: 'default-calculator', name: 'Windows Calculator', executableName: 'calc.exe', enabled: true, category: 'utility', reason: 'Windows Calculator' },
      { id: 'default-snippingtool', name: 'Snipping Tool', executableName: 'snippingtool.exe', enabled: true, category: 'utility', reason: 'Snip & Sketch Tool' },
      { id: 'default-notepad', name: 'Notepad', executableName: 'notepad.exe', enabled: true, category: 'utility', reason: 'Windows Text Editor' },
      { id: 'default-anki', name: 'Anki Flashcards', executableName: 'anki.exe', enabled: true, category: 'study', reason: 'Spaced repetition flashcards' },
      { id: 'default-obsidian', name: 'Obsidian', executableName: 'obsidian.exe', enabled: true, category: 'productivity', reason: 'Note taking' }
    ],
    blockedApps: getDistractingAppsList(),
    allowedSites: [],
    appTimeLimits: {}, // { "executable.exe": { limitMinutes: 30, usedSecondsToday: 0 } }
    hourlyReminder:true,
    blockSites:true,
    blockApps:true,
    blockAllApps:true,
    allowlistApps:true,
    breakPin:'',
    requireReason:true
  };
}

function readFocusGuardConfig(){
  try{
    const f=focusGuardConfigPath();
    const stored=fs.existsSync(f)?(JSON.parse(fs.readFileSync(f,'utf8'))||{}):{};
    const defaultBlocked = getDistractingAppsList();
    const allowedExes = new Set((stored.allowedApps || []).map(x => String(x.executableName || '').toLowerCase()));
    let effectiveBlocked = defaultBlocked.filter(x => !allowedExes.has(String(x.executableName || '').toLowerCase()));
    if (Array.isArray(stored.blockedApps) && stored.blockedApps.length >= 50) {
      effectiveBlocked = stored.blockedApps.filter(x => !allowedExes.has(String(x.executableName || '').toLowerCase()));
    } else if (Array.isArray(stored.blockedApps) && stored.blockedApps.length > 0) {
      const existingExes = new Set(stored.blockedApps.map(x => String(x.executableName || '').toLowerCase()));
      const addedDefaults = defaultBlocked.filter(x => 
        !existingExes.has(String(x.executableName || '').toLowerCase()) && 
        !allowedExes.has(String(x.executableName || '').toLowerCase())
      );
      effectiveBlocked = [...stored.blockedApps.filter(x => !allowedExes.has(String(x.executableName || '').toLowerCase())), ...addedDefaults];
    }
    const config = {
      ...defaultFocusGuardConfig(),
      ...stored,
      allowedApps:Array.isArray(stored.allowedApps) && stored.allowedApps.length ? stored.allowedApps : defaultFocusGuardConfig().allowedApps,
      blockedApps:effectiveBlocked,
      allowedSites: Array.isArray(stored.allowedSites) ? stored.allowedSites : [],
      customBlockedSites: Array.isArray(stored.customBlockedSites) ? stored.customBlockedSites : [],
      appTimeLimits: typeof stored.appTimeLimits === 'object' && stored.appTimeLimits !== null ? stored.appTimeLimits : {},
      blockSites:stored.blockSites!==false,
      blockApps:stored.blockApps!==false,
      blockAllApps:stored.allowlistApps===true||stored.blockAllApps===true,
      allowlistApps:stored.allowlistApps===true||stored.blockAllApps===true,
    };
    updateCustomDomainSet(config.allowedSites, config.customBlockedSites);
    return config;
  }catch(e){console.warn('[FocusGuard] config read failed:',e.message);return defaultFocusGuardConfig();}
}
function writeFocusGuardConfig(cfg){atomicWriteJson(focusGuardConfigPath(),cfg);}

// ---------- Async Windows helpers ----------
function execFileAsync(file,args,options={}){
  return new Promise((resolve,reject)=>{
    let settled = false;
    const timeoutMs = options.timeout || 15000;
    
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Hard timeout: ${file} took longer than ${timeoutMs}ms`));
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs + 1000); // 1s grace period after soft timeout

    const child = execFile(file,args,{encoding:'utf8',windowsHide:true,...options},(error,stdout,stderr)=>{
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if(error){const e=new Error(String(stderr||stdout||error.message||error).trim()||`${file} failed`);e.code=error.code;e.killed=error.killed;return reject(e);}
      resolve({stdout:String(stdout||''),stderr:String(stderr||'')});
    });
  });
}

function runPowerShell(script,timeout=12000){
  return execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{timeout,maxBuffer:1024*1024});
}

async function currentUserSid(){
  if(process.platform!=='win32')return '';
  try{
    const {stdout}=await execFileAsync('whoami.exe',['/user','/fo','csv','/nh'],{timeout:1500,maxBuffer:128*1024});
    return String(stdout).match(/\"(S-\d-\d+(?:-\d+)+)\"/i)?.[1]||String(stdout).match(/S-\d-\d+(?:-\d+)+/i)?.[0]||'';
  }catch{return '';}
}

function parseWhoAmI(output){
  const text=String(output||'');
  const sid=text.match(/S-\d-\d+(?:-\d+)+/i)?.[0]||'';
  const quoted=(text.match(/\"([^\"]+)\"/g)||[]).map(x=>x.slice(1,-1));
  const isAdminGroup=/S-1-5-32-544/i.test(text);
  const denyOnly=/deny only/i.test(text);
  return {name:quoted[0]||'',sid,isAdmin:isAdminGroup&&!denyOnly,reason:isAdminGroup&&!denyOnly?'elevated':'not-elevated'};
}

let cachedAdminStatus = process.platform==='win32'
  ? {isAdmin:null,name:'',sid:'',reason:'checking'}
  : {isAdmin:true,name:'',sid:'',reason:'non-windows'};

function refreshAdminStatus(){
  if(process.platform!=='win32')return;
  execFileAsync('whoami.exe',['/user','/groups','/fo','csv','/nh'],{timeout:1500,maxBuffer:256*1024})
    .then(({stdout})=>{cachedAdminStatus=parseWhoAmI(stdout);})
    .catch(error=>{cachedAdminStatus={...cachedAdminStatus,isAdmin:null,reason:`admin-check-unavailable:${error.code||error.message}`};});
}
function getAdminStatus(){return cachedAdminStatus;}

// ---------- Focus Guard: isolated, fail-safe enforcement ----------
let focusGuardActive = false;
let focusGuardLifecycle = 'OFF';
let focusGuardLastAppSweepAt = 0;
let focusGuardBlockedCount = 0;
let focusGuardLastBlocked = [];
let focusGuardAppSweepFailures = 0;
let focusGuardEnforcerProcess = null;
let focusGuardEnforcerReady = false;
let focusGuardEnforcerLastHeartbeat = 0;
let focusGuardEnforcerReadyWaiter = null;
let focusGuardCleanupPromise = null;
let focusGuardHeartbeatTimer = null;
let focusGuardActivationPromise = null;
let focusGuardSessionId = null;
let focusGuardRunGeneration = 0;

function newFocusGuardSessionId(){
  return `fg-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function readFocusGuardSession(){try{const f=focusGuardSessionPath();return fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):null;}catch{return null;}}
function writeFocusGuardSession(p){atomicWriteJson(focusGuardSessionPath(),{...(readFocusGuardSession()||{}),...p});}
function removeFocusGuardSession(){try{fs.unlinkSync(focusGuardSessionPath());}catch{}}

function setFocusGuardLifecycle(next, extra={}){
  focusGuardLifecycle=next;
  try{writeFocusGuardSession({status:next==='VERIFIED_NORMAL'?'off':next.toLowerCase(),lifecycle:next,...extra});}catch{}
  console.log(`[FocusGuard] LIFECYCLE ${next}${extra.reason?` reason=${extra.reason}`:''}`);
}

function stopFocusGuardHeartbeat(){if(focusGuardHeartbeatTimer){clearInterval(focusGuardHeartbeatTimer);focusGuardHeartbeatTimer=null;}}
function startFocusGuardHeartbeat(){
  stopFocusGuardHeartbeat();
  focusGuardHeartbeatTimer=setInterval(()=>{
    if(!focusGuardActive)return;
    try{writeFocusGuardSession({lastHeartbeat:new Date().toISOString(),parentPid:process.pid,status:'active',appLastSweepAt:focusGuardLastAppSweepAt||null});}catch{}
    // Proxy health monitor: if the proxy died during a focus session, auto-restart
    // it to prevent total network blackout. This is the key fix for the "web search
    // not working" and "network completely blocked" bugs.
    try{
      const cfg=readFocusGuardConfig();
      if(cfg.blockSites!==false&&!isProxyAlive()){
        console.warn('[FocusGuard] Proxy server is down during active session — auto-restarting...');
        startFocusProxy().then(()=>enableSystemProxy()).then(()=>{
          console.log('[FocusGuard] Proxy auto-restarted and system proxy re-enabled.');
        }).catch(err=>{
          console.error('[FocusGuard] Proxy auto-restart failed:',err.message);
        });
      }
    }catch(e){console.warn('[FocusGuard] Proxy health check error:',e.message);}
  },3000);
}

function normalizeAppPath(value){
  const s=String(value||'').trim();
  if(!s)return '';
  try{return path.resolve(s).replace(/[\\/]+$/,'').toLowerCase();}catch{return s.replace(/[\\/]+$/,'').toLowerCase();}
}

function normalizeAppEntries(list){
  const rows=[];
  for(const raw of Array.isArray(list)?list:[]){
    const item=typeof raw==='string'?{path:raw}:(raw||{});
    const p=normalizeAppPath(item.path||item.executablePath);
    const exeNameRaw=String(item.executableName||'').trim();
    const executableName=(exeNameRaw|| (p?path.basename(p):'')).toLowerCase();
    const displayName=String(item.name||item.displayName||(p?path.basename(p,'.exe'):'')).trim();
    const name=displayName.toLowerCase();
    const appId=String(item.appId||item.packageFamilyName||'').trim().toLowerCase();
    const dirScope=normalizeAppPath(item.dirScope||'');
    if(!p&&!name&&!appId)continue;
    const key=(p||appId||`${executableName}|${name}`).toLowerCase();
    if(rows.some(x=>(x.path||x.appId||`${x.executableName||''}|${x.name||''}`).toLowerCase()===key))continue;
    rows.push({
      id:String(item.id||key),
      name:displayName,
      executableName,
      path:p,
      appId,
      dirScope,
      enabled:item.enabled!==false,
      category:String(item.category||''),
      confidence:Number.isFinite(Number(item.confidence))?Number(item.confidence):null,
      reason:String(item.reason||''),
    });
  }
  return rows;
}

function processNameOf(entry){
  const explicit=String(entry?.executableName||'').trim();
  if(explicit)return explicit.toLowerCase().endsWith('.exe')?explicit.toLowerCase():`${explicit.toLowerCase()}.exe`;
  const fromPath=entry?.path?path.basename(String(entry.path)):'';
  if(fromPath)return fromPath.toLowerCase().endsWith('.exe')?fromPath.toLowerCase():`${fromPath.toLowerCase()}.exe`;
  const display=String(entry?.name||'').trim().toLowerCase();
  return display.endsWith('.exe')?display:(display?`${display}.exe`:'');
}

function appRuleMatches(info,entry){
  const exe=normalizeAppPath(info?.path||info?.executablePath);
  const p=exe;
  const rulePath=normalizeAppPath(entry?.path||entry?.executablePath);
  if(entry.path&&exe&&exe===normalizeAppPath(entry.path))return true;
  if(rulePath&&p&&p===rulePath)return true;
  const wanted=processNameOf(entry);
  const n=String(info?.name||'').toLowerCase().endsWith('.exe')?String(info.name).toLowerCase():`${String(info?.name||'').toLowerCase()}.exe`;
  if(!rulePath&&wanted&&n===wanted)return true;
  const scope=normalizeAppPath(entry?.dirScope);
  return Boolean(scope&&p&&(p===scope||p.startsWith(`${scope}\\`)));
}

function isLifeOSExecutable(exe){
  const e=normalizeAppPath(exe);
  if(!e)return false;
  const roots=[
    normalizeAppPath(path.dirname(process.execPath)),
    normalizeAppPath(path.join(app.getAppPath(),'..')),
    normalizeAppPath(path.join(app.getPath('exe'),'..')),
  ].filter(Boolean);
  return roots.some(r=>e===r||e.startsWith(r+'\\'));
}

const VNEXT_PROTECTED_NAMES=new Set([
  'system','idle','registry','smss.exe','csrss.exe','wininit.exe','winlogon.exe','services.exe','lsass.exe','svchost.exe','dwm.exe','explorer.exe','sihost.exe','ctfmon.exe','fontdrvhost.exe','runtimebroker.exe','searchhost.exe','searchapp.exe','startmenuexperiencehost.exe','shellexperiencehost.exe','applicationframehost.exe','textinputhost.exe','securityhealthsystray.exe','securityhealthservice.exe','smartscreen.exe','taskhostw.exe','backgroundtaskhost.exe','dllhost.exe','spoolsv.exe','audiodg.exe','conhost.exe','openconsole.exe','windowsterminal.exe',
  'wudfhost.exe','msmpeng.exe','mpdefendercoreservice.exe','nissrv.exe','lsaiso.exe',
  'powershell.exe','pwsh.exe','cmd.exe','node.exe','git.exe','bash.exe','zsh.exe','wsl.exe','wslhost.exe','wt.exe','python.exe','python3.exe','py.exe','npm.exe','pnpm.exe','yarn.exe','bun.exe','deno.exe','electron.exe','lifeos.exe','brihaspati.exe',
  // Essential Windows Productivity & Utility Tools (Word, Calculator, Snipping Tool, Notepad, Paint, Office)
  'winword.exe','excel.exe','powerpnt.exe','onenote.exe','onenotem.exe','outlook.exe','soffice.exe','soffice.bin',
  'calc.exe','calculator.exe','calculatorapp.exe',
  'snippingtool.exe','screenclippinghost.exe','screensketch.exe','snipandsketch.exe',
  'notepad.exe','notepad++.exe','mspaint.exe','wordpad.exe','write.exe','taskmgr.exe',
  'antigravity.exe','gemini.exe','cursor.exe','claude.exe','ollama.exe','copilot.exe','lmstudio.exe','jan.exe','continue.exe','chatgpt.exe','codex.exe','codex-computer-use-swift.exe','openai.exe',
  'code.exe','code - insiders.exe','vscodium.exe','idea64.exe','pycharm64.exe','webstorm64.exe','rider64.exe','clion64.exe','datagrip64.exe','goland.exe','sublime_text.exe','zed.exe','neovide.exe',
  'zen.exe','chrome.exe','msedge.exe','firefox.exe','brave.exe','opera.exe','vivaldi.exe','arc.exe','waterfox.exe','tor.exe','librewolf.exe','chromium.exe',
  'mydockfinder.exe','mydockfinder64.exe','dock_64.exe','dock_32.exe','mydock.exe','dock.exe'
]);

function VNEXT_PROTECTED_ROOTS() {
  const win = normalizeAppPath(String(process.env.WINDIR || 'C:\\Windows'));
  return [
    win,
    `${win}/system32`,
    `${win}/syswow64`,
    `${win}/systemapps`,
    `${win}/winsxs`,
    'c:/program files/common files',
    'c:/program files (x86)/common files',
    'c:/program files/windowsapps'
  ];
}

const BUILTIN_ALLOWED_APP_NAMES=new Set([
  ...VNEXT_PROTECTED_NAMES,
  'lifeos.exe','brihaspati.exe','electron.exe','node.exe','powershell.exe','pwsh.exe','cmd.exe','conhost.exe'
]);

function appIsWisprFlow(info){
  const exe=normalizeAppPath(info?.path||info?.executablePath);
  const name=String(info?.name||'').toLowerCase();
  if(/\b(wispr|wisprflow|wispr_flow|flow)\.exe$/i.test(name))return true;
  if(exe&&/\b(wispr|wisprflow|wispr-flow)\b/i.test(exe))return true;
  return false;
}

function appIsProtected(info){
  const pid=Number(info?.pid||0);
  const exe=normalizeAppPath(info?.path||info?.executablePath);
  const name=String(info?.name||'').toLowerCase();
  if(pid<=100||pid===process.pid)return true;

  // Essential Windows Tools (Word, Calculator, Snip & Sketch, Notepad, etc.) must NEVER be protected/blocked
  if(/\b(winword|excel|powerpnt|onenote|onenotem|outlook|soffice|calc|calculator|calculatorapp|snippingtool|screenclippinghost|screensketch|snipandsketch|notepad|notepad\+\+|mspaint|wordpad|write|taskmgr)\.exe$/i.test(name))return true;

  // UWP apps (Calculator, Snipping Tool, etc.) run with these process names on modern Windows
  if(/\b(microsoft\.windowscalculator|microsoft\.screensketch|microsoft\.windows\.photos|microsoft\.paint|microsoft\.windowsalarms|microsoft\.windows\.notepad|microsoft\.windowsterminal|microsoft\.windowscamera|microsoft\.getstarted|microsoft\.windowssoundrecorder|microsoft\.windowsfeedbackhub|microsoft\.windowsstore|microsoft\.windbg|microsoft\.todos|microsoft\.people|microsoft\.windowsmaps|microsoft\.bingweather|microsoft\.windowscommunicationsapps|microsoft\.mspaint|microsoft\.screensketch)\b/i.test(name))return true;
  if(exe&&/\b(microsoft\.windowscalculator|microsoft\.screensketch|microsoft\.paint|microsoft\.windows\.notepad)\b/i.test(exe))return true;

  // WhatsApp must NEVER be protected
  if(/\b(whatsapp|whatsapp\.root|whatsappdesktop|whatsapphost)\.exe$/i.test(name)||(exe&&/\bwhatsapp\b/i.test(exe)))return false;

  if(appIsWisprFlow(info))return true;
  if(isLifeOSExecutable(exe))return true;
  if(VNEXT_PROTECTED_NAMES.has(name))return true;
  if(/\b(registry|memory compression|secure system|idle|system|msedgewebview2\.exe|aggregatorhost\.exe|backgroundtransferhost\.exe)\b/i.test(name))return true;
  if(exe&&(/\b(nvidia|intel|realtek|lenovo|amd|dts|dolby|synaptics|driverstore|windows defender|programdata\/microsoft|antigravity|gemini|cursor|vscode|jetbrains|ollama|claude|lifeos|brihaspati|\.gemini|zen browser|zen-browser|mydockfinder|mydock|openai|chatgpt|codex)\b/i.test(exe)))return true;
  if(name&&(/\b(nvsphelper64|defendersessionhelper|antigravity|gemini|cursor|code|node|powershell|pwsh|cmd|git|claude|ollama|collector_service|dsaupdateservice|dtsapo|esrv|ipf_helper|ipf_uf|jhi_service|presentmonservice|nvdisplay|msedgewebview2|zen|chrome|msedge|firefox|brave|opera|vivaldi|arc|mydockfinder|mydockfinder64|dock_64|dock_32|mydock|dock|winword|calc|calculator|calculatorapp|snippingtool|screenclippinghost|screensketch|snipandsketch|notepad|mspaint|chatgpt|codex|openai|brihaspati)\b/i.test(name)))return true;
  for(const root of VNEXT_PROTECTED_ROOTS())if(exe&&root&&(exe===root||exe.startsWith(root+'/')||exe.startsWith(root+'\\')))return true;
  return false;
}

function appMetadataText(appInfo){
  return [
    appInfo?.name,
    appInfo?.displayName,
    appInfo?.productName,
    appInfo?.fileDescription,
    appInfo?.companyName,
    appInfo?.publisher,
    appInfo?.executableName,
    appInfo?.path,
  ].filter(Boolean).join(' ');
}

function appIsBuiltInAllowed(appInfo){
  const exe=String(appInfo?.executableName||path.basename(String(appInfo?.path||''))).toLowerCase();
  if(BUILTIN_ALLOWED_APP_NAMES.has(exe))return true;
  const p=normalizeAppPath(appInfo?.path);
  if(isLifeOSExecutable(p))return true;
  if(p&&(/\b(antigravity|gemini|cursor|vscode|jetbrains|ollama|claude|lifeos|\.gemini)\b/i.test(p)))return true;
  return false;
}

function classifyAppWithBuiltInPolicy(appInfo){
  if(appIsBuiltInAllowed(appInfo)||appIsWisprFlow(appInfo))return {classification:'productive',confidence:100,category:'protected',reason:'Built-in core protection or Wispr Flow rule.'};
  const text=appMetadataText(appInfo);
  if(/\b(game|gaming|launcher|steam|epic games|riot|valorant|fortnite|roblox|minecraft|battle\.net|gog galaxy|tiktok|instagram|facebook|snapchat|netflix|prime video|disney|hotstar|torrent|xbox|playstation|ubisoft|ea app|electronic arts)\b/i.test(text)){
    return {classification:'distracting',confidence:88,category:'distracting',reason:'Installed app metadata matches distracting app pattern.'};
  }
  return {classification:'unknown',confidence:50,category:'other',reason:'No built-in rule matched.'};
}

function focusGuardLogEnforcerMessage(message){
  const type=String(message?.type||'').toUpperCase();
  const pid=Number(message?.pid||0);
  const name=String(message?.name||'process');
  const file=String(message?.path||'');
  if(type==='HEARTBEAT'||type==='SWEEP'){
    focusGuardEnforcerLastHeartbeat=Date.now();
    if(Number(message?.lastSweepAt||0))focusGuardLastAppSweepAt=Number(message.lastSweepAt);
    if(Number.isFinite(Number(message?.matches)))focusGuardBlockedCount=Number(message.matches);
    return;
  }
  if(type==='READY'){
    focusGuardEnforcerReady=true;
    focusGuardEnforcerLastHeartbeat=Date.now();
    if(Number(message?.lastSweepAt||0))focusGuardLastAppSweepAt=Number(message.lastSweepAt);
    if(Number.isFinite(Number(message?.matches)))focusGuardBlockedCount=Number(message.matches);
    console.log(`[AppBlock] WORKER ACTIVE pid=${pid||focusGuardEnforcerProcess?.pid||0} matches=${focusGuardBlockedCount}`);
    try{writeFocusGuardSession({appEnforcerPid:focusGuardEnforcerProcess?.pid||pid||null,appEnforcerReady:true});}catch{}
    if(focusGuardEnforcerReadyWaiter?.resolve){focusGuardEnforcerReadyWaiter.resolve(true);focusGuardEnforcerReadyWaiter=null;}
    return;
  }
  if(type==='STARTING'){console.log(`[AppBlock] STARTING pid=${pid||focusGuardEnforcerProcess?.pid||0} blocked=${message.configBlockedApps||0}`);return;}
  if(type==='BLOCK'){console.log(`[AppBlock] BLOCK ${name} pid=${pid} ${file}`);return;}
  if(type==='ALLOW'){console.log(`[AppBlock] ALLOW ${name} pid=${pid} ${file}`);return;}
  if(type==='PROTECTED'){console.log(`[AppBlock] PROTECTED ${name} pid=${pid} ${file} ${message.reason||''}`);return;}
  if(type==='TIME_LIMIT_EXCEEDED'){
    console.log(`[AppBlock] TIME_LIMIT_EXCEEDED ${name} pid=${pid} limit=${message.limitMinutes}m`);
    focusGuardLastBlocked=[...focusGuardLastBlocked,{name,pid,path:file,reason:`Time limit of ${message.limitMinutes}m reached`,at:message.ts||new Date().toISOString()}].slice(-30);
    
    // Show Desktop Notification
    if(Notification.isSupported()){
      const appTitle = message.exeName ? message.exeName.replace(/\.exe$/i, '') : name;
      const notif = new Notification({
        title: "⌛ App Time Limit Reached Today!",
        body: `Your daily time limit for ${appTitle} (${message.limitMinutes} min max) is over today! The app has been automatically closed.`
      });
      notif.show();
    }
    if(mainWindow && !mainWindow.isDestroyed()){
      mainWindow.webContents.send('focusguard:time-limit-exceeded', {
        name,
        exeName: message.exeName,
        limitMinutes: message.limitMinutes,
        usedSeconds: message.usedSeconds
      });
    }
    return;
  }
  if(type==='TERMINATED'){
    console.log(`[AppBlock] TERMINATED ${name} pid=${pid} ${file}`);
    focusGuardLastBlocked=[...focusGuardLastBlocked,{name,pid,path:file,at:message.ts||new Date().toISOString()}].slice(-30);
    return;
  }
  if(type==='TERMINATE_FAILED'){console.warn(`[AppBlock] TERMINATE_FAILED ${name} pid=${pid} ${file}`);return;}
  if(type==='SWEEP_ERROR'){
    focusGuardAppSweepFailures=Number(message.failures||focusGuardAppSweepFailures+1);
    console.warn(`[AppBlock] sweep failure=${focusGuardAppSweepFailures}: ${message.error||'unknown error'}`);
    return;
  }
  if(type==='FATAL'){
    console.error(`[AppBlock] FATAL reason=${message.reason||'unknown'} ${message.error||''}`);
    if(focusGuardActive){
      console.warn('[AppBlock] Enforcer reported fatal condition — scheduling auto-restart in 2s...');
      setTimeout(()=>{
        if(focusGuardActive){
          if(focusGuardEnforcerProcess){try{focusGuardEnforcerProcess.kill('SIGKILL');}catch{}focusGuardEnforcerProcess=null;}
          startAppEnforcement().catch(err=>console.error('[AppBlock] Enforcer auto-restart failed:',err.message));
        }
      },2000);
    }
    return;
  }
  if(type==='STOPPED')console.log(`[AppBlock] WORKER STOPPED pid=${focusGuardEnforcerProcess?.pid||pid||0}`);
}

function writeFocusGuardRuntimeHeartbeat(extra={}){
  try{atomicWriteJson(focusGuardRuntimePath(),{parentPid:process.pid,sessionId:focusGuardSessionId,lastHeartbeat:new Date().toISOString(),...extra});}catch{}
}
function clearFocusGuardRuntimeHeartbeat(){try{fs.unlinkSync(focusGuardRuntimePath());}catch{}}

function startFocusGuardRuntimeHeartbeat(){
  if(!focusGuardEnforcerProcess)return;
  if(startFocusGuardRuntimeHeartbeat.timer)clearInterval(startFocusGuardRuntimeHeartbeat.timer);
  writeFocusGuardRuntimeHeartbeat({enforcerPid:focusGuardEnforcerProcess.pid});
  startFocusGuardRuntimeHeartbeat.timer=setInterval(()=>{
    if(!focusGuardEnforcerProcess){clearInterval(startFocusGuardRuntimeHeartbeat.timer);startFocusGuardRuntimeHeartbeat.timer=null;return;}
    writeFocusGuardRuntimeHeartbeat({enforcerPid:focusGuardEnforcerProcess.pid});
  },1000);
}
function stopFocusGuardRuntimeHeartbeat(){
  if(startFocusGuardRuntimeHeartbeat.timer){clearInterval(startFocusGuardRuntimeHeartbeat.timer);startFocusGuardRuntimeHeartbeat.timer=null;}
  clearFocusGuardRuntimeHeartbeat();
}

function startAppEnforcement(){
  const cfg=readFocusGuardConfig();
  if(!focusGuardActive||cfg.blockApps===false)return Promise.resolve(true);
  if(focusGuardEnforcerProcess&&!focusGuardEnforcerProcess.killed)return Promise.resolve(focusGuardEnforcerReady);
  const scriptPath=focusGuardEnforcerPath();
  if(!fs.existsSync(scriptPath))return Promise.reject(new Error(`Focus Guard enforcer is missing: ${scriptPath}`));

  const appDir = path.dirname(process.execPath);
  const userDataDir = app.getPath('userData');

  const child=spawn(process.execPath,[
    scriptPath,
    '--config',focusGuardConfigPath(),
    '--runtime',focusGuardRuntimePath(),
    '--parentPid',String(process.pid),
    '--parentExePath',String(process.execPath),
    '--appDir',String(appDir),
    '--userData',String(userDataDir),
    '--sessionId',String(focusGuardSessionId||'')
  ],{
    cwd:path.dirname(scriptPath),windowsHide:true,detached:false,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']
  });
  focusGuardEnforcerProcess=child;
  focusGuardEnforcerReady=false;
  focusGuardEnforcerLastHeartbeat=Date.now();
  focusGuardLastAppSweepAt=0;
  focusGuardAppSweepFailures=0;
  startFocusGuardRuntimeHeartbeat();

  let buffer='';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data',chunk=>{
    buffer+=String(chunk||'');
    const lines=buffer.split(/\r?\n/);buffer=lines.pop()||'';
    for(const line of lines){if(!line.trim())continue;try{focusGuardLogEnforcerMessage(JSON.parse(line));}catch(err){console.warn('[AppBlock] enforcer message parse failed:',err.message);}}
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data',chunk=>{
    console.error(`[AppBlock Enforcer STDERR] ${String(chunk||'').trim()}`);
  });
  child.once('error',error=>{
    console.error('[AppBlock] WORKER ERROR:',error.message);
    if(focusGuardEnforcerReadyWaiter?.reject){focusGuardEnforcerReadyWaiter.reject(error);focusGuardEnforcerReadyWaiter=null;}
  });
  child.once('exit',(code,signal)=>{
    const wasExpected=focusGuardLifecycle==='STOPPING'||focusGuardLifecycle==='RESTORING'||focusGuardLifecycle==='VERIFIED_NORMAL'||!focusGuardActive;
    const deadPid=child.pid;
    if(focusGuardEnforcerProcess===child)focusGuardEnforcerProcess=null;
    focusGuardEnforcerReady=false;
    focusGuardEnforcerLastHeartbeat=0;
    if(focusGuardEnforcerReadyWaiter?.reject){focusGuardEnforcerReadyWaiter.reject(new Error(`Focus Guard enforcer exited before becoming ready (code=${code}, signal=${signal||'none'})`));focusGuardEnforcerReadyWaiter=null;}
    stopFocusGuardRuntimeHeartbeat();
    console.log(`[AppBlock] WORKER EXIT pid=${deadPid||0} code=${code} signal=${signal||'none'} expected=${wasExpected}`);
    try{writeFocusGuardSession({appEnforcerPid:null,appEnforcerReady:false});}catch{}
    if(!wasExpected && focusGuardActive){
      console.warn('[AppBlock] Enforcer worker exited unexpectedly — auto-restarting worker in 1s...'); /* reason:'app-enforcer-exited' */
      setTimeout(()=>{
        if(focusGuardActive && (!focusGuardEnforcerProcess || focusGuardEnforcerProcess.killed)){
          startAppEnforcement().then(ready=>console.log(`[AppBlock] Enforcer auto-restarted successfully (ready=${ready})`)).catch(err=>console.error('[AppBlock] Enforcer auto-restart failed:',err.message));
        }
      },1000);
    }
  });

  return new Promise((resolve,reject)=>{
    const currentWaiter = {
      resolve: (ok) => { clearTimeout(timeout); resolve(Boolean(ok)); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    };
    const timeout=setTimeout(()=>{
      if(focusGuardEnforcerReadyWaiter === currentWaiter){
        focusGuardEnforcerReadyWaiter=null;
        currentWaiter.reject(new Error('Focus Guard application enforcer did not become ready within 15 seconds.'));
      }
    },15000);
    focusGuardEnforcerReadyWaiter = currentWaiter;
  });
}

async function stopAppEnforcement(){
  const child=focusGuardEnforcerProcess;
  focusGuardEnforcerReady=false;
  if(!child){stopFocusGuardRuntimeHeartbeat();return {ok:true,stopped:false};}
  focusGuardEnforcerProcess=null;
  try{child.stdin?.write(JSON.stringify({type:'stop'})+'\n');}catch{}
  const waitForExit=(ms)=>new Promise(resolve=>{
    if(child.exitCode!==null)return resolve(true);
    let done=false;
    const finish=()=>{if(done)return;done=true;resolve(child.exitCode!==null);};
    child.once('exit',finish);
    setTimeout(finish,ms);
  });
  let exited=await waitForExit(1200);
  if(!exited&&child.exitCode===null){
    try{child.kill();}catch{}
    exited=await waitForExit(800);
  }
  if(!exited&&child.exitCode===null&&child.pid){
    try{await execFileAsync('taskkill.exe',['/PID',String(child.pid),'/F'],{timeout:1800,maxBuffer:64*1024});}catch{}
    exited=await waitForExit(500);
  }
  stopFocusGuardRuntimeHeartbeat();
  return {ok:Boolean(exited||child.exitCode!==null),stopped:true,pid:child.pid||null};
}

async function recoverStaleFocusGuardState(reason='startup'){
  const state=readFocusGuardSession();
  try { stopFocusGuardRuntimeHeartbeat(); } catch {}
  try { await stopAppEnforcement(); } catch (e) { console.warn('[FocusGuard] stopAppEnforcement warning:', e.message); }
  try { stopFocusGuardHeartbeat(); } catch {}
  try { await stopFocusProxy(); } catch (e) { console.warn('[FocusProxy] stopFocusProxy warning:', e.message); }
  try { await disableSystemProxy(); } catch (e) { console.warn('[FocusProxy] disableSystemProxy warning:', e.message); }
  try { removeHostsBlocklist(app.getPath('userData')); } catch (e) { console.warn('[FocusWeb] removeHostsBlocklist warning:', e.message); }
  try { await stopNetworkEnforcement(); } catch (e) { console.warn('[FocusNetwork] stopNetworkEnforcement warning:', e.message); }
  try { removeFocusGuardSession(); } catch {}
  focusGuardActive=false;
  focusGuardLifecycle='VERIFIED_NORMAL';
  focusGuardLastBlocked=[];
  focusGuardBlockedCount=0;
  focusGuardLastAppSweepAt=0;
  console.log(`[FocusGuard] Network state and stale session verified clean during ${reason}`);
  return {ok:true,recovered:Boolean(state)};
}

async function stopFocusGuard({force=false,reason='stop'}={}){
  if(focusGuardCleanupPromise && !force) return focusGuardCleanupPromise;
  focusGuardRunGeneration++;
  focusGuardCleanupPromise=(async()=>{
    setFocusGuardLifecycle('STOPPING',{reason});
    focusGuardActive=false;

    let appRes = { ok: true };
    let proxyRes = { ok: true };
    let hostsRes = { ok: true };
    let networkRes = { ok: true };

    try {
      appRes = await stopAppEnforcement();
    } catch (e) {
      console.warn('[FocusGuard] App enforcement stop error:', e.message);
      appRes = { ok: false, error: e.message };
    }

    try { stopFocusGuardHeartbeat(); } catch {}
    try { stopFocusGuardRuntimeHeartbeat(); } catch {}

    try {
      await stopFocusProxy();
    } catch (e) {
      console.warn('[FocusProxy] Proxy server stop error:', e.message);
    }

    try {
      proxyRes = await disableSystemProxy();
    } catch (e) {
      console.warn('[FocusProxy] Disable system proxy error:', e.message);
      proxyRes = { ok: false, error: e.message };
    }

    try {
      hostsRes = removeHostsBlocklist(app.getPath('userData'));
    } catch (e) {
      console.warn('[FocusWeb] Hosts cleanup error:', e.message);
      hostsRes = { ok: false, error: e.message };
    }

    try {
      networkRes = await stopNetworkEnforcement();
    } catch (e) {
      console.warn('[FocusNetwork] Network enforcement stop error:', e.message);
      networkRes = { ok: false, error: e.message };
    }

    focusGuardActive=false;
    focusGuardLifecycle='VERIFIED_NORMAL';
    focusGuardLastBlocked=[];
    focusGuardBlockedCount=0;
    focusGuardLastAppSweepAt=0;
    removeFocusGuardSession();
    focusGuardSessionId=null;
    console.log(`[FocusGuard] STOPPED verified reason=${reason}`);
    return {
      ok: true,
      active: false,
      verified: true,
      emergency: reason.includes('emergency'),
      unblockedWebsites: Boolean(proxyRes.ok && hostsRes.ok),
      unblockedApps: Boolean(appRes.ok),
      networkRestored: Boolean(networkRes.ok)
    };
  })();
  try{return await focusGuardCleanupPromise;}finally{focusGuardCleanupPromise=null;}
}

async function activateFocusGuard(){
  if(focusGuardActivationPromise)return focusGuardActivationPromise;
  focusGuardActivationPromise=(async()=>{
    if(process.platform!=='win32'){focusGuardActive=true;focusGuardLifecycle='ACTIVE';return {ok:true,active:true,isAdmin:true,webMode:'non-windows'};}
    if(focusGuardActive)return {ok:true,active:true,alreadyActive:true,isAdmin:true};
    // Always clean stale state BEFORE starting a new session.
    await recoverStaleFocusGuardState('pre-activation');
    const cfg=readFocusGuardConfig();
    const admin=getAdminStatus();

    const sessionId=newFocusGuardSessionId();focusGuardSessionId=sessionId;focusGuardRunGeneration++;
    focusGuardLifecycle='STARTING';
    focusGuardActive=false;
    focusGuardLastAppSweepAt=0;focusGuardBlockedCount=0;focusGuardLastBlocked=[];focusGuardAppSweepFailures=0;

    const state={
      version:33,
      sessionId,
      status:'starting',
      lifecycle:'STARTING',
      startedAt:new Date().toISOString(),
      lastHeartbeat:new Date().toISOString(),
      parentPid:process.pid,
      parentExePath:process.execPath,
      blockedApps:normalizeAppEntries(cfg.blockedApps||[]),
      allowedApps:normalizeAppEntries(cfg.allowedApps||[]),
      studyWebPolicyActive:true,
      networkMode:'hosts-blocklist-only',
      proxyTouched:false,
      firewallTouched:false
    };
    writeFocusGuardSession(state);

    try{
      // 1. Start Native Study Web Domain Blocklist & Universal Proxy
      if(cfg.blockSites!==false){
        await startNetworkEnforcement({ sessionId });
        applyHostsBlocklist(app.getPath('userData'));
        await startFocusProxy();
        await enableSystemProxy();
        console.log('[FocusWeb] Universal browser proxy + hosts blocklist active');
      }

      focusGuardActive=true;
      focusGuardLifecycle='STARTING';
      const appExpected=Boolean(cfg.blockApps!==false);

      // 2. Start Application Enforcement Worker
      if(appExpected){
        const ready=await startAppEnforcement();
        if(!ready)throw new Error('Application enforcement could not initialize.');
      }
      if(appExpected&&(!focusGuardEnforcerProcess||!focusGuardEnforcerReady))throw new Error('Application enforcement monitor failed to start.');

      focusGuardLifecycle='ACTIVE';
      writeFocusGuardSession({status:'active',lifecycle:'ACTIVE',appEnforcement:{enabled:appExpected,state:appExpected?'ACTIVE':'OFF',lastSweepAt:focusGuardLastAppSweepAt||null}});
      startFocusGuardHeartbeat();
      console.log('[FocusGuard] ACTIVE — Universal browser network domain filtering + supervised application allowlist');
      return {ok:true,active:true,isAdmin:Boolean(admin.isAdmin),sessionId,appEnforcement:appExpected?'ACTIVE':'OFF',webMode:'universal-proxy-hosts'};
    }catch(error){
      console.error('[FocusGuard] activation failed — rolling back safely:',error.message);
      focusGuardActive=false;
      await stopAppEnforcement();
      stopFocusGuardHeartbeat();
      await stopFocusProxy();
      await disableSystemProxy();
      removeHostsBlocklist(app.getPath('userData'));
      await stopNetworkEnforcement();
      removeFocusGuardSession();
      focusGuardLifecycle='VERIFIED_NORMAL';
      return {ok:false,active:false,error:error.message};
    }
  })();
  try{return await focusGuardActivationPromise;}finally{focusGuardActivationPromise=null;}
}

async function deactivateFocusGuard(pin='',reason='manual',force=false){
  if(process.platform!=='win32'){focusGuardActive=false;return {ok:true,active:false};}
  const config=readFocusGuardConfig();
  if(!force&&config.breakPin&&String(pin||'').trim()!==String(config.breakPin).trim())return {ok:false,active:true,error:'Incorrect PIN. Guard remains active.'};
  if(!force&&config.requireReason&&String(reason||'').trim().length<5)return {ok:false,active:true,error:'Please provide a reason (at least 5 characters) to stop Focus Guard.'};
  return stopFocusGuard({force,reason:`deactivate:${reason}`});
}
async function emergencyRestoreFocusGuard(){
  console.warn('[FocusGuard] EMERGENCY RESTORE requested');
  focusGuardCleanupPromise = null;
  focusGuardActivationPromise = null;
  const result = await stopFocusGuard({force:true,reason:'emergency-restore'});
  console.log('[FocusGuard] EMERGENCY RESTORE completed successfully:', result);
  return {...result, emergency: true};
}
async function repairFocusGuardState(){return {...await stopFocusGuard({force:true,reason:'repair'}),repair:true};}

async function discoverInstalledApplications(){
  if(process.platform!=='win32')return [];
  // Discover runnable user applications from Windows' installed-app metadata,
  // Start-menu/Desktop shortcuts, common user program folders and Steam game
  // libraries. We deliberately exclude Windows system roots and never upload
  // the EXE binaries themselves.
  const script=`$ErrorActionPreference='SilentlyContinue';$items=@();
$regRoots=@('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*');
foreach($r in $regRoots){foreach($x in @(Get-ItemProperty $r -ErrorAction SilentlyContinue)){if(-not $x.DisplayName){continue};$p=[string]$x.DisplayIcon;if($p){$p=$p -replace '^"','' -replace '".*$','';$p=$p.Trim()};$install=[string]$x.InstallLocation;if(-not $p -and $install -and (Test-Path -LiteralPath $install)){try{$f=Get-ChildItem -LiteralPath $install -Filter '*.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 2;if($f){$p=$f[0].FullName}}catch{}};$items += [pscustomobject]@{name=[string]$x.DisplayName;publisher=[string]$x.Publisher;version=[string]$x.DisplayVersion;path=[string]$p;installLocation=[string]$install;source='registry'}}};
$shortcutRoots=@($env:APPDATA+'\Microsoft\Windows\Start Menu\Programs',$env:ProgramData+'\Microsoft\Windows\Start Menu\Programs',$env:USERPROFILE+'\Desktop');try{$shell=New-Object -ComObject WScript.Shell;foreach($root in $shortcutRoots){if(-not (Test-Path -LiteralPath $root)){continue};foreach($lnk in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1600)){try{$sc=$shell.CreateShortcut($lnk.FullName);$tp=[string]$sc.TargetPath;if($tp -and $tp -match '(?i)\.exe$'){$items += [pscustomobject]@{name=[IO.Path]::GetFileNameWithoutExtension($tp);publisher='';version='';path=$tp;installLocation=[IO.Path]::GetDirectoryName($tp);source='shortcut'}}}catch{}}}}catch{};
$userRoots=@($env:ProgramFiles,$env:ProgramFilesX86,$env:LOCALAPPDATA+'\Programs',$env:USERPROFILE+'\Downloads');
foreach($root in $userRoots){if(-not $root -or -not (Test-Path -LiteralPath $root)){continue};try{foreach($f in @(Get-ChildItem -LiteralPath $root -Filter '*.exe' -File -Recurse -Depth 7 -ErrorAction SilentlyContinue | Select-Object -First 1200)){$items += [pscustomobject]@{name=$f.BaseName;publisher='';version='';path=$f.FullName;installLocation=$f.DirectoryName;source='filesystem'}}}catch{}};
$steamRoots=@();try{$steamRoots += [string](Get-ItemPropertyValue -Path 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction SilentlyContinue)}catch{};try{$steamRoots += [string](Get-ItemPropertyValue -Path 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -Name InstallPath -ErrorAction SilentlyContinue)}catch{};
$steamLibs=@();foreach($steam in $steamRoots){if(-not $steam -or -not (Test-Path -LiteralPath $steam)){continue};$vdf=Join-Path $steam 'steamapps\libraryfolders.vdf';if(Test-Path -LiteralPath $vdf){try{$txt=Get-Content -LiteralPath $vdf -Raw;foreach($m in [regex]::Matches($txt,'"path"\s+"([^"]+)"')){$steamLibs += ($m.Groups[1].Value -replace '\\\\','\\')}}catch{}};$steamLibs += $steam};
foreach($lib in ($steamLibs | Select-Object -Unique)){if(-not $lib -or -not (Test-Path -LiteralPath $lib)){continue};$common=Join-Path $lib 'steamapps\common';if(-not (Test-Path -LiteralPath $common)){continue};try{foreach($f in @(Get-ChildItem -LiteralPath $common -Filter '*.exe' -File -Recurse -Depth 8 -ErrorAction SilentlyContinue | Select-Object -First 1500)){$items += [pscustomobject]@{name=$f.BaseName;publisher='';version='';path=$f.FullName;installLocation=$f.DirectoryName;source='steam'}}}catch{}};
$out=@{};foreach($x in $items){$p=[string]$x.path;if(-not $p -or -not (Test-Path -LiteralPath $p -PathType Leaf)){continue};try{$p=[IO.Path]::GetFullPath($p)}catch{};
if($p -match '(?i)\\Windows\\(System32|SysWOW64|SystemApps)\\' -or $p -match '(?i)\\WinSxS\\' -or $p -match '(?i)\\WindowsApps\\'){continue};
try{$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($p);$product=[string]$v.ProductName;$desc=[string]$v.FileDescription;$company=[string]$v.CompanyName;$fileVersion=[string]$v.FileVersion}catch{$product='';$desc='';$company='';$fileVersion=''};
$key=$p.ToLowerInvariant();if(-not $out.ContainsKey($key)){$version=[string]$x.version;if(-not $version){$version=$fileVersion};$name=[string]$x.name;if(-not $name){$name=$product;if(-not $name){$name=[IO.Path]::GetFileNameWithoutExtension($p)}};$out[$key]=[pscustomobject]@{id=([guid]::NewGuid().ToString('n'));name=$name;displayName=$name;productName=$product;fileDescription=$desc;companyName=$company;publisher=[string]$x.publisher;version=$version;fileVersion=$fileVersion;executableName=[IO.Path]::GetFileName($p);path=$p;installLocation=[string]$x.installLocation;source=[string]$x.source}}};
@($out.Values | Sort-Object name | Select-Object -First 1200)|ConvertTo-Json -Compress`;
  try{
    const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{timeout:45000,maxBuffer:8*1024*1024});
    const raw=String(stdout||'').trim();if(!raw)return [];
    const jsonStart=Math.min(...['[','{'].map(token=>{const i=raw.indexOf(token);return i<0?Number.MAX_SAFE_INTEGER:i}));
    const candidate=jsonStart===Number.MAX_SAFE_INTEGER?raw:raw.slice(jsonStart);
    let parsed;
    try{parsed=JSON.parse(candidate);}catch(firstError){
      const sanitized=candidate.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,' ');
      try{parsed=JSON.parse(sanitized);}catch{throw new Error(`invalid discovery JSON: ${firstError.message}`);}
    }
    const rows=Array.isArray(parsed)?parsed:[parsed];
    return rows.filter(x=>x?.path).map(x=>({...x,path:path.resolve(String(x.path)),executableName:String(x.executableName||path.basename(String(x.path)))}));
  }catch(e){throw new Error(`Windows application discovery failed: ${e.message}`);}
}
function parseAIJson(text){
  const t=String(text||'').trim();try{return JSON.parse(t);}catch{}
  const code=t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);if(code){try{return JSON.parse(code[1]);}catch{}}
  const obj=t.match(/\{[\s\S]*\}/);if(obj){try{return JSON.parse(obj[0]);}catch{}}
  return null;
}
async function scanFocusGuardApplicationsWithAI(){
  const apps=await discoverInstalledApplications();
  if(!apps.length)return {ok:true,discovered:0,added:[],results:[]};
  const cfg=readFocusGuardConfig();
  const allowed=normalizeAppEntries(cfg.allowedApps||[]);
  const existingBlocked=normalizeAppEntries(cfg.blockedApps||[]);
  const candidates=apps.filter(appInfo=>!allowed.some(rule=>appRuleMatches(appInfo,rule))&&!appIsBuiltInAllowed(appInfo)&&!VNEXT_PROTECTED_ROOTS().some(root=>{const p=normalizeAppPath(appInfo.path);return root&&(p===root||p.startsWith(root+'\\'));}));
  const added=[];const results=[];const batchSize=24;let batchSuccesses=0;let batchFailures=0;
  const alreadyResult=new Set();
  for(const source of candidates){
    const builtin=classifyAppWithBuiltInPolicy(source);
    if(builtin.classification!=='distracting')continue;
    const confidence=Math.max(0,Math.min(100,Number(builtin.confidence)||0));
    const item={id:source.id,name:source.name,path:source.path,publisher:source.publisher,version:source.version,executableName:source.executableName,classification:'distracting',confidence,category:builtin.category,reason:builtin.reason};
    results.push(item);alreadyResult.add(String(source.id));
    if(confidence>=75&&!existingBlocked.some(rule=>appRuleMatches(source,rule))&&!allowed.some(rule=>appRuleMatches(source,rule))){
      const resolvedPath=path.resolve(source.path);const entry={id:`builtin-${source.id}`,name:source.name||source.productName||path.basename(resolvedPath,'.exe'),executableName:path.basename(resolvedPath),path:resolvedPath,dirScope:path.dirname(resolvedPath),enabled:true,category:item.category,confidence,reason:item.reason};
      existingBlocked.push(entry);added.push(entry);
    }
  }
  for(let i=0;i<candidates.length;i+=batchSize){
    const batch=candidates.slice(i,i+batchSize);
    const metadata=batch.map((x)=>({id:x.id,name:x.name,productName:x.productName,fileDescription:x.fileDescription,companyName:x.companyName,publisher:x.publisher,version:x.version,fileVersion:x.fileVersion,executableName:x.executableName}));
    const prompt=`Classify these installed Windows desktop applications for a STUDY focus mode. Return STRICT JSON only in this shape: {"apps":[{"id":"...","classification":"distracting|productive|unknown","confidence":0-100,"category":"game|social|entertainment|developer|productivity|utility|media|other","reason":"short reason"}]}. Rules: games/game launchers/entertainment/social distractions can be distracting; developer tools, browsers, Windows utilities, editors, communication tools and unknown apps must NOT be marked distracting unless the metadata strongly indicates distraction. Never invent an application.\nApps:\n${JSON.stringify(metadata)}`;
    let response=null;
    try{response=await aiGateway.invoke('chat',{message:prompt,history:[],context:{focusGuardScan:true}});batchSuccesses++;}catch(e){batchFailures++;console.warn('[FocusGuard AI Scan] batch failed:',e.message);continue;}
    const parsed=parseAIJson(response?.reply||'');
    const classified=Array.isArray(parsed?.apps)?parsed.apps:[];
    for(const row of classified){
      const source=batch.find(x=>String(x.id)===String(row.id));if(!source)continue;
      const confidence=Math.max(0,Math.min(100,Number(row.confidence)||0));
      const classification=['distracting','productive','unknown'].includes(String(row.classification).toLowerCase())?String(row.classification).toLowerCase():'unknown';
      const item={id:source.id,name:source.name,path:source.path,publisher:source.publisher,version:source.version,classification,confidence,category:String(row.category||'other'),reason:String(row.reason||'')};
      if(!alreadyResult.has(String(source.id))){results.push(item);alreadyResult.add(String(source.id));}
      if(classification==='distracting'&&confidence>=75&&!existingBlocked.some(rule=>appRuleMatches(source,rule))&&!allowed.some(rule=>appRuleMatches(source,rule))){
        const resolvedPath=path.resolve(source.path);const entry={id:`ai-${source.id}`,name:source.name||source.productName||path.basename(resolvedPath,'.exe'),executableName:path.basename(resolvedPath),path:resolvedPath,dirScope:path.dirname(resolvedPath),enabled:true,category:item.category,confidence,reason:item.reason};
        existingBlocked.push(entry);added.push(entry);
      }
    }
  }
  const next={...cfg,blockedApps:normalizeAppEntries(existingBlocked)};
  writeFocusGuardConfig(next);
  if(candidates.length&&batchSuccesses===0)return {ok:true,aiUnavailable:true,discovered:apps.length,candidates:candidates.length,added,results,config:next,batchFailures,warning:'AI classification was unavailable; built-in Focus Guard rules were applied instead.'};
  return {ok:true,discovered:apps.length,candidates:candidates.length,added,results,config:next,batchFailures,warning:batchFailures?`${batchFailures} AI batch(es) failed; built-in and successful AI classifications were applied.`:null};
}


// end Focus Guard vNext

// Hourly reminder
let hourlyTimer=null;
function clearHourlyReminder(){if(hourlyTimer){clearInterval(hourlyTimer);hourlyTimer=null;}}
function showHourlyReminder(){if(!mainWindow)return;mainWindow.webContents.send('lifeos:hourly-reminder',{time:new Date().toISOString()});if(Notification.isSupported())new Notification({title:'LifeOS — Focus check-in',body:'Keep up the great work!'}).show();}
function scheduleHourlyReminder(){clearHourlyReminder();const cfg=readFocusGuardConfig();if(!cfg.hourlyReminder)return;hourlyTimer=setInterval(showHourlyReminder,60*60*1000);console.log('[LifeOS] Hourly reminder scheduled');}

// Daily Routine
let dailyRoutineTimer=null;
let lastRoutineStart=null;
function clearDailyRoutine(){if(dailyRoutineTimer){clearInterval(dailyRoutineTimer);dailyRoutineTimer=null;}}
function checkDailyRoutine(){
  const cfg=readFocusGuardConfig();
  if (cfg.dailyRoutineEnabled === false) return;
  const startTime = cfg.dailyRoutineTime || "18:00";
  if (!startTime) return;
  const now=new Date();
  const currentStr=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  const todayStr=now.toDateString() + '_' + currentStr;
  
  if(currentStr === startTime && lastRoutineStart !== todayStr){
    lastRoutineStart = todayStr;
    console.log('[LifeOS] Daily routine matched. Triggering notification and prompt.');
    if(mainWindow){
      if(mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('focusguard:routine-triggered', {
        startTime: cfg.dailyRoutineTime || startTime,
        endTime: cfg.dailyRoutineEndTime || '',
        label: cfg.dailyRoutineLabel || 'Study Session',
        autoStart: cfg.dailyRoutineAutoStart
      });
    }
    
    if(Notification.isSupported()){
      const notif = new Notification({
        title: "📚 It's Study Time Now!",
        body: `Your scheduled study routine (${cfg.dailyRoutineTime || startTime}${cfg.dailyRoutineEndTime ? ' - ' + cfg.dailyRoutineEndTime : ''}) has arrived. Do you want to turn on Focus Mode?`
      });
      notif.on('click', () => {
        if(mainWindow){
          if(mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        }
      });
      notif.show();
    }
  }
}
function scheduleDailyRoutine(){clearDailyRoutine();dailyRoutineTimer=setInterval(checkDailyRoutine,30000);console.log('[LifeOS] Daily routine checked');}

// ReGain Distracting App Usage Limiter & Monitoring Service
let focusGuardLimiter = null;

function initFocusGuardLimiter() {
  if (focusGuardLimiter) return focusGuardLimiter;
  focusGuardLimiter = new FocusGuardLimiter({
    configPath: focusGuardConfigPath(),
    readConfigFn: readFocusGuardConfig,
    writeConfigFn: writeFocusGuardConfig,
    pollIntervalMs: 1800,
    onEvent: (eventType, data) => {
      // 1. Time Limit Exceeded or Expired event
      if (eventType === 'time-limit-exceeded') {
        const appTitle = data.name || data.exeName.replace(/\.exe$/i, '');
        const isExp = data.reason === 'expired';

        // Show desktop notification
        try {
          if (Notification.isSupported()) {
            const notif = new Notification({
              title: isExp ? `⌛ Allowance Expired: ${appTitle}` : `⌛ App Time Limit Reached: ${appTitle}`,
              body: isExp
                ? `Your allowance for ${appTitle} has expired! The app was automatically closed and blocked.`
                : `Your active usage limit for ${appTitle} (${data.limitMinutes}m max) has been reached! The app was automatically closed.`,
            });
            notif.show();
          }
        } catch {}

        // Notify running focus guard enforcer to synchronize sweep immediately
        if (focusGuardEnforcerProcess && !focusGuardEnforcerProcess.killed) {
          try { focusGuardEnforcerProcess.stdin?.write(JSON.stringify({ type: 'ping' }) + '\n'); } catch {}
        }

        // Send to renderer
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('focusguard:time-limit-exceeded', data);
        }
      }

      // 2. Real-time active time updates
      if (eventType === 'app-limits-update') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('focusguard:app-limits-update', data);
        }
      }
    }
  });

  focusGuardLimiter.start();
  return focusGuardLimiter;
}

// FOCUS GUARD — IPC HANDLERS
// ============================================================

ipcMain.handle('focusguard:get-app-limits', async () => {
  try {
    const limiter = initFocusGuardLimiter();
    return { ok: true, limits: limiter.getAppLimitsState() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('focusguard:set-app-limit', async (_event, payload) => {
  try {
    const limiter = initFocusGuardLimiter();
    const result = limiter.setAppLimit(payload);
    if (focusGuardEnforcerProcess && !focusGuardEnforcerProcess.killed) {
      try { focusGuardEnforcerProcess.stdin?.write(JSON.stringify({ type: 'ping' }) + '\n'); } catch {}
    }
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('focusguard:remove-app-limit', async (_event, exeName) => {
  try {
    const limiter = initFocusGuardLimiter();
    const result = limiter.removeAppLimit(exeName);
    if (focusGuardEnforcerProcess && !focusGuardEnforcerProcess.killed) {
      try { focusGuardEnforcerProcess.stdin?.write(JSON.stringify({ type: 'ping' }) + '\n'); } catch {}
    }
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('focusguard:reset-app-limit', async (_event, exeName) => {
  try {
    const limiter = initFocusGuardLimiter();
    const result = limiter.resetAppLimit(exeName);
    if (focusGuardEnforcerProcess && !focusGuardEnforcerProcess.killed) {
      try { focusGuardEnforcerProcess.stdin?.write(JSON.stringify({ type: 'ping' }) + '\n'); } catch {}
    }
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('focusguard:get-running-processes', async () => {
  try {
    const limiter = initFocusGuardLimiter();
    const processes = await limiter.getRunningUserProcesses();
    return { ok: true, processes };
  } catch (error) {
    return { ok: false, error: error.message, processes: [] };
  }
});

ipcMain.handle('focusguard:pick-apps', async (_event, { mode = 'allowed' } = {}) => {
  try {
    const result = await dialog.showOpenDialog({
      title: mode === 'blocked' ? 'Choose apps to block during Focus' : 'Choose apps to allow during Focus',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Windows applications', extensions: ['exe'] }],
    });
    if (result.canceled) return { ok: true, paths: [] };
    const paths = [...new Set((result.filePaths || []).map((p) => path.resolve(p)))];
    return { ok: true, paths, mode };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('focusguard:get-config', () => {
  return readFocusGuardConfig();
});

ipcMain.handle('focusguard:scan-apps', async () => {
  try {
    const list = getDistractingAppsList();
    return { ok: true, discovered: list.length, added: [], results: list, config: readFocusGuardConfig() };
  } catch (error) {
    return { ok: true, discovered: 0, added: [], results: [], config: readFocusGuardConfig() };
  }
});

ipcMain.handle('focusguard:discover-apps', async () => {
  try {
    const apps = await discoverInstalledApplications();
    return { ok: true, apps };
  } catch (error) {
    return { ok: false, error: error?.message || 'Application discovery failed.' };
  }
});

ipcMain.handle('focusguard:get-study-policy', () => {
  return {
    ok: true,
    categories: STUDY_CATEGORIES,
    allDomains: ALL_STUDY_DOMAINS,
    blockedDomains: DEFAULT_DISTRACTING_DOMAINS
  };
});

ipcMain.handle('focusguard:authorize-domain', async (_event, { domain } = {}) => {
  try {
    const normDomain = normalizeDomain(domain);
    if (!normDomain) return { decision: 'block', reason: 'Empty domain requested' };

    if (isStudyDomainAllowed(normDomain)) {
      console.log(`[FocusWeb] ALLOWED: ${normDomain} (matched study allowlist)`);
      return { decision: 'allow', reason: 'Domain is on the verified study allowlist', source: 'study_allowlist' };
    }

    console.log(`[FocusWeb] BLOCKED: ${normDomain} (not on study allowlist)`);
    return { decision: 'block', confidence: 1, reason: 'Domain is not on the verified study allowlist', source: 'study_blocklist' };
  } catch (error) {
    console.error(`[FocusWeb] ERROR evaluating ${domain}:`, error.message);
    return { decision: 'block', confidence: 0, reason: `Authorization error: ${error.message}`, source: 'fail_safe' };
  }
});

ipcMain.handle('focusguard:get-startup-status', async () => {
  try {
    const settings = app.getLoginItemSettings();
    return { ok: true, openAtLogin: settings.openAtLogin };
  } catch (e) {
    return { ok: false, openAtLogin: false, error: e.message };
  }
});

ipcMain.handle('focusguard:set-startup-status', async (_event, enabled) => {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: true,
      path: process.execPath,
      args: ['--hidden'],
    });
    return { ok: true, openAtLogin: Boolean(enabled) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('focusguard:save-config', async (_event, config) => {
  try {
    const current = readFocusGuardConfig();
    const isOnlyLimitsUpdate = config &&
      Object.keys(config).every(k => k === 'appTimeLimits' || JSON.stringify(config[k]) === JSON.stringify(current[k]));

    if (!isOnlyLimitsUpdate && (focusGuardActive || focusGuardLifecycle === 'ACTIVE' || focusGuardCleanupPromise)) {
      return { ok: false, error: 'Stop Focus Guard before changing enforcement settings. Use Emergency Restore if you need an immediate reset.' };
    }
    const merged = {
      ...current,
      ...config,
      allowedApps:Array.isArray(config?.allowedApps)?config.allowedApps:current.allowedApps,
      blockedApps:normalizeAppEntries(Array.isArray(config?.blockedApps)?config.blockedApps:current.blockedApps),
      allowedSites:Array.isArray(config?.allowedSites)?config.allowedSites:current.allowedSites,
      customBlockedSites:Array.isArray(config?.customBlockedSites)?config.customBlockedSites:current.customBlockedSites,
      appTimeLimits: typeof config?.appTimeLimits === 'object' && config.appTimeLimits !== null ? config.appTimeLimits : (current.appTimeLimits || {}),
      blockAllApps:true,
      allowlistApps:true,
      blockSites:config?.blockSites!==false,
      blockApps:config?.blockApps!==false,
    };
    writeFocusGuardConfig(merged);
    updateCustomDomainSet(merged.allowedSites, merged.customBlockedSites);

    if (focusGuardLimiter) {
      focusGuardLimiter.tick().catch(() => {});
    }
    if (focusGuardEnforcerProcess && !focusGuardEnforcerProcess.killed) {
      try { focusGuardEnforcerProcess.stdin?.write(JSON.stringify({ type: 'ping' }) + '\n'); } catch {}
    }

    // Sync Windows Startup (Auto-launch on system boot)
    const shouldStartup = merged.dailyRoutineEnabled !== false && (merged.autoLaunchOnStartup !== false || Boolean(merged.dailyRoutineTime));
    try {
      app.setLoginItemSettings({
        openAtLogin: shouldStartup,
        openAsHidden: true,
        path: process.execPath,
        args: ['--hidden'],
      });
    } catch (e) {
      console.warn('[Brihaspati] Startup sync error:', e.message);
    }

    scheduleHourlyReminder();
    scheduleDailyRoutine();
    return { ok: true, config: merged };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('focusguard:activate', async () => {
  try {
    const config = readFocusGuardConfig();
    const adminStatus = getAdminStatus();
    console.log('[FocusGuard] activate requested', {
      admin: adminStatus.isAdmin,
      adminReason: adminStatus.reason,
      blockSites: config.blockSites,
      blockApps: config.blockApps,
      blockedApps: config.blockedApps,
      allowedApps: config.allowedApps,
    });
    const result = await activateFocusGuard();
    return {
      ...result,
      isAdmin: result?.ok ? (getAdminStatus().isAdmin === true || process.platform !== 'win32') : (getAdminStatus().isAdmin === true ? true : null),
      config: { blockSites: config.blockSites, blockApps: config.blockApps },
    };
  } catch (error) {
    const raw = String(error?.message || error);
    const elevated = /access is denied|requires elevation|requested operation requires elevation|error 5/i.test(raw);
    console.error('[FocusGuard] activate error:', error);
    return {
      ok: false, active: false, isAdmin: elevated ? false : null,
      error: elevated
        ? 'Windows requires Administrator privileges for network filtering.'
        : (raw || 'Focus Guard activation failed.'),
    };
  }
});

ipcMain.handle('focusguard:deactivate', async (_event, { pin, reason } = {}) => {
  try {
    const autoReasons = ['session_ended_automatically', 'user_stopped_session'];
    const result = await deactivateFocusGuard(pin, reason || 'manual', autoReasons.includes(reason));
    if (result.ok && mainWindow) mainWindow.setAlwaysOnTop(false);
    return result;
  } catch (error) {
    console.error('[FocusGuard] deactivate error:', error);
    return { ok: false, active: true, error: error.message };
  }
});

ipcMain.handle('focusguard:emergency-restore', async () => {
  try {
    const result = await emergencyRestoreFocusGuard();
    if (result.ok && mainWindow) mainWindow.setAlwaysOnTop(false);
    return result;
  } catch (error) {
    console.error('[FocusGuard] emergency restore error:', error);
    return { ok: false, active: true, emergency: true, error: error.message };
  }
});

async function getFocusGuardStatus(){
  const cfg=readFocusGuardConfig();
  const state=readFocusGuardSession();
  const appExpected=Boolean(focusGuardActive&&cfg.blockApps!==false);
  // Use generous 30s heartbeat timeout — the enforcer only needs to respond
  // within a reasonable window, not sub-second. Tight timeouts were causing
  // false "guard died" signals that stopped the focus timer mid-session.
  const appHeartbeatFresh=!appExpected||Boolean(appExpected&&focusGuardEnforcerProcess&&!focusGuardEnforcerProcess.killed&&focusGuardEnforcerReady&&focusGuardEnforcerLastHeartbeat&&Date.now()-focusGuardEnforcerLastHeartbeat<30000&&focusGuardAppSweepFailures<6);
  const appHealthy=!appExpected||Boolean(focusGuardEnforcerProcess&&focusGuardEnforcerReady&&appHeartbeatFresh);
  const webExpected=Boolean(focusGuardActive&&cfg.blockSites!==false);
  const webHealthy=!webExpected||isNetworkEnforcementHealthy();
  // The timer must NOT stop due to transient status hiccups. If we set
  // focusGuardActive=true and lifecycle is ACTIVE, report active=true as long
  // as no *terminal* health failure exists (sweep failures >= hard limit).
  const terminalAppFailure=appExpected&&focusGuardAppSweepFailures>=10;
  const active=Boolean(focusGuardActive&&(focusGuardLifecycle==='ACTIVE'||focusGuardLifecycle==='STARTING')&&!terminalAppFailure);
  return {
    active,
    lifecycle:focusGuardLifecycle,
    isAdmin:getAdminStatus().isAdmin,
    adminReason:getAdminStatus().reason,
    account:getAdminStatus().name,
    adminSid:getAdminStatus().sid,
    sessionId:focusGuardSessionId||state?.sessionId||null,
    startedAtMs:state?.startedAt?Date.parse(state.startedAt):null,
    appBlockingEnabled:cfg.blockApps!==false,
    blockedApps:normalizeAppEntries(cfg.blockedApps||[]),
    allowedApps:normalizeAppEntries(cfg.allowedApps||[]),
    appEnforcementExpected:appExpected,
    appEnforcementHealthy:appHealthy,
    appMonitorRunning:Boolean(focusGuardEnforcerProcess&&!focusGuardEnforcerProcess.killed),
    appEnforcerPid:focusGuardEnforcerProcess?.pid||null,
    appEnforcerLastHeartbeat:focusGuardEnforcerLastHeartbeat||null,
    appLastSweepAt:focusGuardLastAppSweepAt||null,
    appSweepFailures:focusGuardAppSweepFailures,
    currentlyMatchedBlockedApps:focusGuardBlockedCount,
    lastTerminated:focusGuardLastBlocked,
    websiteBlockingEnabled:cfg.blockSites!==false,
    websiteEnforcementHealthy:webHealthy,
    studyWebPolicyActive:isNetworkEnforcementHealthy(),
    studyCategories:STUDY_CATEGORIES,
    allStudyDomainsCount:ALL_STUDY_DOMAINS.length,
    webMode:'hardcoded-study-allowlist',
    networkMode:'windows-firewall-study-allowlist',
    cleanupInProgress:Boolean(focusGuardCleanupPromise),
    safeRecovery:true,
    version:34,
  };
}

ipcMain.handle('focusguard:status', async () => {
  return getFocusGuardStatus();
});
ipcMain.handle('focusguard:bring-to-front', () => {
  if (!mainWindow) return;
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.show();
  mainWindow.focus();
  setTimeout(() => {
    if (mainWindow && !focusGuardActive) mainWindow.setAlwaysOnTop(false);
  }, 3000);
});

// ADMIN ELEVATION
// ============================================================

// Add IPC handler to check admin status
ipcMain.handle('focusguard:check-admin', () => {
  const status=getAdminStatus();
  return status;
});

ipcMain.handle('focusguard:repair', async () => {
  try {
    return await repairFocusGuardState();
  } catch (error) {
    return { ok: false, active: true, error: error.message };
  }
});

// ============================================================
// APP LIFECYCLE
// ============================================================

app.on('before-quit', async (event) => {
  if (appIsQuitting) return;
  const hasState = Boolean(readFocusGuardSession() || fs.existsSync(focusGuardHostsBackupPath()) || fs.existsSync(focusGuardRuntimePath()) || focusGuardActive || focusGuardEnforcerProcess);
  if (!hasState) { appIsQuitting = true; stopManagedDevServer(); return; }
  event.preventDefault();
  // Quit routes through the same unified stop path as Deactivate and
  // Emergency Restore. If a teardown is already running, wait for it.
  try {
    if (focusGuardCleanupPromise) await focusGuardCleanupPromise;
    else {
      const result = await emergencyRestoreFocusGuard();
      if (!result?.ok) {
        console.error('[FocusGuard] app quit blocked because emergency cleanup was not verified:', result?.error);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show();
          mainWindow.focus();
          dialog.showErrorBox('Brihaspati stayed open for safety', `Focus Guard could not verify a safe network restore. Brihaspati will remain open so you can use Emergency Restore.\n\n${result?.error || 'Unknown cleanup error'}`);
        }
        return;
      }
    }
    // Still not fully restored: keep Brihaspati open so Emergency stays available.
    if (readFocusGuardSession()) return;
    appIsQuitting = true;
    stopManagedDevServer();
    app.quit();
  } catch (error) {
    console.error('[FocusGuard] app quit cleanup error:', error);
  }
});

app.on('will-quit', () => {
  clearHourlyReminder();
  try { globalShortcut.unregister(FG_EMERGENCY_HOTKEY); } catch {}
  if (brihaspatiTray) { try { brihaspatiTray.destroy(); } catch {} brihaspatiTray = null; }
  stopManagedDevServer();
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // The close event below prevents this path while Guard is active. Keep the
  // explicit check as a second safety net against accidental renderer closes.
  if (focusGuardActive || focusGuardLifecycle === 'ACTIVE' || focusGuardCleanupPromise) {
    return;
  }
  app.quit();
});

// ============================================================
// APPLICATION MENU
// ============================================================

// Remove native Electron window menu bar ribbon (File, Edit, View, Help)
Menu.setApplicationMenu(null);

// ============================================================
// FOCUS SAFETY UI — tray + emergency hotkey
// ============================================================
function createFocusSafetyTray() {
  if (process.platform !== 'win32' || brihaspatiTray) return;
  try {
    const iconPath = path.join(__dirname, 'lifeos-tray.png');
    const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
    brihaspatiTray = new Tray(icon);
    const menu = Menu.buildFromTemplate([
      { label: 'Open Neo Coach', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
      { type: 'separator' },
      { label: 'Emergency Restore Focus Guard', click: async () => {
          const result = await emergencyRestoreFocusGuard();
          if (result.ok) {
            if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
          } else if (mainWindow) {
            dialog.showErrorBox('Emergency Restore needs another attempt', result.error || 'Network restoration could not be verified.');
          }
        } },
      { label: `Emergency hotkey: ${FG_EMERGENCY_HOTKEY}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit Neo Coach', click: () => app.quit() },
    ]);
    brihaspatiTray.setToolTip('Neo Coach — Focus Guard safety');
    brihaspatiTray.setContextMenu(menu);
    brihaspatiTray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  } catch (error) {
    console.warn('[Brihaspati] tray setup failed:', error.message);
  }
}

function registerFocusSafetyHotkey() {
  if (process.platform !== 'win32') return;
  try {
    const ok = globalShortcut.register(FG_EMERGENCY_HOTKEY, async () => {
      const result = await emergencyRestoreFocusGuard();
      if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
      console.log('[FocusGuard] emergency hotkey result:', result);
    });
    console.log('[FocusGuard] emergency hotkey registered:', ok, FG_EMERGENCY_HOTKEY);
  } catch (error) {
    console.warn('[FocusGuard] emergency hotkey registration failed:', error.message);
  }
}

// MAIN WINDOW
// ============================================================

function probeDevServer(url='http://127.0.0.1:5173', timeout=800){
  return new Promise(resolve => {
    const req=http.get(url, response=>{response.resume();resolve(response.statusCode>=200 && response.statusCode<500);});
    req.setTimeout(timeout,()=>{try{req.destroy();}catch{};resolve(false);});
    req.on('error',()=>resolve(false));
  });
}

let devServerProcess=null;
async function waitForDevServer(url='http://127.0.0.1:5173', timeoutMs=15000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    if(await probeDevServer(url,600))return true;
    await new Promise(r=>setTimeout(r,250));
  }
  return false;
}

function startManagedDevServer(){
  if(devServerProcess || !isDev)return;
  if(process.platform==='win32'){
    const cmd='npm run dev -- --host 127.0.0.1 --port 5173 --strictPort';
    devServerProcess=spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',cmd],{cwd:path.join(__dirname,'..'),windowsHide:true,stdio:['ignore','pipe','pipe']});
  }else{
    devServerProcess=spawn('npm',['run','dev','--','--host','127.0.0.1','--port','5173','--strictPort'],{cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','pipe']});
  }
  devServerProcess.stdout?.on('data',d=>console.log('[Brihaspati Vite]',String(d).trimEnd()));
  devServerProcess.stderr?.on('data',d=>console.error('[Brihaspati Vite]',String(d).trimEnd()));
  devServerProcess.once('error',e=>console.error('[Brihaspati Vite] server process error:',e.message));
  devServerProcess.once('exit',(code,signal)=>{
    console.log('[Brihaspati Vite] server exited',{code,signal});
    devServerProcess=null;
    // The terminal is only a launcher. If it closes (killing Vite), Brihaspati
    // itself must stay alive and usable: restart the managed dev server and
    // reload the window instead of leaving a dead renderer behind.
    if(!appIsQuitting&&useDevServer){
      setTimeout(()=>{
        ensureDevServer().then(()=>{
          if(mainWindow&&!mainWindow.isDestroyed()){
            const devUrl=process.env.NEOCOACH_DEV_SERVER_URL||process.env.LIFEOS_DEV_SERVER_URL||'http://127.0.0.1:5173';
            mainWindow.loadURL(devUrl).catch(()=>{});
          }
        }).catch(e=>console.error('[Brihaspati Vite] auto-restart failed:',e.message));
      },1500);
    }
  });
}

async function stopManagedDevServer(){
  const child=devServerProcess;
  devServerProcess=null;
  if(!child)return;
  try{if(process.platform==='win32' && child.pid){await stopChildProcess(child,3000);}else{child.kill('SIGTERM');}}catch{}
}

async function ensureDevServer(){
  if(!useDevServer)return true;
  const url=process.env.NEOCOACH_DEV_SERVER_URL || process.env.LIFEOS_DEV_SERVER_URL || 'http://127.0.0.1:5173';
  if(await probeDevServer(url,800)){console.log('[Brihaspati] Dev server already available:',url);return true;}
  console.log('[Brihaspati] Dev server not found; starting managed Vite server.');
  startManagedDevServer();
  const ready=await waitForDevServer(url,15000);
  if(!ready)throw new Error(`Brihaspati development server did not become ready at ${url}. Run \"npm run dev\" in another terminal to inspect the Vite error.`);
  console.log('[Brihaspati] Dev server ready:',url);
  return true;
}

function createWindow() {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  mainWindow = new BrowserWindow({
    title: 'Brihaspati',
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (useDevServer) {
    const devUrl = process.env.NEOCOACH_DEV_SERVER_URL || process.env.LIFEOS_DEV_SERVER_URL || 'http://127.0.0.1:5173';
    mainWindow.loadURL(devUrl); 
  } else {
    const rendererPath = path.join(__dirname, '..', 'build', 'index.html');
    if (!fs.existsSync(rendererPath)) {
      const message = `Brihaspati renderer build is missing:\n${rendererPath}\n\nRun: npm run build`;
      console.error('[Brihaspati] ' + message);
      dialog.showErrorBox('Brihaspati could not start', message);
      mainWindow.show();
      return;
    }
    mainWindow.loadFile(rendererPath);
  }

  let rendererLoadFailed = false;
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[Brihaspati] renderer failed to load:', { errorCode, errorDescription, validatedURL });
    if (errorCode === -3 || rendererLoadFailed || mainWindow.isDestroyed()) return;
    rendererLoadFailed = true;
    mainWindow.show();
    const safe = (value) => String(value || '').replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch]));
    const detail = safe(`${errorCode} ${errorDescription}`);
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><meta charset=\"utf-8\"><title>Brihaspati startup error</title><style>body{font-family:Segoe UI,Arial;background:#0f172a;color:#e2e8f0;padding:40px}h1{font-size:24px}pre{white-space:pre-wrap;background:#020617;padding:16px;border-radius:10px}code{color:#93c5fd}</style></head><body><h1>Brihaspati could not load the study interface</h1><p>The Electron window started, but the renderer could not be loaded.</p><pre>${detail}</pre><p>Development mode: <code>npm run dev:electron</code></p><p>Built app: run <code>npm run build</code> before launching.</p></body></html>`)}`);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    rendererLoadFailed = false;
    console.log('[Brihaspati] renderer loaded successfully');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[Brihaspati] renderer process gone:', details);
    if (appIsQuitting || mainWindow.isDestroyed()) return;
    setTimeout(async () => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (useDevServer) { await ensureDevServer(); const devUrl = process.env.NEOCOACH_DEV_SERVER_URL || process.env.LIFEOS_DEV_SERVER_URL || 'http://127.0.0.1:5173'; await mainWindow.loadURL(devUrl); }
          else await mainWindow.loadFile(path.join(__dirname, '..', 'build', 'index.html'));
        }
      } catch (error) {
        console.error('[Brihaspati] renderer recovery failed:', error.message);
      }
    }, 800);
  });
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[Brihaspati Renderer] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!appIsQuitting && (focusGuardActive || focusGuardLifecycle === 'ACTIVE' || focusGuardCleanupPromise)) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'question',
        buttons: ['Yes, End Session & Exit', 'No, Keep Studying'],
        defaultId: 1,
        cancelId: 1,
        title: 'Focus Guard Session Active',
        message: 'Do you want to close the study session?',
        detail: 'Closing Brihaspati now will stop the Focus Guard timer and restore your normal web access and apps.',
        noLink: true
      });

      if (choice === 0) {
        appIsQuitting = true;
        stopFocusGuard({ force: true, reason: 'user-closed-app' }).finally(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.destroy();
          }
          app.quit();
        });
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}
// ============================================================
// START
// ============================================================

app.whenReady().then(async () => {
  // Elevated launches are detached from the npm terminal. Persist the same
  // diagnostics so Focus Guard failures remain inspectable.
  try {
    const logFile=path.join(app.getPath('userData'),'brihaspati-runtime.log');
    const originalLog=console.log.bind(console);
    const originalError=console.error.bind(console);
    const append=(level,args)=>{try{fs.appendFileSync(logFile,`[${new Date().toISOString()}] ${level} ${args.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' ')}\n`);}catch{}};
    console.log=(...args)=>{append('INFO',args);originalLog(...args);};
    console.error=(...args)=>{append('ERROR',args);originalError(...args);};
    console.log(`[Brihaspati] Runtime log: ${logFile}`);
  } catch {}
  refreshAdminStatus();
  createFocusSafetyTray();
  registerFocusSafetyHotkey();
  try { await recoverStaleFocusGuardState('app_ready'); } catch (error) { console.warn('[FocusGuard] startup recovery failed:', error.message); }
  // Daily check for free available AI models
  refreshDailyModels(false).catch((err) => console.warn('[Brihaspati Discovery] Startup daily model check error:', err.message));
  try {
    await ensureDevServer();
    createWindow();
    scheduleHourlyReminder();
    scheduleDailyRoutine();
    initFocusGuardLimiter();
  } catch (error) {
    console.error('[Brihaspati] startup failed:', error);
    dialog.showErrorBox('Brihaspati could not start', error.message || String(error));
    stopManagedDevServer();
  }
});

app.on('before-quit', async (event) => {
  if (focusGuardLimiter) {
    try { focusGuardLimiter.stop(); } catch {}
  }
  if (appIsQuitting) return;
  const hasState = Boolean(readFocusGuardSession() || focusGuardActive || focusGuardEnforcerProcess);
  if (!hasState) { appIsQuitting = true; stopManagedDevServer(); return; }
  event.preventDefault();
  try {
    if (focusGuardCleanupPromise) await focusGuardCleanupPromise;
    else await emergencyRestoreFocusGuard();
    appIsQuitting = true;
    stopManagedDevServer();
    app.quit();
  } catch (error) {
    console.error('[FocusGuard] app quit cleanup error:', error);
    appIsQuitting = true;
    stopManagedDevServer();
    app.quit();
  }
});

app.on('will-quit', () => {
  clearHourlyReminder();
  try { globalShortcut.unregister(FG_EMERGENCY_HOTKEY); } catch {}
  if (brihaspatiTray) { try { brihaspatiTray.destroy(); } catch {} brihaspatiTray = null; }
  stopManagedDevServer();
});
