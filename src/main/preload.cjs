const { contextBridge, ipcRenderer } = require('electron');

console.log('[Brihaspati Preload] loaded, injecting electronAPI...');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  focusApp: () => ipcRenderer.invoke('system:focus-app'),
  showNotification: (payload) => ipcRenderer.invoke('system:show-notification', payload),
  ai: {
    getSettings: () => ipcRenderer.invoke('ai:get-settings'),
    saveSettings: (payload) => ipcRenderer.invoke('ai:save-settings', payload),
    clearKey: (provider) => ipcRenderer.invoke('ai:clear-key', provider),
    getMemory: () => ipcRenderer.invoke('ai:get-memory'),
    clearMemory: () => ipcRenderer.invoke('ai:clear-memory'),
    getMetrics: () => ipcRenderer.invoke('ai:get-metrics'),
    refreshModels: (provider) => ipcRenderer.invoke('ai:refresh-models', provider),
    clearCache: () => ipcRenderer.invoke('ai:clear-cache'),
    clearLog: () => ipcRenderer.invoke('ai:clear-log'),
    showNotification: (payload) => ipcRenderer.invoke('system:show-notification', payload),
    focusApp: () => ipcRenderer.invoke('system:focus-app'),
    recordFeedback: (payload) => ipcRenderer.invoke('ai:record-feedback', payload),
    invoke: (payload) => ipcRenderer.invoke('ai:invoke', payload),
    stream: (payload, handlers = {}) => {
      const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      const onChunk = (_event, data) => {
        if (data?.requestId !== requestId) return;
        handlers.onChunk?.(data);
      };
      const onDone = (_event, data) => {
        if (data?.requestId !== requestId) return;
        cleanup();
        handlers.onDone?.(data);
      };
      const onError = (_event, data) => {
        if (data?.requestId !== requestId) return;
        cleanup();
        handlers.onError?.(data);
      };
      const cleanup = () => {
        ipcRenderer.removeListener('ai:stream:chunk', onChunk);
        ipcRenderer.removeListener('ai:stream:done', onDone);
        ipcRenderer.removeListener('ai:stream:error', onError);
      };
      ipcRenderer.on('ai:stream:chunk', onChunk);
      ipcRenderer.on('ai:stream:done', onDone);
      ipcRenderer.on('ai:stream:error', onError);
      ipcRenderer.send('ai:stream', { requestId, ...(payload || {}) });
      return { requestId, cancel: cleanup };
    },
  },
  focusGuard: {
    getConfig: () => ipcRenderer.invoke('focusguard:get-config'),
    saveConfig: (config) => ipcRenderer.invoke('focusguard:save-config', config),
    pickApps: (options = {}) => ipcRenderer.invoke('focusguard:pick-apps', options),
    discoverApps: () => ipcRenderer.invoke('focusguard:discover-apps'),
    scanApps: () => ipcRenderer.invoke('focusguard:scan-apps'),
    activate: () => ipcRenderer.invoke('focusguard:activate'),
    deactivate: ({ pin, reason } = {}) => ipcRenderer.invoke('focusguard:deactivate', { pin, reason }),
    status: () => ipcRenderer.invoke('focusguard:status'),
    getStudyPolicy: () => ipcRenderer.invoke('focusguard:get-study-policy'),
    authorizeDomain: (domain) => ipcRenderer.invoke('focusguard:authorize-domain', { domain }),
    bringToFront: () => ipcRenderer.invoke('focusguard:bring-to-front'),
    checkAdmin: () => ipcRenderer.invoke('focusguard:check-admin'),
    repair: () => ipcRenderer.invoke('focusguard:repair'),
    emergencyRestore: () => ipcRenderer.invoke('focusguard:emergency-restore'),
    onHourlyReminder: (callback) => {
      ipcRenderer.on('brihaspati:hourly-reminder', (_event, data) => callback(data));
      ipcRenderer.on('lifeos:hourly-reminder', (_event, data) => callback(data));
    },
    removeHourlyReminderListener: () => {
      ipcRenderer.removeAllListeners('brihaspati:hourly-reminder');
      ipcRenderer.removeAllListeners('lifeos:hourly-reminder');
    },
    getStartupStatus: () => ipcRenderer.invoke('focusguard:get-startup-status'),
    setStartupStatus: (enabled) => ipcRenderer.invoke('focusguard:set-startup-status', enabled),
    onRoutineTriggered: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('focusguard:routine-triggered', listener);
      return () => ipcRenderer.removeListener('focusguard:routine-triggered', listener);
    },
    onTimeLimitExceeded: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('focusguard:time-limit-exceeded', listener);
      return () => ipcRenderer.removeListener('focusguard:time-limit-exceeded', listener);
    },
    getAppLimits: () => ipcRenderer.invoke('focusguard:get-app-limits'),
    setAppLimit: (payload) => ipcRenderer.invoke('focusguard:set-app-limit', payload),
    removeAppLimit: (exeName) => ipcRenderer.invoke('focusguard:remove-app-limit', exeName),
    resetAppLimit: (exeName) => ipcRenderer.invoke('focusguard:reset-app-limit', exeName),
    getRunningProcesses: () => ipcRenderer.invoke('focusguard:get-running-processes'),
    onAppLimitsUpdate: (callback) => {
      const listener = (_event, data) => callback(data);
      ipcRenderer.on('focusguard:app-limits-update', listener);
      return () => ipcRenderer.removeListener('focusguard:app-limits-update', listener);
    },
  },
  storage: {
    getData: () => ipcRenderer.invoke('storage:get-data'),
    saveData: (data) => ipcRenderer.invoke('storage:save-data', data),
  },
  systemAction: {
    execute: (payload) => ipcRenderer.invoke('system:execute-action', payload),
  },
  voiceTranscriber: {
    start:  (opts)     => ipcRenderer.invoke('voice:start', opts || {}),
    stop:   ()         => ipcRenderer.invoke('voice:stop'),
    status: ()         => ipcRenderer.invoke('voice:status'),
    onEvent: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on('voice:event', handler);
      return () => ipcRenderer.removeListener('voice:event', handler);
    },
  },
});

console.log('[Brihaspati Preload] electronAPI injected successfully');
