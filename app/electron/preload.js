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
      'clipboard:write-text'
    ];
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    return Promise.reject(new Error(`Invalid channel: `));
  },
  on: (channel, listener) => {
    const validChannels = ['desktop-updater:state', 'window:full-screen-changed'];
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

