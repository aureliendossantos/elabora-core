// A miniature at rest does no work (mode=thumb, D130). The page's style already stops CSS transitions and animations, and the player
// runs none of its own loops for a still screen; what neither reaches is stopped here once a screen is drawn: an animation whose rule
// wins over the page's (an author's `!important` more specific than it) or one started by script, an SVG's SMIL animations
// (`<animate>`, kept in inline SVG), and a picture that moves by itself: a GIF, an animated PNG or WebP, an SVG that animates shown by
// an <img>. Such a picture is drawn once on a canvas and shown as that image. A GIF is known by its name; the others by a few of their
// bytes (an APNG's acTL chunk before its first IDAT, a WebP's animation flag, an SVG's <animate>, <set> or CSS animation), read from
// the module's files the page already has.

export function holdStill(root: Document = document): void {
  for (const animation of root.getAnimations?.() ?? []) animation.pause();
  for (const svg of root.querySelectorAll('svg')) if (svg instanceof SVGSVGElement && !svg.animationsPaused()) svg.pauseAnimations();
  for (const image of root.querySelectorAll('img')) {
    if (!image.complete || !image.naturalWidth || image.dataset.tStill !== undefined) continue;
    const source = image.currentSrc || image.src;
    if (/\.gif(?:$|[?#])|^data:image\/gif[;,]/i.test(source)) still(image);
    else if (/\.(?:png|apng|webp|svg)(?:$|[?#])/i.test(source)) void moves(source).then((moving) => { if (moving && (image.currentSrc || image.src) === source) still(image); }, () => {});
  }
}

// Shown as the image it shows now. A picture of another origin cannot be read back: it stays as it is.
function still(image: HTMLImageElement): void {
  try {
    const canvas = image.ownerDocument.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    image.src = canvas.toDataURL('image/png');
    image.dataset.tStill = '';
  } catch {
    // As it is.
  }
}

// Whether a PNG, a WebP or an SVG moves by itself, from its bytes; false when they cannot be read.
const known = new Map<string, Promise<boolean>>();
function moves(source: string): Promise<boolean> {
  let answer = known.get(source);
  if (!answer) {
    answer = fetch(source).then((response) => (response.ok ? response.arrayBuffer() : new ArrayBuffer(0))).then((buffer) => animated(new Uint8Array(buffer))).catch(() => false);
    known.set(source, answer);
  }
  return answer;
}
export function animated(bytes: Uint8Array): boolean {
  const ascii = (at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
  // PNG: chunks after the 8-byte signature; an acTL before the first IDAT makes it an APNG.
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
    for (let at = 8; at + 8 <= bytes.length;) {
      const length = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
      const type = ascii(at + 4, 4);
      if (type === 'acTL') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      at += 12 + length;
    }
    return false;
  }
  // WebP: RIFF, WEBP, then a VP8X chunk whose flags carry the animation bit.
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return ascii(12, 4) === 'VP8X' && ((bytes[20] ?? 0) & 0x02) !== 0;
  // SVG: SMIL, or a CSS animation in its own style.
  const text = new TextDecoder().decode(bytes.subarray(0, 1 << 20));
  return /<svg[\s>]/i.test(text) && /<(?:animate|animateTransform|animateMotion|set)[\s>/]|@keyframes|animation\s*:/i.test(text);
}
