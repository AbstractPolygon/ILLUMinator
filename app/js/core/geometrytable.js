// The photo's geometry correction table ("geometryCorrectionRef"), read from
// Lytro's engine (LFE::GeometryErrorTable::Deserialize, LookupNormalizedCoord,
// CorrectLightfieldPoint). Little endian:
//   int32 magic 0xAF0880FA, version 2, 15 (header words), 0, byte size,
//   width, height, then height rows of width (u, v) float pairs from byte 28.
// For a ray of a lens at the sensor place (x, y) (units of the image size from
// the middle) the engine takes the cell floor(size * (x + 0.5) + 0.5), clamped,
// and subtracts the cell's (u, v) from the ray's direction, in lens pitches, in
// the lens array's own axes. It moves where every lens's rays sit relative to the
// camera's optical axis, which is a viewpoint shift that no lens-to-lens
// consistency can reveal: near objects land on different pixels.

const MAGIC = 0xaf0880fa;

export function parseGeometryTable(bytes) {
  if (!bytes || bytes.length < 28) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getInt32(4, true) !== 2) return null;
  const size = view.getInt32(16, true);
  const w = view.getInt32(20, true);
  const h = view.getInt32(24, true);
  if (!(w > 0 && h > 0) || size > bytes.length || 28 + 8 * w * h > bytes.length) return null;
  const data = new Float32Array(2 * w * h);
  for (let i = 0; i < data.length; i++) data[i] = view.getFloat32(28 + 4 * i, true);
  return { w, h, data };
}

// The (u, v) correction in lens pitches at the normalized sensor place (nx, ny).
export function geometryAt(geo, nx, ny, out) {
  const ix = Math.min(geo.w - 1, Math.max(0, Math.floor(geo.w * (nx + 0.5) + 0.5)));
  const iy = Math.min(geo.h - 1, Math.max(0, Math.floor(geo.h * (ny + 0.5) + 0.5)));
  const k = 2 * (iy * geo.w + ix);
  out[0] = geo.data[k];
  out[1] = geo.data[k + 1];
  return out;
}
