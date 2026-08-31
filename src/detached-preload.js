const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('detachedVideo', {
  onLoad: (callback) => ipcRenderer.on('detach-video:load', (_event, state) => callback(state)),
  onCommand: (callback) => ipcRenderer.on('detach-video:command', (_event, cmd) => callback(cmd)),
  reportState: (state) => ipcRenderer.send('detach-video:state', state)
});
