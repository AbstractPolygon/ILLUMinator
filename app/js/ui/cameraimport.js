// camera import: moved out of main.js. initCameraImport() runs where the section used to, with what it uses from the rest of the page.
import { connectWebUsb } from '../camera/webusb.js';
import { pickCameraFolder, rememberCameraFolder, native } from '../platform.js';
import { readThumbnail, blobReader } from '../core/lfp.js';

export function initCameraImport({ $, state, setCameraSection, showError, webCameraLabel, importCameraFiles, openItem }) {
  // Shows the photos found on a camera with thumbnails; `onImport(picked)`
  // runs when the user confirms. thumb(file) -> Promise<{ mime, bytes } | null>.
  function showCameraDialog({ files, thumb, onImport }) {
    const grid = $('camera-grid');
    grid.replaceChildren(...files.map((f, i) => {
      const label = document.createElement('label');
      const ph = document.createElement('div');
      ph.className = 'noimg';
      const name = document.createElement('div');
      name.className = 'name';
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, value: i });
      name.append(cb, document.createTextNode(`${f.name} · ${(f.size / 1e6).toFixed(0)} MB`));
      label.append(ph, name);
      thumb(f).then((t) => {
        if (!t) return;
        const img = Object.assign(document.createElement('img'), { src: URL.createObjectURL(new Blob([t.bytes], { type: t.mime })), alt: '' });
        ph.replaceWith(img);
      }).catch(() => {});
      return label;
    }));
    $('camera-import').disabled = !files.length;
    if (!$('camera-dialog').open) $('camera-dialog').showModal();
    $('camera-dialog').onclose = () => {
      if ($('camera-dialog').returnValue !== 'import') return;
      onImport([...grid.querySelectorAll('input:checked')].map((cb) => files[+cb.value]));
    };
  }

  // Browser: the camera is a removable drive; the user picks it (or DCIM).
  // `known`: the folder's listing when it is already read (the remembered one).
  // Browser: the camera read over WebUSB, when it has an interface a page can use
  // (the ILLUM's vendor interface). null when not connected.

  // Connects to the chosen camera and lists its photos in the Camera section.
  // Returns true when it worked; otherwise the reason is in the Camera section
  // and in the console, and `webUsbReport` has what the camera answered.
  async function openWebUsbCamera(device) {
    if (state.webUsbConn && state.webUsbDevice === device) return true;
    if (state.webUsbConn) {
      await state.webUsbConn.close().catch(() => {});
      state.webUsbConn = null;
    }
    setCameraSection({ note: 'Reading the camera…' });
    try {
      state.webUsbConn = await connectWebUsb(device, (line) => console.log('camera:', line));
      state.webUsbDevice = device;
      state.webUsbReport = state.webUsbConn.report;
      const { info, pictures } = state.webUsbConn;
      const files = pictures.map((p) => ({ id: p.id, name: p.name, folder: p.folder, size: 0, picture: p }));
      setCameraSection({ cam: { kind: 'webusb', id: `webusb:${info.serial || device.serialNumber || 'camera'}`, label: `Lytro camera${info.serial ? ` ${info.serial}` : ''} (USB)`, files } });
      return true;
    } catch (err) {
      state.webUsbReport = err.report || '';
      console.warn('camera:', err.message, state.webUsbReport);
      setCameraSection({ note: err.message, show: true });
      return false;
    }
  }

  async function importFromCameraFolder(known = null) {
    let result;
    try {
      result = known || (await pickCameraFolder());
    } catch (err) {
      if (err.name !== 'AbortError') showError(err);
      return;
    }
    const { files, source } = result;
    if (result.dir) {
      state.rememberedFailed = false;
      rememberCameraFolder(result.dir);
    }
    if (files.length) setCameraSection({ cam: { kind: 'web', id: `web:${source}`, label: webCameraLabel(source), files } });
    $('camera-choose').hidden = false;
    $('camera-select-row').hidden = true;
    $('camera-dest').hidden = true;
    $('camera-dialog-source').textContent = files.length
      ? `${files.length} light field photo(s) found on ${source}.`
      : `No .LFR files found on ${source}. Open the camera's drive and choose its DCIM folder.`;
    showCameraDialog({
      files,
      thumb: (f) => readThumbnail(blobReader(f.file)),
      onImport: async (picked) => {
        const added = await importCameraFiles({ kind: 'web' }, picked);
        if (added.length) openItem(added[0]);
      },
    });
  }

  // Desktop app: cameras are detected over USB; photos are copied into the
  // import folder, then opened from there.
  // `preferId` picks that camera first (the one just plugged in).
  async function importFromConnectedCamera(preferId) {
    const cameras = await native.listCameras();
    $('camera-choose').hidden = true;
    // Opened by a plug-in, but the camera has gone again: stay quiet.
    if (preferId && !cameras.some((c) => c.id === preferId)) return;
    const select = $('camera-select');
    $('camera-dest').hidden = false;
    if (!cameras.length) {
      $('camera-select-row').hidden = true;
      $('camera-dialog-source').textContent = 'No Lytro camera found. Connect it with its USB cable and switch it on: it appears as a drive with a DCIM folder. ' +
        '(Cameras with USB debugging enabled are also found if adb is installed.)';
      showCameraDialog({ files: [], thumb: async () => null, onImport: () => {} });
      return;
    }
    select.replaceChildren(...cameras.map((c, i) => Object.assign(document.createElement('option'), { value: i, textContent: c.label })));
    $('camera-select-row').hidden = cameras.length < 2;
    const preferred = cameras.findIndex((c) => c.id === preferId);
    if (preferred >= 0) select.value = String(preferred);
    const show = () => {
      const cam = cameras[+select.value || 0];
      $('camera-dialog-source').textContent = `${cam.files.length} light field photo(s) on ${cam.label}.`;
      showCameraDialog({
        files: cam.files,
        thumb: (f) => native.cameraThumbnail(cam.id, f.id),
        onImport: async (picked) => {
          const added = await importCameraFiles(cam, picked);
          if (added.length) openItem(added[0]);
        },
      });
    };
    select.onchange = show;
    show();
  }
  return { showCameraDialog, openWebUsbCamera, importFromCameraFolder, importFromConnectedCamera };
}
