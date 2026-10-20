import fs from 'node:fs';
import path from 'node:path';
import { FONTS, FONT_CATALOGUE, type FontFamily, type FontStyle } from '@elabora/node/fonts';
import * as edit from '@elabora/node/edit';
import { ArgumentError } from '../arguments.ts';
import { defineCommand, printDiagnostics, printFormatMigration, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  font list [dir] [--category <c>] [--json]           The vetted fonts shipped with Elabora (offline): family, category,
                                                      weights, styles, size, licence; ✔ marks those of the course
  font add [dir] <family> [--weights 400,700] [--styles normal,italic] [--for body,heading] [--subsets latin,latin-ext]
                                                      Copy a vetted font and its licence into theme/fonts/<id>/, declare its
                                                      faces in course.json and give its stack to tokens (--for body,
                                                      heading, mono, display… or none; default: what the list says);
                                                      latin, and latin-ext when a language of the course needs it
  font add [dir] --from <Fontsource package folder or .tgz> [--family <name>] [--weights …] [--styles …] [--subsets …] [--for …]
  font add [dir] --file <a.woff2,b.woff2> --license <OFL.txt> [--family <name>] [--for …]
                                                      Any other font, with its licence: npm pack @fontsource-variable/<id>,
                                                      or WOFF2 files (weights and style read from the files)`;

const CATEGORIES = new Set(['serif', 'sans-serif', 'monospace', 'display', 'handwriting']);
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const weightsOf = (font: FontFamily) => (font.variable ? font.files[0].weight.replace(' ', '–') : font.weights.join(' '));

// Families the course in a folder declares in theme.fonts, if it is a course.
function courseFamilies(dir: string): Set<string> {
  try {
    const course = JSON.parse(fs.readFileSync(path.join(dir, 'course.json'), 'utf8')) as { theme?: { fonts?: { family?: unknown }[] } };
    return new Set((course.theme?.fonts ?? []).map((font) => String(font?.family).toLowerCase()));
  } catch {
    return new Set();
  }
}

const list = defineCommand({
  name: 'font list',
  flags: { category: 'string', json: 'boolean' },
  run({ positionals: [dir = '.'], flags }) {
    if (flags.category && !CATEGORIES.has(flags.category)) { console.error(`✘ --category is one of ${[...CATEGORIES].join(', ')}`); return 2; }
    const fonts = FONTS.filter((font) => !flags.category || font.category === flags.category);
    if (flags.json) { printJson({ ...FONT_CATALOGUE, families: fonts }); return 0; }
    const used = courseFamilies(dir);
    const [latin, ...others] = FONT_CATALOGUE.subsets;
    console.log(`Vetted fonts, shipped with Elabora: WOFF2 files with their licence, in the ${latin.name} subset (Western European languages: ${latin.languages.join(' ')})${others.map((subset) => ` and the ${subset.name} subset (${subset.languages.join(' ')})`).join('')}. elabora font add takes the ${others.map((subset) => subset.name).join(', ')} files when a language of the course needs them.\n`);
    console.log(`  ${'Family'.padEnd(28)}${'Category'.padEnd(13)}${'Style'.padEnd(20)}${'Weights'.padEnd(14)}${'Italic'.padEnd(8)}${'Size'.padEnd(8)}${'Licence'.padEnd(9)}Sets`);
    for (const font of fonts) {
      const mark = used.has(font.family.toLowerCase()) ? '✔ ' : '  ';
      console.log(`${mark}${font.family.padEnd(28)}${font.category.padEnd(13)}${font.style.padEnd(20)}${weightsOf(font).padEnd(14)}${(font.styles.includes('italic') ? 'yes' : '—').padEnd(8)}${kb(font.bytes).padEnd(8)}${font.license.id.padEnd(9)}${font.for.join(', ')}`);
      console.log(`  ${font.use}`);
    }
    console.log(`\n${fonts.length} famil${fonts.length === 1 ? 'y' : 'ies'}, ${(fonts.reduce((sum, font) => sum + font.bytes, 0) / 1024 / 1024).toFixed(2)} MB. elabora font add [dir] "<family>"; another font: elabora font add [dir] --from <Fontsource package> or --file <font.woff2> --license <file>.`);
    return 0;
  }
});

const STYLES = new Set<FontStyle>(['normal', 'italic']);

const add = defineCommand({
  name: 'font add',
  flags: { weights: 'list', styles: 'list', subsets: 'list', for: 'list', from: 'string', file: 'list', license: 'string', family: 'string', json: 'boolean' },
  run({ positionals, flags }) {
    // The course folder comes first when it is one and something else names the font; a family
    // name may come unquoted (elabora font add EB Garamond).
    const [first, ...rest] = positionals;
    const external = !!(flags.from || flags.file?.length);
    const firstIsDir = first !== undefined && fs.existsSync(path.join(first, 'course.json')) && (rest.length > 0 || external);
    const dir = firstIsDir ? first : '.';
    const named = (firstIsDir ? rest : positionals).join(' ').trim();
    if (!named && !external) throw new ArgumentError('Name a vetted family (elabora font list), or give --from or --file');
    const weights = flags.weights?.map((weight) => {
      if (!/^[1-9]00$/.test(weight)) throw new ArgumentError(`--weights takes weights such as 400,700 (not ${weight})`);
      return Number(weight);
    });
    const styles = flags.styles?.map((style) => {
      if (!STYLES.has(style as FontStyle)) throw new ArgumentError(`--styles takes normal and italic (not ${style})`);
      return style as FontStyle;
    });
    for (const subset of flags.subsets ?? []) if (!/^[a-z][a-z0-9-]{0,31}$/.test(subset)) throw new ArgumentError(`--subsets takes subset names such as latin,latin-ext (not ${subset})`);
    const family = flags.family ?? (named || undefined);
    return reportingFailures(() => addFont(dir, { family, weights, styles, flags }));
  }
});

// Runs the edit and says what it wrote: the faces, the tokens and their previous values, the notes.
function addFont(dir: string, { family, weights, styles, flags }: { family?: string; weights?: number[]; styles?: FontStyle[]; flags: { for?: string[]; subsets?: string[]; from?: string; file?: string[]; license?: string; json: boolean } }): number {
  const result = edit.addFont(dir, { family, weights, styles, subsets: flags.subsets, for: flags.for, from: flags.from, files: flags.file, license: flags.license });
  if (flags.json) { printJson(result); return 0; }
  printFormatMigration(result.formatMigration);
  const { font } = result;
  if (!result.change) { console.log(`✔ ${font.family} is already in the course as asked (${font.folder}/): nothing changed.`); return 0; }
  const faces = [...new Set(font.faces.map((face) => `${face.weight.replace(' ', '–')} ${face.style}`))].join(', ');
  const subsets = [...new Set(font.faces.map((face) => face.subset).filter((subset) => subset !== undefined))];
  const bytes = result.files.filter((file) => file.startsWith(`${font.folder}/`)).reduce((sum, file) => sum + (fs.existsSync(path.join(dir, file)) ? fs.statSync(path.join(dir, file)).size : 0), 0);
  console.log(`✔ ${font.family} (${font.licenseId ?? 'licence not recognised'}, ${result.origin}) in ${font.folder}/: ${faces}${subsets.length ? ` (${subsets.join(', ')})` : ''}; ${kb(bytes)} with ${path.posix.basename(font.license)}`);
  for (const [token, { from, to }] of Object.entries(result.tokens)) console.log(`  ${token} = ${to}${from && from !== to ? `   (was ${from})` : ''}`);
  if (!Object.keys(result.tokens).length) console.log(`  No token set: use font-family: "${font.family}" in the stylesheet, or elabora font add --for <token>.`);
  for (const note of result.notes) console.log(`  ${note}`);
  const touched = new Set(result.files);
  printDiagnostics(result.diagnostics.filter((d) => d.file !== undefined && touched.has(d.file)));
  console.log(`  Undo: elabora undo --change ${result.change.seq}`);
  return 0;
}

export const fontCommands: CommandGroup = {
  title: 'Fonts',
  help: HELP,
  commands: [list, add],
  subcommandUsage: { font: 'Usage: elabora font list|add …' }
};
