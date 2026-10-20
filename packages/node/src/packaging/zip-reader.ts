import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Streaming ZIP reader, the counterpart of zip-writer.ts for archives that come from elsewhere:
// it reads the central directory, then extracts one entry at a time to a file, in chunks, so a
// 300 MB video is never held in memory. Methods 0 and 8, no encryption, no ZIP64 (Elabora writes
// neither). Every extraction is checked against the CRC and size of the central directory, and
// inflating stops at the declared size, so a crafted entry cannot fill the disk.

export interface ZipReaderEntry {
  name: string;
  method: 0 | 8;
  crc: number;
  compressedSize: number;
  size: number; // uncompressed
  headerOffset: number; // of the local header
}

export interface ExtractResult {
  size: number;
  sha256: string; // hex digest of the extracted bytes
}

export class ZipFormatError extends Error {
  readonly code = 'E_ZIP_FORMAT';
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

const CHUNK = 1024 * 1024;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;

export class ZipReader {
  readonly file: string;
  readonly entries: readonly ZipReaderEntry[];
  readonly size: number; // bytes of the archive
  #handle: fs.promises.FileHandle;
  #rawNames: Map<ZipReaderEntry, Buffer>;
  // Where the next entry (or the central directory) starts: an entry's data must end before it,
  // so entries cannot overlap (a classic way to make a small archive inflate to terabytes).
  #limits: Map<ZipReaderEntry, number>;

  private constructor(file: string, handle: fs.promises.FileHandle, size: number, entries: ZipReaderEntry[], rawNames: Map<ZipReaderEntry, Buffer>, limits: Map<ZipReaderEntry, number>) {
    this.file = file;
    this.#handle = handle;
    this.size = size;
    this.entries = entries;
    this.#rawNames = rawNames;
    this.#limits = limits;
  }

  static async open(file: string): Promise<ZipReader> {
    const handle = await fs.promises.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const tailLength = Math.min(size, 22 + MAX_COMMENT);
      const tail = await readAt(handle, size - tailLength, tailLength);
      let eocd = -1;
      for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD) { eocd = i; break; }
      }
      if (eocd < 0) throw new ZipFormatError('Not a ZIP file (end of central directory not found).');
      const disk = tail.readUInt16LE(eocd + 4);
      const count = tail.readUInt16LE(eocd + 10);
      const centralSize = tail.readUInt32LE(eocd + 12);
      const centralOffset = tail.readUInt32LE(eocd + 16);
      if (disk !== 0) throw new ZipFormatError('Split ZIP archives are not supported.');
      if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new ZipFormatError('ZIP64 archives are not supported.');
      if (centralOffset + centralSize > size - tailLength + eocd) throw new ZipFormatError('Damaged ZIP file (central directory out of bounds).');
      const central = await readAt(handle, centralOffset, centralSize);
      const entries: ZipReaderEntry[] = [];
      const rawNames = new Map<ZipReaderEntry, Buffer>();
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (p + 46 > central.length || central.readUInt32LE(p) !== CENTRAL) throw new ZipFormatError('Damaged ZIP file (central directory).');
        const flags = central.readUInt16LE(p + 8);
        const method = central.readUInt16LE(p + 10);
        const nameLength = central.readUInt16LE(p + 28);
        const extraLength = central.readUInt16LE(p + 30);
        const commentLength = central.readUInt16LE(p + 32);
        const rawName = central.subarray(p + 46, p + 46 + nameLength);
        const name = rawName.toString('utf8');
        if (flags & 0x1) throw new ZipFormatError(`${name} is encrypted.`);
        if (method !== 0 && method !== 8) throw new ZipFormatError(`${name} uses compression method ${method} (only stored and deflated entries are read).`);
        const entry: ZipReaderEntry = {
          name,
          method,
          crc: central.readUInt32LE(p + 16),
          compressedSize: central.readUInt32LE(p + 20),
          size: central.readUInt32LE(p + 24),
          headerOffset: central.readUInt32LE(p + 42),
        };
        if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.headerOffset === 0xffffffff) throw new ZipFormatError('ZIP64 archives are not supported.');
        if (method === 0 && entry.compressedSize !== entry.size) throw new ZipFormatError(`${name}: a stored entry with two sizes.`);
        entries.push(entry);
        rawNames.set(entry, Buffer.from(rawName));
        p += 46 + nameLength + extraLength + commentLength;
      }
      const byOffset = [...entries].sort((a, b) => a.headerOffset - b.headerOffset);
      const limits = new Map<ZipReaderEntry, number>();
      for (let i = 0; i < byOffset.length; i++) {
        const next = i + 1 < byOffset.length ? byOffset[i + 1].headerOffset : centralOffset;
        if (next === byOffset[i].headerOffset && i + 1 < byOffset.length) throw new ZipFormatError(`${byOffset[i].name} and ${byOffset[i + 1].name} share their data.`);
        limits.set(byOffset[i], next);
      }
      return new ZipReader(file, handle, size, entries, rawNames, limits);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  // Start of an entry's data, after checking its local header against the central directory.
  async #dataRange(entry: ZipReaderEntry): Promise<{ start: number; end: number }> {
    const header = await readAt(this.#handle, entry.headerOffset, 30);
    if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw new ZipFormatError(`Damaged ZIP file (local header of ${entry.name}).`);
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const name = await readAt(this.#handle, entry.headerOffset + 30, nameLength);
    if (!name.equals(this.#rawNames.get(entry)!)) throw new ZipFormatError(`Damaged ZIP file (${entry.name} has another name in its local header).`);
    const start = entry.headerOffset + 30 + nameLength + extraLength;
    const end = start + entry.compressedSize;
    if (end > this.#limits.get(entry)!) throw new ZipFormatError(`Damaged ZIP file (${entry.name} overlaps the next entry).`);
    return { start, end };
  }

  // Decompressed bytes of an entry, checked; for small entries (manifests).
  async readEntry(entry: ZipReaderEntry, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    if (entry.size > maxBytes) throw new ZipFormatError(`${entry.name} is larger than ${maxBytes} bytes.`);
    const chunks: Buffer[] = [];
    // Copies: the chunks of a stored entry share one buffer.
    for await (const chunk of this.#data(entry)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  // The first bytes of an entry's decompressed data (at least `bytes` of them unless it is shorter),
  // without reading the rest: enough for a picture's header. The CRC of what is not read is not checked.
  async readPrefix(entry: ZipReaderEntry, bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of this.#data(entry)) {
      chunks.push(Buffer.from(chunk));
      length += chunk.length;
      if (length >= bytes) break;
    }
    return Buffer.concat(chunks).subarray(0, bytes);
  }

  // Writes an entry to `target`, which must not exist, and returns the SHA-256 of what was written.
  // `flush` waits for the bytes to reach the disk before returning.
  async extractEntry(entry: ZipReaderEntry, target: string, options: { flush?: boolean; onBytes?: (bytes: number) => void } = {}): Promise<ExtractResult> {
    const hash = crypto.createHash('sha256');
    // Opened first: a target that exists is refused before anything is read, and left as it is.
    const handle = await fs.promises.open(target, 'wx');
    try {
      for await (const chunk of this.#data(entry)) {
        hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) offset += (await handle.write(chunk, offset, chunk.length - offset)).bytesWritten;
        options.onBytes?.(chunk.length);
      }
      if (options.flush) await handle.sync();
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.promises.rm(target, { force: true });
      throw error;
    }
    return { size: entry.size, sha256: hash.digest('hex') };
  }

  // A digest of an entry's bytes (hex), read in chunks: importers match media by their MD5.
  async hashEntry(entry: ZipReaderEntry, algorithm: 'md5' | 'sha256' = 'sha256'): Promise<string> {
    const hash = crypto.createHash(algorithm);
    for await (const chunk of this.#data(entry)) hash.update(chunk);
    return hash.digest('hex');
  }

  // The entry's decompressed bytes, checked against its size (as they come) and CRC (at the end).
  // A stored entry is read into one reused buffer, so a 300 MB video leaves no garbage behind: each
  // chunk is valid until the next one is asked for.
  async *#data(entry: ZipReaderEntry): AsyncGenerator<Buffer> {
    const { start, end } = await this.#dataRange(entry);
    let crc = 0;
    let size = 0;
    const check = (chunk: Buffer) => {
      size += chunk.length;
      if (size > entry.size) throw new ZipFormatError(`${entry.name} holds more bytes than its header says.`);
      crc = zlib.crc32(chunk, crc);
    };
    if (entry.method === 0) {
      const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, end - start)));
      for (let position = start; position < end;) {
        const { bytesRead } = await this.#handle.read(buffer, 0, Math.min(buffer.length, end - position), position);
        if (bytesRead === 0) throw new ZipFormatError(`${entry.name} is cut short.`);
        const chunk = buffer.subarray(0, bytesRead);
        check(chunk);
        yield chunk;
        position += bytesRead;
      }
    } else {
      // An empty range cannot be read by createReadStream (end is inclusive).
      const source = end > start ? fs.createReadStream(this.file, { start, end: end - 1, highWaterMark: 256 * 1024 }) : Readable.from([]);
      const inflate = zlib.createInflateRaw({ chunkSize: 256 * 1024 });
      // Errors of the source reach the loop through the inflater, which pipeline destroys with them.
      const piping = pipeline(source, inflate);
      piping.catch(() => {});
      try {
        for await (const chunk of inflate as AsyncIterable<Buffer>) {
          check(chunk);
          yield chunk;
        }
        await piping;
      } finally {
        source.destroy();
        inflate.destroy();
      }
    }
    if (size !== entry.size || crc !== entry.crc) throw new ZipFormatError(`${entry.name} is damaged (its CRC or size does not match the archive's directory).`);
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

async function readAt(handle: fs.promises.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}
