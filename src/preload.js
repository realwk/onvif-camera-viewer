const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    connectCamera: (connectionString) => ipcRenderer.invoke('connect-camera', connectionString),
    disconnectCamera: () => ipcRenderer.invoke('disconnect-camera'),
    ptzControl: (command) => ipcRenderer.invoke('ptz-control', command),
    getSavedCameras: () => ipcRenderer.invoke('get-saved-cameras'),
    removeCamera: (connectionString) => ipcRenderer.invoke('remove-camera', connectionString),
    clearHistory: () => ipcRenderer.invoke('clear-history')
});