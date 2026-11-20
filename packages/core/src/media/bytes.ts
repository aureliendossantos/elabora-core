// Reading a file's structure without holding the file, the same on both hosts
// (docs/architecture/media.md, « One reading of the bytes »). A reader is a generator that asks for
// ranges of the file and returns what it found: the desktop answers from a file handle at once
// (readSync), a browser from a File's slices (readAsync) or from bytes it already holds.

export interface ByteRange { position: number; length: number }

// Yields the ranges it needs, receives their bytes (shorter at the end of the file), returns its answer.
export type ByteSteps<T> = Generator<ByteRange, T, Uint8Array>;

export function readSync<T>(steps: ByteSteps<T>, read: (position: number, length: number) => Uint8Array): T {
  let next = steps.next();
  while (!next.done) next = steps.next(read(next.value.position, next.value.length));
  return next.value;
}

export async function readAsync<T>(steps: ByteSteps<T>, read: (position: number, length: number) => Promise<Uint8Array>): Promise<T> {
  let next = steps.next();
  while (!next.done) next = steps.next(await read(next.value.position, next.value.length));
  return next.value;
}

// Bytes held whole: each range is a view of them, never a copy.
export const bytesReader = (bytes: Uint8Array) => (position: number, length: number): Uint8Array =>
  bytes.subarray(Math.min(position, bytes.length), Math.min(bytes.length, position + length));

// A file written from pieces: bytes made by the reader, or a range of the file it read, copied as it is.
export type BytePiece = Uint8Array | ByteRange;

export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let text = '';
  for (let at = start; at < end; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, Math.min(end, at + 0x8000)));
  return text;
}

export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export const u16be = (bytes: Uint8Array, at: number) => view(bytes).getUint16(at);
export const u32be = (bytes: Uint8Array, at: number) => view(bytes).getUint32(at);
export const u32le = (bytes: Uint8Array, at: number) => view(bytes).getUint32(at, true);
export const u64be = (bytes: Uint8Array, at: number) => Number(view(bytes).getBigUint64(at));

let CRC_TABLE: Uint32Array | null = null;

// CRC-32 (IEEE), as PNG's chunks and zlib's crc32 compute it.
export function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
