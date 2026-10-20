import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONTS, FONT_CATALOGUE, findFont, selectFontFiles, coversLanguage, languageSubsets, subsetsByLanguage, type FontFamily, type FontStyle } from '@elabora/fonts';
import { binaryFile, textFile } from '@elabora/core/project/files';
import { isLicensePath } from '@elabora/core/project/fonts';
import { CommandError, type FontFace, type FontRequest, type FontSource } from '@elabora/core/commands/index';
import { hashBytes } from '../blobs.ts';
import { readTar } from '../util/tar.ts';
import { readFontInfo, FontFileError } from './font-info.ts';

// Where the fonts a course embeds come from (`elabora font add`, MCP elabora_add_font, the app):
// - the vetted fonts of @elabora/fonts, shipped with Elabora, so they are there offline;
// - a Fontsource package (npm @fontsource/<id> or @fontsource-variable/<id>), as a folder
//   (node_modules/…) or as the tarball of `npm pack`: its files of the subsets asked (latin and
//   latin-ext by default) with their unicode ranges (unicode.json), and its LICENSE;
// - local WOFF2 or WOFF files with their licence file.
// Each gives the core command addFont a FontSource, and the bytes of its files by hash (the change
// brings them into the project's blob store, so undo can restore them). The command keeps the
// subsets the languages of the course need.

export { FONTS, FONT_CATALOGUE, findFont, coversLanguage, languageSubsets };
export type { FontFamily, FontStyle, FontRequest };
export { readFontInfo, type FontInfo } from './font-info.ts';

// The folder of @elabora/fonts: files/<id>/… of the catalogue are relative to it.
export const FONTS_DIR = path.dirname(fileURLToPath(import.meta.resolve('@elabora/fonts/package.json')));

export interface ResolvedFont {
  source: FontSource;
  sources: Map<string, Uint8Array | string>; // bytes of the font files by hash: a path, or the bytes
  origin: string; // where it came from, in words
  notes: string[];
}

const LICENSE_FILE: Record<string, string> = { 'OFL-1.1': 'OFL.txt' };
const FALLBACKS: Record<string, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  'sans-serif': 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  monospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  display: 'system-ui, sans-serif',
  handwriting: 'cursive'
};
const TOKENS: Record<string, string[]> = { serif: ['body', 'heading'], 'sans-serif': ['body', 'heading'], monospace: ['mono'], display: ['display'], handwriting: ['display'] };

export function resolveFont(request: FontRequest): ResolvedFont {
  if (request.from && request.files?.length) throw new CommandError('Give either from (a Fontsource package) or files (local font files), not both.');
  if (request.from) return fontsourceFont(request.from, request);
  if (request.files?.length && request.subsets?.length) throw new CommandError('subsets name the files of a vetted font or of a Fontsource package (from): local files are embedded whole.');
  if (request.files?.length) return localFont(request.files, request);
  if (!request.family) throw new CommandError('Name a vetted family (elabora font list), or give a Fontsource package (from) or font files with their licence (files, license).');
  const font = findFont(request.family);
  if (!font) {
    const near = FONTS.filter((f) => f.family.toLowerCase().includes(request.family!.toLowerCase().split(/\s+/)[0])).map((f) => f.family);
    throw new CommandError(`"${request.family}" is not a vetted font${near.length ? ` (did you mean ${near.join(', ')}?)` : ''}. elabora font list shows them; for another font, take its Fontsource package (npm pack @fontsource-variable/<id>, then from) or its files with their licence (files, license).`);
  }
  return vettedFont(font, request);
}

function vettedFont(font: FontFamily, request: FontRequest): ResolvedFont {
  const selection = selectFontFiles(font, { weights: request.weights, styles: request.styles, subsets: request.subsets });
  if ('error' in selection) {
    const subsetMissing = request.subsets?.some((subset) => !font.subsets.includes(subset));
    throw new CommandError(`${selection.error}${font.variable || subsetMissing ? '' : ` Other weights: from ${font.source.package} (npm pack ${font.source.package}, then from).`}`);
  }
  const sources = new Map<string, Uint8Array | string>();
  const faces: FontFace[] = selection.files.map((file) => {
    sources.set(file.hash, path.join(FONTS_DIR, file.path));
    return { name: path.posix.basename(file.path), weight: file.weight, style: file.style, subset: file.subset, unicodeRange: file.unicodeRange, file: binaryFile(file.bytes, { hash: file.hash }) };
  });
  const notes = font.variable && request.weights?.length ? [`${font.family} is variable: one file per style covers the weights ${font.files[0].weight}.`] : [];
  return {
    source: {
      family: font.family, folder: font.id, stack: font.stack, faces, subsets: font.subsets, for: font.for, languages: subsetsByLanguage(),
      license: { name: path.posix.basename(font.license.path), file: textFile(fs.readFileSync(path.join(FONTS_DIR, font.license.path), 'utf8')), id: font.license.id }
    },
    sources, origin: `vetted, from ${font.source.package}@${font.source.version}`, notes
  };
}

interface FontsourceMetadata {
  id?: string;
  family?: string;
  category?: string;
  subsets?: string[];
  weights?: number[];
  styles?: string[];
  variable?: Record<string, { min: string; max: string }> | false;
  license?: { type?: string };
}

// A Fontsource package: metadata.json, LICENSE and files/<id>-<subset>-<weight|axes>-<style>.woff2.
function fontsourceFont(from: string, request: FontRequest): ResolvedFont {
  const location = path.resolve(from);
  if (!fs.existsSync(location)) throw new CommandError(`${from} not found: give the folder of a Fontsource package (node_modules/@fontsource-variable/<id>) or the .tgz that npm pack wrote.`);
  const files = new Map<string, Buffer>();
  const read = (name: string): Buffer | undefined => files.get(name) ?? (fs.statSync(location).isDirectory() && fs.existsSync(path.join(location, name)) ? fs.readFileSync(path.join(location, name)) : undefined);
  if (fs.statSync(location).isFile()) {
    try {
      for (const [name, bytes] of readTar(fs.readFileSync(location))) files.set(name.replace(/^[^/]+\//, ''), bytes);
    } catch (error) {
      throw new CommandError(`${from} is not an npm package tarball: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const metaBytes = read('metadata.json');
  if (!metaBytes) throw new CommandError(`${from} is not a Fontsource package: no metadata.json.`);
  const meta = JSON.parse(metaBytes.toString('utf8')) as FontsourceMetadata;
  const license = read('LICENSE') ?? read('LICENSE.txt') ?? read('OFL.txt');
  if (!license) throw new CommandError(`${from} has no LICENSE: Elabora embeds a font only with its licence.`);
  if (!meta.id || !meta.family) throw new CommandError(`${from}: metadata.json names no font.`);
  // The subsets to read: those asked, or latin and latin-ext (the command keeps what the languages
  // of the course need), each with its range from unicode.json.
  const offered = meta.subsets ?? [];
  const ranges = parseRanges(read('unicode.json'));
  for (const subset of request.subsets ?? []) if (!offered.includes(subset)) throw new CommandError(`${meta.family} has no ${subset} subset in its Fontsource package (${offered.join(', ')}).`);
  const subsets = request.subsets?.length ? request.subsets : ['latin', 'latin-ext'].filter((subset) => offered.includes(subset));
  if (!subsets.length) throw new CommandError(`${meta.family} has no latin subset in its Fontsource package (${offered.join(', ')}): name the subsets to embed (subsets), or take font files that hold the letters of the course (files, license).`);
  // Large scripts (Japanese, Chinese, Korean) are split by Fontsource into numbered slices ([0],
  // [1]…), a hundred files that course.json cannot declare.
  const sliced = subsets.filter((subset) => !ranges[subset] && Object.keys(ranges).some((key) => /^\[\d+\]$/.test(key)));
  if (sliced.length) throw new CommandError(`${meta.family} splits its ${sliced.join(', ')} letters into numbered slices (${Object.keys(ranges).filter((key) => /^\[\d+\]$/.test(key)).length} files): course.json cannot declare them all. Take a font file that holds the letters of the course (files, license).`);
  const listed = (name: string) => files.has(`files/${name}`) || (fs.statSync(location).isDirectory() && fs.existsSync(path.join(location, 'files', name)));
  const styles = (['normal', 'italic'] as const).filter((style) => (request.styles?.length ? request.styles : (meta.styles ?? ['normal'])).includes(style));
  for (const style of request.styles ?? []) if (!meta.styles?.includes(style)) throw new CommandError(`${meta.family} has no ${style} style (${(meta.styles ?? []).join(', ')}).`);
  const wght = meta.variable ? meta.variable.wght : undefined;
  const notes: string[] = [];
  let picked: { name: string; weight: string; style: FontStyle; subset: string; unicodeRange?: string }[];
  const range = (subset: string) => (ranges[subset] ? { unicodeRange: ranges[subset] } : {});
  if (wght) {
    const [low, high] = [Math.max(100, Number(wght.min)), Math.min(900, Number(wght.max))];
    const outside = (request.weights ?? []).filter((weight) => weight < low || weight > high);
    if (outside.length) throw new CommandError(`${meta.family} covers the weights ${low} to ${high}: ${outside.join(', ')} is outside.`);
    // The weight axis alone is the lightest file; then every standard axis, then all of them.
    picked = styles.flatMap((style) => subsets.map((subset) => {
      const name = ['wght', 'standard', 'full'].map((axes) => `${meta.id}-${subset}-${axes}-${style}.woff2`).find(listed);
      return { name: name ?? `${meta.id}-${subset}-wght-${style}.woff2`, weight: `${low} ${high}`, style, subset, ...range(subset) };
    }));
  } else {
    const available = meta.weights ?? [];
    const weights = request.weights?.length ? request.weights : available.filter((weight) => weight === 400 || weight === 700);
    const chosen = weights.length ? weights : available.slice(0, 1);
    if (!request.weights?.length) notes.push(`${meta.family} is static: took the weights ${chosen.join(', ')} (others with weights: ${available.join(', ')}).`);
    picked = styles.flatMap((style) => chosen.flatMap((weight) => subsets.map((subset) => ({ name: `${meta.id}-${subset}-${weight}-${style}.woff2`, weight: String(weight), style, subset, ...range(subset) }))));
  }
  // latin-ext read by default is left out where the package lacks some of its files (the command
  // then says so if the course needs it); files of the subsets asked, and of latin, are required.
  const lacking = new Set(picked.filter((face) => !listed(face.name)).map((face) => face.subset));
  const usable = !request.subsets?.length && lacking.has('latin-ext') && !lacking.has('latin') ? offered.filter((subset) => subset !== 'latin-ext') : offered;
  picked = picked.filter((face) => usable.includes(face.subset));
  const missing = picked.filter((face) => !listed(face.name));
  if (missing.length) throw new CommandError(`${from} has no ${missing.map((face) => face.name).join(', ')}.`);
  const sources = new Map<string, Uint8Array | string>();
  const faces = picked.map((face): FontFace => {
    const bytes = read(`files/${face.name}`)!;
    const hash = hashBytes(bytes);
    sources.set(hash, bytes);
    return { ...face, file: binaryFile(bytes.length, { hash }) };
  });
  const licenseText = license.toString('utf8');
  const licenseId = meta.license?.type ?? recogniseLicense(licenseText);
  if (!isFreeLicense(licenseId)) notes.push(`Licence ${licenseId ?? 'not recognised'}: check that it allows embedding the font in course packages.`);
  const category = meta.category && FALLBACKS[meta.category] ? meta.category : 'sans-serif';
  const family = request.family ?? meta.family;
  return {
    source: { family, folder: slug(family), stack: `"${family}", ${FALLBACKS[category]}`, faces, subsets: usable, for: TOKENS[category], languages: subsetsByLanguage(), license: { name: LICENSE_FILE[licenseId ?? ''] ?? 'LICENSE.txt', file: textFile(licenseText), id: licenseId } },
    sources, origin: `Fontsource package ${meta.id}`, notes
  };
}

// unicode.json of a Fontsource package: the unicode range of each subset (and of the numbered
// slices of large scripts). Older packages have none: their files are then taken one subset at a time.
function parseRanges(bytes: Buffer | undefined): Record<string, string> {
  if (!bytes) return {};
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

// Local font files of one family, with the licence file given next to them.
function localFont(paths: string[], request: FontRequest): ResolvedFont {
  if (!request.license) throw new CommandError('A font needs its licence: give its licence file (license: OFL.txt, LICENSE…). Free fonts ship one; check that it allows embedding the font in course packages.');
  const licensePath = path.resolve(request.license);
  if (!fs.existsSync(licensePath) || !fs.statSync(licensePath).isFile()) throw new CommandError(`Licence file ${request.license} not found.`);
  const sources = new Map<string, Uint8Array | string>();
  const notes: string[] = [];
  const read = paths.map((file) => {
    const location = path.resolve(file);
    if (!fs.existsSync(location)) throw new CommandError(`${file} not found.`);
    if (!/\.(woff2|woff)$/i.test(location)) throw new CommandError(`${file}: courses embed WOFF2 (or WOFF) files. Convert it (fonttools ttLib.woff2 compress ${path.basename(file)}), or take the WOFF2 files of its Fontsource package (from).`);
    const bytes = fs.readFileSync(location);
    let info;
    try {
      info = readFontInfo(bytes);
    } catch (error) {
      throw new CommandError(`${file}: ${error instanceof FontFileError ? error.message : String(error)}`);
    }
    return { location, bytes, info };
  });
  const families = [...new Set(read.map(({ info }) => info.family).filter((family): family is string => !!family))];
  const family = request.family ?? families[0];
  if (!family) throw new CommandError('The font files name no family: give it (family).');
  if (!request.family && families.length > 1) throw new CommandError(`The files are of several families (${families.join(', ')}): add them one family at a time, or name the family to declare (family).`);
  const faces = read.map(({ location, bytes, info }): FontFace => {
    const hash = hashBytes(bytes);
    sources.set(hash, location);
    return { name: path.basename(location).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-'), weight: info.weight, style: info.style, file: binaryFile(bytes.length, { hash }) };
  });
  const duplicate = faces.find((face, i) => faces.findIndex((other) => other.weight === face.weight && other.style === face.style) !== i);
  if (duplicate) throw new CommandError(`Two files are the ${duplicate.style} face at weight ${duplicate.weight}: keep one.`);
  const licenseText = fs.readFileSync(licensePath, 'utf8');
  const licenseId = recogniseLicense(licenseText);
  if (!isFreeLicense(licenseId)) notes.push(`Licence ${licenseId ?? 'not recognised'}: check that it allows embedding the font in course packages.`);
  const category = read.map(({ info }) => info.category).find((found) => found !== null) ?? null;
  if (!category) notes.push(`The files do not say whether ${family} is a serif or a sans: its stack falls back to the system sans-serif; adjust the token in course.json if needed.`);
  return {
    source: { family, folder: slug(family), stack: `"${family}", ${FALLBACKS[category ?? 'sans-serif']}`, faces, for: TOKENS[category ?? 'sans-serif'], languages: null, license: { name: LICENSE_FILE[licenseId ?? ''] ?? (isLicensePath(path.basename(licensePath)) && /\.(txt|md)$/i.test(licensePath) ? path.basename(licensePath) : 'LICENSE.txt'), file: textFile(licenseText), id: licenseId } },
    sources, origin: `${faces.length} local file(s)`, notes
  };
}

export function recogniseLicense(text: string): string | null {
  if (/SIL OPEN FONT LICEN[CS]E/i.test(text)) return 'OFL-1.1';
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/UBUNTU FONT LICEN[CS]E/i.test(text)) return 'UFL-1.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  return null;
}

const isFreeLicense = (id: string | null) => id === 'OFL-1.1' || id === 'Apache-2.0' || id === 'UFL-1.0' || id === 'MIT';

const slug = (family: string) => family.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'font';
