const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.send('start'),
  stop: () => ipcRenderer.send('stop'),
  getState: () => ipcRenderer.invoke('get-state'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: c => ipcRenderer.invoke('save-config', c),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d))
});
