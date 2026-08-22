const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConfig: (id) => ipcRenderer.invoke('config:load', id),
  saveConfig: (id, values) => ipcRenderer.invoke('config:save', id, values),
  removeConfig: (id) => ipcRenderer.invoke('config:remove', id),
  testConfig: (values) => ipcRenderer.invoke('config:test', values),
  close: () => ipcRenderer.invoke('config:close'),
  // Native chrome: size the window to its content and match the system accent.
  fitWindow: (height) => ipcRenderer.invoke('config:fit', height),
  accentColor: () => ipcRenderer.invoke('config:accent'),
});
