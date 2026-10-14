import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseVideoType, videoType, videoBitrate, videoFrame, VIDEO_FORMATS, VIDEO_CODECS } from '../app/js/core/video-format.js';

const only = (...types) => (t) => types.includes(t);

test('the chosen format and compression when the browser records them', () => {
  const pick = chooseVideoType('mp4', 'h264', only('video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9'));
  assert.deepEqual(pick, { type: 'video/mp4;codecs=avc1.42E01E', format: 'mp4', codec: 'h264', fallback: false });
});

test('falls back to the same format first, then any other', () => {
  const vp8 = chooseVideoType('webm', 'av1', only('video/webm;codecs=vp8'));
  assert.equal(vp8.codec, 'vp8');
  assert.equal(vp8.fallback, true);
  const webm = chooseVideoType('mp4', 'h265', only('video/webm;codecs=vp9'));
  assert.equal(webm.format, 'webm');
  assert.equal(chooseVideoType('webm', 'vp9', () => false), null);
});

test('every format codec has a type to try', () => {
  for (const [f, fmt] of Object.entries(VIDEO_FORMATS)) {
    for (const c of fmt.codecs) assert.ok(VIDEO_CODECS[c].types[f].length, `${f} ${c}`);
  }
  assert.equal(videoType('webm', 'h264', () => true), null);
});

test('bitrate from the quality slider, 1 to 40 Mbit/s', () => {
  assert.equal(videoBitrate(16), 16e6);
  assert.equal(videoBitrate('40'), 40e6);
  assert.equal(videoBitrate(90), 40e6);
  assert.equal(videoBitrate('high'), 16e6);
});

test('video frames: heights keep the shape, social sizes cut the center', () => {
  assert.deepEqual(videoFrame('1080', 2460, 1708), { width: 1556, height: 1080, crop: { x: 0, y: 0, w: 2460, h: 1708 } });
  const vertical = videoFrame('1080x1920', 2460, 1708);
  assert.equal(vertical.width, 1080);
  assert.equal(vertical.height, 1920);
  assert.equal(vertical.crop.h, 1708);
  assert.ok(Math.abs(vertical.crop.w - 1708 * 9 / 16) < 1e-9);
  assert.ok(Math.abs(vertical.crop.x - (2460 - vertical.crop.w) / 2) < 1e-9);
  const square = videoFrame('1080x1080', 2460, 1708);
  assert.deepEqual(square.crop, { x: 376, y: 0, w: 1708, h: 1708 });
  // A tall picture into a wide video: full width, centered rows.
  const wide = videoFrame('1920x1080', 900, 1600);
  assert.equal(wide.crop.w, 900);
  assert.ok(Math.abs(wide.crop.h - 900 * 9 / 16) < 1e-9);
});
