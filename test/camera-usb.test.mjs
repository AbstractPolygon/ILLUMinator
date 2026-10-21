import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LytroCamera, command } = require('../electron/lytro-protocol.cjs');
const { BulkTransport } = require('../electron/lytro-usb.cjs');
const { assembleLfp } = require('../electron/camera.cjs');

// A stand-in for the camera: answers the commands of the protocol.
function fakeCamera(files, pictures) {
  let loaded = Buffer.alloc(0);
  const record = (p) => {
    const b = Buffer.alloc(128);
    b.write(p.postfix || '', 0, 'latin1');
    b.write(p.prefix, 8, 'latin1');
    b.writeUInt32LE(p.folder, 16);
    b.writeUInt32LE(p.number, 20);
    b.writeUInt32LE(p.starred ? 1 : 0, 40);
    b.write(p.id, 48, 'latin1');
    b.write(p.date, 96, 'latin1');
    b.writeUInt32LE(1, 124);
    return b;
  };
  const list = () => {
    const head = Buffer.alloc(12 + 8);
    head.writeUInt32LE(1, 0);
    head.writeUInt32LE(128, 4);
    head.writeUInt32LE(1, 8);
    return Buffer.concat([head, ...pictures.map(record)]);
  };
  const log = [];
  return {
    log,
    async read(cdb, size) {
      log.push(['read', cdb[0], cdb[2], size]);
      if (cdb[0] === 0xc6 && cdb[2] === 0) { const b = Buffer.alloc(4); b.writeUInt32LE(loaded.length, 0); return b; }
      if (cdb[0] === 0xc6 && cdb[2] === 6) { const b = Buffer.alloc(4); b.writeFloatLE(87.5, 0); return b; }
      if (cdb[0] === 0xc6 && cdb[2] === 3) { const b = Buffer.alloc(14); [2026, 10, 17, 9, 30, 15, 250].forEach((v, i) => b.writeUInt16LE(v, 2 * i)); return b; }
      if (cdb[0] === 0xc2 && cdb[2] === 2) { loaded = list(); return Buffer.alloc(0); }
      if (cdb[0] === 0xc2 && cdb[2] === 0) {
        const b = Buffer.alloc(640);
        b.write('Lytro, Inc.', 0, 'latin1'); b.write('A5120012', 256, 'latin1'); b.write('b1', 384, 'latin1'); b.write('1.0.1', 512, 'latin1');
        loaded = b;
        return Buffer.alloc(0);
      }
      if (cdb[0] === 0xc4) {
        assert.equal(cdb[2], 1);
        return loaded.subarray(cdb.readUInt32LE(3), cdb.readUInt32LE(3) + size);
      }
      throw new Error(`unexpected read ${cdb[0].toString(16)}`);
    },
    async write(cdb, data) {
      log.push(['write', cdb[0], cdb[2], data.length]);
      assert.equal(cdb[0], 0xc2);
      if (cdb[2] === 1) {
        const name = data.subarray(0, data.indexOf(0)).toString('latin1');
        loaded = files[name] || Buffer.alloc(0);
        return;
      }
      throw new Error('unexpected load');
    },
  };
}

test('camera protocol: battery, time, hardware info', async () => {
  const cam = new LytroCamera(fakeCamera({}, []));
  assert.equal(await cam.battery(), 87.5);
  assert.equal((await cam.time()).toISOString(), '2026-10-17T09:30:15.250Z');
  const info = await cam.hardwareInfo();
  assert.deepEqual(info, { vendor: 'Lytro, Inc.', serial: 'A5120012', build: 'b1', version: '1.0.1' });
});

test('camera protocol: picture list and file download', async () => {
  const pictures = [
    { prefix: 'IMG_', folder: 100, postfix: 'PHOTO', number: 1, id: 'sha1-aaaa', date: '2026-10-01T10:00:00.000Z' },
    { prefix: 'IMG_', folder: 100, postfix: 'PHOTO', number: 2, id: 'sha1-bbbb', date: '2026-10-01T10:05:00.000Z', starred: true },
  ];
  const raw = Buffer.from('raw sensor data '.repeat(1000));
  const fake = fakeCamera({ 'I:\\DCIM\\100PHOTO\\IMG_0002.RAW': raw }, pictures);
  const cam = new LytroCamera(fake);
  const list = await cam.pictureList();
  assert.equal(list.length, 2);
  assert.equal(list[1].name, 'IMG_0002');
  assert.equal(list[1].folder, '100PHOTO');
  assert.equal(list[1].id, 'sha1-bbbb');
  assert.equal(list[1].starred, true);
  assert.equal(list[0].rotation, 0);
  const got = await cam.download('file', LytroCamera.pathOf(list[1], 'RAW'));
  assert.ok(got.equals(raw));
  await assert.rejects(() => cam.download('file', 'I:\\nothing'), /no I:\\nothing/);
});

test('commands: 16 byte blocks with the code first and the parameter third', () => {
  const c = command(0xc6, 6);
  assert.equal(c.length, 16);
  assert.deepEqual([...c.subarray(0, 4)], [0xc6, 0, 6, 0]);
});

test('bulk transport: wrapper layout, data and status', async () => {
  const sent = [];
  const reply = [];
  const csw = (status = 0) => { const b = Buffer.alloc(13); b.write('USBS', 0, 'latin1'); b[12] = status; return b; };
  const epOut = { transfer(data, cb) { sent.push(Buffer.from(data)); cb(null); } };
  const epIn = { transfer(len, cb) { cb(null, reply.shift()); } };
  const t = new BulkTransport(epIn, epOut);
  reply.push(Buffer.from([1, 2, 3, 4]), csw());
  const out = await t.read(command(0xc6, 6), 4);
  assert.deepEqual([...out], [1, 2, 3, 4]);
  const cbw = sent[0];
  assert.equal(cbw.length, 31);
  assert.equal(cbw.toString('latin1', 0, 4), 'USBC');
  assert.equal(cbw.readUInt32LE(8), 4);
  assert.equal(cbw[12], 0x80);
  assert.equal(cbw[14], 16);
  assert.equal(cbw[15], 0xc6);
  reply.push(csw());
  await t.write(command(0xc2, 1), Buffer.from('x\0'));
  assert.equal(sent[1][12], 0);
  assert.equal(sent[2].length, 2);
  reply.push(Buffer.from([0]), csw(1));
  await assert.rejects(() => t.read(command(0xc6, 6), 1), /refused/);
});

test('first generation parts become an LFP file the app can read', async () => {
  const { openContainer, findFrame, bufferReader } = await import('../app/js/core/lfp.js');
  const raw = Buffer.from('0123456789'.repeat(100));
  const txt = Buffer.from(JSON.stringify({ image: { width: 3280, height: 3280 }, devices: { sensor: {} } }));
  const lfp = await assembleLfp({ raw, txt });
  const c = await openContainer(bufferReader(new Uint8Array(lfp)));
  const frame = findFrame(c.toc);
  assert.ok(frame.metadataRef && frame.imageRef);
  assert.equal(c.json.get(frame.metadataRef).image.width, 3280);
  assert.equal((await c.readSection(frame.imageRef)).length, raw.length);
});

test('a camera drive: firmware, serial and calibration folder', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { driveInfo, pullDriveCalibration, scanVolume } = require('../electron/camera.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'illum-drive-'));
  await fs.mkdir(path.join(root, 'MISC'));
  await fs.mkdir(path.join(root, 'unitdata'));
  await fs.mkdir(path.join(root, 'DCIM', '100PHOTO'), { recursive: true });
  await fs.writeFile(path.join(root, 'DCIM', '100PHOTO', 'IMG_0001.LFR'), 'x');
  await fs.writeFile(path.join(root, 'MISC', '.LYT_VER.inf'), JSON.stringify({ 'fw-version': '2.0.1' }));
  await fs.writeFile(path.join(root, 'unitdata', 'unit_info.json'), JSON.stringify({ camera: { serialNumber: ' B5123 ' } }));
  await fs.writeFile(path.join(root, 'unitdata', 'cal_file_manifest.json'), '{"calibrationFiles":[]}');
  assert.deepEqual(await driveInfo(root), { firmware: '2.0.1', model: null, serial: 'B5123' });
  // The version file's own serial and model win when it has them.
  await fs.writeFile(path.join(root, 'MISC', '.LYT_VER.inf'), JSON.stringify({ 'fw-version': '2.0.1', model: 'F01', serial: 'A9' }));
  assert.deepEqual(await driveInfo(root), { firmware: '2.0.1', model: 'F01', serial: 'A9' });
  await fs.writeFile(path.join(root, 'MISC', '.LYT_VER.inf'), JSON.stringify({ 'fw-version': '2.0.1' }));
  const cam = await scanVolume(root);
  assert.equal(cam.hasCalibration, true);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'illum-cal-'));
  const dest = await pullDriveCalibration(root, out);
  assert.ok(dest.endsWith(path.join('cameras', 'B5123')));
  assert.equal((await fs.readdir(dest)).sort().join(), 'cal_file_manifest.json,unit_info.json');
});

test('the calibration item is requested as load type 6', async () => {
  const log = [];
  const cam = new LytroCamera({
    async read(cdb, size) { log.push(cdb[0].toString(16) + ':' + cdb[2]); return cdb[0] === 0xc6 ? Buffer.from([3, 0, 0, 0]) : Buffer.from([1, 2, 3]).subarray(0, size); },
    async write() {},
  });
  assert.deepEqual([...await cam.calibration()], [1, 2, 3]);
  assert.equal(log[0], 'c2:6');
});

test('a big item is read in 64 KB packets by offset', async () => {
  const big = Buffer.alloc(150000);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  const fake = fakeCamera({ 'I:\\DCIM\\100PHOTO\\IMG_0001.RAW': big }, []);
  const got = await new LytroCamera(fake).download('file', 'I:\\DCIM\\100PHOTO\\IMG_0001.RAW');
  assert.ok(got.equals(big));
  const reads = fake.log.filter((l) => l[1] === 0xc4);
  assert.deepEqual(reads.map((l) => l[3]), [65536, 65536, 150000 - 131072]);
});

test('the picture list takes its record length from the header', async () => {
  const fake = fakeCamera({}, [{ prefix: 'IMG_', folder: 100, postfix: 'PHOTO', number: 7, id: 'sha1-cc', date: '2026-10-01T10:00:00.000Z' }]);
  const list = await new LytroCamera(fake).pictureList();
  assert.equal(list[0].name, 'IMG_0007');
});

test('calibration files MOD_0000..MOD_0061 are read and saved under the camera serial', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pullUsbCalibration } = require('../electron/camera.cjs');
  const files = {};
  for (const i of [0, 1, 61]) files[`C:\\T1CALIB\\MOD_${String(i).padStart(4, '0')}`] = Buffer.from(`cal ${i}`);
  const camera = new LytroCamera(fakeCamera(files, []));
  const list = await camera.calibrationFiles();
  assert.deepEqual(list.map((f) => f.name), ['MOD_0000', 'MOD_0001', 'MOD_0061']);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'lytro-cal-'));
  const dest = await pullUsbCalibration({ camera, info: { serial: 'A5120012' } }, out);
  assert.ok(dest.endsWith(path.join('cameras', 'A5120012', 'T1CALIB')));
  assert.equal((await fs.readFile(path.join(dest, 'MOD_0061'), 'utf8')), 'cal 61');
});

test('the transport waits until the camera reports ready', async () => {
  const csw = (status = 0) => { const b = Buffer.alloc(13); b.write('USBS', 0, 'latin1'); b[12] = status; return b; };
  const replies = [csw(1), csw(1), csw(0)];
  const sent = [];
  const t = new BulkTransport({ transfer(len, cb) { cb(null, replies.shift()); } }, { transfer(data, cb) { sent.push(Buffer.from(data)); cb(null); } });
  assert.equal(await t.waitReady(5, 1), true);
  assert.equal(sent.length, 3);
  assert.ok(sent[0].subarray(15, 31).every((v) => v === 0));
});

test('the ILLUM is tried on its vendor interface first, the first generation on mass storage', () => {
  const { describeInterfaces, candidateInterfaces } = require('../electron/lytro-usb.cjs');
  const ep = (direction) => ({ direction, transferType: 2, address: direction === 'in' ? 0x81 : 0x02 });
  const iface = (number, cls, sub = 0, proto = 0) => ({ interfaceNumber: number, descriptor: { bInterfaceClass: cls, bInterfaceSubClass: sub, bInterfaceProtocol: proto }, endpoints: [ep('in'), ep('out')] });
  const illum = describeInterfaces({ interfaces: [iface(0, 8, 6, 0x50), iface(1, 0xff, 0, 0)] });
  assert.deepEqual(candidateInterfaces(illum, 0x00b1).map((i) => i.number), [1, 0]);
  const gen1 = describeInterfaces({ interfaces: [iface(0, 8, 6, 0x50)] });
  assert.deepEqual(candidateInterfaces(gen1, 0x00a1).map((i) => i.number), [0]);
  // An Android debug interface is left to adb.
  const adb = describeInterfaces({ interfaces: [iface(0, 8, 6, 0x50), iface(2, 0xff, 0x42, 1)] });
  assert.deepEqual(candidateInterfaces(adb, 0x00b1).map((i) => i.number), [0]);
});
