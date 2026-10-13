// Bridge between the app and the main process: exposes window.lytroNative
// (see app/js/platform.js). Only these calls are available to the page.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('lytroNative', {
  openFiles: () => ipcRenderer.invoke('open-files'),
  readFile: (path) => ipcRenderer.invoke('read-file', path),
  readRange: (path, offset, length) => ipcRenderer.invoke('read-range', path, offset, length),
  listCameras: () => ipcRenderer.invoke('list-cameras'),
  cameraThumbnail: (cameraId, fileId) => ipcRenderer.invoke('camera-thumbnail', cameraId, fileId),
  importDir: () => ipcRenderer.invoke('import-dir'),
  libraryDir: () => ipcRenderer.invoke('library-dir'),
  chooseLibraryDir: () => ipcRenderer.invoke('choose-library-dir'),
  chooseImportDir: () => ipcRenderer.invoke('choose-import-dir'),
  importFromCamera: (cameraId, fileIds, destDir) => ipcRenderer.invoke('import-from-camera', cameraId, fileIds, destDir),
  listLibrary: () => ipcRenderer.invoke('list-library'),
  saveFile: (name, bytes) => ipcRenderer.invoke('save-file', name, bytes),
  onCamerasChanged: (callback) => subscribe('cameras-changed', callback),
  onImportProgress: (callback) => subscribe('import-progress', callback),
});
