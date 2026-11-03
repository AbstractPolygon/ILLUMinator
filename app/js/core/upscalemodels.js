// Optional image upscaling models: Real-ESRGAN (BSD-3-Clause, Xintao Wang et al.), as ONNX files, run with ONNX Runtime Web on the graphics card (WebGPU). Not part of
// the app's own download: each is fetched when its checkbox in Settings is ticked, checked against its SHA-256, and kept in the browser's cache (the desktop app's too)
// until the box is unticked. The files are a format conversion of the official weights (see the model card at the address below); pinned to one revision so they cannot change.
//
// Model contract (from the card): input `input`, float32 [1, 3, H, W], RGB 0..1, H and W dynamic; output `output`, float32 [1, 3, 4H, 4W], RGB 0..1 (to be clipped).

const BASE = 'https://huggingface.co/relax123666/clearpic-models/resolve/f96b35c2b7ad0eb74db505f89eab5ea24a94ba08/';
const CACHE = 'illuminator-upscale-models-v1';

export const UPSCALE_MODELS = [
  { id: 'realesr-general-x4v3', name: 'Real-ESRGAN general', note: 'fast', file: 'realesr-general-x4v3.onnx', size: 4866396, sha256: 'f788518cc66e302bc9b6946016e989dd9374f1012d5b6c0c7e753904ef3f99e4', scale: 4 },
  { id: 'RealESRGAN_x4plus', name: 'Real-ESRGAN x4plus', note: 'best quality', file: 'RealESRGAN_x4plus.onnx', size: 67051618, sha256: 'c6a0cc3b0535ea566f30f20b8dd42f0462502b9e22cf45ea6e0b3ccf55d03d98', scale: 4 },
];

// The Method value of a model in Render Settings > Upscaling.
export const modelMethod = (id) => `ai:${id}`;
export const methodModel = (method) => (typeof method === 'string' && method.startsWith('ai:') ? UPSCALE_MODELS.find((m) => m.id === method.slice(3)) || null : null);

const urlOf = (model) => BASE + model.file;

async function openCache() {
  try {
    return typeof caches !== 'undefined' ? await caches.open(CACHE) : null;
  } catch {
    return null;
  }
}

export async function modelDownloaded(model) {
  const cache = await openCache();
  return !!cache && !!(await cache.match(urlOf(model)));
}

export async function removeModel(model) {
  const cache = await openCache();
  if (cache) await cache.delete(urlOf(model));
}

export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Downloads a model (`onProgress(0..1)`), checks it and keeps it. Throws when it cannot be downloaded or is not the file expected; nothing is kept then.
export async function downloadModel(model, onProgress = () => {}) {
  const cache = await openCache();
  if (!cache) throw new Error('This browser cannot keep downloaded models.');
  const res = await fetch(urlOf(model));
  if (!res.ok) throw new Error(`Could not download ${model.name}: ${res.status}`);
  const total = +res.headers.get('content-length') || model.size;
  const parts = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  if (bytes.length !== model.size || (await sha256Hex(bytes)) !== model.sha256) throw new Error(`${model.name} did not download correctly. Try again.`);
  await cache.put(urlOf(model), new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
}

export async function readModel(model) {
  const cache = await openCache();
  const hit = cache && (await cache.match(urlOf(model)));
  if (!hit) throw new Error(`${model.name} is not downloaded (Settings > Upscaling models).`);
  return new Uint8Array(await hit.arrayBuffer());
}
