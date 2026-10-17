// The command protocol of Lytro cameras, as worked out by others for the
// first generation camera (Lyli, pyly, "Lytro protocol" by L. Jirkovsky): a
// handful of vendor specific 16 byte SCSI style commands, carried in the
// bulk-only wrappers of USB mass storage (or over TCP).
//
//   C6 00 <query>             read: 0 size of the loaded item (uint32), 3 time
//                             (7 x uint16), 6 battery (float32, percent)
//   C2 00 <type> + path\0     write: load an item: 0 hardware info, 1 file (by
//                             camera path), 2 picture list, 5 picture (by id
//                             and a format digit), 6 calibration, 7 compressed
//                             raw picture
//   C4 00 01 <offset u32>     read: the loaded item, from the offset
//
// A transport gives read(cdb, size) -> Buffer and write(cdb, buffer).
// Nothing here is known to work on the ILLUM; electron/camera.cjs checks the
// camera's answers before trusting it.

const LOAD_TYPES = { hardware_info: 0, file: 1, picture_list: 2, picture: 5, calibration: 6, rawcompressedpicture: 7 };
const PICTURE_FORMATS = ['jpg', 'raw', 'txt', '128', 'stk'];

function command(code, ...params) {
  const cdb = Buffer.alloc(16);
  cdb[0] = code;
  params.forEach((p, i) => { if (p !== undefined) cdb[2 + i] = p; });
  return cdb;
}

function cString(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? buf.length : end).toString('latin1');
}

class LytroCamera {
  // `log(line)` receives a line per command, for diagnostics.
  constructor(transport, log = () => {}) {
    this.t = transport;
    this.log = log;
  }

  async query(id, size) {
    const data = await this.t.read(command(0xc6, id), size);
    this.log(`query ${id}: ${data.length} bytes`);
    return data;
  }

  async battery() {
    return (await this.query(6, 4)).readFloatLE(0);
  }

  async time() {
    const d = await this.query(3, 14);
    const v = Array.from({ length: 7 }, (_, i) => d.readUInt16LE(2 * i));
    return new Date(Date.UTC(v[0], v[1] - 1, v[2], v[3], v[4], v[5], v[6]));
  }

  // Loads an item on the camera, then reads all of it.
  async download(type, name = null) {
    const cdb = command(0xc2, LOAD_TYPES[type]);
    if (name === null) {
      await this.t.read(cdb, 0);
    } else {
      await this.t.write(cdb, Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0])]));
    }
    const size = (await this.query(0, 4)).readUInt32LE(0);
    this.log(`load ${type}${name ? ` ${name}` : ''}: ${size} bytes`);
    if (!size) throw new Error(`The camera has no ${name || type}`);
    const read = Buffer.alloc(16);
    read[0] = 0xc4;
    read[2] = 1;
    read.writeUInt32LE(0, 3);
    const data = await this.t.read(read, size);
    return data.subarray(0, size);
  }

  async hardwareInfo() {
    const d = await this.download('hardware_info');
    return {
      vendor: cString(d.subarray(0, 256)),
      serial: cString(d.subarray(256, 384)),
      build: cString(d.subarray(384, 512)),
      version: cString(d.subarray(512, 640)),
    };
  }

  // [{ id, folder, folderNumber, prefix, number, starred, date, rotation }]
  async pictureList() {
    const b = await this.download('picture_list');
    if (b.length < 12 || b.readUInt32LE(0) !== 1) throw new Error('Unexpected picture list from the camera');
    const recordsPerItem = b.readUInt32LE(8);
    const RECORD = 8 + 8 + 4 + 4 + 16 + 4 + 4 + 48 + 28 + 4;
    const ROTATION = { 1: 0, 8: 90, 3: 180, 6: 270 };
    const pictures = [];
    for (let o = 12 + 8 * recordsPerItem; o + RECORD <= b.length; o += RECORD) {
      const folderPostfix = cString(b.subarray(o, o + 8));
      const prefix = cString(b.subarray(o + 8, o + 16));
      const folderNumber = b.readUInt32LE(o + 16);
      const number = b.readUInt32LE(o + 20);
      // 16 bytes not used here, then starred (uint32) and focus (float32).
      const starred = b.readUInt32LE(o + 40);
      const id = cString(b.subarray(o + 48, o + 96));
      const date = cString(b.subarray(o + 96, o + 124));
      const rotation = b.readUInt32LE(o + 124);
      pictures.push({
        id,
        folder: `${String(folderNumber).padStart(3, '0')}${folderPostfix}`,
        folderNumber,
        prefix,
        number,
        starred: !!starred,
        date,
        rotation: ROTATION[rotation] ?? 0,
        name: `${prefix}${String(number).padStart(4, '0')}`,
      });
    }
    return pictures;
  }

  // The camera's own path for a picture's file of one kind (RAW, TXT, 128).
  static pathOf(picture, extension) {
    return `I:\\DCIM\\${picture.folder}\\${picture.name}.${extension}`;
  }
}

module.exports = { LytroCamera, LOAD_TYPES, PICTURE_FORMATS, command, cString };
