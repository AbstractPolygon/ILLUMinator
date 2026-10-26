// High level decoding shared by the worker and the command line tool.

import { bufferReader, isLfp, readLightFieldPicture, photoIdOf, LfpError } from './lfp.js';
import { cameraInfo, guessRawLayout, packedSize, unpackRaw } from './raw.js';
import { findRecipe } from './recipe.js';
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
    // Names the camera's geometry calibration file (its SHA-1) the photo was made with.
    geometryRef: picture && picture.frame ? picture.frame.geometryCorrectionRef || null : null,
    stacks: picture ? picture.stacks : [],
    frameDepth: picture ? picture.frameDepth : null,
    photoId: picture ? photoIdOf(picture.container) : null,
    thumbnails: picture ? picture.thumbnails : [],
    // Lytro Desktop edits saved in the file, if any (recipe.js).
    recipe: picture ? findRecipe(picture.toc) : null,
    readSection: picture ? picture.container.readSection : async () => null,
    // The camera's own correction of its rays (core/raywarp.js).
    rayWarpBytes: null,
    cam: null,
    raw: null,
  };

  if (picture && picture.frame && picture.frame.aberrationCorrectionRef) {
    try {
      result.rayWarpBytes = await picture.container.readSection(picture.frame.aberrationCorrectionRef);
    } catch {
      result.rayWarpBytes = null;
    }
  }
  // The photo's reconstruction filter bank (core/lytroedof.js).
  if (picture && picture.frame && picture.frame.reconstructionFilterRef && picture.frame.reconstructionFilterMetadataRef) {
    try {
      const png = await picture.container.readSection(picture.frame.reconstructionFilterRef);
      const meta = await picture.container.readSection(picture.frame.reconstructionFilterMetadataRef);
      result.reconFilter = { png, meta: JSON.parse(new TextDecoder().decode(meta)) };
    } catch {
      result.reconFilter = null;
    }
  }
  if (!rawBytes) return result;
  const cam = cameraInfo(result.metadata, layout);
  if (!cam.width || !cam.height || rawBytes.length < packedSize(cam.width, cam.height, cam.bits)) {
    // Not a sensor image we understand (e.g. a processed file); show stacks only.
    return result;
  }
  onProgress('Unpacking sensor data', 0.1);
  result.cam = cam;
  result.raw = unpackRaw(rawBytes, cam.width, cam.height, cam.bits);

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
