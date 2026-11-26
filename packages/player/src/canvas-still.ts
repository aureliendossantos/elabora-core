// A miniature at rest does no work (mode=thumb, D130). The page's style already stops CSS transitions and animations, and the player
// runs none of its own loops for a still screen; what neither reaches is stopped here once a screen is drawn: an animation whose rule
// wins over the page's (an author's `!important` more specific than it) or one started by script, an SVG's SMIL animations
// (`<animate>`, kept in inline SVG), and an animated GIF, drawn once on a canvas and shown as that image. An animated PNG or WebP,
// and an SVG with SMIL shown by an <img>, still move: rarer, and a browser gives no way to tell or stop them that costs nothing.

export function holdStill(root: Document = document): void {
  for (const animation of root.getAnimations?.() ?? []) animation.pause();
  for (const svg of root.querySelectorAll('svg')) if (svg instanceof SVGSVGElement && !svg.animationsPaused()) svg.pauseAnimations();
  for (const image of root.querySelectorAll('img')) {
    if (!image.complete || !image.naturalWidth || !/\.gif(?:$|[?#])|^data:image\/gif[;,]/i.test(image.currentSrc || image.src)) continue;
    try {
      const canvas = root.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d')?.drawImage(image, 0, 0);
      image.src = canvas.toDataURL('image/png');
    } catch {
      // A picture of another origin cannot be read back: it stays as it is.
    }
  }
}
