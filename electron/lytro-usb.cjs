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
  constructor(epIn, epOut, log = () => {}) {
    this.epIn = epIn;
    this.epOut = epOut;
    this.epIn.timeout = IO_TIMEOUT_MS;
    this.epOut.timeout = IO_TIMEOUT_MS;
    this.tag = 0;
    this.log = log;
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

// Opens a device and claims its mass storage interface: { camera, close,
// product }. Throws with a reason the user can act on.
async function connect({ device, product, key }, log = () => {}) {
  const lib = usbLib();
  if (!lib) throw new Error('USB access is not available in this build');
  try {
    device.open();
  } catch (err) {
    throw new Error(`The camera cannot be opened (${err.message}). ${process.platform === 'win32' ? 'Windows needs the camera\'s WinUSB driver (Zadig)' : process.platform === 'linux' ? 'Linux needs a udev rule for USB vendor 24cf' : 'macOS may need the camera\'s disk driver released'}.`);
  }
  let iface = null;
  try {
    iface = device.interfaces.find((i) => i.descriptor.bInterfaceClass === 8) || device.interfaces[0];
    if (!iface) throw new Error('The camera has no USB interface');
    // Only the first generation camera, which is not a drive, has its driver
    // released; a camera showing up as a drive keeps it (and its drive).
    if (product === FIRST_GENERATION_PRODUCT && process.platform !== 'win32' && iface.isKernelDriverActive()) iface.detachKernelDriver();
    iface.claim();
    const endpoints = iface.endpoints;
    const epIn = endpoints.find((e) => e.direction === 'in' && e.transferType === 2);
    const epOut = endpoints.find((e) => e.direction === 'out' && e.transferType === 2);
    if (!epIn || !epOut) throw new Error('The camera has no bulk endpoints');
    log(`${key}: product ${product.toString(16)}, interface ${iface.interfaceNumber}, endpoints ${epIn.address.toString(16)}/${epOut.address.toString(16)}`);
    const transport = new BulkTransport(epIn, epOut, log);
    if (!(await transport.waitReady())) log('the camera did not report ready; going on');
    const camera = new LytroCamera(transport, log);
    const close = async () => {
      try {
        await pify((cb) => iface.release(true, cb));
      } catch {
        // Already gone.
      }
      try {
        device.close();
      } catch {
        // Already gone.
      }
    };
    return { camera, close, product };
  } catch (err) {
    try {
      device.close();
    } catch {
      // Not open.
    }
    throw err;
  }
}

module.exports = { LYTRO_VENDOR, FIRST_GENERATION_PRODUCT, BulkTransport, listDevices, connect, usbAvailable: () => !!usbLib() };
