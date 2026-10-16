// Electron main process: window, native dialogs, file access and USB camera
// import. The app itself is the same code as the browser version (app/),
// served through a private app:// scheme so module workers and WebGL run as
// they do on the web.

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, session, shell } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const camera = require('./camera.cjs');

// Render on the faster GPU of computers that have two (laptops).
app.commandLine.appendSwitch('force_high_performance_gpu');

const APP_DIR = path.join(__dirname, '..', 'app');
const POLL_MS = 3000;
// After a Lytro is plugged in: scan every second for this long, while its
// drive mounts.
const FAST_POLL_MS = 1000;
const FAST_POLL_FOR_MS = 20000;
// Importing straight from a connected camera (as CAMERA_IMPORT in
// app/js/platform.js): off until it works with real cameras.
const CAMERA_IMPORT = false;

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
      { label: 'About ILLUMinator', click: send('about') }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'Import Lytro File…', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: 'Import Lytro Library…', click: send('import-library') },
      ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ] },
    // Undo and redo step through a photo's edits (text fields keep their
    // own); the page decides which.
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
      { label: 'Redo', accelerator: process.platform === 'darwin' ? 'Shift+Cmd+Z' : 'Ctrl+Y', click: send('redo') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'About', click: send('about') },
      { label: 'Wiki', click: () => shell.openExternal('https://github.com/AbstractPolygon/ILLUMinator/wiki') },
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

// Watches for cameras being plugged in or removed: every few seconds, and
// every second for a while after the app sees a Lytro arrive on USB.
let pollTimer = null;
let fastUntil = 0;
async function pollCameras() {
  clearTimeout(pollTimer);
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
  pollTimer = setTimeout(pollCameras, Date.now() < fastUntil ? FAST_POLL_MS : POLL_MS);
}

function scanSoon() {
  fastUntil = Date.now() + FAST_POLL_FOR_MS;
  pollCameras();
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
  ipcMain.handle('open-files', async (_e, options) => {
    // `options` picks another kind of file (camera calibration backups).
    const kind = options && options.kind === 'calibration';
    const res = await dialog.showOpenDialog(win, {
      title: kind ? 'Add camera calibration data' : 'Open light field photos',
      properties: kind ? ['openFile'] : ['openFile', 'multiSelections'],
      filters: kind
        ? [{ name: 'Camera calibration backup', extensions: ['tar', 'TAR'] }]
        : [{ name: 'Lytro photos and album archives', extensions: ['lfr', 'lfp', 'raw', 'zip', 'LFR', 'LFP', 'RAW', 'ZIP'] }],
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

  // The page saw a Lytro plugged in over USB (app/js/main.js, WebUSB).
  ipcMain.on('camera-usb-connected', () => scanSoon());

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

// A Linux AppImage is one file that does not put itself in the applications
// menu. The first time it runs the user is asked whether to add it (and a
// desktop shortcut); .deb installs get their menu entry from the package.
async function offerLinuxMenuEntry() {
  const appImage = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !appImage || settings.menuEntry) return;
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'ILLUMinator',
    message: 'Add ILLUMinator to your applications menu?',
    detail: 'This copies a launcher and an icon into your home folder; nothing outside it is changed. You can remove them by deleting illuminator.desktop from ~/.local/share/applications.',
    buttons: ['Add to menu', 'Not now', 'Don\'t ask again'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: 'Also put a shortcut on the desktop',
    checkboxChecked: false,
  });
  if (res.response === 2) {
    settings.menuEntry = 'never';
    await saveSettings();
    return;
  }
  if (res.response !== 0) return;
  try {
    const home = app.getPath('home');
    const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const iconDir = path.join(dataHome, 'icons', 'hicolor', 'scalable', 'apps');
    await fsp.mkdir(iconDir, { recursive: true });
    await fsp.writeFile(path.join(iconDir, 'illuminator.svg'), await fsp.readFile(path.join(APP_DIR, 'icon.svg')));
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=ILLUMinator',
      'Comment=Lytro light field photo editor',
      `Exec="${appImage}" %F`,
      'Icon=illuminator',
      'Terminal=false',
      'Categories=Graphics;Photography;',
      'MimeType=image/x-lytro-lfr;image/x-lytro-lfp;',
      'StartupWMClass=ILLUMinator',
      '',
    ].join('\n');
    const appsDir = path.join(dataHome, 'applications');
    await fsp.mkdir(appsDir, { recursive: true });
    await fsp.writeFile(path.join(appsDir, 'illuminator.desktop'), entry, { mode: 0o755 });
    if (res.checkboxChecked) {
      const desktop = app.getPath('desktop');
      await fsp.mkdir(desktop, { recursive: true });
      await fsp.writeFile(path.join(desktop, 'ILLUMinator.desktop'), entry, { mode: 0o755 });
    }
    settings.menuEntry = 'added';
    await saveSettings();
  } catch (err) {
    dialog.showErrorBox('ILLUMinator', `The menu entry could not be added: ${err.message}`);
  }
}

app.whenReady().then(async () => {
  await loadSettings();
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_DIR + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  // USB plug-in events reach the page (WebUSB) for Lytro cameras only,
  // without asking: the page only watches them come and go.
  if (CAMERA_IMPORT) session.defaultSession.setDevicePermissionHandler((details) => details.deviceType === 'usb' && camera.isLytroUsb(details.device));
  registerIpc();
  buildMenu();
  createWindow();
  win.once('ready-to-show', () => offerLinuxMenuEntry().catch(() => {}));
  if (CAMERA_IMPORT) pollCameras();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
