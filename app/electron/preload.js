const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, ...args) => {
    const validChannels = [
      'virtual-camera:start',
      'virtual-camera:stop',
      'camera:validate-selection',
      'get-update-state',
      'check-for-updates',
      'download-update',
      'install-update',
      'open-release-page',
      'window:get-full-screen',
      'window:toggle-full-screen',
      'clipboard:write-text',
      'morphlyvc:status',
      'morphlyvc:reference',
      'morphlyvc:prepare',
      'morphlyvc:start',
      'morphlyvc:pitch',
      'morphlyvc:stop',
      'virtual-microphone:open-setup',
      'virtual-microphone:install',
      'virtual-microphone:detect'
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error(`Invalid channel: `));
  },
  on: (channel, listener) => {
    const validChannels = [
      'desktop-updater:state',
      'virtual-camera:receiver-state',
      'window:full-screen-changed'
    ];
    if (!validChannels.includes(channel) || typeof listener !== 'function') {
      return () => {};
    }

    const wrappedListener = (_event, ...args) => listener(...args);
    ipcRenderer.on(channel, wrappedListener);

    return () => {
      ipcRenderer.removeListener(channel, wrappedListener);
    };
  },
  isElectron: true,
  sendVirtualCameraFrame: (frame) => {
    ipcRenderer.send('virtual-camera:push-frame', frame);
  }
});

