// Image metadata read and removed without re-encoding, and the top-level boxes of an MP4: the same
// rules on the desktop and in a browser (docs/architecture/media.md, « One reading of the bytes »).
// Phone photos carry their GPS position in EXIF and XMP; JPEGs from phones also append preview
// images and motion-photo videos after the picture. Removing them is lossless: the orientation (as a
// minimal EXIF block) and the colour profile are kept, so the image displays exactly as before.

import { concatBytes, crc32, latin1, latin1Bytes, startsWith, u16be, u32be, u32le, u64be } from './bytes.ts';
import type { BytePiece, ByteSteps } from './bytes.ts';

export type ImageContainer = 'jpeg' | 'png' | 'webp';

export interface ImageMetadata {
  orientation: number | null; // EXIF orientation, 1 to 8
  location: boolean;          // GPS coordinates in EXIF or XMP
}

// The rotation an EXIF orientation asks for, in degrees clockwise (mirrored ones included).
export const ORIENTATION_DEGREES: Readonly<Record<number, number>> = { 3: 180, 5: 90, 6: 90, 7: 270, 8: 270 };

const CHUNK = 1024 * 1024;
const MAX_HEADER = 32 * 1024 * 1024; // JPEG segments before the image data: never that large in practice

export function* imageMetadataSteps(size: number, container: ImageContainer): ByteSteps<ImageMetadata> {
  const result: ImageMetadata = { orientation: null, location: false };
  const exif = (tiff: Uint8Array) => {
    const parsed = parseTiff(tiff);
    result.orientation ??= parsed.orientation;
    result.location ||= parsed.gps;
  };
  const xmp = (bytes: Uint8Array) => { result.location ||= /GPS(Latitude|Longitude)/.test(latin1(bytes)); };
  if (container === 'jpeg') {
    const head = yield* jpegHead();
    for (const s of head?.segments ?? []) {
      if (s.marker === 0xe1 && startsWith(s.payload, EXIF_HEADER)) exif(s.payload.subarray(EXIF_HEADER.length));
      else if (s.marker === 0xe1) xmp(s.payload);
    }
  } else if (container === 'png') {
    for (const c of yield* pngChunks(size)) {
      if (c.type === 'eXIf') exif(yield { position: c.dataStart, length: c.length });
      else if (c.type === 'iTXt' || c.type === 'tEXt' || c.type === 'zTXt') xmp(yield { position: c.dataStart, length: c.length });
    }
  } else {
    for (const c of (yield* webpChunks(size)) ?? []) {
      if (c.type === 'EXIF') {
        const data = yield { position: c.dataStart, length: c.length };
        exif(startsWith(data, EXIF_HEADER) ? data.subarray(EXIF_HEADER.length) : data);
      } else if (c.type === 'XMP ') xmp(yield { position: c.dataStart, length: c.length });
    }
  }
  return result;
}

// The image without its metadata, as pieces to write; null when the file cannot be parsed (the
// caller then re-encodes it instead).
export function* strippedImageSteps(size: number, container: ImageContainer): ByteSteps<BytePiece[] | null> {
  const { orientation } = yield* imageMetadataSteps(size, container);
  const keepOrientation = orientation !== null && orientation !== 1 ? orientation : null;
  const out: BytePiece[] = [];
  if (container === 'jpeg') {
    const head = yield* jpegHead();
    if (!head) return null;
    out.push(Uint8Array.of(0xff, 0xd8));
    let exifWritten = keepOrientation === null;
    for (const s of head.segments) {
      if (!exifWritten && s.marker !== 0xe0) { out.push(segment(0xe1, concatBytes([EXIF_HEADER, minimalTiff(keepOrientation!)]))); exifWritten = true; }
      if (keepJpegSegment(s.marker, s.payload)) out.push(segment(s.marker, s.payload));
    }
    if (!exifWritten) out.push(segment(0xe1, concatBytes([EXIF_HEADER, minimalTiff(keepOrientation!)])));
    const end = yield* jpegDataEnd(head.dataStart);
    out.push({ position: head.dataStart, length: end - head.dataStart });
  } else if (container === 'png') {
    const chunks = yield* pngChunks(size);
    if (!chunks.length) return null;
    out.push(PNG_SIGNATURE);
    let exifWritten = keepOrientation === null;
    for (const c of chunks) {
      if (PNG_METADATA.has(c.type)) continue;
      // eXIf must come before the image data.
      if (!exifWritten && c.type === 'IDAT') { out.push(pngChunk('eXIf', minimalTiff(keepOrientation!))); exifWritten = true; }
      out.push({ position: c.start, length: c.end - c.start });
    }
  } else {
    const chunks = yield* webpChunks(size);
    if (!chunks) return null;
    const kept = chunks.filter((c) => c.type !== 'EXIF' && c.type !== 'XMP ');
    const exifChunk = keepOrientation !== null ? riffChunk('EXIF', minimalTiff(keepOrientation)) : null;
    const vp8x = kept.find((c) => c.type === 'VP8X');
    if (exifChunk && !vp8x) return null; // a simple WebP cannot carry EXIF: re-encode instead
    const length = 4 + kept.reduce((sum, c) => sum + (c.end - c.start), 0) + (exifChunk?.length ?? 0);
    const header = new Uint8Array(12);
    header.set(latin1Bytes('RIFF'), 0);
    new DataView(header.buffer).setUint32(4, length, true);
    header.set(latin1Bytes('WEBP'), 8);
    out.push(header);
    for (const c of kept) {
      if (c === vp8x) {
        const data = (yield { position: c.start, length: c.end - c.start }).slice();
        data[8] = (data[8] & ~0x0c) | (exifChunk ? 0x08 : 0); // EXIF and XMP flags
        out.push(data);
      } else {
        out.push({ position: c.start, length: c.end - c.start });
      }
    }
    if (exifChunk) out.push(exifChunk);
  }
  return out;
}

// --- JPEG

interface JpegSegment { marker: number; payload: Uint8Array }

// Segments before the first scan (SOS); dataStart is the offset of the SOS marker.
function* jpegHead(): ByteSteps<{ segments: JpegSegment[]; dataStart: number } | null> {
  let buffer = yield { position: 0, length: 256 * 1024 };
  function* ensure(end: number): ByteSteps<boolean> {
    if (end <= buffer.length) return true;
    if (end > MAX_HEADER) return false;
    const more = yield { position: 0, length: Math.max(end, buffer.length * 2) };
    if (more.length < end) return false;
    buffer = more;
    return true;
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const segments: JpegSegment[] = [];
  let p = 2;
  for (;;) {
    if (!(yield* ensure(p + 4))) return null;
    if (buffer[p] !== 0xff) return null;
    while (buffer[p + 1] === 0xff) { p++; if (!(yield* ensure(p + 4))) return null; } // fill bytes
    const marker = buffer[p + 1];
    if (marker === 0xda) return { segments, dataStart: p };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    if (marker === 0xd9) return null;
    const length = u16be(buffer, p + 2);
    if (length < 2 || !(yield* ensure(p + 2 + length))) return null;
    segments.push({ marker, payload: buffer.slice(p + 4, p + 2 + length) });
    p += 2 + length;
  }
}

const EXIF_HEADER = latin1Bytes('Exif\0\0');
const ICC_HEADER = latin1Bytes('ICC_PROFILE\0');

// Kept: JFIF (APP0), the ICC colour profile (APP2), Adobe's colour transform (APP14) and every
// non-APP segment. Dropped: EXIF and XMP (APP1), multi-picture index (APP2 MPF), maker data,
// IPTC (APP13) and comments.
function keepJpegSegment(marker: number, payload: Uint8Array): boolean {
  if (marker === 0xe0 || marker === 0xee) return true;
  if (marker === 0xe2) return startsWith(payload, ICC_HEADER);
  if (marker >= 0xe1 && marker <= 0xef) return false;
  return marker !== 0xfe;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xff00 | marker);
  view.setUint16(2, payload.length + 2);
  out.set(payload, 4);
  return out;
}

// Where the scans end: after the end-of-image marker, or at the end of the file; what follows
// (preview images, motion-photo videos, maker trailers) is dropped. In entropy-coded data 0xFF is
// followed by 0x00 or a restart marker; other markers (tables and scan headers of progressive JPEGs)
// carry a length and are skipped whole, so bytes inside them are never taken for the end marker.
function* jpegDataEnd(start: number): ByteSteps<number> {
  let position = start;
  let state: 'data' | 'marker' | 'length-high' | 'length-low' | 'skip' = 'data';
  let lengthHigh = 0;
  let skip = 0;
  for (;;) {
    const buffer = yield { position, length: CHUNK };
    const bytesRead = buffer.length;
    if (bytesRead === 0) return position;
    for (let i = 0; i < bytesRead; i++) {
      const byte = buffer[i];
      if (state === 'skip') {
        const n = Math.min(skip, bytesRead - i);
        skip -= n;
        i += n - 1;
        if (skip === 0) state = 'data';
      } else if (state === 'data') {
        if (byte === 0xff) state = 'marker';
      } else if (state === 'marker') {
        if (byte === 0xd9) return position + i + 1;
        if (byte === 0x00 || (byte >= 0xd0 && byte <= 0xd7)) state = 'data';
        else if (byte !== 0xff) state = 'length-high';
      } else if (state === 'length-high') {
        lengthHigh = byte;
        state = 'length-low';
      } else {
        skip = ((lengthHigh << 8) | byte) - 2;
        state = skip > 0 ? 'skip' : 'data';
      }
    }
    position += bytesRead;
  }
}

// --- PNG

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PNG_METADATA = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

interface Chunk { type: string; start: number; dataStart: number; length: number; end: number }

// Every chunk up to IEND; none when the file is cut or not a PNG.
function* pngChunks(size: number): ByteSteps<Chunk[]> {
  if (!startsWith(yield { position: 0, length: 8 }, PNG_SIGNATURE)) return [];
  const chunks: Chunk[] = [];
  let p = 8;
  while (p + 12 <= size) {
    const head = yield { position: p, length: 8 };
    const length = u32be(head, 0);
    const type = latin1(head, 4, 8);
    const end = p + 12 + length;
    if (end > size) return [];
    chunks.push({ type, start: p, dataStart: p + 8, length, end });
    p = end;
    if (type === 'IEND') return chunks;
  }
  return [];
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(latin1Bytes(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// --- WebP (RIFF)

function* webpChunks(size: number): ByteSteps<Chunk[] | null> {
  const header = yield { position: 0, length: 12 };
  if (header.length < 12 || latin1(header, 0, 4) !== 'RIFF' || latin1(header, 8, 12) !== 'WEBP') return null;
  const end = Math.min(size, 8 + u32le(header, 4));
  const chunks: Chunk[] = [];
  let p = 12;
  while (p + 8 <= end) {
    const head = yield { position: p, length: 8 };
    const length = u32le(head, 4);
    const chunkEnd = p + 8 + length + (length % 2);
    if (chunkEnd > end) return null;
    chunks.push({ type: latin1(head, 0, 4), start: p, dataStart: p + 8, length, end: chunkEnd });
    p = chunkEnd;
  }
  return chunks;
}

function riffChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length + (data.length % 2));
  out.set(latin1Bytes(type), 0);
  new DataView(out.buffer).setUint32(4, data.length, true);
  out.set(data, 8);
  return out;
}

// --- EXIF (TIFF structure)

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
function minimalTiff(orientation: number): Uint8Array {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  out.set(latin1Bytes('MM'), 0);
  view.setUint16(2, 42);
  view.setUint32(4, 8);
  view.setUint16(8, 1);
  view.setUint16(10, 0x0112);
  view.setUint16(12, 3);
  view.setUint32(14, 1);
  view.setUint16(18, orientation);
  view.setUint32(22, 0);
  return out;
}

// --- MP4 top-level boxes

export interface Mp4Layout {
  brand: string | null;      // major brand of ftyp
  faststart: boolean | null; // moov before the first mdat; null without moov
  boxes: string[];           // top-level box types in file order
}

export function* mp4LayoutSteps(size: number): ByteSteps<Mp4Layout> {
  const boxes: string[] = [];
  let brand: string | null = null;
  let position = 0;
  while (position + 8 <= size && boxes.length < 10_000) {
    const header = yield { position, length: 16 };
    if (header.length < 8) break;
    const type = latin1(header, 4, 8);
    let boxSize = u32be(header, 0);
    if (boxSize === 1) {
      if (header.length < 16) break;
      boxSize = u64be(header, 8);
    } else if (boxSize === 0) {
      boxSize = size - position; // extends to the end of the file
    }
    if (boxSize < 8) break;
    if (type === 'ftyp' && header.length >= 12) brand = latin1(header, 8, 12);
    boxes.push(type);
    if (boxes.includes('moov') && boxes.includes('mdat')) break;
    position += boxSize;
  }
  const moov = boxes.indexOf('moov');
  const mdat = boxes.indexOf('mdat');
  return { brand, faststart: moov < 0 ? null : mdat < 0 || moov < mdat, boxes };
}
