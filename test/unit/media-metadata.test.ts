import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { bytesReader, concatBytes, readAsync, readSync } from '@elabora/core/media/bytes';
import type { BytePiece } from '@elabora/core/media/bytes';
import { imageMetadataSteps, mp4LayoutSteps, strippedImageSteps } from '@elabora/core/media/metadata';
import { readImageMetadata, stripImageMetadata, readMp4Layout } from '@elabora/node/media/index';

// Images and MP4s built byte by byte, as phones and cameras write them: what the desktop reads of
// them and the bytes it writes without their metadata. The browser reads and writes them with the
// same code of @elabora/core/media/, which must give the desktop's bytes.

const latin1 = (text: string) => Buffer.from(text, 'latin1');
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

// A TIFF block: the orientation and, if asked, a GPS latitude (big- or little-endian).
function tiff(orientation: number | null, gps: boolean, little = false): Buffer {
  const out = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 2 + 12 + 4 + 24);
  const w16 = (v: number, o: number) => little ? out.writeUInt16LE(v, o) : out.writeUInt16BE(v, o);
  const w32 = (v: number, o: number) => little ? out.writeUInt32LE(v, o) : out.writeUInt32BE(v, o);
  out.write(little ? 'II' : 'MM', 0, 'latin1');
  w16(42, 2); w32(8, 4);
  const entries = [...(orientation !== null ? [[0x0112, 3, 1, orientation]] : []), ...(gps ? [[0x8825, 4, 1, 8 + 2 + 2 * 12 + 4]] : [])];
  w16(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    w16(tag, at); w16(type, at + 2); w32(count, at + 4);
    if (type === 3) w16(value, at + 8); else w32(value, at + 8);
  });
  const gpsIfd = 8 + 2 + 2 * 12 + 4;
  if (gps) {
    w16(1, gpsIfd);
    w16(0x0002, gpsIfd + 2); w16(5, gpsIfd + 4); w32(3, gpsIfd + 6); w32(gpsIfd + 18, gpsIfd + 10);
    for (let i = 0; i < 3; i++) { w32([48, 51, 30][i], gpsIfd + 18 + i * 8); w32(1, gpsIfd + 22 + i * 8); }
  }
  return out;
}

const XMP_GPS = latin1('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description exif:GPSLatitude="48,51.5N" exif:GPSLongitude="2,17.7E"/></x:xmpmeta>');
const XMP_PLAIN = latin1('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description xmp:CreatorTool="Camera"/></x:xmpmeta>');
const ICC = Buffer.concat([latin1('ICC_PROFILE\0'), Buffer.from([1, 1]), Buffer.alloc(40, 7)]);

const segment = (marker: number, payload: Buffer) => Buffer.concat([u16(0xff00 | marker), u16(payload.length + 2), payload]);
const exif = (block: Buffer) => segment(0xe1, Buffer.concat([latin1('Exif\0\0'), block]));
const JFIF = segment(0xe0, Buffer.concat([latin1('JFIF\0'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 0, 0])]));
const TABLES = Buffer.concat([segment(0xdb, Buffer.alloc(65, 2)), segment(0xc0, Buffer.from([8, 0, 16, 0, 16, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])), segment(0xc4, Buffer.alloc(30, 3))]);
const SCAN = Buffer.concat([segment(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])), Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78])]);
const EOI = Buffer.from([0xff, 0xd9]);
// What phones append after the picture: a preview JPEG, a motion photo's video.
const TRAILER = Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, EOI, latin1('ftypmp42 MotionPhoto_Data')]);

const SOI = Buffer.from([0xff, 0xd8]);
const JPEGS: Record<string, Buffer> = {
  // A phone's photo: JFIF, EXIF turned and placed, XMP with GPS, its colour profile, a multi-picture
  // index, IPTC, a comment, then the picture and a trailer.
  'phone.jpg': Buffer.concat([SOI, JFIF, exif(tiff(6, true)), segment(0xe1, XMP_GPS), segment(0xe2, ICC), segment(0xe2, Buffer.concat([latin1('MPF\0'), Buffer.alloc(20)])),
    segment(0xed, latin1('Photoshop 3.0\0IPTC')), segment(0xee, latin1('Adobe\0\x64\0\0\0\0\x01')), segment(0xfe, latin1('a comment')), TABLES, SCAN, EOI, TRAILER]),
  // Progressive: tables between scans hold bytes that look like an end marker.
  'progressive.jpg': Buffer.concat([SOI, exif(tiff(1, false, true)), TABLES, SCAN, segment(0xc4, Buffer.from([0xff, 0xd9, 0xff, 0xd9, 1, 2])), SCAN, EOI, latin1('maker trailer')]),
  // No JFIF: the orientation's EXIF comes first. Fill bytes before a marker.
  'turned.jpg': Buffer.concat([SOI, Buffer.from([0xff]), exif(tiff(8, false)), segment(0xe1, XMP_PLAIN), TABLES, SCAN, EOI]),
  // GPS in XMP alone, no orientation.
  'xmp.jpg': Buffer.concat([SOI, JFIF, segment(0xe1, XMP_GPS), TABLES, SCAN, EOI]),
  // Upright, its EXIF says so: nothing of it kept.
  'upright.jpg': Buffer.concat([SOI, JFIF, exif(tiff(1, true)), TABLES, SCAN, EOI]),
  // Cut before its picture: read without failing, never rewritten.
  'cut.jpg': Buffer.concat([SOI, JFIF, exif(tiff(3, true)), segment(0xdb, Buffer.alloc(65, 2))]).subarray(0, 60),
  // No end marker: everything after the scan is kept.
  'endless.jpg': Buffer.concat([SOI, JFIF, TABLES, SCAN, Buffer.from([1, 2, 3])])
};

const pngChunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([latin1(type), data]);
  return Buffer.concat([u32be(data.length), body, u32be(zlib.crc32(body))]);
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = pngChunk('IHDR', Buffer.from([0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0]));
const IDAT = pngChunk('IDAT', zlib.deflateSync(Buffer.alloc(16 * 49, 9)));
const IEND = pngChunk('IEND', Buffer.alloc(0));
const PNGS: Record<string, Buffer> = {
  'phone.png': Buffer.concat([PNG_SIGNATURE, IHDR, pngChunk('iCCP', latin1('icc\0\0profile')), pngChunk('eXIf', tiff(6, true)), pngChunk('tEXt', latin1('Comment\0hello')),
    pngChunk('iTXt', Buffer.concat([latin1('XML:com.adobe.xmp\0\0\0\0\0'), XMP_GPS])), IDAT, IDAT, pngChunk('tIME', Buffer.alloc(7, 1)), IEND]),
  'plain.png': Buffer.concat([PNG_SIGNATURE, IHDR, pngChunk('zTXt', latin1('Software\0\0x')), IDAT, IEND]),
  'cut.png': Buffer.concat([PNG_SIGNATURE, IHDR, pngChunk('eXIf', tiff(6, true)), IDAT]).subarray(0, 80)
};

const riffChunk = (type: string, data: Buffer) => Buffer.concat([latin1(type), u32le(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const riff = (...chunks: Buffer[]) => { const body = Buffer.concat([latin1('WEBP'), ...chunks]); return Buffer.concat([latin1('RIFF'), u32le(body.length), body]); };
const vp8x = (flags: number) => riffChunk('VP8X', Buffer.from([flags, 0, 0, 0, 15, 0, 0, 15, 0, 0]));
const VP8 = riffChunk('VP8 ', Buffer.alloc(31, 5));
const WEBPS: Record<string, Buffer> = {
  'phone.webp': riff(vp8x(0x20 | 0x08 | 0x04), riffChunk('ICCP', Buffer.alloc(21, 4)), VP8, riffChunk('EXIF', Buffer.concat([latin1('Exif\0\0'), tiff(6, true)])), riffChunk('XMP ', XMP_GPS)),
  'upright.webp': riff(vp8x(0x08), riffChunk('VP8L', Buffer.alloc(20, 6)), riffChunk('EXIF', tiff(1, true, true))),
  'simple.webp': riff(VP8, riffChunk('EXIF', tiff(6, false))),
  'simple-plain.webp': riff(VP8, riffChunk('XMP ', XMP_GPS)),
  'cut.webp': riff(vp8x(0x08), VP8, riffChunk('EXIF', tiff(6, true))).subarray(0, 40)
};

const box = (type: string, size: number) => { const b = Buffer.alloc(size); b.writeUInt32BE(size, 0); b.write(type, 4, 'latin1'); return b; };
const ftyp = (brand: string) => { const b = box('ftyp', 16); b.write(brand, 8, 'latin1'); return b; };
const largeMdat = () => { const b = Buffer.alloc(24); b.writeUInt32BE(1, 0); b.write('mdat', 4, 'latin1'); b.writeBigUInt64BE(24n, 8); return b; };
const MP4S: Record<string, Buffer> = {
  'fast.mp4': Buffer.concat([ftyp('isom'), box('moov', 40), box('mdat', 100)]),
  'slow.mov': Buffer.concat([ftyp('qt  '), box('free', 8), largeMdat(), box('moov', 40)]),
  'to-the-end.mp4': Buffer.concat([ftyp('mp42'), box('moov', 16), Buffer.concat([u32be(0), latin1('mdat'), Buffer.alloc(30)])]),
  'no-index.mp4': Buffer.concat([ftyp('M4A '), box('mdat', 20)]),
  'broken.mp4': Buffer.concat([ftyp('isom'), u32be(3), latin1('moov')])
};

const sha = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);

// What the desktop gave before its rules moved to the core: read, then rewritten (null: not
// rewritten, the caller re-encodes).
const EXPECTED: Record<string, { orientation: number | null; location: boolean; stripped: string | null }> = {
  'phone.jpg': { orientation: 6, location: true, stripped: '841a86e62fa0f3df' },
  'progressive.jpg': { orientation: 1, location: false, stripped: 'c5c0440153d18743' },
  'turned.jpg': { orientation: 8, location: false, stripped: '9e42c08f4cc5c5a2' },
  'xmp.jpg': { orientation: null, location: true, stripped: '533a492cf7652bc0' },
  'upright.jpg': { orientation: 1, location: true, stripped: '533a492cf7652bc0' },
  'cut.jpg': { orientation: null, location: false, stripped: null },
  'endless.jpg': { orientation: null, location: false, stripped: 'bd9b6b0df11ae4a2' },
  'phone.png': { orientation: 6, location: true, stripped: '2964fb3320ad2824' },
  'plain.png': { orientation: null, location: false, stripped: 'fe0ef01c06f883ff' },
  'cut.png': { orientation: null, location: false, stripped: null },
  'phone.webp': { orientation: 6, location: true, stripped: '050bb0cb86433b99' },
  'upright.webp': { orientation: 1, location: true, stripped: '134ba8e133acb715' },
  'simple.webp': { orientation: 6, location: false, stripped: null },
  'simple-plain.webp': { orientation: null, location: true, stripped: 'af037c07a4043b8d' },
  'cut.webp': { orientation: null, location: false, stripped: null }
};

const LAYOUTS: Record<string, unknown> = {
  'fast.mp4': { brand: 'isom', faststart: true, boxes: ['ftyp', 'moov', 'mdat'] },
  'slow.mov': { brand: 'qt  ', faststart: false, boxes: ['ftyp', 'free', 'mdat', 'moov'] },
  'to-the-end.mp4': { brand: 'mp42', faststart: true, boxes: ['ftyp', 'moov', 'mdat'] },
  'no-index.mp4': { brand: 'M4A ', faststart: null, boxes: ['ftyp', 'mdat'] },
  'broken.mp4': { brand: 'isom', faststart: null, boxes: ['ftyp'] }
};

const IMAGES = { ...JPEGS, ...PNGS, ...WEBPS };
const containerOf = (name: string) => name.endsWith('.jpg') ? 'jpeg' : name.endsWith('.png') ? 'png' : 'webp';

// As a browser writes it: the pieces joined, the ranges taken from the file's bytes.
const assemble = (bytes: Uint8Array, pieces: readonly BytePiece[]) =>
  concatBytes(pieces.map((p) => p instanceof Uint8Array ? p : bytes.subarray(p.position, p.position + p.length)));

test('image metadata: the desktop reads and rewrites as before its rules moved to the core', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-media-metadata-'));
  try {
    for (const [name, bytes] of Object.entries(IMAGES)) {
      const file = path.join(dir, name);
      const out = path.join(dir, `out-${name}`);
      fs.writeFileSync(file, bytes);
      const written = stripImageMetadata(file, out, containerOf(name));
      assert.deepEqual({ ...readImageMetadata(file, containerOf(name)), stripped: written ? sha(fs.readFileSync(out)) : null }, EXPECTED[name], name);
      if (!written) assert.equal(fs.existsSync(out), false, `${name}: nothing written`);
    }
    for (const [name, bytes] of Object.entries(MP4S)) {
      fs.writeFileSync(path.join(dir, name), bytes);
      assert.deepEqual(await readMp4Layout(path.join(dir, name)), LAYOUTS[name], name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('image metadata: a browser reads and rewrites the same bytes as the desktop', async () => {
  for (const [name, bytes] of Object.entries(IMAGES)) {
    const read = readSync(imageMetadataSteps(bytes.length, containerOf(name)), bytesReader(bytes));
    const pieces = readSync(strippedImageSteps(bytes.length, containerOf(name)), bytesReader(bytes));
    assert.deepEqual({ ...read, stripped: pieces ? sha(assemble(bytes, pieces)) : null }, EXPECTED[name], name);
    // From a File's slices, as the media Worker reads one.
    const blob = new Blob([new Uint8Array(bytes)]);
    const slices = async (position: number, length: number) => new Uint8Array(await blob.slice(position, position + length).arrayBuffer());
    const sliced = await readAsync(strippedImageSteps(bytes.length, containerOf(name)), slices);
    assert.equal(sliced && sha(assemble(bytes, sliced)), EXPECTED[name].stripped, name);
  }
  for (const [name, bytes] of Object.entries(MP4S)) assert.deepEqual(readSync(mp4LayoutSteps(bytes.length), bytesReader(bytes)), LAYOUTS[name], name);
});
