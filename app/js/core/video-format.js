// Video export settings: file format, compression (codec) and quality, and
// the MediaRecorder type and bitrate they come to. Browsers record different
// codecs, so each choice lists the types to try, most capable first.

export const VIDEO_FORMATS = {
  webm: { name: 'WebM', ext: 'webm', codecs: ['vp9', 'av1', 'vp8'] },
  mp4: { name: 'MP4', ext: 'mp4', codecs: ['h264', 'h265', 'av1'] },
};

export const VIDEO_CODECS = {
  vp9: { name: 'VP9', types: { webm: ['video/webm;codecs=vp9', 'video/webm;codecs=vp09.00.41.08'] } },
  vp8: { name: 'VP8', types: { webm: ['video/webm;codecs=vp8'] } },
  av1: { name: 'AV1', types: { webm: ['video/webm;codecs=av01', 'video/webm;codecs=av1', 'video/webm;codecs=av01.0.08M.08'], mp4: ['video/mp4;codecs=av01.0.08M.08', 'video/mp4;codecs=av01'] } },
  h264: { name: 'H.264', types: { mp4: ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1.4d0033', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'] } },
  h265: { name: 'H.265 (HEVC)', types: { mp4: ['video/mp4;codecs=hvc1.1.6.L153.B0', 'video/mp4;codecs=hev1.1.6.L153.B0', 'video/mp4;codecs=hvc1'] } },
};

// Quality: the bitrate in megabits a second.
export const VIDEO_QUALITY = { min: 1, max: 40, default: 16 };

// The first type this browser records for a format and codec, or null.
export function videoType(format, codec, supported) {
  const list = (VIDEO_CODECS[codec] && VIDEO_CODECS[codec].types[format]) || [];
  return list.find((t) => supported(t)) || null;
}

// The type to record with: the chosen format and codec when the browser
// records them, else the format's first codec it does, else any it does.
// `fallback` says the choice could not be kept.
export function chooseVideoType(format, codec, supported) {
  const exact = videoType(format, codec, supported);
  if (exact) return { type: exact, format, codec, fallback: false };
  const order = [format, ...Object.keys(VIDEO_FORMATS).filter((f) => f !== format)].filter((f) => VIDEO_FORMATS[f]);
  for (const f of order) {
    for (const c of VIDEO_FORMATS[f].codecs) {
      const type = videoType(f, c, supported);
      if (type) return { type, format: f, codec: c, fallback: true };
    }
  }
  return null;
}

// Bits a second for a quality setting (megabits a second), kept within
// the slider's range.
export function videoBitrate(mbps) {
  const v = Number.isFinite(+mbps) && +mbps > 0 ? +mbps : VIDEO_QUALITY.default;
  return Math.round(Math.min(VIDEO_QUALITY.max, Math.max(VIDEO_QUALITY.min, v)) * 1e6);
}

// A video's frame for a Size setting and a picture w x h: a height such as
// '1080' keeps the picture's shape with that short side; a fixed size such
// as '1080x1920' (social media) takes the largest centered part of the
// picture with that shape. Sizes are even, as video encoders need.
export function videoFrame(size, w, h) {
  const even = (v) => Math.max(2, 2 * Math.round(v / 2));
  const fixed = /^(\d+)x(\d+)$/.exec(String(size));
  if (fixed) {
    const W = +fixed[1];
    const H = +fixed[2];
    const aspect = W / H;
    let cw = w;
    let ch = w / aspect;
    if (ch > h) {
      ch = h;
      cw = h * aspect;
    }
    return { width: W, height: H, crop: { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch } };
  }
  const up = (+size || 1080) / Math.min(w, h);
  return { width: even(w * up), height: even(h * up), crop: { x: 0, y: 0, w, h } };
}
