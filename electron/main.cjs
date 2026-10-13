// Electron main process: window, native dialogs, file access and USB camera
// import. The app itself is the same code as the browser version (app/),
// served through a private app:// scheme so module workers and WebGL run as
// they do on the web.

const { app, BrowserWindow, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const camera = require('./camera.cjs');

const APP_DIR = path.join(__dirname, '..', 'app');
const POLL_MS = 3000;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// The renderer may only read files the user chose (dialogs), files on a
// detected camera and files in the import folder.
const allowed = new Set();
let cameras = [];
let importDir = null;
let settings = { libraryDir: null };
let win = null;

function allow(file) {
  allowed.add(path.resolve(file));
}

function checkAllowed(file) {
  const p = path.resolve(file);
  if (allowed.has(p)) return p;
  if (importDir && p.startsWith(path.resolve(importDir) + path.sep)) return p;
  if (p.startsWith(path.resolve(libraryDir()) + path.sep)) return p;
  throw new Error('This file was not opened in ILLUMinator.');
}

// App settings, kept in the user data folder.
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

async function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(await fsp.readFile(settingsFile(), 'utf8')) };
  } catch {
    // First run: defaults.
  }
}

async function saveSettings() {
  await fsp.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fsp.writeFile(settingsFile(), JSON.stringify(settings, null, 2));
}

// Where the library lives (the user can choose it in Settings).
function libraryDir() {
  return settings.libraryDir || path.join(app.getPath('pictures'), 'ILLUMinator');
}

// Photos imported from the camera go into the library.
function defaultImportDir() {
  return path.join(libraryDir(), 'Photos');
}

async function describe(file) {
  const st = await fsp.stat(file);
  return { path: file, name: path.basename(file), size: st.size };
}

async function lfpModule() {
  return import(pathToFileURL(path.join(APP_DIR, 'js', 'core', 'lfp.js')).href);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#121417',
    title: 'ILLUMinator',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadURL('app://lytro/index.html');
  // Links to other sites open in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
}

// Watches for cameras being plugged in or removed.
async function pollCameras() {
  try {
    const found = await camera.listCameras();
    const key = (list) => list.map((c) => `${c.id}:${c.files.length}`).join('|');
    if (key(found) !== key(cameras)) {
      cameras = found;
      for (const c of cameras) for (const f of c.files) if (c.kind === 'drive') allow(f.id);
      if (win) win.webContents.send('cameras-changed', summary());
    }
  } catch (err) {
    console.error('Camera scan failed', err);
  }
  setTimeout(pollCameras, POLL_MS);
}

function summary() {
  return cameras.map((c) => ({ id: c.id, kind: c.kind, label: c.label, files: c.files.map(({ id, name, size, folder }) => ({ id, name, size, folder })) }));
}

function findCamera(id) {
  const c = cameras.find((x) => x.id === id);
  if (!c) throw new Error('That camera is no longer connected.');
  return c;
}

function registerIpc() {
  ipcMain.handle('open-files', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open light field photos',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Lytro photos', extensions: ['lfr', 'lfp', 'raw', 'LFR', 'LFP', 'RAW'] }],
    });
    if (res.canceled) return [];
    res.filePaths.forEach(allow);
    return Promise.all(res.filePaths.map(describe));
  });

  ipcMain.handle('read-file', async (_e, file) => {
    const buf = await fsp.readFile(checkAllowed(file));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  });

  ipcMain.handle('read-range', async (_e, file, offset, length) => {
    const reader = await camera.fileReader(checkAllowed(file));
    try {
      return await reader.read(offset, length);
    } finally {
      await reader.close();
    }
  });

  ipcMain.handle('list-cameras', async () => {
    cameras = await camera.listCameras();
    for (const c of cameras) for (const f of c.files) if (c.kind === 'drive') allow(f.id);
    return summary();
  });

  // Thumbnail of a photo on a camera drive, reading only the thumbnail.
  ipcMain.handle('camera-thumbnail', async (_e, cameraId, fileId) => {
    const c = findCamera(cameraId);
    if (c.kind !== 'drive') return null;
    const { readThumbnail } = await lfpModule();
    const reader = await camera.fileReader(checkAllowed(fileId));
    try {
      const t = await readThumbnail(reader);
      return t ? { mime: t.mime, bytes: t.bytes } : null;
    } catch {
      return null;
    } finally {
      await reader.close();
    }
  });

  ipcMain.handle('import-dir', async () => importDir || defaultImportDir());

  ipcMain.handle('library-dir', async () => libraryDir());

  ipcMain.handle('choose-library-dir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose library location',
      defaultPath: libraryDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    settings.libraryDir = res.filePaths[0];
    importDir = null;
    await saveSettings();
    return libraryDir();
  });

  ipcMain.handle('choose-import-dir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Import photos to',
      defaultPath: importDir || defaultImportDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    importDir = res.filePaths[0];
    return importDir;
  });

  ipcMain.handle('import-from-camera', async (e, cameraId, fileIds, destDir) => {
    const c = findCamera(cameraId);
    importDir = destDir || importDir || defaultImportDir();
    const paths = await camera.importFiles(c, fileIds, importDir, (p) => e.sender.send('import-progress', p));
    paths.forEach(allow);
    return Promise.all(paths.map(describe));
  });

  // Photos already in the import folder (the library).
  ipcMain.handle('list-library', async () => {
    const dir = importDir || defaultImportDir();
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const files = names.filter((n) => camera.LIGHT_FIELD.test(n)).sort().map((n) => path.join(dir, n));
    files.forEach(allow);
    return Promise.all(files.map(describe));
  });

  ipcMain.handle('save-file', async (_e, name, bytes) => {
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('pictures'), name) });
    if (res.canceled || !res.filePath) return null;
    await fsp.writeFile(res.filePath, Buffer.from(bytes));
    return res.filePath;
  });
}

app.whenReady().then(async () => {
  await loadSettings();
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  registerIpc();
  createWindow();
  pollCameras();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
