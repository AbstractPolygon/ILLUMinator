// First generation cameras (model F01): Lytro Desktop's own auto level (ToneMap::Analyze), which runs for the first generation camera only; the ILLUM keeps its exposure.
// On the central 80 % of the picture at one pixel a lens, in white balanced camera colour, scaled by the camera's digital ISO gain (ISO / 794, at least 1):
//   white = the largest of the channels' 99.9th percentiles; black = the smallest of their 0.1th, at most a tenth of white;
//   a white below 1 is pulled toward 1 (1 - 0.9 (1 - white)); gain = min(8, 1 / (white - black)).
// The engine's picture is (x - black) * gain. Here the exposure is that gain times the ISO gain (the black offset is not applied).

export const isFirstGeneration = (cam) => !!cam && /^F01/i.test(cam.model || '');

export const isoDigitalGain = (iso) => Math.max(1, (iso || 0) / 794);

// rgb: Float32Array of w x h pixels (linear, white balanced camera colour). Returns { exposure, white, black, gain, isoGain }, or null when there is too little picture.
export function firstGenLevel(rgb, w, h, iso) {
  const isoGain = isoDigitalGain(iso);
  const x0 = Math.floor(w * 0.1);
  const x1 = Math.ceil(w * 0.9);
  const y0 = Math.floor(h * 0.1);
  const y1 = Math.ceil(h * 0.9);
  const planes = [[], [], []];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 3;
      if (!(rgb[i] + rgb[i + 1] + rgb[i + 2] > 0)) continue;
      for (let c = 0; c < 3; c++) planes[c].push(rgb[i + c] * isoGain);
    }
  }
  if (planes[0].length < 100) return null;
  const pct = (a, q) => {
    const t = Float32Array.from(a).sort();
    return t[Math.min(t.length - 1, Math.max(0, Math.round(q * (t.length - 1))))];
  };
  const white0 = Math.max(...planes.map((a) => pct(a, 0.999)));
  const black = Math.min(Math.min(...planes.map((a) => pct(a, 0.001))), 0.1 * white0);
  const white = white0 < 1 ? 1 - 0.9 * (1 - white0) : white0;
  const gain = Math.min(8, 1 / Math.max(1e-3, white - black));
  return { exposure: isoGain * gain, white, black, gain, isoGain };
}
