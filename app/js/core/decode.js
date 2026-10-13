// High level decoding shared by the worker and the command line tool.

import { bufferReader, isLfp, readLightFieldPicture, LfpError } from './lfp.js';
import { cameraInfo, guessRawLayout, packedSize, unpackRaw, removeHotPixels } from './raw.js';
import { gridFromCamera, calibrateGrid, measureGrid, normalizeGrid } from './lenslet.js';

export async function decodeLightField(bytes, { onProgress = () => {}, calibrate = true } = {}) {
  onProgress('Reading file', 0);
  let picture = null;
  let rawBytes = null;
  let layout = null;
  if (isLfp(bytes)) {
    picture = await readLightFieldPicture(bufferReader(bytes));
    if (picture.rawRef) rawBytes = await picture.container.readSection(picture.rawRef);
  } else {
    layout = guessRawLayout(bytes.length);
    if (!layout) throw new LfpError('Unrecognized file: not an LFP/LFR container or a known raw sensor dump');
    rawBytes = bytes;
  }

  const result = {
    metadata: picture ? picture.metadata : null,
    privateMetadata: picture ? picture.privateMetadata : null,
    stacks: picture ? picture.stacks : [],
    frameDepth: picture ? picture.frameDepth : null,
    // Stable id for the photo: the sha1 of its raw data (recorded in the
    // file), or of its table of contents for processed files.
    photoId: picture ? picture.rawRef || (picture.container.sections.find((s) => s.type === 'LFM') || {}).sha1 || null : null,
    thumbnails: picture ? picture.thumbnails : [],
    readSection: picture ? picture.container.readSection : async () => null,
    cam: null,
    raw: null,
  };

  if (!rawBytes) return result;
  const cam = cameraInfo(result.metadata, layout);
  if (!cam.width || !cam.height || rawBytes.length < packedSize(cam.width, cam.height, cam.bits)) {
    // Not a sensor image we understand (e.g. a processed file); show stacks only.
    return result;
  }
  onProgress('Unpacking sensor data', 0.1);
  result.cam = cam;
  result.raw = unpackRaw(rawBytes, cam.width, cam.height, cam.bits);
  result.hotPixels = removeHotPixels(result.raw, cam.width, cam.height);

  const metadataGrid = normalizeGrid(gridFromCamera(cam), cam);
  result.metadataGrid = metadataGrid;
  result.metadataGridQuality = measureGrid(result.raw, cam, metadataGrid);
  result.grid = metadataGrid;
  result.gridQuality = result.metadataGridQuality;
  if (calibrate) {
    onProgress('Locating microlenses', 0.2);
    const cal = calibrateGrid(result.raw, cam, metadataGrid, (p) => onProgress('Locating microlenses', 0.2 + 0.7 * p));
    if (cal.quality > result.metadataGridQuality) {
      result.grid = cal.grid;
      result.gridQuality = cal.quality;
    }
  }
  onProgress('Ready', 1);
  return result;
}
