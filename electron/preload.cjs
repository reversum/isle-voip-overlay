const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("isleVoip", {
  getSettings: () => ipcRenderer.invoke("overlay:getSettings"),
  setSettings: (next) => ipcRenderer.invoke("overlay:setSettings", next),
  steamLogin: () => ipcRenderer.invoke("auth:steamLogin"),
  getAuth: () => ipcRenderer.invoke("auth:getAuth"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  onAuthChanged: (cb) => ipcRenderer.on("auth:changed", (_e, payload) => cb(payload)),
  getVoiceTicket: () => ipcRenderer.invoke("voice:getTicket"),
  listServers: () => ipcRenderer.invoke("servers:list"),
  listLinkedServers: (hash) => ipcRenderer.invoke("servers:linked", hash),
  listGroups: (hash) => ipcRenderer.invoke("groups:list", hash),
  globalKeysActive: () => ipcRenderer.invoke("keys:globalActive"),
  onGlobalKey: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("global-key", handler);
    return () => ipcRenderer.removeListener("global-key", handler);
  },
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  maximizeToggle: () => ipcRenderer.invoke("window:maximizeToggle"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  openExternal: (url) => ipcRenderer.invoke("window:openExternal", url),
  getWhitelabel: () => ipcRenderer.invoke("app:getWhitelabel"),
  updaterRestart: () => ipcRenderer.invoke("updater:restart"),
  updaterCheck: () => ipcRenderer.invoke("updater:check"),
  updaterGetState: () => ipcRenderer.invoke("updater:getState"),
  onUpdaterEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("updater:event", handler);
    return () => ipcRenderer.removeListener("updater:event", handler);
  }
});
