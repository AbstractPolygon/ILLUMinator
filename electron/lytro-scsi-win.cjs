// The first generation camera on Windows, reached the way Lytro Desktop's
// service (LytroService.exe) reaches it: not over libusb but through the
// camera's ordinary disk device, with SCSI pass-through (DeviceIoControl,
// IOCTL_SCSI_PASS_THROUGH) carrying the vendor commands of lytro-protocol.cjs.
// No driver needs replacing.
//
// Worked out from the service: it lists the disk and CD-ROM devices, asks each
// for its vendor and product (IOCTL_STORAGE_QUERY_PROPERTY) and takes the one
// that is "ZORAN" / "COACH6 (I62)" or "Lytro" / "F01"; it opens that device
// read/write and sends each command as a SCSI_PASS_THROUGH with an 8 byte
// command block, the 16 bytes of the command at offset 0x24, the data buffer at
// offset 0x41 and a timeout of 100 seconds; data in is 1, data out 0, a command
// without data 2.
//
// The Windows calls come from `koffi` (loaded on demand); `api` can be replaced
// (tests).

const { LytroCamera } = require('./lytro-protocol.cjs');

const GENERIC_READ_WRITE = 0xc0000000;
const OPEN_EXISTING = 3;
const IOCTL_STORAGE_QUERY_PROPERTY = 0x2d1400;
const IOCTL_SCSI_PASS_THROUGH = 0x4d004;
const SPT_LENGTH = 0x38;
const DATA_OFFSET = 0x41;
const TIMEOUT_SECONDS = 100;
const DATA_OUT = 0;
const DATA_IN = 1;
const NO_DATA = 2;
const FIRST_GENERATION_PRODUCT = 0x00a1;

// [vendor, product] of the first generation camera as its disk reports it.
const IDENTITIES = [['ZORAN', 'COACH6 (I62)'], ['Lytro', 'F01']];

function windowsApi() {
  if (process.platform !== 'win32') return null;
  let koffi;
  try {
    koffi = require('koffi');
  } catch {
    return null;
  }
  const kernel32 = koffi.load('kernel32.dll');
  const CreateFileW = kernel32.func('void * __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 disposition, uint32 flags, void *template)');
  const DeviceIoControl = kernel32.func('bool __stdcall DeviceIoControl(void *handle, uint32 code, void *inBuffer, uint32 inSize, void *outBuffer, uint32 outSize, _Out_ uint32 *returned, void *overlapped)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)');
  const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
  const invalid = (h) => h === null || koffi.address(h) === 0xffffffffffffffffn || koffi.address(h) === 0xffffffffn;
  return {
    open(path, access) {
      const h = CreateFileW(path, access, 0x3, null, OPEN_EXISTING, 0, null);
      return invalid(h) ? null : h;
    },
    ioctl(handle, code, inBuf, outBuf) {
      const returned = [0];
      const ok = DeviceIoControl(handle, code, inBuf, inBuf ? inBuf.length : 0, outBuf, outBuf ? outBuf.length : 0, returned, null);
      return ok ? returned[0] : -GetLastError() || -1;
    },
    close(handle) {
      CloseHandle(handle);
    },
  };
}

const text = (buf, offset) => {
  if (!offset || offset >= buf.length) return '';
  const end = buf.indexOf(0, offset);
  return buf.toString('latin1', offset, end < 0 ? buf.length : end).trim();
};

// { vendor, product, revision } of an open disk device.
function queryIdentity(api, handle) {
  const query = Buffer.alloc(12); // StorageDeviceProperty (0), PropertyStandardQuery (0)
  const out = Buffer.alloc(1024);
  const got = api.ioctl(handle, IOCTL_STORAGE_QUERY_PROPERTY, query, out);
  if (!(got > 0)) return null;
  return { vendor: text(out, out.readUInt32LE(12)), product: text(out, out.readUInt32LE(16)), revision: text(out, out.readUInt32LE(20)) };
}

const isFirstGeneration = (id) => !!id && IDENTITIES.some(([v, p]) => id.vendor === v && id.product === p);

// First generation cameras on this computer: [{ key, path, identity }].
function listDevices(api = windowsApi()) {
  if (!api) return [];
  const found = [];
  for (const prefix of ['\\\\.\\PhysicalDrive', '\\\\.\\CdRom']) {
    for (let n = 0; n < 32; n++) {
      const path = `${prefix}${n}`;
      const handle = api.open(path, 0);
      if (!handle) continue;
      try {
        const identity = queryIdentity(api, handle);
        if (isFirstGeneration(identity)) found.push({ key: `scsi:${path}`, path, identity });
      } finally {
        api.close(handle);
      }
    }
  }
  return found;
}

// A command as a SCSI_PASS_THROUGH buffer.
function passThrough(cdb, dataIn, length, payload = null) {
  const buf = Buffer.alloc(DATA_OFFSET + length);
  buf.writeUInt16LE(SPT_LENGTH, 0);
  buf[6] = 8; // CdbLength
  buf[8] = dataIn;
  buf.writeUInt32LE(length, 12);
  buf.writeUInt32LE(TIMEOUT_SECONDS, 16);
  buf.writeBigUInt64LE(BigInt(DATA_OFFSET), 24);
  cdb.copy(buf, 0x24, 0, Math.min(16, cdb.length));
  if (payload) payload.copy(buf, DATA_OFFSET);
  return buf;
}

class ScsiTransport {
  constructor(api, handle) {
    this.api = api;
    this.handle = handle;
  }

  send(buf) {
    const got = this.api.ioctl(this.handle, IOCTL_SCSI_PASS_THROUGH, buf, buf);
    if (got < 0) throw new Error(`The camera could not be reached (Windows error ${-got})`);
    if (buf[2] !== 0) throw new Error(`The camera refused the command (SCSI status ${buf[2]})`);
  }

  async read(cdb, size) {
    const buf = passThrough(cdb, size ? DATA_IN : NO_DATA, size);
    this.send(buf);
    return Buffer.from(buf.subarray(DATA_OFFSET, DATA_OFFSET + size));
  }

  async write(cdb, data) {
    this.send(passThrough(cdb, data.length ? DATA_OUT : NO_DATA, data.length, data));
  }
}

// Opens a camera found by listDevices: { camera, close, product }.
async function connect({ path }, log = () => {}, api = windowsApi()) {
  if (!api) throw new Error('This computer cannot reach the camera through its disk (the Windows call library is not available in this build).');
  const handle = api.open(path, GENERIC_READ_WRITE);
  if (!handle) throw new Error(`The camera's disk ${path} could not be opened. Close Lytro Desktop (it keeps the camera to itself) and try again.`);
  log(`${path}: opened`);
  return { camera: new LytroCamera(new ScsiTransport(api, handle), log), close: async () => api.close(handle), product: FIRST_GENERATION_PRODUCT };
}


// An ILLUM that Windows lists as an empty removable drive: ask its disk why
// ("not ready" sense data goes to the log) and tell it to start up, as an
// ordinary host would for a drive that spun down. `drives` lists letters.
const CAMERA_NAME = /lytro|illum|firefly/i;

function senseText(api, handle) {
  const buf = passThrough(Buffer.from([0x03, 0, 0, 0, 18, 0]), DATA_IN, 18);
  if (api.ioctl(handle, IOCTL_SCSI_PASS_THROUGH, buf, buf) < 0) return 'sense unavailable';
  const d = buf.subarray(DATA_OFFSET, DATA_OFFSET + 18);
  return `sense key ${d[2] & 15} asc ${d[12].toString(16)} ascq ${d[13].toString(16)}`;
}

function wakeStorage(log = () => {}, api = windowsApi(), letters = 'DEFGHIJKLMNOPQRSTUVWXYZ') {
  if (!api) return [];
  const woken = [];
  for (const letter of letters) {
    const path = `\\\\.\\${letter}:`;
    const handle = api.open(path, GENERIC_READ_WRITE);
    if (!handle) continue;
    try {
      const inq = passThrough(Buffer.from([0x12, 0, 0, 0, 36, 0]), DATA_IN, 36);
      if (api.ioctl(handle, IOCTL_SCSI_PASS_THROUGH, inq, inq) < 0 || inq[2] !== 0) continue;
      const id = inq.toString('latin1', DATA_OFFSET + 8, DATA_OFFSET + 32).trim();
      if (!CAMERA_NAME.test(id)) continue;
      const ready = () => {
        const t = passThrough(Buffer.alloc(6), NO_DATA, 0);
        return api.ioctl(handle, IOCTL_SCSI_PASS_THROUGH, t, t) >= 0 && t[2] === 0;
      };
      if (ready()) continue;
      log(`${letter}: ${id} not ready (${senseText(api, handle)}); sending start`);
      const start = passThrough(Buffer.from([0x1b, 0, 0, 0, 1, 0]), NO_DATA, 0);
      api.ioctl(handle, IOCTL_SCSI_PASS_THROUGH, start, start);
      log(`${letter}: start unit status ${start[2]}; now ${ready() ? 'ready' : 'still not ready (' + senseText(api, handle) + ')'}`);
      woken.push(letter);
    } finally {
      api.close(handle);
    }
  }
  return woken;
}

module.exports = { wakeStorage, listDevices, connect, passThrough, queryIdentity, isFirstGeneration, ScsiTransport, DATA_OFFSET, IDENTITIES };
