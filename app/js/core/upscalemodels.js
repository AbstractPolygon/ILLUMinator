// Optional image upscaling models: Real-ESRGAN (BSD-3-Clause, Xintao Wang et al.), as ONNX files, run with ONNX Runtime Web on the graphics card (WebGPU). Not part of
// the app's own download: each is fetched when its checkbox in Settings is ticked, checked against its SHA-256, and kept in the browser's cache (the desktop app's too)
// until the box is unticked. The files are a format conversion of the official weights; copies are in this repository's models/ folder (see models/README.md for how they
// are kept up to date), and the models and their hashes are listed in upscalemodels-data.js, generated from models/manifest.json.
//
// Model contract (from the card): input `input`, float32 [1, 3, H, W], RGB 0..1, H and W dynamic; output `output`, float32 [1, 3, 4H, 4W], RGB 0..1 (to be clipped).

import { MODEL_DATA, MODEL_SOURCE } from './upscalemodels-data.js';

const CACHE = 'illuminator-upscale-models-v1';
// Where a model is fetched from, in order: this repository's copy (models/), then the pinned revision of the source repository. Only a file with the expected SHA-256 is kept,
// so a replaced model in the repository does not break an older app (it falls through to the source, which still has the file its hash names).
const REPO_BASE = 'https://raw.githubusercontent.com/AbstractPolygon/Illuminator/main/models/';
const SOURCE_BASE = `https://huggingface.co/${MODEL_SOURCE.repo}/resolve/${MODEL_SOURCE.revision}/`;

export const UPSCALE_MODELS = MODEL_DATA;

// The Method value of a model in Render Settings > Upscaling.
export const modelMethod = (id) => `ai:${id}`;
export const methodModel = (method) => (typeof method === 'string' && method.startsWith('ai:') ? UPSCALE_MODELS.find((m) => m.id === method.slice(3)) || null : null);

// (the cache key: the same whichever address it came from; the entry says which file it holds, so a model replaced in the manifest is found out of date)
const urlOf = (model) => REPO_BASE + model.file;

async function openCache() {
  try {
    return typeof caches !== 'undefined' ? await caches.open(CACHE) : null;
  } catch {
    return null;
  }
}

// 'none' (not downloaded), 'ready', or 'stale': an older version of the model is kept (the manifest names a newer file) and should be downloaded again.
export async function modelState(model) {
  const cache = await openCache();
  const hit = cache && (await cache.match(urlOf(model)));
  if (!hit) return 'none';
  return hit.headers.get('x-sha256') === model.sha256 ? 'ready' : 'stale';
}

export async function modelDownloaded(model) {
  return (await modelState(model)) === 'ready';
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
  let failure = null;
  for (const base of [REPO_BASE, SOURCE_BASE]) {
    try {
      const bytes = await fetchBytes(base + model.file, model, onProgress);
      if (bytes.length !== model.size || (await sha256Hex(bytes)) !== model.sha256) throw new Error(`${model.name} did not download correctly. Try again.`);
      await cache.put(urlOf(model), new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-sha256': model.sha256 } }));
      return;
    } catch (err) {
      failure = err;
    }
  }
  throw failure;
}

async function fetchBytes(url, model, onProgress) {
  const res = await fetch(url);
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
  return bytes;
}

export async function readModel(model) {
  const cache = await openCache();
  const hit = cache && (await cache.match(urlOf(model)));
  if (!hit || hit.headers.get('x-sha256') !== model.sha256) throw new Error(`${model.name} is not downloaded (Settings > Upscaling models).`);
  return new Uint8Array(await hit.arrayBuffer());
}
