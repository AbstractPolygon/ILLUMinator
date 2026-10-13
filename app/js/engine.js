// Promise wrapper around the decoding worker.

export class Engine {
  constructor() {
    // Test hook: ?cpu on the page renders without the GPU.
    const cpu = typeof location !== 'undefined' && new URLSearchParams(location.search).has('cpu');
    this.worker = new Worker(new URL(`./worker.js${cpu ? '?cpu' : ''}`, import.meta.url), { type: 'module' });
    this.nextId = 1;
    this.nextJob = 1;
    this.pending = new Map();
    this.worker.onmessage = (event) => this.dispatch(event.data);
    this.worker.onerror = (event) => console.error('Worker error', event.message || event);
  }

  dispatch(msg) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      if (p.onProgress) p.onProgress(msg.stage, msg.progress);
    } else if (msg.type === 'frame') {
      if (p.onFrame) p.onFrame(msg);
    } else if (msg.type === 'error') {
      this.pending.delete(msg.id);
      p.reject(new Error(msg.message));
    } else {
      this.pending.delete(msg.id);
      p.resolve('result' in msg ? msg.result : msg);
    }
  }

  request(type, args = {}, { onProgress, onFrame, transfer } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress, onFrame });
      this.worker.postMessage({ id, type, ...args }, transfer || []);
    });
  }

  // Long running jobs of one kind replace each other: starting a new one
  // stops the previous at its next frame.
  job(type, kind, args, handlers) {
    const job = this.nextJob++;
    return { job, promise: this.request(type, { ...args, job }, handlers) };
  }

  cancel(kind) {
    return this.request('cancel', { kind });
  }
}

// A worker picture: an ImageBitmap (GPU path) or RGBA bytes (CPU path).
// Both can be drawn and passed to createImageBitmap.
export function toImageData(msg) {
  if (msg.bitmap) return msg.bitmap;
  return new ImageData(new Uint8ClampedArray(msg.pixels), msg.width, msg.height);
}
