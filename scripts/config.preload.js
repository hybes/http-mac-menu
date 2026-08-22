const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadConfig: (configNumber) => ipcRenderer.invoke('config:load', configNumber),
  saveConfig: (configNumber, values) =>
    ipcRenderer.invoke('config:save', configNumber, values),
  clearConfig: (configNumber) =>
    ipcRenderer.invoke('config:clear', configNumber),
  testConfig: (values) => ipcRenderer.invoke('config:test', values),
  close: () => ipcRenderer.invoke('config:close'),
});
