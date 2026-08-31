const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('matchtag', {
  openVideo: () => ipcRenderer.invoke('dialog:openVideo'),
  saveSession: (sessionData) => ipcRenderer.invoke('file:saveSession', sessionData),
  exportCsv: (csvString) => ipcRenderer.invoke('file:exportCsv', csvString),
  exportClipPlaylist: (data) => ipcRenderer.invoke('file:exportClipPlaylist', data),
  loadSession: () => ipcRenderer.invoke('file:loadSession'),
  loadMultipleSessions: () => ipcRenderer.invoke('file:loadMultipleSessions'),
  loadSquad: () => ipcRenderer.invoke('squad:load'),
  saveSquad: (squad) => ipcRenderer.invoke('squad:save', squad),
  detachVideo: (state) => ipcRenderer.invoke('video:detach', state),
  reattachVideo: () => ipcRenderer.invoke('video:reattach'),
  sendVideoCommand: (cmd) => ipcRenderer.send('video:command', cmd),
  onVideoState: (callback) => ipcRenderer.on('detach-video:state', (_event, state) => callback(state)),
  onVideoClosed: (callback) => ipcRenderer.on('detach-video:closed', () => callback()),
  // Autosave / recovery — see main.js for the file format and atomic-write logic.
  autosaveRead: () => ipcRenderer.invoke('autosave:read'),
  autosaveWrite: (data) => ipcRenderer.invoke('autosave:write', data),
  autosaveDelete: () => ipcRenderer.invoke('autosave:delete'),
  // Synchronous flush for the renderer's beforeunload handler — the write
  // completes before the call returns, so the window can close safely.
  autosaveFlushSync: (data) => ipcRenderer.sendSync('autosave:flush-sync', data),
  // Safe-close: main process intercepts the OS close and sends 'close:requested'
  // to the renderer; the renderer shows the unsaved-changes modal (if dirty)
  // and calls 'closeProceed' once the user has decided.
  onCloseRequested: (callback) => ipcRenderer.on('close:requested', () => callback()),
  closeProceed: () => ipcRenderer.send('close:proceed')
});
