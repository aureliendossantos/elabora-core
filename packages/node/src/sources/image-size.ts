// The size in pixels of a PNG, JPEG, GIF or WebP, read from its header (docs/decisions.md D49), and
// which pictures a deck's readable version leaves out as too small to matter. No dependency; the size
// is null when the header is not one of these or is cut short.

// How many bytes of a picture are read to find its size: a JPEG may carry a large EXIF block before its
// frame.
export const HEADER_BYTES = 1024 * 1024;

export interface PixelSize { width: number; height: number }

// JPEG markers that carry the frame's size (SOF0 to SOF15, but not DHT, JPG and DAC).
const isFrame = (marker: number): boolean => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

export function imageSize(head: Buffer): PixelSize | null {
  if (head.length >= 24 && head.readUInt32BE(0) === 0x89504e47 && head.toString('ascii', 12, 16) === 'IHDR') {
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  }
  if (head.length >= 10 && (head.toString('ascii', 0, 6) === 'GIF87a' || head.toString('ascii', 0, 6) === 'GIF89a')) {
    return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
  }
  if (head.length >= 30 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    const kind = head.toString('ascii', 12, 16);
    if (kind === 'VP8 ' && head.readUInt16LE(23) === 0x019d && head[25] === 0x2a) return { width: head.readUInt16LE(26) & 0x3fff, height: head.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && head[20] === 0x2f) {
      const bits = head.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: head.readUIntLE(24, 3) + 1, height: head.readUIntLE(27, 3) + 1 };
    return null;
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= head.length) {
      if (head[at] !== 0xff) { at++; continue; }
      const marker = head[at + 1];
      if (marker === 0xff) { at++; continue; }
      // Markers without a length (restart, start and end of image, TEM), then the scan: no frame before it.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { if (marker === 0xd9) return null; at += 2; continue; }
      if (marker === 0xda) return null;
      const length = head.readUInt16BE(at + 2);
      if (isFrame(marker)) return at + 9 <= head.length ? { height: head.readUInt16BE(at + 5), width: head.readUInt16BE(at + 7) } : null;
      at += 2 + length;
    }
  }
  return null;
}

// The pictures a slide places that are left out of its readable version, because an agent that looks at
// them sees a dot or a line, not a picture. Three tests, each a size under which a picture shows nothing
// the text around it does not say:
//   · in pixels, no side over 32: an icon or a bullet (an agent looks at pictures shrunk to a few hundred
//     pixels; a 32 px square holds about as much as one letter of the slide's text);
//   · in pixels, a side under 8: a rule or a separator drawn as a picture, whatever its length;
//   · as placed on the slide, no side over 3% of its width (1 cm on a 33.9 cm slide, 48 px on the 1600 px
//     reference), or a side under 1% of its height (5 pt on a 7.5 in slide): a dot or a rule.
// They are set so as to cut only what is evidently a mark, and checked against real decks (D49): a
// wrong call costs a bullet, not a figure.
export const SMALL_PICTURE = { pixels: 32, hairlinePixels: 8, placedShare: 0.03, placedHairlineShare: 0.01 } as const;

export interface Placement { cx: number; cy: number; slideCx: number; slideCy: number }

// Why a picture is left out, or null when it matters. `placed` is the box it is shown in, in the units
// of the slide's size (EMU in a deck); null when it has no box of its own (the picture of a background).
export function smallPicture(pixels: PixelSize | null, placed: Placement | null): string | null {
  const { pixels: tiny, hairlinePixels, placedShare, placedHairlineShare } = SMALL_PICTURE;
  if (pixels) {
    if (Math.max(pixels.width, pixels.height) <= tiny) return `${pixels.width}×${pixels.height} px`;
    if (Math.min(pixels.width, pixels.height) < hairlinePixels) return `${pixels.width}×${pixels.height} px, a rule`;
  }
  if (placed && placed.cx > 0 && placed.cy > 0 && placed.slideCx > 0 && placed.slideCy > 0) {
    if (Math.max(placed.cx, placed.cy) / placed.slideCx <= placedShare) return 'a dot on the slide';
    if (Math.min(placed.cx, placed.cy) / placed.slideCy < placedHairlineShare) return 'a rule on the slide';
  }
  return null;
}
