// Optional monocular depth models, as ONNX files run with ONNX Runtime Web (on the graphics card where there is one, else on the CPU): Depth Anything V2 Small (Apache-2.0,
// Lihe Yang et al.) and MiDaS v2.1 Small (MIT, Intel ISL). Not part of the app's own download: each is fetched when its box in Settings is ticked, checked against its
// SHA-256 and kept in the browser's cache (the desktop app's too) until the box is unticked. They are fetched from the pinned revision of the repository that publishes
// them (Hugging Face), so a changed file there does not reach the app: only a file with the expected hash is kept.
//
// What they give is a relative depth (larger = nearer, in no unit); core/depthmodel.js fits it to the measured depth.

import { sha256Hex } from './upscalemodels.js';

const CACHE = 'illuminator-depth-models-v1';

export const DEPTH_MODELS = [
  {
    id: 'da2-small',
    name: 'Depth Anything V2 Small',
    note: 'detailed edges, Apache-2.0',
    url: 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx',
    size: 99060839,
    sha256: 'afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c',
    input: 518, // the square picture the model is given
    inputName: 'pixel_values',
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
  {
    id: 'midas-small',
    name: 'MiDaS v2.1 Small',
    note: 'fast, MIT',
    url: 'https://huggingface.co/Heliosoph/midas-small-onnx/resolve/f3a5a5e4c852c7bfac10517767e5b0636cb42b92/midas_v21_small_256.onnx',
    size: 66389153,
    sha256: 'b0a5b3f12625137e626805167907fe0410665bec671685d59daaa2daab19f977',
    input: 256,
    inputName: 'input_image',
    mean: [0.485, 0.456, 0.406],
    std: [0.229, 0.224, 0.225],
  },
];

// The Depth method value of a model in Camera > Depth.
export const depthModelMethod = (id) => `model:${id}`;
export const methodDepthModel = (method) => (typeof method === 'string' && method.startsWith('model:') ? DEPTH_MODELS.find((m) => m.id === method.slice(6)) || null : null);

async function openCache() {
  try {
    return typeof caches !== 'undefined' ? await caches.open(CACHE) : null;
  } catch {
    return null;
  }
}

// 'none' (not downloaded), 'ready', or 'stale' (a file with another hash is kept).
export async function depthModelState(model) {
  const cache = await openCache();
  const hit = cache && (await cache.match(model.url));
  if (!hit) return 'none';
  return hit.headers.get('x-sha256') === model.sha256 ? 'ready' : 'stale';
}

export async function removeDepthModel(model) {
  const cache = await openCache();
  if (cache) await cache.delete(model.url);
}

// Downloads a model (`onProgress(0..1)`), checks it and keeps it. Throws when it cannot be downloaded or is not the file expected; nothing is kept then.
export async function downloadDepthModel(model, onProgress = () => {}) {
  const cache = await openCache();
  if (!cache) throw new Error('This browser cannot keep downloaded models.');
  const res = await fetch(model.url);
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
  await cache.put(model.url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-sha256': model.sha256 } }));
}

export async function readDepthModel(model) {
  const cache = await openCache();
  const hit = cache && (await cache.match(model.url));
  if (!hit || hit.headers.get('x-sha256') !== model.sha256) throw new Error(`${model.name} is not downloaded (Settings > Depth models).`);
  return new Uint8Array(await hit.arrayBuffer());
}
