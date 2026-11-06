// camera section: moved out of main.js. initCameraSection() runs where the section used to, with what it uses from the rest of the page.
import { readThumbnail, blobReader } from '../core/lfp.js';
import { native, NativeFile, listCameraFolder, recallCameraFolder, pickCameraFolder, rememberCameraFolder } from '../platform.js';
import { downloadPicture } from '../camera/webusb.js';
import { groupPhotos } from '../library/scan.js';

export function initCameraSection({ state, cameraThumbs, renderLibrary, $, showGrid, openItem, showProgress, showError, hideProgress, importPhotos, importFromConnectedCamera, importFromCameraFolder, showCameraDialog }) {
  // The Camera section above the library: the connected camera's photos.
  // { cam: { kind: 'drive' | 'adb' | 'web', id, label, files }, note, show }
  // (`show`: the Show photos… button, to choose or allow reading the drive in
  // a browser). Clicking a photo imports it (once) and opens it.

  function setCameraSection(next) {
    const was = state.cameraSection.cam;
    state.cameraSection = next;
    if (!next.cam || (was && was.id !== next.cam.id)) {
      for (const url of cameraThumbs.values()) URL.revokeObjectURL(url);
      cameraThumbs.clear();
    }
    // The camera's photos just arrived while the library grid is showing:
    // show them.
    if (next.cam && !was && state.grid) state.cameraView = true;
    renderLibrary();
  }

  // The library photo this camera file was imported as, if any.
  function importedAs(f) {
    return state.lib ? state.lib.photos.find((p) => p.name === f.name && p.size === f.size) || null : null;
  }

  function cameraThumb(cam, f) {
    if (cam.kind === 'web') return readThumbnail(blobReader(f.file));
    if (cam.kind === 'drive' || cam.kind === 'lytro') return native.cameraThumbnail(cam.id, f.id);
    return Promise.resolve(null);
  }

  // The Camera row in the sidebar: like an album, it shows the camera's
  // photos in the grid.
  function renderCameraSection() {
    const { cam, note = '', show = false } = state.cameraSection;
    $('camera-section').hidden = !cam && !note;
    $('camera-section-note').textContent = cam ? '' : note;
    $('camera-section-note').hidden = !!cam || !note;
    $('camera-show').hidden = !show || !!cam;
    $('camera-show').textContent = state.rememberedFailed ? 'Choose DCIM folder…' : 'Show photos…';
    const rows = cam || note ? [{ name: cam ? cam.label : 'Lytro camera', count: cam ? cam.files.length : '' }] : [];
    $('camera-rows').replaceChildren(...rows.map((row) => {
      const li = document.createElement('li');
      li.classList.toggle('current', !!state.cameraView);
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'album', title: 'Show the photos on the camera' });
      b.append(
        Object.assign(document.createElement('span'), { className: 'name', textContent: row.name }),
        Object.assign(document.createElement('span'), { className: 'count', textContent: row.count }),
      );
      b.onclick = () => {
        state.cameraView = true;
        showGrid(true);
      };
      li.append(b);
      return li;
    }));
  }

  // The camera's photos as thumbnails in the grid: clicking one imports it
  // (once) and opens it; ✓ marks photos already in the library.
  function renderCameraGrid() {
    if (!state.grid) return;
    const { cam } = state.cameraSection;
    const files = cam ? cam.files : [];
    $('grid-title').textContent = cam ? cam.label : 'Lytro camera';
    $('grid-count').textContent = cam ? `${files.length} photo${files.length === 1 ? '' : 's'} on the camera` : '';
    $('grid-import-all').hidden = !files.length || files.every(importedAs);
    $('photo-grid').replaceChildren(...files.map((f) => {
      const tile = document.createElement('div');
      const inLib = importedAs(f);
      tile.className = inLib ? 'tile imported' : 'tile';
      tile.tabIndex = 0;
      tile.setAttribute('role', 'button');
      tile.setAttribute('aria-label', inLib ? `Open ${f.name}` : `Import and open ${f.name}`);
      tile.title = inLib ? `${f.name} (in the library)` : `${f.name} · ${(f.size / 1e6).toFixed(0)} MB`;
      const frame = Object.assign(document.createElement('div'), { className: 'frame' });
      const key = `${cam.id}|${f.id || f.path}`;
      if (cameraThumbs.has(key)) frame.append(Object.assign(document.createElement('img'), { src: cameraThumbs.get(key), alt: '' }));
      else {
        cameraThumb(cam, f).then((t) => {
          if (!t || state.cameraSection.cam !== cam) return;
          const url = URL.createObjectURL(new Blob([t.bytes], { type: t.mime }));
          cameraThumbs.set(key, url);
          frame.append(Object.assign(document.createElement('img'), { src: url, alt: '' }));
        }).catch(() => {});
      }
      const name = Object.assign(document.createElement('div'), { className: 'name', textContent: f.name });
      tile.append(frame, name);
      const open = async () => {
        const photo = importedAs(f) || (await importCameraFiles(cam, [f]))[0];
        if (photo) openItem(photo);
      };
      tile.onclick = open;
      tile.onkeydown = (e) => {
        if (e.target === tile && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          open();
        }
      };
      return tile;
    }));
    // A browser reads the camera only from a drive the user chooses.
    $('grid-camera-choose-row').hidden = !!cam || native !== null;
    $('grid-empty').hidden = files.length > 0;
    $('grid-empty').textContent = cam
      ? `No photos found on ${cam.label}.`
      : native ? 'Looking for the photos on the camera…'
      : 'To see the photos on the camera, open the camera\'s drive in the folder picker and choose its DCIM folder. (Browsers read a camera only through a folder you choose, and do not let a page choose a whole drive.) It is remembered for next time.';
  }

  // Imports photos from a camera into the library: a camera drive (desktop
  // or browser) is read directly; a camera reached over adb is copied to the
  // library's staging folder first. Returns the added photos.
  async function importCameraFiles(cam, picked) {
    if (!picked.length) return [];
    let entries;
    if (cam.kind === 'web') {
      entries = picked.map((f) => ({ path: f.path, file: f.file }));
    } else if (cam.kind === 'drive') {
      entries = picked.map((f) => ({ path: `${f.folder}/${f.name}`, file: new NativeFile({ path: f.id, name: f.name, size: f.size }) }));
    } else if (cam.kind === 'webusb') {
      // Over WebUSB, in the page: each picture is read off the camera.
      entries = [];
      try {
        for (let i = 0; i < picked.length; i++) {
          showProgress(`Copying ${picked[i].name} from the camera (${i + 1} of ${picked.length})`, i / picked.length);
          const got = await downloadPicture(state.webUsbConn.camera, picked[i].picture, state.webUsbConn.product);
          entries.push({ path: got.name, file: new File([got.data], got.name) });
        }
      } catch (err) {
        showError(err);
        return [];
      } finally {
        hideProgress();
      }
    } else {
      const stop = native.onImportProgress((p) => showProgress(`Copying ${p.file} from the camera (${Math.min(p.index + 1, p.count)} of ${p.count})`, p.total ? p.bytes / p.total : 0));
      try {
        const files = await native.importFromCamera(cam.id, picked.map((f) => f.id));
        entries = files.map((f) => ({ path: f.name, file: new NativeFile(f) }));
      } catch (err) {
        showError(err);
        return [];
      } finally {
        stop();
        hideProgress();
      }
    }
    const added = await importPhotos(groupPhotos(entries));
    if (cam.kind === 'adb') state.lib.store.remove('.incoming').catch(() => {});
    return added;
  }

  // The name shown for a camera folder chosen in a browser: its DCIM folder
  // (what browsers let a page choose) reads as the camera.
  function webCameraLabel(source) {
    return /^dcim$/i.test(source) ? 'Lytro camera' : source;
  }

  // Browser: lists a camera drive (a folder handle) in the Camera section.
  // False when it has no photos or cannot be read (not mounted yet, gone).
  async function showWebCamera(dir) {
    try {
      const { source, files } = await listCameraFolder(dir);
      if (!files.length) return false;
      setCameraSection({ cam: { kind: 'web', id: `web:${source}`, label: webCameraLabel(source), files } });
      return true;
    } catch {
      return false;
    }
  }

  async function showCameraPhotos() {
    // First the drive chosen last time (asking to read it again), then, if
    // that fails, a fresh choice.
    if (!state.rememberedFailed) {
      const dir = await recallCameraFolder();
      if (dir && dir.requestPermission) {
        const ok = (await dir.requestPermission({ mode: 'read' }).catch(() => 'denied')) === 'granted';
        if (ok && (await showWebCamera(dir))) return;
        state.rememberedFailed = true;
        renderCameraSection();
        return;
      }
    }
    let result;
    try {
      result = await pickCameraFolder();
    } catch (err) {
      if (err.name !== 'AbortError') showError(err);
      return;
    }
    if (result.dir) {
      state.rememberedFailed = false;
      rememberCameraFolder(result.dir);
    }
    if (result.dir && (await showWebCamera(result.dir))) return;
    setCameraSection({ ...state.cameraSection, cam: { kind: 'web', id: `web:${result.source}`, label: webCameraLabel(result.source), files: result.files } });
  }

  $('camera-show').onclick = () => {
    state.cameraView = true;
    showGrid(true);
    showCameraPhotos();
  };
  $('grid-camera-choose').onclick = showCameraPhotos;

  $('grid-import-all').onclick = async () => {
    const { cam } = state.cameraSection;
    if (!cam) return;
    const added = await importCameraFiles(cam, cam.files.filter((f) => !importedAs(f)));
    if (added.length) openItem(added[0]);
  };

  // Browser: the USB chooser is the permission to connect to a camera; it is
  // asked first (the browser offers cameras it may use, such as an ILLUM), then
  // the camera's drive is read through a folder the user chooses.
  async function importFromCamera() {
    if (native) return importFromConnectedCamera(null);
    // The drive chosen last time, if the browser lets the page read it again
    // (one click allows it): no folder to pick.
    const remembered = await recallCameraFolder();
    if (remembered && remembered.requestPermission) {
      try {
        if ((await remembered.requestPermission({ mode: 'read' })) === 'granted') {
          const listed = await listCameraFolder(remembered);
          if (listed.files.length) return importFromCameraFolder({ ...listed, dir: remembered });
        }
      } catch {
        // The drive is not there now: choose it again below.
      }
    }
    if (!navigator.usb) return importFromCameraFolder();
    // Choosing the folder needs its own click, so the dialog comes next.
    const allowed = await state.askCameraPermission();
    if (state.webUsbConn) {
      // Read over USB: the dialog lists the photos on the camera.
      const cam = state.cameraSection.cam;
      $('camera-choose').hidden = true;
      $('camera-select-row').hidden = true;
      $('camera-dest').hidden = true;
      $('camera-dialog-source').textContent = `${cam.files.length} light field photo(s) on ${cam.label}.`;
      showCameraDialog({
        files: cam.files,
        thumb: async () => null,
        onImport: async (picked) => {
          const added = await importCameraFiles(cam, picked);
          if (added.length) openItem(added[0]);
        },
      });
      return;
    }
    $('camera-select-row').hidden = true;
    $('camera-dest').hidden = true;
    $('camera-choose').hidden = false;
    $('camera-dialog-source').textContent = state.webUsbReport
      // What the camera answered over USB, to read and select here.
      ? `The camera was found but could not be read over USB. ${state.cameraSection.note || ''}\n\n${state.webUsbReport}\n\nYou can still choose its drive's DCIM folder to list its photos.`
      : allowed
        ? 'Camera allowed. Now choose its drive\'s DCIM folder to list its photos.'
        : 'Switch the camera on and connect its USB cable, then choose its drive\'s DCIM folder to list its photos.';
    showCameraDialog({ files: [], thumb: async () => null, onImport: () => {} });
  }

  $('camera-select-all').onclick = () => {
    $('camera-grid').querySelectorAll('input').forEach((b) => { b.checked = true; });
  };
  $('camera-select-none').onclick = () => {
    $('camera-grid').querySelectorAll('input').forEach((b) => { b.checked = false; });
  };
  return { setCameraSection, renderCameraSection, renderCameraGrid, importCameraFiles, webCameraLabel, showWebCamera, importFromCamera };
}
