// preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Expose a function to send requests to the main process for backend calls
  sendRequest: (channel, data) => ipcRenderer.invoke(channel, data),
});