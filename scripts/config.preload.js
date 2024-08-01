const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
	saveConfig: (config) => ipcRenderer.invoke("config:save", config),
	loadConfig: () => ipcRenderer.invoke("config:load"),
	openExternal: (url) => ipcRenderer.send("open-external", url),
	exit: () => ipcRenderer.invoke("config:exit"),
});