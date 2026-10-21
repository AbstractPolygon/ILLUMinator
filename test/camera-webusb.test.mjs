// The camera protocol over WebUSB (app/js/camera/webusb.js) against a stand-in device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectWebUsb, describeInterfaces, candidateInterfaces, downloadPicture, LytroCamera, WebUsbTransport } from '../app/js/camera/webusb.js';

// A WebUSB device that answers the bulk-only wrappers like the camera does.
function fakeDevice({ files = {}, pictures = [], interfaces, claimFails = [] }) {
  let loaded = new Uint8Array(0);
  const queue = [];
  let pendingWrite = null;
  const csw = (status = 0) => { const b = new Uint8Array(13); b.set([0x55, 0x53, 0x42, 0x53]); b[12] = status; return b; };
  const le = (n, size = 4) => { const b = new Uint8Array(size); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const record = (p) => {
    const b = new Uint8Array(128);
    const dv = new DataView(b.buffer);
    [...(p.postfix || '')].forEach((c, i) => { b[i] = c.charCodeAt(0); });
    [...p.prefix].forEach((c, i) => { b[8 + i] = c.charCodeAt(0); });
    dv.setUint32(16, p.folder, true); dv.setUint32(20, p.number, true);
    [...p.id].forEach((c, i) => { b[48 + i] = c.charCodeAt(0); });
    [...p.date].forEach((c, i) => { b[96 + i] = c.charCodeAt(0); });
    dv.setUint32(124, 1, true);
    return b;
  };
  const list = () => {
    const head = new Uint8Array(20);
    const dv = new DataView(head.buffer);
    dv.setUint32(0, 1, true); dv.setUint32(4, 128, true); dv.setUint32(8, 1, true);
    return Uint8Array.from([...head, ...pictures.flatMap((p) => [...record(p)])]);
  };
  const dev = {
    vendorId: 0x24cf, productId: 0x00b1, productName: 'ILLUM',
    configuration: { interfaces: interfaces.map((i) => ({ interfaceNumber: i.number, alternates: [{ interfaceClass: i.cls, interfaceSubclass: i.sub || 0, interfaceProtocol: i.proto || 0, endpoints: [{ endpointNumber: 1, direction: 'in', type: 'bulk' }, { endpointNumber: 2, direction: 'out', type: 'bulk' }] }] })) },
    claimed: [],
    async open() {}, async close() {}, async selectConfiguration() {}, async clearHalt() {},
    async claimInterface(n) { if (claimFails.includes(n)) throw new Error('Unable to claim interface.'); dev.claimed.push(n); },
    async releaseInterface() {},
    async transferOut(ep, data) {
      if (pendingWrite) {
        const name = String.fromCharCode(...data.subarray(0, data.indexOf(0)));
        loaded = files[name] || new Uint8Array(0);
        pendingWrite = null;
        return { status: 'ok' };
      }
      assert.equal(String.fromCharCode(...data.subarray(0, 4)), 'USBC');
      const cdb = data.subarray(15, 31);
      const size = new DataView(data.buffer, data.byteOffset).getUint32(8, true);
      if (cdb[0] === 0xc6 && cdb[2] === 0) queue.push(le(loaded.length));
      else if (cdb[0] === 0xc2 && cdb[2] === 2) loaded = list();
      else if (cdb[0] === 0xc2 && cdb[2] === 0) { loaded = new Uint8Array(640); [...'Lytro, Inc.'].forEach((c, i) => { loaded[i] = c.charCodeAt(0); }); [...'B5120001'].forEach((c, i) => { loaded[256 + i] = c.charCodeAt(0); }); }
      else if (cdb[0] === 0xc2 && cdb[2] === 1) { pendingWrite = true; queue.push(csw()); return { status: 'ok' }; }
      else if (cdb[0] === 0xc4) { const off = new DataView(cdb.buffer, cdb.byteOffset).getUint32(3, true); queue.push(loaded.slice(off, off + size)); }
      queue.push(csw());
      return { status: 'ok' };
    },
    async transferIn(ep, length) {
      const next = queue.shift();
      return { status: 'ok', data: new DataView(next.buffer, next.byteOffset, next.byteLength) };
    },
  };
  return dev;
}

const ILLUM = [{ number: 0, cls: 8, sub: 6, proto: 0x50 }, { number: 1, cls: 0xff }];

test('interfaces: the vendor interface is the one a page can use', () => {
  const infos = describeInterfaces(fakeDevice({ interfaces: ILLUM }));
  assert.deepEqual(infos.map((i) => i.kind), ['mass', 'vendor']);
  assert.deepEqual(candidateInterfaces(infos).map((i) => i.number), [1]);
  const adb = describeInterfaces(fakeDevice({ interfaces: [{ number: 0, cls: 0xff, sub: 0x42, proto: 1 }] }));
  assert.deepEqual(candidateInterfaces(adb), []);
});

test('connects on the vendor interface, reads the picture list and a file', async () => {
  const lfr = new Uint8Array(150000).map((_, i) => i % 251);
  const dev = fakeDevice({
    interfaces: ILLUM,
    files: { 'I:\\DCIM\\100PHOTO\\IMG_0001.LFR': lfr },
    pictures: [{ prefix: 'IMG_', folder: 100, postfix: 'PHOTO', number: 1, id: 'sha1-aa', date: '2026-10-01T10:00:00.000Z' }],
  });
  const conn = await connectWebUsb(dev);
  assert.deepEqual(dev.claimed, [1]);
  assert.equal(conn.info.serial, 'B5120001');
  assert.equal(conn.pictures[0].name, 'IMG_0001');
  assert.match(conn.report, /interfaces: 0: class 8\/6\/50 mass storage; 1: class ff\/0\/0 vendor specific/);
  const got = await downloadPicture(conn.camera, conn.pictures[0], conn.product);
  assert.equal(got.name, '100PHOTO_IMG_0001.LFR');
  assert.deepEqual([...got.data], [...lfr]);
});

test('a camera with no usable interface says why, with a report', async () => {
  const dev = fakeDevice({ interfaces: [{ number: 0, cls: 8, sub: 6, proto: 0x50 }] });
  await assert.rejects(() => connectWebUsb(dev), (err) => /USB drive/.test(err.message) && /mass storage/.test(err.report));
  const stuck = fakeDevice({ interfaces: ILLUM, claimFails: [1] });
  await assert.rejects(() => connectWebUsb(stuck), /cannot be claimed/);
});

test('transport framing: wrapper layout', async () => {
  const sent = [];
  const t = new WebUsbTransport({ transferOut: async (ep, d) => { sent.push(d); return { status: 'ok' }; } }, 1, 2);
  await t.out(t.wrapper(new Uint8Array([0xc6, 0, 6, ...new Array(13).fill(0)]), 4, false));
  assert.equal(sent[0].length, 31);
  assert.equal(sent[0][12], 0x80);
  assert.equal(sent[0][14], 16);
  assert.equal(sent[0][15], 0xc6);
});
