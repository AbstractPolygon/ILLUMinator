// Electron main process: window, native dialogs, file access and USB camera
// import. The app itself is the same code as the browser version (app/),
// served through a private app:// scheme so module workers and WebGL run as
// they do on the web.

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const camera = require('./camera.cjs');

// Render on the faster GPU of computers that have two (laptops).
app.commandLine.appendSwitch('force_high_performance_gpu');

const APP_DIR = path.join(__dirname, '..', 'app');
const POLL_MS = 3000;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

// The renderer may only read files the user chose (dialogs), files on a
// detected camera and files in the library.
const allowed = new Set();
let cameras = [];
let settings = { libraryDir: null };
let win = null;

function allow(file) {
  allowed.add(path.resolve(file));
}

function checkAllowed(file) {
  const p = path.resolve(file);
  if (allowed.has(p)) return p;
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

// A path inside the library from one the app gives ('Photos/IMG_0001/...').
function inLibrary(rel) {
  const root = path.resolve(libraryDir());
  const p = path.resolve(root, ...String(rel || '').split('/').filter(Boolean));
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error('Outside the library');
  return p;
}

const notFound = (err) => err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');

// Every light field file and thumbnail under a folder, with paths relative
// to it. Used to import a Lytro Desktop library or a camera folder.
async function walk(root, rel = '', out = [], depth = 0) {
  if (depth > 12 || out.length > 20000) return out;
  let entries = [];
  try {
    entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, r, out, depth + 1);
    else if (/\.(lfr|lfp|raw|jpe?g|png)$/i.test(e.name)) out.push(r);
  }
  return out;
}

async function describe(file) {
  const st = await fsp.stat(file);
  return { path: file, name: path.basename(file), size: st.size };
}

async function lfpModule() {
  return import(pathToFileURL(path.join(APP_DIR, 'js', 'core', 'lfp.js')).href);
}

// The menu bar: Electron's standard menus without reload and developer tools,
// plus the app's import commands. On macOS, Quit sits in the app menu.
function buildMenu() {
  const mac = process.platform === 'darwin';
  const send = (id) => () => { if (win) win.webContents.send('menu', id); };
  const template = [
    ...(mac ? [{ role: 'appMenu', submenu: [
      { role: 'about' }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'Import Lytro File…', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: 'Import Lytro Library…', click: send('import-library') },
      ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'ILLUMinator Help', click: () => shell.openExternal('https://github.com/AbstractPolygon/ILLUMinator/wiki') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
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
      // No developer tools in the installed app; `npm start` keeps them.
      devTools: !app.isPackaged,
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
      filters: [{ name: 'Lytro photos and album archives', extensions: ['lfr', 'lfp', 'raw', 'zip', 'LFR', 'LFP', 'RAW', 'ZIP'] }],
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

  // Lytro Desktop keeps a picture's edits in stack.view.lfp, in the same
  // folder as its raw.lfp; an exported IMG_0001.lfp next to IMG_0001.lfr
  // carries them too.
  ipcMain.handle('find-sidecar', async (_e, file) => {
    const p = checkAllowed(file);
    const dir = path.dirname(p);
    const candidates = [path.join(dir, 'stack.view.lfp')];
    if (/\.lfr$/i.test(p)) {
      const base = path.basename(p).replace(/\.[^.]+$/, '').toLowerCase();
      try {
        for (const name of await fsp.readdir(dir)) {
          if (/\.lfp$/i.test(name) && name.replace(/\.[^.]+$/, '').toLowerCase() === base) candidates.push(path.join(dir, name));
        }
      } catch {
        // Folder not readable: only the fixed name is tried.
      }
    }
    for (const side of candidates) {
      if (side === p) continue;
      try {
        const found = await describe(side);
        allow(side);
        return found;
      } catch {
        // Not there.
      }
    }
    return null;
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

  ipcMain.handle('library-dir', async () => libraryDir());

  ipcMain.handle('choose-library-dir', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose library location',
      defaultPath: libraryDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    settings.libraryDir = res.filePaths[0];
    await saveSettings();
    return libraryDir();
  });

  // Copies photos off a camera reached over adb into the library's staging
  // folder; the app then adds them to the library (and empties it).
  ipcMain.handle('import-from-camera', async (e, cameraId, fileIds) => {
    const c = findCamera(cameraId);
    const paths = await camera.importFiles(c, fileIds, inLibrary('.incoming'), (p) => e.sender.send('import-progress', p));
    paths.forEach(allow);
    return Promise.all(paths.map(describe));
  });

  // The library folder (relative paths, see inLibrary).
  ipcMain.handle('lib-list', async (_e, rel) => {
    try {
      const entries = await fsp.readdir(inLibrary(rel), { withFileTypes: true });
      return Promise.all(entries.filter((e) => !e.name.startsWith('.')).map(async (e) => ({
        name: e.name,
        dir: e.isDirectory(),
        size: e.isDirectory() ? 0 : (await fsp.stat(path.join(inLibrary(rel), e.name))).size,
      })));
    } catch (err) {
      if (notFound(err)) return [];
      throw err;
    }
  });

  ipcMain.handle('lib-read-text', async (_e, rel) => {
    try {
      return await fsp.readFile(inLibrary(rel), 'utf8');
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  });

  // Written to a temporary file first, so a crash never leaves half a file.
  ipcMain.handle('lib-write', async (_e, rel, data) => {
    const p = inLibrary(rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.part`;
    await fsp.writeFile(tmp, typeof data === 'string' ? data : Buffer.from(data));
    await fsp.rename(tmp, p);
  });

  ipcMain.handle('lib-copy-in', async (_e, src, rel) => {
    const from = checkAllowed(src);
    const p = inLibrary(rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.copyFile(from, `${p}.part`);
    await fsp.rename(`${p}.part`, p);
  });

  ipcMain.handle('lib-stat', async (_e, rel) => {
    try {
      return await describe(inLibrary(rel));
    } catch (err) {
      if (notFound(err)) return null;
      throw err;
    }
  });

  ipcMain.handle('lib-move', async (_e, from, to) => {
    const dest = inLibrary(to);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.rename(inLibrary(from), dest);
  });

  // Removed photos go to the system trash where there is one.
  ipcMain.handle('lib-remove', async (_e, rel) => {
    const p = inLibrary(rel);
    if (p === path.resolve(libraryDir())) throw new Error('Will not remove the library itself');
    try {
      await shell.trashItem(p);
    } catch {
      await fsp.rm(p, { recursive: true, force: true });
    }
  });

  // Picks a folder and lists the photos in it (all subfolders included).
  ipcMain.handle('pick-folder', async (_e, title) => {
    const res = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths.length) return null;
    const root = res.filePaths[0];
    const files = [];
    for (const rel of await walk(root)) {
      const abs = path.join(root, ...rel.split('/'));
      allow(abs);
      try {
        files.push({ rel, ...(await describe(abs)) });
      } catch {
        // Vanished while scanning.
      }
    }
    return { root, name: path.basename(root), files };
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
  buildMenu();
  createWindow();
  pollCameras();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
