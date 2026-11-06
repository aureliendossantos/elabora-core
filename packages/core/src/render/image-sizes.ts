import { decodeEntities } from '../import/xml.ts';

// The size of each picture a page shows, written on its <img> by the build (width and height, in the
// picture's own pixels). The page keeps the picture's room before it arrives, so nothing moves when it
// does; and the browser's lazy loading sees where each picture really is, so it loads the pictures near
// the window first and the others as the learner comes to them. Without the sizes, every picture is
// empty at first, the page is short, and the browser finds them all near the window.
//
// Only an <img> without width or height takes them: a component that sizes its pictures keeps its own.
// The sized ones are marked data-t-sized: the player's stylesheet keeps their height following the
// width (`height: auto`), so a picture that the page narrows keeps its proportions.

export interface PictureSize { width: number; height: number }

export function sizeImages(html: string, sizeOf: (src: string) => PictureSize | null): string {
  if (!html.includes('<img')) return html;
  return html.replace(/<img\b[^>]*>/g, (img) => {
    // The attribute names only: a text alternative may say "width=".
    if (/\s(width|height)\s*=/i.test(img.replace(/"[^"]*"|'[^']*'/g, '""'))) return img;
    const src = /\ssrc="([^"]*)"/.exec(img);
    const size = src ? sizeOf(decodeEntities(src[1])) : null;
    return size ? img.replace(/^<img\b/, `<img width="${size.width}" height="${size.height}" data-t-sized`) : img;
  });
}

// The size an SVG declares on its root: width and height in pixels (or without a unit). A drawing sized
// by its viewBox alone has none: the page sizes it, and the build leaves it as it is.
export function svgSize(source: string): PictureSize | null {
  const root = /<svg\b[^>]*>/i.exec(source)?.[0];
  if (!root) return null;
  const length = (name: string) => {
    const found = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9]*\\.?[0-9]+)\\s*(px)?\\s*["']`, 'i').exec(root);
    const value = found ? Number(found[1]) : NaN;
    return value > 0 && Number.isFinite(value) ? value : null;
  };
  const width = length('width');
  const height = length('height');
  return width && height ? { width, height } : null;
}
