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
  findSidecar: (path) => ipcRenderer.invoke('find-sidecar', path),
  readRange: (path, offset, length) => ipcRenderer.invoke('read-range', path, offset, length),
  listCameras: () => ipcRenderer.invoke('list-cameras'),
  cameraThumbnail: (cameraId, fileId) => ipcRenderer.invoke('camera-thumbnail', cameraId, fileId),
  libraryDir: () => ipcRenderer.invoke('library-dir'),
  chooseLibraryDir: () => ipcRenderer.invoke('choose-library-dir'),
  importFromCamera: (cameraId, fileIds) => ipcRenderer.invoke('import-from-camera', cameraId, fileIds),
  saveFile: (name, bytes) => ipcRenderer.invoke('save-file', name, bytes),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  library: {
    list: (rel) => ipcRenderer.invoke('lib-list', rel),
    readText: (rel) => ipcRenderer.invoke('lib-read-text', rel),
    write: (rel, data) => ipcRenderer.invoke('lib-write', rel, data),
    copyIn: (src, rel) => ipcRenderer.invoke('lib-copy-in', src, rel),
    stat: (rel) => ipcRenderer.invoke('lib-stat', rel),
    move: (from, to) => ipcRenderer.invoke('lib-move', from, to),
    remove: (rel) => ipcRenderer.invoke('lib-remove', rel),
  },
  onCamerasChanged: (callback) => subscribe('cameras-changed', callback),
  onImportProgress: (callback) => subscribe('import-progress', callback),
  onMenu: (callback) => subscribe('menu', callback),
});
