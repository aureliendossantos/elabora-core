import zlib from 'node:zlib';

// Deterministic ZIP: entries sorted by path, fixed timestamp (1980-01-01 00:00), no extra fields,
// DEFLATE level 9 (or STORE when deflate does not help). Same input → same bytes, so a package
// hash identifies its content. Methods 0 and 8 only, as LMSs expect.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

export interface CreatedZip {
  zip: Buffer;
  entries: number;
  uncompressed: number; // total size of the entries before compression
}

// files: paths with "/" separators, relative to the package root.
export function createZip(files: ReadonlyMap<string, Uint8Array | string>): CreatedZip {
  const names = [...files.keys()].sort();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  let uncompressed = 0;
  for (const name of names) {
    const content = files.get(name) ?? '';
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const utf8 = /[^\x20-\x7e]/.test(name) ? 0x0800 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(utf8, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(utf8, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
    uncompressed += data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const zip = Buffer.concat([...locals, ...centrals, end]);
  return { zip, entries: names.length, uncompressed };
}

export interface ZipEntryInfo {
  name: string;
  method: number; // 0 stored, 8 deflated
  compressed: number;
  size: number;
}

export interface ReadZip {
  files: Map<string, Buffer>;
  meta: ZipEntryInfo[];
}

// Reads any ZIP (methods 0 and 8): used to inspect packages, ours or from other tools.
export function readZip(zip: Buffer): ReadZip {
  let endOfCentral = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { endOfCentral = i; break; }
  }
  if (endOfCentral < 0) throw new Error('Not a ZIP file (end of central directory not found)');
  const count = zip.readUInt16LE(endOfCentral + 10);
  let cursor = zip.readUInt32LE(endOfCentral + 16);
  const files = new Map<string, Buffer>();
  const meta: ZipEntryInfo[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Corrupt central directory');
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localHeader = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    const localNameLength = zip.readUInt16LE(localHeader + 26);
    const localExtraLength = zip.readUInt16LE(localHeader + 28);
    const start = localHeader + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(start, start + compressedSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported compression method ${method} for ${name}`);
    files.set(name, data);
    meta.push({ name, method, compressed: compressedSize, size });
  }
  return { files, meta };
}
