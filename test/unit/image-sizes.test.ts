import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeImages, svgSize } from '@elabora/core/render/image-sizes';
import { displayedSize } from '@elabora/node/packaging/image-sizes';

// The width and height the build writes on each <img> (core/render/image-sizes.ts), from the file
// the package ships (node/packaging/image-sizes.ts).

test('sizeImages writes the size of each known picture on its <img>, and leaves the others as they are', () => {
  const sizes: Record<string, { width: number; height: number }> = { 'assets/a.png': { width: 1200, height: 800 }, 'assets/b & c.svg': { width: 10, height: 20 } };
  const sizeOf = (src: string) => sizes[src] ?? null;
  assert.equal(sizeImages('<p><img src="assets/a.png" alt="A" loading="lazy"></p>', sizeOf), '<p><img width="1200" height="800" src="assets/a.png" alt="A" loading="lazy"></p>');
  assert.equal(sizeImages('<img class="x" src="assets/b &amp; c.svg" alt="">', sizeOf), '<img width="10" height="20" class="x" src="assets/b &amp; c.svg" alt="">', 'the address is read decoded');
  assert.equal(sizeImages('<img src="assets/a.png" width="40">', sizeOf), '<img src="assets/a.png" width="40">', 'a size given by the component stays');
  assert.equal(sizeImages('<img src="assets/unknown.png" data-width="3">', sizeOf), '<img src="assets/unknown.png" data-width="3">');
  assert.equal(sizeImages('no picture', sizeOf), 'no picture');
});

test('svgSize reads the width and height an SVG declares in pixels, none from a viewBox alone', () => {
  assert.deepEqual(svgSize('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 260" width="760" height="260">'), { width: 760, height: 260 });
  assert.deepEqual(svgSize('<svg width="12.5px" height=\'30\' stroke-width="2">'), { width: 12.5, height: 30 });
  assert.equal(svgSize('<svg viewBox="0 0 10 10">'), null);
  assert.equal(svgSize('<svg width="100%" height="200">'), null);
  assert.equal(svgSize('<svg width="10em" height="20em">'), null);
});

// A JPEG header: SOI, an optional EXIF block with the orientation tag, then a frame of width × height.
function jpeg(width: number, height: number, orientation?: number): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (orientation !== undefined) {
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'ascii'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8); // one entry
    tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
    const head = Buffer.from([0xff, 0xe1, 0, 0]); head.writeUInt16BE(body.length + 2, 2);
    parts.push(head, body);
  }
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  frame.writeUInt16BE(height, 5); frame.writeUInt16BE(width, 7);
  parts.push(frame, Buffer.from([0xff, 0xda]));
  return Buffer.concat(parts);
}

test('displayedSize: a JPEG turned by its EXIF orientation shows with its sides swapped', () => {
  assert.deepEqual(displayedSize(jpeg(4000, 3000)), { width: 4000, height: 3000 });
  assert.deepEqual(displayedSize(jpeg(4000, 3000, 1)), { width: 4000, height: 3000 });
  assert.deepEqual(displayedSize(jpeg(4000, 3000, 3)), { width: 4000, height: 3000 });
  assert.deepEqual(displayedSize(jpeg(4000, 3000, 6)), { width: 3000, height: 4000 });
  assert.deepEqual(displayedSize(jpeg(4000, 3000, 8)), { width: 3000, height: 4000 });
  assert.equal(displayedSize(Buffer.from('not a picture')), null);
});
