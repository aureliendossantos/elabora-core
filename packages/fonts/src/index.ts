import catalogue from '../catalogue.json' with { type: 'json' };

// The vetted fonts of Elabora: free fonts (SIL OFL 1.1 or Apache 2.0) that courses embed, as WOFF2
// files of the latin and latin-ext subsets next to their licence, in files/<id>/ of this package,
// so they are there without network access. The catalogue is data for the CLI, the MCP server and the desktop
// app: family, category, weights, styles, licence, where each file came from, preview texts.
// `npm run fonts` writes it from sources.json (README.md). No Node API here: the app's renderer
// imports this module; Node code finds the files from the package folder (@elabora/node fonts/).

export type FontCategory = 'serif' | 'sans-serif' | 'monospace' | 'display' | 'handwriting';
export type FontStyle = 'normal' | 'italic';
export type FontHash = `sha256:${string}`;

export interface FontFile {
  path: string; // in this package: files/<id>/<name>.woff2
  subset: string; // the characters it holds: latin, latin-ext (Fontsource's names)
  unicodeRange: string; // the same as a CSS unicode-range, from the package's unicode.json
  weight: string; // the @font-face weight: "400", or the range of a variable file ("100 900")
  style: FontStyle;
  bytes: number;
  hash: FontHash;
}

export interface FontLicense {
  id: 'OFL-1.1' | 'Apache-2.0';
  path: string; // files/<id>/OFL.txt (or LICENSE.txt), with the copyright line of the font
  bytes: number;
  hash: FontHash;
  copyright: string;
  url: string;
}

export interface FontFamily {
  id: string; // the folder of its files, here and in courses (theme/fonts/<id>/)
  family: string; // the CSS family name
  category: FontCategory;
  style: string; // its classification: old-style, humanist, geometric, blackletter…
  use: string; // one line: what it is good for
  stack: string; // CSS font stack with fallbacks, for font.body, font.heading or a custom token
  for: string[]; // the tokens `elabora font add` sets by default: body, heading, mono, display
  pairs: string[]; // families of the catalogue it pairs with
  specimen: Record<string, string>; // a short line to show it, by language (en, fr)
  variable: boolean; // one file per style covers every weight
  weights: number[]; // the weights the files cover
  styles: FontStyle[];
  subsets: string[]; // the subsets of its files (every family has latin)
  files: FontFile[]; // by weight and style, each in its subsets (latin, then latin-ext)
  license: FontLicense;
  bytes: number; // the files and the licence
  source: {
    package: string; // npm package (Fontsource) the files were taken from
    version: string;
    tarball: string;
    integrity: string; // of the tarball, as the npm registry gives it
    page: string;
    upstream: string; // where Fontsource takes the font from
    fontVersion: string; // version of the font upstream
    lastModified: string;
  };
}

// A subset of the characters of a font, as Fontsource and Google Fonts split them: latin (Western
// European languages), latin-ext (Central European, Baltic, Romanian, Turkish…).
export interface FontSubset {
  name: string;
  // Primary language subtags written with the subsets up to this one: the languages of latin need
  // latin alone, those of latin-ext need latin and latin-ext.
  languages: string[];
}

export interface FontCatalogue {
  format: 'elabora-fonts/2';
  subsets: FontSubset[]; // in the order of the files of a face
  pangrams: Record<string, string>; // by language: the player's languages and some of latin-ext, accents included
  bytes: number;
  families: FontFamily[];
}

export const FONT_CATALOGUE = catalogue as FontCatalogue;
export const FONTS: readonly FontFamily[] = FONT_CATALOGUE.families;

const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

// A family by its name or its id, whatever the case, spaces and hyphens: "EB Garamond",
// "eb-garamond" and "ebgaramond" are the same family.
export function findFont(name: string): FontFamily | undefined {
  const wanted = key(name);
  return FONTS.find((font) => key(font.family) === wanted || key(font.id) === wanted);
}

// The subsets whose files write a language (a BCP 47 tag: "fr", "pl", "pt-BR"): ["latin"],
// ["latin", "latin-ext"], or null when the vetted subsets do not write it ("ru", "ja").
export function languageSubsets(language: string): string[] | null {
  const primary = language.toLowerCase().split(/[-_]/)[0];
  const index = FONT_CATALOGUE.subsets.findIndex((subset) => subset.languages.includes(primary));
  return index < 0 ? null : FONT_CATALOGUE.subsets.slice(0, index + 1).map((subset) => subset.name);
}

// The subsets each language needs, by primary subtag, for those the vetted subsets write.
export function subsetsByLanguage(): Record<string, string[]> {
  const table: Record<string, string[]> = {};
  FONT_CATALOGUE.subsets.forEach((subset, index) => {
    for (const language of subset.languages) table[language] = FONT_CATALOGUE.subsets.slice(0, index + 1).map((before) => before.name);
  });
  return table;
}

// Whether the vetted subsets write a language.
export const coversLanguage = (language: string): boolean => languageSubsets(language) !== null;

// The weight range of a file ("400" or "100 900").
export function weightRange(weight: string): [number, number] {
  const [low, high = low] = weight.split(' ').map(Number);
  return [low, high];
}

export interface FontSelection {
  weights?: readonly number[]; // static families: the files to take; variable ones: checked against the range
  styles?: readonly FontStyle[];
  subsets?: readonly string[]; // default: every subset of the family
}

// The files of a family for the weights, styles and subsets asked (everything vetted by default). A
// static family has one file per weight, style and subset; a variable file covers its whole range,
// so weights only have to fall within it.
export function selectFontFiles(font: FontFamily, { weights, styles, subsets }: FontSelection = {}): { files: FontFile[] } | { error: string } {
  const missingStyle = (styles ?? []).find((style) => !font.styles.includes(style));
  if (missingStyle) return { error: `${font.family} has no ${missingStyle} style in the vetted files (${font.styles.join(', ')}).` };
  const missingSubset = (subsets ?? []).find((subset) => !font.subsets.includes(subset));
  if (missingSubset) return { error: `${font.family} has no ${missingSubset} files in the vetted list (${font.subsets.join(', ')}).` };
  const files = font.files.filter((file) => (!styles?.length || styles.includes(file.style)) && (!subsets?.length || subsets.includes(file.subset)));
  if (!weights?.length) return { files };
  if (font.variable) {
    const [low, high] = weightRange(files[0].weight);
    const outside = weights.filter((weight) => weight < low || weight > high);
    if (outside.length) return { error: `${font.family} covers the weights ${low} to ${high}: ${outside.join(', ')} is outside.` };
    return { files };
  }
  const shipped = (style: FontStyle) => [...new Set(files.filter((file) => file.style === style).map((file) => Number(file.weight)))];
  const missing = weights.filter((weight) => !files.some((file) => Number(file.weight) === weight));
  if (missing.length) {
    const offered = font.styles.map((style) => `${style} ${shipped(style).join(', ')}`).filter((line) => !line.endsWith(' ')).join('; ');
    return { error: `${font.family} is vetted at the weights ${offered}: ${missing.join(', ')} is not among them.` };
  }
  return { files: files.filter((file) => weights.includes(Number(file.weight))) };
}
