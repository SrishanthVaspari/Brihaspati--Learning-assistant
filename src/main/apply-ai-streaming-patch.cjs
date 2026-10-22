const fs = require('fs');
const path = require('path');

const mainPath = path.resolve(__dirname, 'main.cjs');
if (!fs.existsSync(mainPath)) {
  console.error(`main.cjs not found: ${mainPath}`);
  process.exit(1);
}

let source = fs.readFileSync(mainPath, 'utf8');
if (source.includes("'ai:stream'") || source.includes('"ai:stream"')) {
  console.log('[LifeOS] ai:stream handler already exists. Nothing to patch.');
  process.exit(0);
}

const marker = `\n// ============================================================\n// LIFEOS AI STREAMING IPC\n// ============================================================\n`;
const handler = `${marker}
ipcMain.on('ai:stream', async (event, payload = {}) => {
  const requestId = payload.requestId;
  const send = (channel, data = {}) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, { requestId, ...data });
  };

  try {
    if (!aiGateway || typeof aiGateway.stream !== 'function') {
      throw new Error('AI streaming is not available. Make sure electron/aiGateway.cjs was replaced with the LifeOS streaming version.');
    }

    const { operation = 'chat', args = {} } = payload;
    await aiGateway.stream(operation, args, async (text, meta = {}) => {
      if (text) send('ai:stream:chunk', { text, ...meta });
      if (meta.done) send('ai:stream:done', meta);
    });
  } catch (error) {
    console.error('[LifeOS AI Stream]', error);
    send('ai:stream:error', {
      error: error?.message || 'AI streaming failed.',
      code: error?.code || 'AI_STREAM_ERROR',
      details: error?.errors || undefined,
      partialReply: error?.partialReply || '',
    });
  }
});
`;

fs.appendFileSync(mainPath, handler, 'utf8');
console.log('[LifeOS] Added ai:stream IPC handler to electron/main.cjs');
