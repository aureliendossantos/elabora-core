import { dirname } from '../util/paths.ts';

// Font files and their licences. A free font licence (SIL OFL, Apache) lets a course embed the font
// when its text travels with it: a licence file in the same folder as the font, which the build
// copies into the package next to it. `elabora font add` writes theme/fonts/<id>/ that way.

export const isFontPath = (path: string): boolean => /\.(woff2?|ttf|otf)$/i.test(path);

// OFL.txt, OFL-eb-garamond.txt, LICENSE, LICENSE.md, licence.txt, UFL.txt, EULA.txt, COPYING…
export const isLicensePath = (path: string): boolean => /^(ofl|ufl|eula|licen[cs]e|copying|copyright)([-_. ][^/]*)?$/i.test(path.slice(path.lastIndexOf('/') + 1));

// The licence files in the folder of a font, sorted.
export function fontLicenses(paths: Iterable<string>, font: string): string[] {
  const folder = dirname(font);
  const found: string[] = [];
  for (const path of paths) if (dirname(path) === folder && isLicensePath(path) && !isFontPath(path)) found.push(path);
  return found.sort();
}
