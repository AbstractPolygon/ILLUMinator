import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseVideoType, videoType, videoBitrate, VIDEO_FORMATS, VIDEO_CODECS } from '../app/js/core/video-format.js';

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

test('bitrate scales with the quality and the picture size', () => {
  assert.equal(videoBitrate('high', 1920, 1080), 16e6);
  assert.equal(videoBitrate('low', 3840, 2160), 16e6);
  assert.equal(videoBitrate('unknown', 1920, 1080), 16e6);
});
