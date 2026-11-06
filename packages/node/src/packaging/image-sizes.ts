import fs from 'node:fs';
import type { PictureSize } from '@elabora/core/render/image-sizes';
import { svgSize } from '@elabora/core/render/image-sizes';
import { HEADER_BYTES, imageSize } from '../sources/image-size.ts';

// The size a browser shows a packaged picture at, for the width and height the build writes on its
// <img> (core/render/image-sizes.ts): read from the file the package ships (a rendition is smaller
// than its master). A JPEG turned by its EXIF orientation shows with its sides swapped. A PNG or a
// WebP that carries EXIF data may be turned as well: the build leaves its size unwritten, as for any
// file whose header it does not read.

export function packagedPictureSize(path: string, { text, file }: { text?: Buffer; file?: string | null }): PictureSize | null {
  if (/\.svg$/i.test(path)) return text ? svgSize(text.toString('utf8')) : null;
  if (!/\.(png|jpe?g|gif|webp)$/i.test(path)) return null;
  const head = text ? text.subarray(0, HEADER_BYTES) : file ? readHead(file) : null;
  return head ? displayedSize(head) : null;
}

function readHead(file: string): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(HEADER_BYTES);
    return head.subarray(0, fs.readSync(fd, head, 0, HEADER_BYTES, 0));
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function displayedSize(head: Buffer): PictureSize | null {
  const size = imageSize(head);
  if (!size || !size.width || !size.height) return null;
  if (head[0] === 0xff && head[1] === 0xd8) {
    const orientation = jpegOrientation(head);
    return orientation !== null && orientation >= 5 && orientation <= 8 ? { width: size.height, height: size.width } : size;
  }
  if (head.readUInt32BE(0) === 0x89504e47 && pngHasExif(head)) return null;
  if (head.toString('ascii', 12, 16) === 'VP8X' && (head[20] & 0x08) !== 0) return null;
  return size;
}

// The orientation tag (0x0112) of a JPEG's EXIF block, or null without one.
function jpegOrientation(head: Buffer): number | null {
  let at = 2;
  while (at + 4 <= head.length && head[at] === 0xff) {
    const marker = head[at + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    const length = head.readUInt16BE(at + 2);
    if (marker === 0xe1 && head.toString('ascii', at + 4, at + 10) === 'Exif\0\0') return tiffOrientation(head.subarray(at + 10, at + 2 + length));
    at += 2 + length;
  }
  return null;
}

function tiffOrientation(tiff: Buffer): number | null {
  if (tiff.length < 8) return null;
  const little = tiff.toString('ascii', 0, 2) === 'II';
  const u16 = (at: number) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at: number) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return null;
}

// Whether a PNG has an eXIf chunk before its pixels.
function pngHasExif(head: Buffer): boolean {
  let at = 8;
  while (at + 8 <= head.length) {
    const type = head.toString('ascii', at + 4, at + 8);
    if (type === 'eXIf') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    at += 12 + head.readUInt32BE(at);
  }
  return false;
}
