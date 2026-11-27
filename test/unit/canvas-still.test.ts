import { test } from 'node:test';
import assert from 'node:assert/strict';
import { animated } from '@elabora/player/canvas-still';

// A miniature holds still a picture that moves by itself (D130); which ones do is read from a few of their bytes.
const bytes = (text: string) => [...text].map((c) => c.charCodeAt(0));
const png = (chunks: string[]) => new Uint8Array([0x89, ...bytes('PNG'), 13, 10, 26, 10, ...chunks.flatMap((type) => [0, 0, 0, 0, ...bytes(type), 0, 0, 0, 0])]);
const webp = (flags: number) => new Uint8Array([...bytes('RIFF'), 0, 0, 0, 0, ...bytes('WEBPVP8X'), 10, 0, 0, 0, flags, 0, 0, 0]);
const svg = (body: string) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`);

test('a picture that moves by itself is known by its bytes: an APNG, an animated WebP, an SVG with SMIL or a CSS animation; a still one is not', () => {
  assert.equal(animated(png(['IHDR', 'acTL', 'IDAT'])), true, 'an APNG');
  assert.equal(animated(png(['IHDR', 'IDAT', 'IEND'])), false, 'a PNG');
  assert.equal(animated(webp(0x02)), true, 'an animated WebP');
  assert.equal(animated(webp(0x10)), false, 'a WebP with alpha');
  assert.equal(animated(svg('<circle><animate attributeName="r" dur="1s"/></circle>')), true, 'SMIL');
  assert.equal(animated(svg('<style>@keyframes turn { to { rotate: 1turn } }</style>')), true, 'a CSS animation');
  assert.equal(animated(svg('<circle r="2"/>')), false, 'a still SVG');
  assert.equal(animated(new Uint8Array(0)), false, 'nothing read');
});
