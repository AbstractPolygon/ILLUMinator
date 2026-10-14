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

// Bitrate at 1080p (1920 x 1080), in megabits a second; other sizes scale
// with their pixel count.
export const VIDEO_QUALITY = { low: 4, medium: 8, high: 16, max: 40 };

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

// Bits a second for a video of w x h pixels at the chosen quality.
export function videoBitrate(quality, w, h) {
  const mbps = VIDEO_QUALITY[quality] || VIDEO_QUALITY.high;
  return Math.round(mbps * 1e6 * (w * h) / (1920 * 1080));
}
