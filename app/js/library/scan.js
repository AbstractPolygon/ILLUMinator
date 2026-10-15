// Turns a list of files found in a folder tree (a Lytro Desktop library, a
// camera's DCIM folder, files picked together) into photos: the light field
// file, the Lytro Desktop edits that belong to it and a thumbnail if one is
// stored beside it.
//
// entries: [{ path: 'a/b/IMG_0001.LFR', file }] (path relative, '/' separated)
// returns: [{ name, label, file, sidecar, thumb, depthMap, depthRange, stack }]
//
// Lytro Desktop keeps each picture in its own folder: raw.lfp (the light
// field), stack.view.lfp (the edits), stack.lfp (a rendered focal stack),
// thumbnails and, when its depth map was edited, stack.userdepthmap.png with
// stack.userdepthmap.txt (core/userdepth.js). stack.lfp also holds the depth
// Lytro Desktop computed, kept as `stack` beside raw.lfp. Everywhere else photos are IMG_0001.LFR files, optionally with
// an IMG_0001.LFP exported next to them.

const LIGHT_FIELD = /\.(lfr|lfp|raw)$/i;
const VIEW = /(^|\.)view\.lfp$/i;
const THUMB = /thumb.*\.(jpe?g|png)$/i;
const DEPTH_MAP = /userdepthmap(\.(png|jpe?g|tiff?|bmp))?$/i;
const DEPTH_RANGE = /userdepthmap\.txt$/i;

const baseName = (path) => path.split('/').pop();
const dirName = (path) => path.split('/').slice(0, -1).join('/');
export const stem = (name) => name.replace(/\.[^.]+$/, '').toLowerCase();
const title = (name) => name.replace(/\.[^.]+$/, '');

// Hidden files and macOS resource forks (._IMG_0001.LFR) are not photos.
const visible = (name) => !name.startsWith('.');

export function groupPhotos(entries) {
  const byDir = new Map();
  for (const e of entries) {
    const name = baseName(e.path || e.file.name);
    if (!visible(name)) continue;
    const dir = dirName(e.path || '');
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push({ ...e, name });
  }
  const photos = [];
  for (const [dir, files] of byDir) {
    const find = (re) => files.find((f) => re.test(f.name));
    const thumb = find(THUMB);
    const lf = files.filter((f) => LIGHT_FIELD.test(f.name));
    const main = find(/^raw\.lfp$/i) || find(/^stack\.lfp$/i);
    if (main) {
      // A Lytro Desktop picture folder: named after the folder.
      const label = baseName(dir) || title(main.name);
      const view = lf.find((f) => VIEW.test(f.name));
      const depthMap = find(DEPTH_MAP);
      const depthRange = find(DEPTH_RANGE);
      const depth = depthMap && depthRange ? { depthMap: depthMap.file, depthRange: depthRange.file } : { depthMap: null, depthRange: null };
      const stack = /^raw\.lfp$/i.test(main.name) ? find(/^stack\.lfp$/i) : null;
      photos.push({ name: label, label, file: main.file, sidecar: view ? view.file : null, thumb: thumb ? thumb.file : null, ...depth, stack: stack ? stack.file : null });
      continue;
    }
    const photoFiles = lf.filter((f) => /\.(lfr|raw)$/i.test(f.name));
    for (const f of photoFiles) {
      const exported = lf.find((g) => /\.lfp$/i.test(g.name) && stem(g.name) === stem(f.name));
      photos.push({ name: f.name, label: title(f.name), file: f.file, sidecar: exported ? exported.file : null, thumb: null });
    }
    const views = lf.filter((f) => VIEW.test(f.name));
    for (const f of lf) {
      if (photoFiles.includes(f) || VIEW.test(f.name)) continue;
      // An exported LFP is a photo too (it keeps its own pictures and depth).
      photos.push({ name: f.name, label: title(f.name), file: f.file, sidecar: null, thumb: null });
    }
    // A lone edits file picked with a single photo belongs to it.
    const single = photos.filter((p) => files.some((f) => f.file === p.file));
    if (views.length === 1 && single.length === 1 && !single[0].sidecar) single[0].sidecar = views[0].file;
  }
  return photos;
}
