import type { Course, ThemeFont } from '../project/model.ts';
import { filesIn, pathsUnder, type SourceFile } from '../project/files.ts';
import { isFontPath, isLicensePath } from '../project/fonts.ts';
import { isRecord } from '../util/values.ts';
import { CommandError, Draft, listIn, type CommandContext, type CommandOutput } from './context.ts';

// Embedding a font: its files and its licence go to theme/fonts/<folder>/, its faces are declared
// in course.json theme.fonts (the player writes the @font-face rules), and tokens get its stack.
// @elabora/node reads the font from the vetted fonts of @elabora/fonts, a Fontsource package or local
// files (fonts/); the command keeps the subsets the languages of the course need (or those asked)
// and writes them.

export interface FontFace {
  name: string; // file name in the folder: <name>.woff2 or .woff
  weight: string; // "400", or the range of a variable file: "100 900"
  style: 'normal' | 'italic';
  subset?: string; // the part of the font's characters the file holds (latin, latin-ext), when split
  unicodeRange?: string; // those characters as a CSS unicode-range, when known
  file: SourceFile;
}

export interface FontSource {
  family: string;
  folder: string; // theme/fonts/<folder>/
  stack: string; // CSS font stack the tokens get
  faces: FontFace[];
  subsets?: string[]; // every subset the font has, when its files are split (the faces may hold fewer: those asked)
  license: { name: string; file: SourceFile; id: string | null }; // id: OFL-1.1, Apache-2.0… when recognised
  for: string[]; // the tokens set when the caller names none
  // The subsets each language needs, by primary subtag ({ fr: ["latin"], pl: ["latin", "latin-ext"] }),
  // for the languages that are known; null when nothing is known (local files).
  languages: Record<string, string[]> | null;
}

// What a caller asks for (the CLI, the MCP server, the app); @elabora/node reads the font and gives
// the command a FontSource.
export interface FontRequest {
  family?: string; // a vetted family; with from or files, the family name to declare (default: the font's own)
  weights?: number[]; // static fonts: the weights to take; a variable file covers its whole range
  styles?: ('normal' | 'italic')[]; // default: every style there is
  from?: string; // a Fontsource package: its folder or the .tgz of npm pack
  files?: string[]; // local WOFF2 or WOFF files of one family
  license?: string; // the licence file of local files
  subsets?: string[]; // vetted fonts and Fontsource packages: the subsets to take (see AddFontArgs)
}

export interface AddFontArgs {
  // Tokens that get the font's stack: body (font.body), heading (font.heading), or the name of a
  // custom font token (mono → theme.custom font.mono, --t-font-mono). ["none"]: no token.
  for?: string[];
  // The subsets to embed (latin, latin-ext; a Fontsource package may have cyrillic, greek…).
  // Default: latin, and what the languages of the course (course.json and its translations) need.
  subsets?: string[];
}

export interface AddFontResult {
  font: { family: string; folder: string; license: string; licenseId: string | null; faces: { src: string; weight: string; style: string; subset?: string }[] };
  tokens: Record<string, { from: string | null; to: string }>;
  notes: string[];
}

const MAX_FACES = 24; // theme.fonts in the course schema
const FAMILY = /^[A-Za-z0-9 _-]{1,60}$/;
const FOLDER = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FACE_FILE = /^[A-Za-z0-9._-]+\.(woff2|woff)$/;
const TOKEN = /^[a-z][a-z0-9-]{0,31}$/;

const sameFamily = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

export function addFont(context: CommandContext, args: AddFontArgs, source: FontSource): CommandOutput<AddFontResult> {
  const { family, folder, license, stack } = source;
  if (!FAMILY.test(family)) throw new CommandError(`"${family}" cannot be a family name in course.json (letters, digits, spaces, "-" and "_", 60 at most): name the font with family.`);
  if (!FOLDER.test(folder)) throw new CommandError(`theme/fonts/${folder}: the folder of a font is a slug (a-z, 0-9, "-").`);
  if (!source.faces.length) throw new CommandError(`No font file for ${family}.`);
  for (const face of source.faces) if (!FACE_FILE.test(face.name)) throw new CommandError(`${face.name}: course fonts are WOFF2 or WOFF files with a portable name (letters, digits, ".", "-", "_").`);
  if (!isLicensePath(license.name)) throw new CommandError(`${license.name} is not a licence file name (OFL.txt, LICENSE.txt…).`);
  if (stack.length > 200 || /url\(|https?:/i.test(stack)) throw new CommandError(`The font stack of ${family} must be a CSS font stack of 200 characters at most, without URL.`);
  const tokens = (args.for ?? source.for).includes('none') ? [] : [...new Set(args.for ?? source.for)];
  for (const token of tokens) if (!TOKEN.test(token)) throw new CommandError(`for "${token}": body, heading, none, or the name of a custom font token (mono, display…).`);

  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  if (course.theme !== undefined && !isRecord(course.theme)) throw new CommandError('course.json: "theme" is not an object. Fix the file first: elabora validate reports what breaks its schema.');
  const languages = courseLanguages(course, context.files);
  const { faces, notes: subsetNotes } = pickSubsets(source, languages, args.subsets);
  const theme = (course.theme ??= {});
  const fonts = listIn<ThemeFont>(theme, 'fonts', 'course.json', { create: true });
  const dir = `theme/fonts/${folder}`;

  // Adding a family again replaces its faces (other weights or styles): the entries of the same
  // family, and the files of its folder that the new faces do not keep.
  const replaced = fonts.filter((font) => sameFamily(font?.family, family) || (typeof font?.src === 'string' && font.src.startsWith(`${dir}/`)));
  const kept = fonts.filter((font) => !replaced.includes(font));
  // Files beyond latin carry their ranges: the files of one face are told apart by them, and the
  // browser downloads a file only for a page that uses one of its characters. A font embedded in
  // latin alone is declared for every character, as before subsets.
  const ranged = faces.some((face) => face.subset !== undefined && face.subset !== 'latin');
  const entries: ThemeFont[] = faces.map((face) => ({
    family, src: `${dir}/${face.name}`, ...(face.weight !== '400' ? { weight: face.weight } : {}), ...(face.style !== 'normal' ? { style: face.style } : {}),
    ...(ranged && face.unicodeRange ? { unicodeRange: face.unicodeRange } : {})
  }));
  if (kept.length + entries.length > MAX_FACES) {
    throw new CommandError(`course.json declares at most ${MAX_FACES} font faces: ${kept.length} are taken by other families and ${family} needs ${entries.length}. Take fewer weights, styles or subsets, or a variable font (one file covers every weight).`);
  }
  const next: ThemeFont[] = [];
  for (const font of fonts) {
    if (!replaced.includes(font)) next.push(font);
    else if (font === replaced[0]) next.push(...entries);
  }
  if (!replaced.length) next.push(...entries);
  fonts.splice(0, fonts.length, ...next);

  const written = new Set([...faces.map((face) => `${dir}/${face.name}`), `${dir}/${license.name}`]);
  for (const path of pathsUnder(context.files, dir)) if (!written.has(path) && (isFontPath(path) || isLicensePath(path))) draft.remove(path);
  for (const face of faces) draft.writeFile(`${dir}/${face.name}`, face.file);
  draft.writeFile(`${dir}/${license.name}`, license.file);

  const changed: AddFontResult['tokens'] = {};
  for (const token of tokens) {
    const charter = token === 'body' || token === 'heading';
    const name = `font.${token}`;
    const holder = (charter ? (theme.tokens ??= {}) : (theme.custom ??= {})) as Record<string, unknown>;
    if (!isRecord(holder)) throw new CommandError(`course.json: theme.${charter ? 'tokens' : 'custom'} is not an object. Fix the file first: elabora validate reports what breaks its schema.`);
    const from = typeof holder[name] === 'string' ? holder[name] as string : null;
    holder[name] = stack;
    changed[charter ? name : `custom ${name}`] = { from, to: stack };
  }
  draft.writeJson('course.json', course);

  const notes: string[] = [];
  const unused = replaced.map((font) => font.src).filter((src) => typeof src === 'string' && !src.startsWith(`${dir}/`) && context.files.has(src));
  if (unused.length) notes.push(`No longer declared: ${unused.join(', ')} (left in place; delete them if nothing else uses them).`);
  notes.push(...subsetNotes);
  return {
    files: draft.files(),
    result: {
      font: {
        family, folder: dir, license: `${dir}/${license.name}`, licenseId: license.id,
        faces: entries.map((entry, i) => ({ src: entry.src, weight: entry.weight ?? '400', style: entry.style ?? 'normal', ...(faces[i].subset ? { subset: faces[i].subset } : {}) }))
      },
      tokens: changed,
      notes
    }
  };
}

// The primary language subtags of the course: its language, then those of its translations
// (translations/<language>.xlf).
function courseLanguages(course: Course, files: CommandContext['files']): string[] {
  const tags = [typeof course.language === 'string' ? course.language : '', ...filesIn(files, 'translations').filter((name) => name.endsWith('.xlf')).map((name) => name.slice(0, -4)).sort()];
  return [...new Set(tags.map((tag) => tag.toLowerCase().split(/[-_]/)[0]).filter(Boolean))];
}

// The faces of the subsets to embed: those asked, or latin and what the languages need. Notes say
// which languages keep letters no embedded file holds (drawn by the next fonts of the stack).
function pickSubsets(source: FontSource, languages: string[], asked: string[] | undefined): { faces: FontFace[]; notes: string[] } {
  const { family } = source;
  const offered = [...new Set(source.faces.map((face) => face.subset).filter((subset): subset is string => !!subset))];
  if (!offered.length) return { faces: source.faces, notes: [] };
  const table = source.languages ?? {};
  for (const subset of asked ?? []) if (!offered.includes(subset)) throw new CommandError(`${family} has no ${subset} files here (${offered.join(', ')}).`);
  const wanted = asked?.length ? asked : [...new Set(['latin', ...languages.flatMap((language) => table[language] ?? [])])];
  const faces = source.faces.filter((face) => !face.subset || wanted.includes(face.subset));
  if (!faces.length) throw new CommandError(`${family} has no ${wanted.join(' or ')} files (${offered.join(', ')}): name the subsets to embed (subsets: ${offered.join(', ')}).`);
  if (new Set(faces.map((face) => face.subset)).size > 1 && faces.some((face) => !face.unicodeRange)) {
    throw new CommandError(`The files of ${family} give no unicode range for their subsets, so they cannot be told apart: embed one subset (subsets).`);
  }
  const taken = new Set(faces.map((face) => face.subset));
  const notes: string[] = [];
  if (!source.languages) return { faces, notes };
  // Languages whose subsets are known, and what they miss.
  const missing = new Map<string, string[]>();
  for (const language of languages) {
    for (const subset of table[language] ?? []) if (!taken.has(subset)) missing.set(subset, [...(missing.get(subset) ?? []), language]);
  }
  for (const [subset, needing] of missing) {
    const why = (source.subsets ?? offered).includes(subset) ? `it was embedded without its ${subset} files (subsets: ${[...taken, subset].join(', ')})` : `${family} has no ${subset} files`;
    notes.push(`The course is in ${needing.join(', ')}, whose letters need the ${subset} subset, and ${why}: those letters are drawn by the next fonts of the stack.`);
  }
  // Languages no known subset writes: unless a subset beyond the known ones was taken for them.
  const known = new Set(Object.values(table).flat());
  const unknown = languages.filter((language) => !table[language]);
  if (unknown.length && [...taken].every((subset) => subset && known.has(subset))) {
    notes.push(`The files hold the ${[...taken].join(' and ')} subset${taken.size > 1 ? 's' : ''} and the course is in ${unknown.join(', ')}: letters outside them are drawn by the next fonts of the stack. Embed a font that holds them: its Fontsource package with the subset of its script (from, subsets: cyrillic, greek, vietnamese…), or its files (files).`);
  }
  return { faces, notes };
}
