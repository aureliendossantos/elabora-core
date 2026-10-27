import fs from 'node:fs';
import zlib from 'node:zlib';

// Image metadata read and removed without re-encoding. Phone photos carry their GPS position in
// EXIF and XMP; JPEGs from phones also append preview images and motion-photo videos after the
// picture. Removing them is lossless: the orientation (as a minimal EXIF block) and the colour
// profile are kept, so the image displays exactly as before. Reads are synchronous: the snapshot of a
// folder probes new images synchronously, and images worth stripping are at most a few megabytes.

export type ImageContainer = 'jpeg' | 'png' | 'webp';

export interface ImageMetadata {
  orientation: number | null; // EXIF orientation, 1 to 8
  location: boolean;          // GPS coordinates in EXIF or XMP
}

const CHUNK = 1024 * 1024;
const MAX_HEADER = 32 * 1024 * 1024; // JPEG segments before the image data: never that large in practice

export function readImageMetadata(file: string, container: ImageContainer): ImageMetadata {
  const handle = fs.openSync(file, 'r');
  try {
    const result: ImageMetadata = { orientation: null, location: false };
    const exif = (tiff: Uint8Array) => {
      const parsed = parseTiff(tiff);
      result.orientation ??= parsed.orientation;
      result.location ||= parsed.gps;
    };
    const xmp = (bytes: Uint8Array) => { result.location ||= /GPS(Latitude|Longitude)/.test(Buffer.from(bytes).toString('latin1')); };
    if (container === 'jpeg') {
      const head = jpegHead(handle);
      for (const s of head?.segments ?? []) {
        if (s.marker === 0xe1 && startsWith(s.payload, EXIF_HEADER)) exif(s.payload.subarray(EXIF_HEADER.length));
        else if (s.marker === 0xe1) xmp(s.payload);
      }
    } else if (container === 'png') {
      for (const c of pngChunks(handle)) {
        if (c.type === 'eXIf') exif(readAt(handle, c.dataStart, c.length));
        else if (c.type === 'iTXt' || c.type === 'tEXt' || c.type === 'zTXt') xmp(readAt(handle, c.dataStart, c.length));
      }
    } else {
      for (const c of (webpChunks(handle))?.chunks ?? []) {
        if (c.type === 'EXIF') {
          const data = readAt(handle, c.dataStart, c.length);
          exif(startsWith(data, EXIF_HEADER) ? data.subarray(EXIF_HEADER.length) : data);
        } else if (c.type === 'XMP ') xmp(readAt(handle, c.dataStart, c.length));
      }
    }
    return result;
  } finally {
    fs.closeSync(handle);
  }
}

// Writes `output`: the image of `input` without its metadata. Returns false when the file cannot
// be parsed (the caller then re-encodes it instead).
export function stripImageMetadata(input: string, output: string, container: ImageContainer): boolean {
  const source = fs.openSync(input, 'r');
  let target: number | null = null;
  try {
    const { orientation } = readImageMetadata(input, container);
    const keepOrientation = orientation !== null && orientation !== 1 ? orientation : null;
    if (container === 'jpeg') {
      const head = jpegHead(source);
      if (!head) return false;
      target = fs.openSync(output, 'w');
      write(target, Uint8Array.of(0xff, 0xd8));
      let exifWritten = keepOrientation === null;
      for (const s of head.segments) {
        if (!exifWritten && s.marker !== 0xe0) { write(target, segment(0xe1, Buffer.concat([EXIF_HEADER, minimalTiff(keepOrientation!)]))); exifWritten = true; }
        if (keepJpegSegment(s.marker, s.payload)) write(target, segment(s.marker, s.payload));
      }
      if (!exifWritten) write(target, segment(0xe1, Buffer.concat([EXIF_HEADER, minimalTiff(keepOrientation!)])));
      copyJpegData(source, target, head.dataStart);
    } else if (container === 'png') {
      const chunks = pngChunks(source);
      if (!chunks.length) return false;
      target = fs.openSync(output, 'w');
      write(target, PNG_SIGNATURE);
      let exifWritten = keepOrientation === null;
      for (const c of chunks) {
        if (PNG_METADATA.has(c.type)) continue;
        // eXIf must come before the image data.
        if (!exifWritten && c.type === 'IDAT') { write(target, pngChunk('eXIf', minimalTiff(keepOrientation!))); exifWritten = true; }
        copyRange(source, target, c.start, c.end - c.start);
      }
    } else {
      const parsed = webpChunks(source);
      if (!parsed) return false;
      const kept = parsed.chunks.filter((c) => c.type !== 'EXIF' && c.type !== 'XMP ');
      const exifChunk = keepOrientation !== null ? riffChunk('EXIF', minimalTiff(keepOrientation)) : null;
      const vp8x = kept.find((c) => c.type === 'VP8X');
      if (exifChunk && !vp8x) return false; // a simple WebP cannot carry EXIF: re-encode instead
      const size = 4 + kept.reduce((sum, c) => sum + (c.end - c.start), 0) + (exifChunk?.length ?? 0);
      target = fs.openSync(output, 'w');
      const header = Buffer.alloc(12);
      header.write('RIFF', 0, 'latin1');
      header.writeUInt32LE(size, 4);
      header.write('WEBP', 8, 'latin1');
      write(target, header);
      for (const c of kept) {
        if (c === vp8x) {
          const data = readAt(source, c.start, c.end - c.start);
          data[8] = (data[8] & ~0x0c) | (exifChunk ? 0x08 : 0); // EXIF and XMP flags
          write(target, data);
        } else {
          copyRange(source, target, c.start, c.end - c.start);
        }
      }
      if (exifChunk) write(target, exifChunk);
    }
    return true;
  } finally {
    fs.closeSync(source);
    if (target !== null) fs.closeSync(target);
  }
}


interface JpegSegment { marker: number; payload: Buffer }

// Segments before the first scan (SOS); dataStart is the offset of the SOS marker.
function jpegHead(handle: number): { segments: JpegSegment[]; dataStart: number } | null {
  let buffer = readAt(handle, 0, 256 * 1024);
  const ensure = (end: number) => {
    if (end <= buffer.length) return true;
    if (end > MAX_HEADER) return false;
    const more = readAt(handle, 0, Math.max(end, buffer.length * 2));
    if (more.length < end) return false;
    buffer = more;
    return true;
  };
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const segments: JpegSegment[] = [];
  let p = 2;
  for (;;) {
    if (!(ensure(p + 4))) return null;
    if (buffer[p] !== 0xff) return null;
    while (buffer[p + 1] === 0xff) { p++; if (!(ensure(p + 4))) return null; } // fill bytes
    const marker = buffer[p + 1];
    if (marker === 0xda) return { segments, dataStart: p };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xd9) return null;
    const length = buffer.readUInt16BE(p + 2);
    if (length < 2 || !(ensure(p + 2 + length))) return null;
    segments.push({ marker, payload: Buffer.from(buffer.subarray(p + 4, p + 2 + length)) });
    p += 2 + length;
  }
}

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');

// Kept: JFIF (APP0), the ICC colour profile (APP2), Adobe's colour transform (APP14) and every
// non-APP segment. Dropped: EXIF and XMP (APP1), multi-picture index (APP2 MPF), maker data,
// IPTC (APP13) and comments.
function keepJpegSegment(marker: number, payload: Buffer): boolean {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2) return startsWith(payload, Buffer.from('ICC_PROFILE\0', 'latin1'));
  if (marker >= 0xe1 && marker <= 0xef) return false;
  return marker !== 0xfe;
}

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xff00 | marker, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

// Copies the scans up to the end-of-image marker; what follows (preview images, motion-photo
// videos, maker trailers) is dropped. In entropy-coded data 0xFF is followed by 0x00 or a restart
// marker; other markers (tables and scan headers of progressive JPEGs) carry a length and are
// skipped whole, so bytes inside them are never taken for the end marker.
function copyJpegData(source: number, target: number, start: number): void {
  const buffer = Buffer.alloc(CHUNK);
  let position = start;
  let state: 'data' | 'marker' | 'length-high' | 'length-low' | 'skip' = 'data';
  let lengthHigh = 0;
  let skip = 0;
  for (;;) {
    const bytesRead = fs.readSync(source, buffer, 0, CHUNK, position);
    if (bytesRead === 0) return;
    let end = -1;
    for (let i = 0; i < bytesRead && end < 0; i++) {
      const byte = buffer[i];
      if (state === 'skip') {
        const n = Math.min(skip, bytesRead - i);
        skip -= n;
        i += n - 1;
        if (skip === 0) state = 'data';
      } else if (state === 'data') {
        if (byte === 0xff) state = 'marker';
      } else if (state === 'marker') {
        if (byte === 0xd9) end = i + 1;
        else if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) state = 'data';
        else if (byte !== 0xff) state = 'length-high';
      } else if (state === 'length-high') {
        lengthHigh = byte;
        state = 'length-low';
      } else {
        skip = ((lengthHigh << 8) | byte) - 2;
        state = skip > 0 ? 'skip' : 'data';
      }
    }
    write(target, buffer, 0, end < 0 ? bytesRead : end);
    if (end >= 0) return;
    position += bytesRead;
  }
}


const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

interface Chunk { type: string; start: number; dataStart: number; length: number; end: number }

function pngChunks(handle: number): Chunk[] {
  const size = fs.fstatSync(handle).size;
  if (!startsWith(readAt(handle, 0, 8), PNG_SIGNATURE)) return [];
  const chunks: Chunk[] = [];
  let p = 8;
  while (p + 12 <= size) {
    const head = readAt(handle, p, 8);
    const length = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    const end = p + 12 + length;
    if (end > size) return [];
    chunks.push({ type, start: p, dataStart: p + 8, length, end });
    p = end;
    if (type === 'IEND') return chunks;
  }
  return [];
}

function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}


function webpChunks(handle: number): { chunks: Chunk[] } | null {
  const size = fs.fstatSync(handle).size;
  const header = readAt(handle, 0, 12);
  if (header.length < 12 || header.toString('latin1', 0, 4) !== 'RIFF' || header.toString('latin1', 8, 12) !== 'WEBP') return null;
  const end = Math.min(size, 8 + header.readUInt32LE(4));
  const chunks: Chunk[] = [];
  let p = 12;
  while (p + 8 <= end) {
    const head = readAt(handle, p, 8);
    const length = head.readUInt32LE(4);
    const chunkEnd = p + 8 + length + (length % 2);
    if (chunkEnd > end) return null;
    chunks.push({ type: head.toString('latin1', 0, 4), start: p, dataStart: p + 8, length, end: chunkEnd });
    p = chunkEnd;
  }
  return { chunks };
}

function riffChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + (data.length % 2));
  out.write(type, 0, 'latin1');
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}


function parseTiff(tiff: Uint8Array): { orientation: number | null; gps: boolean } {
  const none = { orientation: null, gps: false };
  if (tiff.length < 8) return none;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return none;
  const u16 = (o: number) => (o + 2 <= tiff.length ? view.getUint16(o, little) : 0);
  const u32 = (o: number) => (o + 4 <= tiff.length ? view.getUint32(o, little) : 0);
  if (u16(2) !== 42) return none;
  const entries = (ifd: number) => {
    const count = u16(ifd);
    const list: { tag: number; offset: number }[] = [];
    for (let i = 0; i < count && ifd + 2 + (i + 1) * 12 <= tiff.length; i++) list.push({ tag: u16(ifd + 2 + i * 12), offset: ifd + 2 + i * 12 });
    return list;
  };
  let orientation: number | null = null;
  let gps = false;
  for (const e of entries(u32(4))) {
    if (e.tag === 0x0112) {
      const value = u16(e.offset + 8);
      if (value >= 1 && value <= 8) orientation = value;
    } else if (e.tag === 0x8825) {
      // GPS IFD: latitude (2) or longitude (4) present means a position.
      gps = entries(u32(e.offset + 8)).some((g) => g.tag === 0x0002 || g.tag === 0x0004);
    }
  }
  return { orientation, gps };
}

// A big-endian TIFF block holding only the orientation.
function minimalTiff(orientation: number): Buffer {
  const out = Buffer.alloc(26);
  out.write('MM', 0, 'latin1');
  out.writeUInt16BE(42, 2);
  out.writeUInt32BE(8, 4);
  out.writeUInt16BE(1, 8);
  out.writeUInt16BE(0x0112, 10);
  out.writeUInt16BE(3, 12);
  out.writeUInt32BE(1, 14);
  out.writeUInt16BE(orientation, 18);
  out.writeUInt32BE(0, 22);
  return out;
}


function readAt(handle: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const bytesRead = fs.readSync(handle, buffer, 0, length, position);
  return bytesRead < length ? buffer.subarray(0, bytesRead) : buffer;
}

function copyRange(source: number, target: number, start: number, length: number): void {
  const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(1, length)));
  let done = 0;
  while (done < length) {
    const bytesRead = fs.readSync(source, buffer, 0, Math.min(buffer.length, length - done), start + done);
    if (bytesRead === 0) throw new Error('Unexpected end of file');
    write(target, buffer, 0, bytesRead);
    done += bytesRead;
  }
}

function write(target: number, data: Uint8Array, offset = 0, length = data.length - offset): void {
  for (let done = 0; done < length;) done += fs.writeSync(target, data, offset + done, length - done);
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (data[i] !== prefix[i]) return false;
  return true;
}
