// The memory limits chosen in Settings > Memory (the desktop app): how much RAM and video memory (VRAM) the app may plan to use. Heavy steps that can be sized (a full sensor
// render, a 16-bit export, an upscaling model) look here before they allocate and say what to lower instead of running the computer out of memory. The page and the worker
// each hold their own copy (the page sends its to the worker). No limits set: nothing is refused.

const GB = 1024 ** 3;
let limits = { ram: Infinity, vram: Infinity };

export function setMemoryLimits({ ramBytes, vramBytes } = {}) {
  limits = { ram: ramBytes > 0 ? ramBytes : Infinity, vram: vramBytes > 0 ? vramBytes : Infinity };
}

export const memoryLimits = () => ({ ...limits });

// kind: 'ram' or 'vram'.
export const fitsMemory = (kind, bytes) => bytes <= limits[kind];

const gb = (bytes) => `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`;

// The message for a step that does not fit (without a limit set, it is more than the computer can be asked for).
export function memoryProblem(kind, bytes, what, hint) {
  const name = kind === 'ram' ? 'memory' : 'video memory';
  const limit = Number.isFinite(limits[kind]) ? `the limit in Settings > Memory is ${gb(limits[kind])}` : 'that is more than it can use';
  return `${what} needs about ${gb(bytes)} of ${name}; ${limit}. ${hint}`;
}

// Rough sizes of the steps that matter (bytes).
// a full sensor render: about six float RGBA pictures of its size on the card, and the raw data and views already there
export const superResVram = (w, h) => w * h * 16 * 6 + 0.5 * GB;
// a 16-bit picture saved: the 16-bit RGB values, the enlarged copy, and the PNG's raw rows
export const exportRam = (w, h, k = 1) => w * h * 6 + w * k * h * k * (6 + 6) + 64 * 1024 ** 2;
// the graphics card's part of enlarging a 16-bit picture to W x H: the passes' float pictures (32-bit floats, or 16-bit where that does not fit) and the 8-bit target
export const enlargeVram = (W, H, f32) => W * H * ((f32 ? 16 : 8) * 2 + 4);
// a model's result: its pixels (16-bit RGB) times the scale squared
export const modelRam = (w, h, scale) => w * h * scale * scale * 6 * 2 + w * h * 6;
