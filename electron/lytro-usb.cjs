// Talks to a Lytro camera over USB the way the first generation camera is
// reached by Lytro Desktop and by the open source tools Lyli and pyly: the
// camera declares USB mass storage (bulk-only transport) but answers a few
// vendor specific commands instead of reading and writing disk blocks, see
// lytro-protocol.cjs. This needs raw USB access (libusb, through the `usb`
// package):
//   Linux:   a udev rule for vendor 24cf (build/51-lytro.rules), or root
//   macOS:   may need the system's mass storage driver released (sudo)
//   Windows: the camera's WinUSB driver (Zadig) in place of the disk driver
// Where that is not possible the camera still works as a drive (card reader).

const { LytroCamera } = require('./lytro-protocol.cjs');

const LYTRO_VENDOR = 0x24cf;
const FIRST_GENERATION_PRODUCT = 0x00a1;
const CBW_SIGNATURE = Buffer.from('USBC');
const CSW_SIGNATURE = 'USBS';
const IO_TIMEOUT_MS = 10000;
const CHUNK = 1 << 20;

let usbModule;
function usbLib() {
  if (usbModule === undefined) {
    try {
      usbModule = require('usb');
    } catch {
      usbModule = null;
    }
  }
  return usbModule;
}

const pify = (fn) => new Promise((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result))));

// Bulk-only transport over a claimed interface: command block wrapper, data,
// status wrapper.
class BulkTransport {
  constructor(epIn, epOut, log = () => {}, timeoutMs = IO_TIMEOUT_MS) {
    this.epIn = epIn;
    this.epOut = epOut;
    this.setTimeout(timeoutMs);
    this.tag = 0;
    this.log = log;
  }

  setTimeout(ms) {
    this.epIn.timeout = ms;
    this.epOut.timeout = ms;
  }

  wrapper(cdb, size, toDevice) {
    const cbw = Buffer.alloc(31);
    CBW_SIGNATURE.copy(cbw, 0);
    cbw.writeUInt32LE(++this.tag, 4);
    cbw.writeUInt32LE(size, 8);
    cbw[12] = toDevice ? 0 : 0x80;
    cbw[13] = 0;
    cbw[14] = cdb.length;
    cdb.copy(cbw, 15);
    return cbw;
  }

  async status() {
    const csw = await pify((cb) => this.epIn.transfer(13, cb));
    if (csw.length !== 13 || csw.toString('latin1', 0, 4) !== CSW_SIGNATURE) throw new Error('The camera sent an unexpected status');
    if (csw[12] !== 0) throw new Error(`The camera refused the command (status ${csw[12]})`);
  }

  // TEST UNIT READY (an all zero block): the camera answers it once it can take
  // commands; Lyli waits for that before anything else.
  async waitReady(tries = 25, delayMs = 200) {
    for (let i = 0; i < tries; i++) {
      try {
        await pify((cb) => this.epOut.transfer(this.wrapper(Buffer.alloc(16), 0, true), cb));
        await this.status();
        return true;
      } catch (err) {
        this.log(`not ready yet: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return false;
  }

  async read(cdb, size) {
    await pify((cb) => this.epOut.transfer(this.wrapper(cdb, size, false), cb));
    const parts = [];
    let got = 0;
    while (got < size) {
      const part = await pify((cb) => this.epIn.transfer(Math.min(CHUNK, size - got), cb));
      if (!part.length) break;
      parts.push(part);
      got += part.length;
    }
    await this.status();
    return Buffer.concat(parts);
  }

  async write(cdb, data) {
    await pify((cb) => this.epOut.transfer(this.wrapper(cdb, data.length, true), cb));
    if (data.length) await pify((cb) => this.epOut.transfer(data, cb));
    await this.status();
  }
}

// Lytro devices on the bus: [{ key, product, device }].
function listDevices() {
  const lib = usbLib();
  if (!lib) return [];
  return lib.getDeviceList()
    .filter((d) => d.deviceDescriptor.idVendor === LYTRO_VENDOR)
    .map((d) => ({ key: `${d.busNumber}:${d.deviceAddress}`, product: d.deviceDescriptor.idProduct, device: d }));
}

// The USB interfaces of a device, as { iface, number, cls, sub, proto, bulkIn,
// bulkOut, kind }: kind is 'mass' (class 8), 'adb' (Android debug bridge:
// vendor class, subclass 0x42, protocol 1) or 'vendor' (any other vendor
// class); null otherwise.
function describeInterfaces(device) {
  return device.interfaces.map((iface) => {
    const d = iface.descriptor;
    const endpoints = iface.endpoints || [];
    const bulk = (dir) => endpoints.find((e) => e.direction === dir && e.transferType === 2) || null;
    const kind = d.bInterfaceClass === 8 ? 'mass' : d.bInterfaceClass === 0xff ? (d.bInterfaceSubClass === 0x42 && d.bInterfaceProtocol === 1 ? 'adb' : 'vendor') : null;
    return { iface, number: iface.interfaceNumber, cls: d.bInterfaceClass, sub: d.bInterfaceSubClass, proto: d.bInterfaceProtocol, bulkIn: bulk('in'), bulkOut: bulk('out'), kind };
  });
}

// The interfaces to try the camera's protocol on, best first. The first
// generation camera speaks it on its mass storage interface. A camera that
// is also a drive (the ILLUM: product 00B1, interface 0 its drive, interface 1
// vendor specific) is tried on its vendor interfaces first, so that its drive
// keeps its driver and stays a drive. An Android debug interface is left to
// adb.
function candidateInterfaces(infos, product) {
  const usable = infos.filter((i) => i.bulkIn && i.bulkOut && (i.kind === 'mass' || i.kind === 'vendor'));
  const rank = (i) => (product === FIRST_GENERATION_PRODUCT ? (i.kind === 'mass' ? 0 : 1) : i.kind === 'vendor' ? 0 : 1);
  return usable.slice().sort((x, y) => rank(x) - rank(y) || x.number - y.number);
}

const KIND_NAMES = { mass: 'mass storage', adb: 'Android debug (adb)', vendor: 'vendor specific' };
const describe = (infos) => infos.map((i) => `${i.number}: class ${i.cls.toString(16)}/${i.sub.toString(16)}/${i.proto.toString(16)} ${KIND_NAMES[i.kind] || 'other'}${i.bulkIn && i.bulkOut ? '' : ' (no bulk endpoints)'}`).join('; ');

// Opens a device and finds the interface that answers the camera's protocol:
// { camera, close, product }. Throws with a reason the user can act on.
async function connect({ device, product, key }, log = () => {}) {
  const lib = usbLib();
  if (!lib) throw new Error('USB access is not available in this build');
  try {
    device.open();
  } catch (err) {
    throw new Error(`The camera cannot be opened (${err.message}). ${process.platform === 'win32' ? 'Windows needs the camera\'s WinUSB driver on the interface of the camera (Zadig; for the ILLUM its interface 1, not the mass storage one)' : process.platform === 'linux' ? 'Linux needs a udev rule for USB vendor 24cf' : 'macOS may need the camera\'s disk driver released'}.`);
  }
  const closeDevice = () => {
    try {
      device.close();
    } catch {
      // Not open.
    }
  };
  try {
    const infos = describeInterfaces(device);
    log(`${key}: product ${product.toString(16)}; interfaces ${describe(infos)}`);
    const candidates = candidateInterfaces(infos, product);
    if (!candidates.length) {
      throw new Error(infos.some((i) => i.kind === 'adb') ? 'This camera offers only its Android debug interface (adb) over USB: use USB debugging (adb) to import from it.' : `The camera has no interface to talk to (${describe(infos)}).`);
    }
    const failures = [];
    for (const c of candidates) {
      const { iface } = c;
      try {
        // Only the first generation camera, which is not a drive, has its
        // driver released; a camera that is also a drive keeps its drive.
        if ((product === FIRST_GENERATION_PRODUCT || c.kind === 'vendor') && process.platform !== 'win32' && iface.isKernelDriverActive()) iface.detachKernelDriver();
        iface.claim();
      } catch (err) {
        failures.push(`interface ${c.number}: ${err.message}`);
        log(`interface ${c.number} cannot be claimed: ${err.message}`);
        continue;
      }
      const transport = new BulkTransport(c.bulkIn, c.bulkOut, log, 4000);
      const camera = new LytroCamera(transport, log);
      const release = async () => {
        try {
          await pify((cb) => iface.release(true, cb));
        } catch {
          // Already gone.
        }
      };
      try {
        if (!(await transport.waitReady(8, 150))) log(`interface ${c.number} did not report ready; going on`);
        await camera.hardwareInfo();
        transport.setTimeout(IO_TIMEOUT_MS);
        log(`interface ${c.number} answers the camera protocol`);
        return { camera, close: async () => { await release(); closeDevice(); }, product, interfaceNumber: c.number };
      } catch (err) {
        failures.push(`interface ${c.number} (${KIND_NAMES[c.kind]}): ${err.message}`);
        log(`interface ${c.number} does not answer: ${err.message}`);
        await release();
      }
    }
    throw new Error(`The camera did not answer its protocol (${failures.join('; ')}).`);
  } catch (err) {
    closeDevice();
    throw err;
  }
}

module.exports = { LYTRO_VENDOR, FIRST_GENERATION_PRODUCT, BulkTransport, describeInterfaces, candidateInterfaces, listDevices, connect, usbAvailable: () => !!usbLib() };
