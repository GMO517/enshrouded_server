const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  start: () => ipcRenderer.send('start'),
  stop: () => ipcRenderer.send('stop'),
  getState: () => ipcRenderer.invoke('get-state'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: c => ipcRenderer.invoke('save-config', c),
  chooseDir: () => ipcRenderer.invoke('choose-dir'),
  getPaths: () => ipcRenderer.invoke('get-paths'),
  chooseSteamcmd: () => ipcRenderer.invoke('choose-steamcmd'),
  installServer: () => ipcRenderer.invoke('install-server'),
  backupList: () => ipcRenderer.invoke('backup-list'),
  backupCreate: () => ipcRenderer.invoke('backup-create'),
  backupRestore: n => ipcRenderer.invoke('backup-restore', n),
  backupDelete: n => ipcRenderer.invoke('backup-delete', n),
  on: (ch, fn) => ipcRenderer.on(ch, (_e, d) => fn(d))
});
