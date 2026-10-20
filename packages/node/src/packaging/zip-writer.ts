import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Streaming deterministic ZIP: the same bytes as createZip (../zip.ts) — entries sorted by name,
// timestamp 1980-01-01 00:00, no extra fields, DEFLATE level 9 or STORE when deflating does not
// help — but entries may be files on disk, read in chunks and never held whole in memory. Media
// and fonts read from disk are stored without trying to compress them: they are compressed
// already, and a 300 MB video costs seconds of deflate for nothing. Entries in memory are always
// tried, as createZip does, so a package without files from disk keeps createZip's bytes.
//
// A file is read twice: a first pass computes its CRC and sizes (the local header comes before
// the data and the output is written in order), the second writes it and checks it did not
// change in between. Planning first also gives the exact archive size before anything is written,
// so a build can refuse a package that is too large for the LMS without writing it.

export const STORED_EXTENSIONS: ReadonlySet<string> = new Set(['.mp4', '.m4a', '.mp3', '.webm', '.ogg', '.webp', '.jpg', '.jpeg', '.png', '.gif', '.avif', '.woff', '.woff2', '.zip']);

export type ZipInput =
  | { name: string; data: Uint8Array | string }   // in memory (generated files)
  | { name: string; file: string; store?: boolean; known?: { crc: number; size: number } };   // on disk (assets, media)
// store: never deflate this file (contents known to be compressed already, whatever the name).
// known: CRC and size of a stored file, from a pass the caller made anyway (hashing an archive's
// files): the file is then read once, when it is written, and checked against them there.

export interface ZipEntry {
  name: string;
  method: 0 | 8;
  crc: number;
  size: number;            // uncompressed
  compressedSize: number;
  offset: number;          // of the local header
  file: string | null;
  data: Buffer | null;     // the bytes to write for an in-memory entry (deflated when method 8)
}

export interface ZipPlan {
  entries: ZipEntry[];
  size: number;            // bytes of the archive
  uncompressed: number;    // sum of the entries' sizes
}

export interface ZipWriteResult extends ZipPlan {
  path: string;
  sha256: string;
}

export class ZipLimitError extends Error {
  readonly code = 'E_ZIP_LIMIT';
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

const LIMIT = 0xffffffff; // ZIP without the ZIP64 extension, which LMSs do not all read
const MAX_ENTRIES = 0xffff;
const CHUNK = 1024 * 1024;
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

const isStored = (name: string) => STORED_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
const storedInput = (input: ZipInput) => 'file' in input && (input.store === true || isStored(input.name));
const nameBytes = (name: string) => Buffer.from(name, 'utf8');
const tooLarge = (bytes: number) => new ZipLimitError(`The package would weigh ${(bytes / 1073741824).toFixed(2)} GB: ZIP files without ZIP64 stop at 4 GB.`);

export async function planZip(inputs: Iterable<ZipInput>): Promise<ZipPlan> {
  const sorted = [...inputs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (sorted.length > MAX_ENTRIES) throw new ZipLimitError(`${sorted.length} files: a ZIP without ZIP64 holds at most ${MAX_ENTRIES}.`);
  for (let i = 0; i < sorted.length; i++) {
    const name = sorted[i].name;
    if (i > 0 && sorted[i - 1].name === name) throw new Error(`Two package entries are named ${name}.`);
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error(`Unsafe package entry name: ${name}`);
  }
  // Stored files have known sizes: refuse at once, before reading gigabytes.
  let lowerBound = 22;
  for (const input of sorted) {
    if ('file' in input && storedInput(input)) lowerBound += 30 + nameBytes(input.name).length + (await fs.promises.stat(input.file)).size;
  }
  if (lowerBound >= LIMIT) throw tooLarge(lowerBound);

  const entries: ZipEntry[] = [];
  let offset = 0;
  let uncompressed = 0;
  for (const input of sorted) {
    const stored = storedInput(input);
    let entry: Omit<ZipEntry, 'offset'>;
    if ('data' in input) {
      const data = typeof input.data === 'string' ? Buffer.from(input.data) : Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
      const deflated = stored ? null : zlib.deflateRawSync(data, { level: 9 });
      const useDeflate = !!deflated && deflated.length < data.length;
      const body = useDeflate ? deflated! : data;
      entry = { name: input.name, method: useDeflate ? 8 : 0, crc: zlib.crc32(data), size: data.length, compressedSize: body.length, file: null, data: body };
    } else {
      const { crc, size, deflatedSize } = stored && input.known ? { ...input.known, deflatedSize: null } : await measureFile(input.file, !stored);
      const useDeflate = deflatedSize !== null && deflatedSize < size;
      entry = { name: input.name, method: useDeflate ? 8 : 0, crc, size, compressedSize: useDeflate ? deflatedSize : size, file: input.file, data: null };
    }
    if (entry.size >= LIMIT) throw new ZipLimitError(`${input.name} weighs more than 4 GB.`);
    entries.push({ ...entry, offset });
    offset += 30 + nameBytes(input.name).length + entry.compressedSize;
    uncompressed += entry.size;
    if (offset >= LIMIT) throw tooLarge(offset);
  }
  const size = offset + entries.reduce((sum, e) => sum + 46 + nameBytes(e.name).length, 0) + 22;
  if (size >= LIMIT) throw tooLarge(size);
  return { entries, size, uncompressed };
}

// Passes chunks through, keeping the CRC and size of the original bytes.
function counter(): { state: { crc: number; size: number }; stream: Transform } {
  const state = { crc: 0, size: 0 };
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      state.crc = zlib.crc32(chunk, state.crc);
      state.size += chunk.length;
      callback(null, chunk);
    }
  });
  return { state, stream };
}

// First pass over a file: CRC, size and, when it may be deflated, the deflated size.
async function measureFile(file: string, deflate: boolean): Promise<{ crc: number; size: number; deflatedSize: number | null }> {
  if (!deflate) {
    let crc = 0;
    let size = 0;
    await eachChunk(file, (chunk) => { crc = zlib.crc32(chunk, crc); size += chunk.length; });
    return { crc, size, deflatedSize: null };
  }
  const tap = counter();
  let deflatedSize = 0;
  await pipeline(fs.createReadStream(file, { highWaterMark: CHUNK }), tap.stream, zlib.createDeflateRaw({ level: 9 }), async (deflated: AsyncIterable<Buffer>) => {
    for await (const chunk of deflated) deflatedSize += chunk.length;
  });
  return { ...tap.state, deflatedSize };
}

// Reads a file into one reused buffer: stored media go through without leaving garbage behind.
async function eachChunk(file: string, use: (chunk: Buffer) => void | Promise<void>): Promise<void> {
  const handle = await fs.promises.open(file, 'r');
  const buffer = Buffer.allocUnsafe(CHUNK);
  try {
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, position);
      if (bytesRead === 0) return;
      await use(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

export interface WriteZipOptions {
  onProgress?: (written: number, total: number) => void; // bytes of the archive written so far
}

// Writes the archive to `target` (through a temporary file renamed at the end, so a reader never
// sees half a package). Takes the inputs, or a plan made by planZip.
export async function writeZip(target: string, inputs: Iterable<ZipInput> | ZipPlan, options: WriteZipOptions = {}): Promise<ZipWriteResult> {
  const plan = isPlan(inputs) ? inputs : await planZip(inputs);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.promises.open(temporary, 'w');
  let sha256: string;
  try {
    sha256 = await emitZip(plan, async (bytes) => { await handle.write(bytes); }, options);
    await handle.close();
    await fs.promises.rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
  return { ...plan, path: target, sha256 };
}

// The SHA-256 of the archive a plan describes, without writing it (a build that only writes a
// folder still reports its package's hash).
export function hashZip(plan: ZipPlan): Promise<string> {
  return emitZip(plan, async () => {});
}

// The bytes of the archive in order, to a sink; returns their SHA-256.
async function emitZip(plan: ZipPlan, sink: (bytes: Buffer) => Promise<void>, options: WriteZipOptions = {}): Promise<string> {
  const hash = crypto.createHash('sha256');
  let written = 0;
  const write = async (bytes: Buffer) => {
    hash.update(bytes);
    written += bytes.length;
    await sink(bytes);
    options.onProgress?.(written, plan.size);
  };
  for (const entry of plan.entries) {
    if (written !== entry.offset) throw new Error(`Package entry ${entry.name} is not where it was planned.`);
    const name = nameBytes(entry.name);
    await write(Buffer.concat([localHeader(entry, name.length), name]));
    if (entry.data) await write(entry.data);
    else await writeFileEntry(entry, write);
  }
  const central: Buffer[] = plan.entries.map((e) => {
    const name = nameBytes(e.name);
    return Buffer.concat([centralHeader(e, name.length), name]);
  });
  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  await write(Buffer.concat([...central, endRecord(plan.entries.length, centralSize, written)]));
  if (written !== plan.size) throw new Error('The package size differs from its plan.');
  return hash.digest('hex');
}

// Second pass: the file again, checked against the first (a file edited in between would make
// the headers lie).
async function writeFileEntry(entry: ZipEntry, write: (bytes: Buffer) => Promise<void>): Promise<void> {
  const changed = () => new Error(`${entry.file} changed while the package was written: build again.`);
  if (entry.method === 0) {
    let crc = 0;
    let size = 0;
    await eachChunk(entry.file!, async (chunk) => {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      if (size > entry.size) throw changed();
      await write(chunk);
    });
    if (crc !== entry.crc || size !== entry.size) throw changed();
    return;
  }
  const tap = counter();
  let compressed = 0;
  await pipeline(fs.createReadStream(entry.file!, { highWaterMark: CHUNK }), tap.stream, zlib.createDeflateRaw({ level: 9 }), async (chunks: AsyncIterable<Buffer>) => {
    for await (const chunk of chunks) {
      compressed += chunk.length;
      if (compressed > entry.compressedSize) throw changed();
      await write(chunk);
    }
  });
  if (tap.state.crc !== entry.crc || tap.state.size !== entry.size || compressed !== entry.compressedSize) throw changed();
}

function isPlan(value: Iterable<ZipInput> | ZipPlan): value is ZipPlan {
  return !!value && Array.isArray((value as ZipPlan).entries) && typeof (value as ZipPlan).size === 'number';
}

const utf8Flag = (name: string) => (/[^\x20-\x7e]/.test(name) ? 0x0800 : 0);

function localHeader(e: ZipEntry, nameLength: number): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(utf8Flag(e.name), 6);
  b.writeUInt16LE(e.method, 8);
  b.writeUInt16LE(DOS_TIME, 10);
  b.writeUInt16LE(DOS_DATE, 12);
  b.writeUInt32LE(e.crc, 14);
  b.writeUInt32LE(e.compressedSize, 18);
  b.writeUInt32LE(e.size, 22);
  b.writeUInt16LE(nameLength, 26);
  b.writeUInt16LE(0, 28);
  return b;
}

function centralHeader(e: ZipEntry, nameLength: number): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);
  b.writeUInt16LE(20, 6);
  b.writeUInt16LE(utf8Flag(e.name), 8);
  b.writeUInt16LE(e.method, 10);
  b.writeUInt16LE(DOS_TIME, 12);
  b.writeUInt16LE(DOS_DATE, 14);
  b.writeUInt32LE(e.crc, 16);
  b.writeUInt32LE(e.compressedSize, 20);
  b.writeUInt32LE(e.size, 24);
  b.writeUInt16LE(nameLength, 28);
  // extra and comment lengths, disk number, attributes: zero
  b.writeUInt32LE(e.offset, 42);
  return b;
}

function endRecord(count: number, centralSize: number, centralOffset: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(centralSize, 12);
  b.writeUInt32LE(centralOffset, 16);
  return b;
}
