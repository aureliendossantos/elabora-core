import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FONTS, FONT_CATALOGUE, findFont, selectFontFiles, coversLanguage, languageSubsets } from '@elabora/fonts';
import { FONTS_DIR, readFontInfo } from '@elabora/node/fonts';
import { readTar } from '@elabora/node/util/tar';
import * as edit from '@elabora/node/edit';
import { validateDir } from '@elabora/node/project-reader';
import { build } from '@elabora/node/build';
import { readZip } from '@elabora/node/zip';
import { createMcpServer } from '@elabora/cli/mcp';
import { openProject } from '@elabora/engine';
import { ROOT, copyExample, readJSON, writeJSON, codes } from '../helpers.ts';

// The vetted fonts of @elabora/fonts (files, licences, catalogue), embedding them and other fonts in
// a course (elabora font add, MCP elabora_add_font, the engine's add_font), the licence check and the
// licence files the build carries.

const temporary: string[] = [];
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const course = () => { const dir = copyExample(); temporary.push(dir); return dir; };
const scratch = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-fonts-')); temporary.push(dir); return dir; };
const sha256 = (bytes: Uint8Array) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const vetted = (family: string) => { const font = findFont(family); assert.ok(font, family); return font; };
const fontFile = (family: string, index = 0) => path.join(FONTS_DIR, vetted(family).files[index].path);
// What course.schema.json accepts in theme.fonts unicodeRange.
const UNICODE_RANGE = /^[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?(, ?[Uu]\+[0-9A-Fa-f?]{1,6}(-[0-9A-Fa-f]{1,6})?)*$/;
const inRange = (range: string, codePoint: number) => range.split(',').some((part) => {
  const [low, high = low] = part.trim().slice(2).split('-').map((hex) => parseInt(hex, 16));
  return codePoint >= low && codePoint <= high;
});

test('the vetted fonts: free licences, files as the catalogue says, a reasonable size', () => {
  assert.equal(FONT_CATALOGUE.format, 'elabora-fonts/2');
  assert.deepEqual(FONT_CATALOGUE.subsets.map((subset) => subset.name), ['latin', 'latin-ext']);
  assert.ok(FONTS.length >= 15 && FONTS.length <= 25, `${FONTS.length} families`);
  assert.equal(new Set(FONTS.map((font) => font.id)).size, FONTS.length);
  assert.equal(new Set(FONTS.map((font) => font.family.toLowerCase())).size, FONTS.length);
  for (const category of ['serif', 'sans-serif', 'monospace', 'display', 'handwriting']) assert.ok(FONTS.some((font) => font.category === category), category);
  let total = 0;
  for (const font of FONTS) {
    assert.match(font.id, /^[a-z0-9][a-z0-9-]{0,47}$/);
    assert.match(font.family, /^[A-Za-z0-9 _-]{1,60}$/, 'a family name course.json accepts');
    assert.ok(['OFL-1.1', 'Apache-2.0'].includes(font.license.id), `${font.family}: ${font.license.id}`);
    const license = fs.readFileSync(path.join(FONTS_DIR, font.license.path));
    assert.equal(sha256(license), font.license.hash, font.license.path);
    assert.match(license.toString('utf8'), font.license.id === 'OFL-1.1' ? /SIL OPEN FONT LICENSE Version 1\.1/ : /Apache License/);
    assert.ok(license.toString('utf8').includes(font.license.copyright.slice(0, 40)), `${font.family}: the copyright line is in the licence file`);
    assert.ok(font.stack.startsWith(`"${font.family}", `) && font.stack.length <= 200 && !/url\(|https?:/.test(font.stack), font.stack);
    for (const token of font.for) assert.match(token, /^[a-z][a-z0-9-]{0,31}$/);
    for (const pair of font.pairs) assert.ok(findFont(pair), `${font.family} pairs with ${pair}, which is not in the list`);
    assert.ok(font.specimen.en && font.specimen.fr, `${font.family}: specimens in English and French`);
    assert.ok(font.files.length && font.files.length <= 10, font.family);
    // Every face in every subset of the family, latin first.
    assert.equal(font.subsets[0], 'latin', font.family);
    const faces = [...new Set(font.files.map((file) => `${file.weight} ${file.style}`))];
    assert.deepEqual(font.files.map((file) => `${file.weight} ${file.style} ${file.subset}`), faces.flatMap((face) => font.subsets.map((subset) => `${face} ${subset}`)), font.family);
    let bytes = license.length;
    for (const file of font.files) {
      const content = fs.readFileSync(path.join(FONTS_DIR, file.path));
      assert.equal(content.length, file.bytes, file.path);
      assert.equal(sha256(content), file.hash, file.path);
      assert.match(file.weight, /^[1-9]00( [1-9]00)?$/, 'a weight course.json accepts');
      assert.match(file.unicodeRange, UNICODE_RANGE, 'a unicode range course.json accepts');
      assert.ok(file.unicodeRange.length <= 2000);
      assert.ok(path.posix.basename(file.path).startsWith(`${font.id}-${file.subset}-`), file.path);
      assert.equal(path.posix.dirname(file.path), `files/${font.id}`);
      const info = readFontInfo(content);
      assert.deepEqual([info.format, info.family, info.weight, info.style], ['woff2', font.family, file.weight, file.style], file.path);
      bytes += content.length;
    }
    // The folder holds the files of the catalogue and the licence, nothing else.
    assert.deepEqual(fs.readdirSync(path.join(FONTS_DIR, 'files', font.id)).sort(), [...font.files.map((file) => path.posix.basename(file.path)), path.posix.basename(font.license.path)].sort());
    assert.equal(font.bytes, bytes);
    total += bytes;
  }
  assert.deepEqual(fs.readdirSync(path.join(FONTS_DIR, 'files')).sort(), FONTS.map((font) => font.id).sort());
  assert.equal(FONT_CATALOGUE.bytes, total);
  // D22: about 4 MB at most (3.42 MB with latin-ext, 7 Oct 2026).
  assert.ok(total < 4 * 1024 * 1024, `${(total / 1024 / 1024).toFixed(2)} MB: keep the vetted fonts light`);
  assert.ok(FONTS.filter((font) => font.subsets.includes('latin-ext')).length >= FONTS.length - 2, 'latin-ext for nearly every family');
  // The player's languages are written by the latin subset, Central European ones with latin-ext;
  // each has a pangram to preview them, and the ranges of the files hold their letters.
  for (const language of ['de', 'en', 'es', 'fr', 'it', 'nl', 'pt']) {
    assert.ok(coversLanguage(language) && FONT_CATALOGUE.pangrams[language], language);
    assert.deepEqual(languageSubsets(language), ['latin'], language);
  }
  for (const language of ['cs', 'hu', 'pl', 'ro', 'tr']) assert.deepEqual(languageSubsets(language), ['latin', 'latin-ext'], language);
  const range = (subset: string) => FONTS[0].files.find((file) => file.subset === subset)!.unicodeRange;
  for (const [language, text] of Object.entries(FONT_CATALOGUE.pangrams)) {
    const subsets = languageSubsets(language);
    assert.ok(subsets, `${language}: a pangram of a language the vetted subsets write`);
    for (const letter of text) assert.ok(subsets.some((subset) => inRange(range(subset), letter.codePointAt(0)!)), `${language}: ${letter} (U+${letter.codePointAt(0)!.toString(16)}) is in ${subsets.join(' or ')}`);
  }
  assert.ok(coversLanguage('pt-BR') && coversLanguage('pl') && !coversLanguage('ru') && !coversLanguage('ja'));
  assert.equal(languageSubsets('vi'), null);
});

test('the catalogue is what npm run fonts wrote from sources.json', () => {
  const sources = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/fonts/sources.json'), 'utf8')) as { subsets: { name: string; languages: string[] }[]; pangrams: Record<string, string>; families: { id: string; family: string; package: string; version: string; for: string[]; stack: string }[] };
  assert.deepEqual(FONT_CATALOGUE.subsets, sources.subsets);
  assert.deepEqual(FONT_CATALOGUE.pangrams, sources.pangrams);
  const languages = sources.subsets.flatMap((subset) => subset.languages);
  assert.equal(new Set(languages).size, languages.length, 'a language is listed by one subset');
  assert.deepEqual(FONTS.map((font) => [font.id, font.family, font.source.package, font.source.version, font.for, font.stack]), sources.families.map((font) => [font.id, font.family, font.package, font.version, font.for, font.stack]), 'run npm run fonts after editing sources.json');
  for (const font of FONTS) {
    assert.match(font.source.tarball, /^https:\/\/registry\.npmjs\.org\/@fontsource/);
    assert.match(font.source.integrity, /^sha512-/);
  }
  // Every family of the README table, and nothing else.
  const readme = fs.readFileSync(path.join(ROOT, 'packages/fonts/README.md'), 'utf8');
  for (const font of FONTS) assert.ok(readme.includes(`| ${font.family} |`), `packages/fonts/README.md lists ${font.family}`);
});

test('findFont and selectFontFiles: names, weights and styles', () => {
  assert.equal(findFont('eb garamond')?.id, 'eb-garamond');
  assert.equal(findFont('EB-Garamond')?.id, 'eb-garamond');
  assert.equal(findFont('jetbrainsmono')?.family, 'JetBrains Mono');
  assert.equal(findFont('Comic Sans'), undefined);
  const lato = vetted('Lato');
  const picked = selectFontFiles(lato, { weights: [400, 700], styles: ['normal'], subsets: ['latin'] });
  assert.ok('files' in picked);
  assert.deepEqual(picked.files.map((file) => `${file.weight} ${file.style}`), ['400 normal', '700 normal']);
  const both = selectFontFiles(lato, { weights: [400], styles: ['normal'] });
  assert.ok('files' in both);
  assert.deepEqual(both.files.map((file) => file.subset), ['latin', 'latin-ext'], 'every subset by default');
  const missing = selectFontFiles(lato, { weights: [300] });
  assert.ok('error' in missing && /300/.test(missing.error) && /normal 400, 700, 900; italic 400, 700:/.test(missing.error), JSON.stringify(missing));
  const inter = vetted('Inter');
  const range = selectFontFiles(inter, { weights: [300, 800], subsets: ['latin'] });
  assert.ok('files' in range && range.files.length === 2, 'a variable file covers every weight of its range');
  assert.ok('error' in selectFontFiles(vetted('Lora'), { weights: [900] }));
  assert.ok('error' in selectFontFiles(vetted('Space Grotesk'), { styles: ['italic'] }));
  const fraktur = selectFontFiles(vetted('UnifrakturMaguntia'), { subsets: ['latin-ext'] });
  assert.ok('error' in fraktur && /no latin-ext files in the vetted list \(latin\)/.test(fraktur.error), JSON.stringify(fraktur));
});

test('elabora font add: the files and the licence, the faces, the tokens; undone in one step', () => {
  const dir = course();
  const before = fs.readFileSync(path.join(dir, 'course.json'), 'utf8');
  const result = edit.addFont(dir, { family: 'EB Garamond' }, { author: { kind: 'agent', name: 'test' } });
  assert.deepEqual(result.files, ['course.json', 'theme/fonts/eb-garamond/OFL.txt', 'theme/fonts/eb-garamond/eb-garamond-latin-wght-italic.woff2', 'theme/fonts/eb-garamond/eb-garamond-latin-wght-normal.woff2']);
  for (const file of vetted('EB Garamond').files.filter((file) => file.subset === 'latin')) {
    assert.deepEqual(fs.readFileSync(path.join(dir, 'theme/fonts/eb-garamond', path.posix.basename(file.path))), fs.readFileSync(path.join(FONTS_DIR, file.path)));
  }
  assert.equal(fs.readFileSync(path.join(dir, 'theme/fonts/eb-garamond/OFL.txt'), 'utf8'), fs.readFileSync(path.join(FONTS_DIR, vetted('EB Garamond').license.path), 'utf8'));
  const theme = readJSON(dir, 'course.json').theme;
  assert.deepEqual(theme.fonts, [
    { family: 'EB Garamond', src: 'theme/fonts/eb-garamond/eb-garamond-latin-wght-normal.woff2', weight: '400 800' },
    { family: 'EB Garamond', src: 'theme/fonts/eb-garamond/eb-garamond-latin-wght-italic.woff2', weight: '400 800', style: 'italic' }
  ]);
  assert.equal(theme.tokens['font.body'], vetted('EB Garamond').stack);
  assert.equal(theme.tokens['font.heading'], vetted('EB Garamond').stack);
  assert.deepEqual(Object.keys(result.tokens), ['font.body', 'font.heading']);
  assert.equal(result.font.licenseId, 'OFL-1.1');
  assert.deepEqual(result.notes, []);
  assert.ok(!codes(validateDir(dir).diagnostics).some((code) => code.startsWith('W_FONT') || code === 'E_SCHEMA'), JSON.stringify(validateDir(dir).diagnostics.filter((d) => d.code.startsWith('W_FONT'))));

  // A monospace goes to a custom token; for names the tokens.
  const mono = edit.addFont(dir, { family: 'JetBrains Mono' });
  assert.deepEqual(Object.keys(mono.tokens), ['custom font.mono']);
  assert.equal(readJSON(dir, 'course.json').theme.custom['font.mono'], vetted('JetBrains Mono').stack);
  const heading = edit.addFont(dir, { family: 'Playfair Display', for: ['heading'], styles: ['normal'] });
  assert.deepEqual(heading.tokens, { 'font.heading': { from: vetted('EB Garamond').stack, to: vetted('Playfair Display').stack } });
  assert.equal(readJSON(dir, 'course.json').theme.tokens['font.body'], vetted('EB Garamond').stack);
  edit.addFont(dir, { family: 'Caveat', for: ['none'] });
  assert.equal(readJSON(dir, 'course.json').theme.custom['font.display'], undefined);

  // Added again with other styles: its faces are replaced, the file it no longer uses goes.
  edit.addFont(dir, { family: 'eb garamond', styles: ['normal'], for: ['none'] });
  const fonts = readJSON(dir, 'course.json').theme.fonts;
  assert.deepEqual(fonts.filter((font: { family: string }) => font.family === 'EB Garamond').map((font: { src: string }) => font.src), ['theme/fonts/eb-garamond/eb-garamond-latin-wght-normal.woff2']);
  assert.equal(fonts[0].family, 'EB Garamond', 'it keeps its place');
  assert.ok(!fs.existsSync(path.join(dir, 'theme/fonts/eb-garamond/eb-garamond-latin-wght-italic.woff2')));

  // Undo, newest first, gives the course back as it was.
  for (let seq = 5; seq >= 1; seq--) edit.undo(dir, seq);
  assert.equal(fs.readFileSync(path.join(dir, 'course.json'), 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(dir, 'theme/fonts/eb-garamond/eb-garamond-latin-wght-normal.woff2')));
});

test('elabora font add refuses what it cannot embed, and says why', () => {
  const dir = course();
  assert.throws(() => edit.addFont(dir, { family: 'Comic Sans' }), /not a vetted font.*elabora font list/s);
  assert.throws(() => edit.addFont(dir, { family: 'Garamond' }), /did you mean EB Garamond/);
  assert.throws(() => edit.addFont(dir, { family: 'Lato', weights: [300] }), /300 is not among them.*npm pack @fontsource\/lato/s);
  assert.throws(() => edit.addFont(dir, { family: 'Inter', for: ['Body Text'] }), /body, heading, none/);
  assert.throws(() => edit.addFont(dir, { family: 'Inter', subsets: ['cyrillic'] }), /Inter has no cyrillic files in the vetted list \(latin, latin-ext\)\.$/);
  // theme.fonts holds 24 faces at most: one per file, so per subset.
  const both = ['latin', 'latin-ext'];
  edit.addFont(dir, { family: 'Lato', subsets: both });
  edit.addFont(dir, { family: 'Poppins', subsets: both });
  edit.addFont(dir, { family: 'Inter', subsets: both });
  assert.throws(() => edit.addFont(dir, { family: 'JetBrains Mono', subsets: both }), /at most 24 font faces: 24 are taken by other families and JetBrains Mono needs 4\. Take fewer weights, styles or subsets/);
  assert.equal(readJSON(dir, 'course.json').theme.fonts.length, 24);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_SCHEMA'));
});

test('latin-ext when a language of the course needs it: one face per file, with its unicode range', async () => {
  const dir = course();
  const data = readJSON(dir, 'course.json');
  data.language = 'pl';
  data.theme = { ...data.theme, fonts: [{ family: 'Inter', src: 'theme/inter.woff2', weight: '100 900' }] };
  writeJSON(dir, 'course.json', data);
  fs.mkdirSync(path.join(dir, 'theme'), { recursive: true });
  fs.copyFileSync(fontFile('Inter'), path.join(dir, 'theme/inter.woff2'));
  const inter = vetted('Inter');
  const range = (subset: string) => inter.files.find((file) => file.subset === subset)!.unicodeRange;
  const result = edit.addFont(dir, { family: 'Inter' });
  assert.deepEqual(result.notes, ['No longer declared: theme/inter.woff2 (left in place; delete them if nothing else uses them).']);
  assert.deepEqual(result.font.faces.map((face) => `${face.style} ${face.subset}`), ['normal latin', 'normal latin-ext', 'italic latin', 'italic latin-ext']);
  assert.deepEqual(readJSON(dir, 'course.json').theme.fonts, [
    { family: 'Inter', src: 'theme/fonts/inter/inter-latin-wght-normal.woff2', weight: '100 900', unicodeRange: range('latin') },
    { family: 'Inter', src: 'theme/fonts/inter/inter-latin-ext-wght-normal.woff2', weight: '100 900', unicodeRange: range('latin-ext') },
    { family: 'Inter', src: 'theme/fonts/inter/inter-latin-wght-italic.woff2', weight: '100 900', style: 'italic', unicodeRange: range('latin') },
    { family: 'Inter', src: 'theme/fonts/inter/inter-latin-ext-wght-italic.woff2', weight: '100 900', style: 'italic', unicodeRange: range('latin-ext') }
  ]);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_SCHEMA'));

  // The package declares one rule per file: the browser loads latin-ext only for pages with its letters.
  const built = await build(dir, { out: scratch() });
  assert.ok(built.ok && built.zipPath, JSON.stringify(built.diagnostics.filter((d) => d.severity === 'error')));
  const { files } = readZip(fs.readFileSync(built.zipPath));
  assert.ok(files.has('theme/fonts/inter/inter-latin-ext-wght-italic.woff2'));
  const css = files.get('elabora/theme.css')?.toString('utf8') ?? '';
  assert.ok(css.includes(`@font-face{font-family:"Inter";src:url("../theme/fonts/inter/inter-latin-ext-wght-normal.woff2") format("woff2");font-weight:100 900;font-style:normal;font-display:swap;unicode-range:${range('latin-ext')}}`), css);
  const courseData = JSON.parse((files.get('elabora/course.js')?.toString('utf8') ?? '').replace(/^window\.ELABORA_COURSE = /, '').replace(/;\s*$/, ''));
  assert.equal(courseData.fonts[1].unicodeRange, range('latin-ext'), 'the course data gives free objects the range of each file');

  // Asked for latin alone, or a family without latin-ext: the course is told which letters fall back.
  const latin = edit.addFont(dir, { family: 'Inter', subsets: ['latin'], for: ['none'] });
  assert.deepEqual(readJSON(dir, 'course.json').theme.fonts.map((font: { src: string; unicodeRange?: string }) => [font.src, font.unicodeRange]), [
    ['theme/fonts/inter/inter-latin-wght-normal.woff2', undefined], ['theme/fonts/inter/inter-latin-wght-italic.woff2', undefined]
  ], 'one subset: no range to tell files apart');
  assert.deepEqual(latin.notes, ['The course is in pl, whose letters need the latin-ext subset, and it was embedded without its latin-ext files (subsets: latin, latin-ext): those letters are drawn by the next fonts of the stack.']);
  const fraktur = edit.addFont(dir, { family: 'UnifrakturMaguntia', for: ['none'] });
  assert.deepEqual(fraktur.notes, ['The course is in pl, whose letters need the latin-ext subset, and UnifrakturMaguntia has no latin-ext files: those letters are drawn by the next fonts of the stack.']);

  // The languages of the translations count, a language no subset writes gets a note.
  const french = course();
  fs.mkdirSync(path.join(french, 'translations'), { recursive: true });
  fs.writeFileSync(path.join(french, 'translations/cs.xlf'), '<?xml version="1.0" encoding="UTF-8"?>\n<xliff version="1.2"/>\n');
  assert.deepEqual(edit.addFont(french, { family: 'Lora', styles: ['normal'] }).font.faces.map((face) => face.subset), ['latin', 'latin-ext']);
  const russian = course();
  writeJSON(russian, 'course.json', { ...readJSON(russian, 'course.json'), language: 'ru' });
  const cyrillic = edit.addFont(russian, { family: 'Lora', styles: ['normal'] });
  assert.deepEqual(cyrillic.font.faces.map((face) => face.subset), ['latin']);
  assert.match(cyrillic.notes.join('\n'), /The files hold the latin subset and the course is in ru: letters outside them are drawn by the next fonts of the stack\. Embed a font that holds them: its Fontsource package with the subset of its script \(from, subsets: cyrillic/);

  // The schema accepts code points only.
  const broken = readJSON(dir, 'course.json');
  broken.theme.fonts[0].unicodeRange = 'U+0000-00FF;}body{display:none';
  writeJSON(dir, 'course.json', broken);
  assert.ok(validateDir(dir).diagnostics.some((d) => d.code === 'E_SCHEMA' && d.path === '/theme/fonts/0/unicodeRange'), JSON.stringify(validateDir(dir).diagnostics.filter((d) => d.code === 'E_SCHEMA')));
});

// A Fontsource package as npm pack writes it (package/…), from the files of a vetted font.
// Its unicode.json gives the range of each subset, unless ranges is false (older packages).
function fontsourcePackage(family: string, { variable = true, ranges = true }: { variable?: boolean; ranges?: boolean } = {}): Map<string, Buffer> {
  const font = vetted(family);
  const entries = new Map<string, Buffer>();
  entries.set('package/package.json', Buffer.from(JSON.stringify({ name: `@fontsource${variable ? '-variable' : ''}/${font.id}`, version: '5.3.0' })));
  entries.set('package/LICENSE', fs.readFileSync(path.join(FONTS_DIR, font.license.path)));
  const [low, high] = font.files[0].weight.split(' ');
  entries.set('package/metadata.json', Buffer.from(JSON.stringify({
    id: font.id, family: font.family, category: font.category, subsets: font.subsets, weights: font.weights, styles: font.styles,
    variable: variable ? { wght: { min: low, max: high ?? low, default: '400', step: '1' } } : false, license: { type: font.license.id }
  })));
  if (ranges) entries.set('package/unicode.json', Buffer.from(JSON.stringify(Object.fromEntries(font.subsets.map((subset) => [subset, font.files.find((file) => file.subset === subset)!.unicodeRange])))));
  for (const file of font.files) entries.set(`package/files/${path.posix.basename(file.path)}`, fs.readFileSync(path.join(FONTS_DIR, file.path)));
  return entries;
}

// A package as a folder (node_modules/<name>).
function unpack(entries: Map<string, Buffer>, folder: string): string {
  for (const [name, data] of entries) {
    fs.mkdirSync(path.dirname(path.join(folder, name.slice('package/'.length))), { recursive: true });
    fs.writeFileSync(path.join(folder, name.slice('package/'.length)), data);
  }
  return folder;
}

// A gzipped tar archive (ustar headers, a pax record for long names), as npm writes tarballs.
function tgz(entries: Map<string, Buffer>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string) => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 100), 0, 'utf8');
    block.write('0000644\0', 100);
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    block.write('00000000000\0', 136);
    block.write(type, 156);
    block.write('ustar\0' + '00', 257);
    block.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return block;
  };
  const pad = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  for (const [name, data] of entries) {
    if (name.length > 100) {
      const record = ` path=${name}\n`;
      let length = record.length + String(record.length).length;
      if (String(length).length !== String(record.length).length) length = record.length + String(length).length;
      const pax = Buffer.from(`${length}${record}`);
      blocks.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    blocks.push(header(name, data.length, '0'), pad(data));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('readTar reads npm tarballs: gzip, ustar, long names', () => {
  const long = `package/${'x'.repeat(120)}.txt`;
  const files = readTar(tgz(new Map([['package/a.txt', Buffer.from('A')], [long, Buffer.from('long')]])));
  assert.deepEqual([...files.keys()], ['package/a.txt', long]);
  assert.equal(files.get(long)?.toString(), 'long');
});

test('a font from a Fontsource package (folder or npm pack tarball), with its licence', () => {
  const dir = course();
  const work = scratch();
  // The tarball of a variable package.
  const tarball = path.join(work, 'fontsource-variable-lora-5.3.0.tgz');
  fs.writeFileSync(tarball, tgz(fontsourcePackage('Lora')));
  const result = edit.addFont(dir, { from: tarball, family: 'Lora Text', for: ['body'] });
  assert.equal(result.origin, 'Fontsource package lora');
  assert.equal(result.font.folder, 'theme/fonts/lora-text');
  assert.deepEqual(result.font.faces.map((face) => `${face.weight} ${face.style}`), ['400 700 normal', '400 700 italic']);
  assert.ok(fs.existsSync(path.join(dir, 'theme/fonts/lora-text/OFL.txt')));
  assert.equal(readJSON(dir, 'course.json').theme.tokens['font.body'], '"Lora Text", Georgia, "Times New Roman", serif');
  // The folder of a static package: 400 and 700 unless weights say otherwise.
  const folder = unpack(fontsourcePackage('Lato', { variable: false }), path.join(work, 'node_modules/@fontsource/lato'));
  const lato = edit.addFont(dir, { from: folder, styles: ['normal'], for: ['none'] });
  assert.deepEqual(lato.font.faces.map((face) => face.src), ['theme/fonts/lato/lato-latin-400-normal.woff2', 'theme/fonts/lato/lato-latin-700-normal.woff2']);
  assert.match(lato.notes[0], /static: took the weights 400, 700/);
  assert.throws(() => edit.addFont(dir, { from: folder, weights: [300] }), /no lato-latin-300-normal\.woff2/);
  fs.rmSync(path.join(folder, 'LICENSE'));
  assert.throws(() => edit.addFont(dir, { from: folder }), /has no LICENSE/);
  assert.throws(() => edit.addFont(dir, { from: path.join(work, 'absent') }), /not found/);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('W_FONT_LICENSE_MISSING'));
});

test('a Fontsource package in the subsets the course needs or asks for, with the ranges of its unicode.json', () => {
  const dir = course();
  writeJSON(dir, 'course.json', { ...readJSON(dir, 'course.json'), language: 'hu' });
  const work = scratch();
  const lora = vetted('Lora');
  const range = (subset: string) => lora.files.find((file) => file.subset === subset)!.unicodeRange;
  const tarball = path.join(work, 'lora.tgz');
  fs.writeFileSync(tarball, tgz(fontsourcePackage('Lora')));
  const result = edit.addFont(dir, { from: tarball, styles: ['normal'], for: ['none'] });
  assert.deepEqual(readJSON(dir, 'course.json').theme.fonts, [
    { family: 'Lora', src: 'theme/fonts/lora/lora-latin-wght-normal.woff2', weight: '400 700', unicodeRange: range('latin') },
    { family: 'Lora', src: 'theme/fonts/lora/lora-latin-ext-wght-normal.woff2', weight: '400 700', unicodeRange: range('latin-ext') }
  ]);
  assert.deepEqual(result.notes, []);
  assert.throws(() => edit.addFont(dir, { from: tarball, subsets: ['cyrillic'] }), /Lora has no cyrillic subset in its Fontsource package \(latin, latin-ext\)/);
  // Without unicode.json the files of two subsets cannot be told apart; one subset still can.
  const older = path.join(work, 'lora-older.tgz');
  fs.writeFileSync(older, tgz(fontsourcePackage('Lora', { ranges: false })));
  assert.throws(() => edit.addFont(dir, { from: older }), /give no unicode range for their subsets.*embed one subset/s);
  edit.addFont(dir, { from: older, subsets: ['latin'], styles: ['normal'], for: ['none'] });
  assert.deepEqual(readJSON(dir, 'course.json').theme.fonts, [{ family: 'Lora', src: 'theme/fonts/lora/lora-latin-wght-normal.woff2', weight: '400 700' }]);
  // A package that lists latin-ext without all its files: its latin files, and the note.
  const partial = fontsourcePackage('Lora');
  partial.delete('package/files/lora-latin-ext-wght-italic.woff2');
  const incomplete = path.join(work, 'lora-partial.tgz');
  fs.writeFileSync(incomplete, tgz(partial));
  const latinOnly = edit.addFont(dir, { from: incomplete, for: ['none'] });
  assert.deepEqual(latinOnly.font.faces.map((face) => face.subset), ['latin', 'latin']);
  assert.deepEqual(latinOnly.notes, ['The course is in hu, whose letters need the latin-ext subset, and Lora has no latin-ext files: those letters are drawn by the next fonts of the stack.']);
  assert.throws(() => edit.addFont(dir, { from: incomplete, subsets: ['latin', 'latin-ext'] }), /has no lora-latin-ext-wght-italic\.woff2/);

  // Any subset of the package by name, such as the script of a Russian course.
  const russian = course();
  writeJSON(russian, 'course.json', { ...readJSON(russian, 'course.json'), language: 'ru' });
  const cyrillic = fontsourcePackage('Lora');
  const metadata = JSON.parse(cyrillic.get('package/metadata.json')!.toString());
  cyrillic.set('package/metadata.json', Buffer.from(JSON.stringify({ ...metadata, subsets: ['cyrillic', ...metadata.subsets] })));
  cyrillic.set('package/unicode.json', Buffer.from(JSON.stringify({ ...JSON.parse(cyrillic.get('package/unicode.json')!.toString()), cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116' })));
  for (const style of ['normal', 'italic']) cyrillic.set(`package/files/lora-cyrillic-wght-${style}.woff2`, cyrillic.get(`package/files/lora-latin-wght-${style}.woff2`)!);
  const folder = unpack(cyrillic, path.join(work, 'node_modules/@fontsource-variable/lora'));
  const taken = edit.addFont(russian, { from: folder, subsets: ['latin', 'cyrillic'], for: ['none'] });
  assert.deepEqual(taken.font.faces.map((face) => `${face.style} ${face.subset}`), ['normal latin', 'normal cyrillic', 'italic latin', 'italic cyrillic']);
  assert.equal(readJSON(russian, 'course.json').theme.fonts[1].unicodeRange, 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116');
  assert.deepEqual(taken.notes, [], 'a subset taken for the script of the course: no note');
  edit.addFont(russian, { from: folder, subsets: ['cyrillic'], styles: ['normal'], for: ['none'] });
  assert.deepEqual(readJSON(russian, 'course.json').theme.fonts, [{ family: 'Lora', src: 'theme/fonts/lora/lora-cyrillic-wght-normal.woff2', weight: '400 700', unicodeRange: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116' }], 'a subset beyond latin keeps its range, even alone');
  // Large scripts come in numbered slices: refused, a font file is the way.
  const japanese = fontsourcePackage('Lora');
  japanese.set('package/metadata.json', Buffer.from(JSON.stringify({ ...metadata, subsets: ['japanese', 'latin'] })));
  japanese.set('package/unicode.json', Buffer.from(JSON.stringify({ '[0]': 'U+3000-30FF', '[1]': 'U+4E00-4FFF', latin: range('latin') })));
  const sliced = path.join(work, 'sliced.tgz');
  fs.writeFileSync(sliced, tgz(japanese));
  assert.throws(() => edit.addFont(russian, { from: sliced, subsets: ['japanese'] }), /splits its japanese letters into numbered slices \(2 files\).*files, license/s);
  // Local files are embedded whole.
  assert.throws(() => edit.addFont(russian, { files: [fontFile('Lora')], license: path.join(FONTS_DIR, lora.license.path), subsets: ['latin'] }), /local files are embedded whole/);
});

test('local font files with their licence: weights, style and family read from the files', () => {
  const dir = course();
  const work = scratch();
  const files = vetted('Figtree').files.filter((file) => file.subset === 'latin').map((file) => {
    const target = path.join(work, path.posix.basename(file.path).replace('figtree-latin-wght', 'Figtree[wght]'));
    fs.copyFileSync(path.join(FONTS_DIR, file.path), target);
    return target;
  });
  assert.throws(() => edit.addFont(dir, { files }), /needs its licence/);
  const license = path.join(work, 'LICENSE');
  fs.copyFileSync(path.join(FONTS_DIR, vetted('Figtree').license.path), license);
  const result = edit.addFont(dir, { files, license });
  assert.equal(result.font.family, 'Figtree');
  assert.deepEqual(result.font.faces, [
    { src: 'theme/fonts/figtree/Figtree-wght-normal.woff2', weight: '300 900', style: 'normal' },
    { src: 'theme/fonts/figtree/Figtree-wght-italic.woff2', weight: '300 900', style: 'italic' }
  ]);
  assert.equal(result.font.license, 'theme/fonts/figtree/OFL.txt', 'an OFL licence is named OFL.txt');
  assert.match(result.notes.join(' '), /do not say whether Figtree is a serif or a sans/);
  // A licence Elabora does not recognise is copied, with a note.
  const other = path.join(work, 'EULA-licence.txt');
  fs.writeFileSync(other, 'Web font licence of Example Foundry. Embedding in e-learning packages is allowed.\n');
  const custom = edit.addFont(dir, { files: [files[0]], license: other, family: 'Brand Sans' });
  assert.equal(custom.font.license, 'theme/fonts/brand-sans/EULA-licence.txt');
  assert.match(custom.notes[0], /not recognised: check that it allows embedding/);
  // Not WOFF2 or WOFF, not a font.
  const ttf = path.join(work, 'font.ttf');
  fs.writeFileSync(ttf, 'x');
  assert.throws(() => edit.addFont(dir, { files: [ttf], license }), /WOFF2.*fonttools/s);
  const fake = path.join(work, 'fake.woff2');
  fs.writeFileSync(fake, 'not a font at all');
  assert.throws(() => edit.addFont(dir, { files: [fake], license }), /Not a WOFF2, WOFF/);
});

test('W_FONT_LICENSE_MISSING: a font file without a licence next to it, one finding per folder', () => {
  const dir = course();
  fs.mkdirSync(path.join(dir, 'theme/fonts'), { recursive: true });
  fs.copyFileSync(fontFile('Inter'), path.join(dir, 'theme/fonts/inter.woff2'));
  fs.copyFileSync(fontFile('Inter', 1), path.join(dir, 'theme/fonts/inter-italic.woff2'));
  fs.mkdirSync(path.join(dir, 'objects/diagnostic-reseau/fonts'), { recursive: true });
  fs.copyFileSync(fontFile('Oswald'), path.join(dir, 'objects/diagnostic-reseau/fonts/oswald.woff2'));
  const found = validateDir(dir).diagnostics.filter((d) => d.code === 'W_FONT_LICENSE_MISSING');
  assert.deepEqual(found.map((d) => d.file), ['objects/diagnostic-reseau/fonts/oswald.woff2', 'theme/fonts/inter-italic.woff2']);
  assert.match(found[1].message, /inter-italic\.woff2, inter\.woff2 in theme\/fonts\/ have no licence/);
  fs.writeFileSync(path.join(dir, 'theme/fonts/OFL-inter.txt'), 'SIL OPEN FONT LICENSE Version 1.1\n');
  fs.writeFileSync(path.join(dir, 'objects/diagnostic-reseau/fonts/LICENSE'), 'SIL OPEN FONT LICENSE Version 1.1\n');
  assert.ok(!codes(validateDir(dir).diagnostics).includes('W_FONT_LICENSE_MISSING'));
  // The samples keep their licences next to their fonts.
  for (const entry of fs.readdirSync(path.join(ROOT, 'examples'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // a Finder's .DS_Store is no sample
    assert.ok(!codes(validateDir(path.join(ROOT, 'examples', entry.name)).diagnostics).includes('W_FONT_LICENSE_MISSING'), entry.name);
  }
});

test('the build carries the licence of each packaged font next to it', async () => {
  const dir = course();
  edit.addFont(dir, { family: 'Source Sans 3' });
  fs.writeFileSync(path.join(dir, 'theme/fonts/source-sans-3/unused.woff2'), fs.readFileSync(fontFile('Inter')));
  const result = await build(dir, { out: scratch() });
  assert.ok(result.ok && result.zipPath, JSON.stringify(result.diagnostics.filter((d) => d.severity === 'error')));
  const { files } = readZip(fs.readFileSync(result.zipPath));
  const fonts = [...files.keys()].filter((name) => name.startsWith('theme/'));
  assert.deepEqual(fonts.sort(), ['theme/fonts/source-sans-3/OFL.txt', 'theme/fonts/source-sans-3/source-sans-3-latin-wght-italic.woff2', 'theme/fonts/source-sans-3/source-sans-3-latin-wght-normal.woff2']);
  assert.equal(files.get('theme/fonts/source-sans-3/OFL.txt')?.toString('utf8'), fs.readFileSync(path.join(FONTS_DIR, vetted('Source Sans 3').license.path), 'utf8'));
  assert.deepEqual(result.report.design.fontLicenses, ['theme/fonts/source-sans-3/OFL.txt']);
  assert.match(files.get('elabora/theme.css')?.toString('utf8') ?? '', /@font-face\{font-family:"Source Sans 3";src:url\("\.\.\/theme\/fonts\/source-sans-3\/source-sans-3-latin-wght-normal\.woff2"\) format\("woff2"\);font-weight:200 900/);
});

test('elabora font list and elabora font add on the command line', () => {
  const dir = course();
  const run = (args: string[], cwd = dir) => spawnSync(process.execPath, [path.join(ROOT, 'bin/elabora.js'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, ELABORA_AUTHOR: 'human' } });
  const listed = run(['font', 'list', '--json']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(JSON.parse(listed.stdout).families.map((font: { family: string }) => font.family), FONTS.map((font) => font.family));
  const added = run(['font', 'add', 'Atkinson', 'Hyperlegible', 'Next', '--for', 'body']);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /✔ Atkinson Hyperlegible Next \(OFL-1\.1, vetted, from @fontsource-variable\/atkinson-hyperlegible-next@5\.3\.0\) in theme\/fonts\/atkinson-hyperlegible-next\/: 200–800 normal, 200–800 italic \(latin\); \d+ KB with OFL\.txt\n  font\.body = "Atkinson Hyperlegible Next", /);
  const extended = run(['font', 'add', 'Figtree', '--subsets', 'latin,latin-ext', '--styles', 'normal', '--for', 'none']);
  assert.equal(extended.status, 0, extended.stderr);
  assert.match(extended.stdout, /: 300–900 normal \(latin, latin-ext\); \d+ KB with OFL\.txt/);
  const badSubset = run(['font', 'add', 'Figtree', '--subsets', 'Latin Ext']);
  assert.equal(badSubset.status, 2);
  assert.match(badSubset.stderr, /^--subsets takes subset names such as latin,latin-ext \(not Latin Ext\)/);
  const text = run(['font', 'list', '--category', 'sans-serif']);
  assert.match(text.stdout, /\n✔ Atkinson Hyperlegible Next +sans-serif /, 'the families of the course are marked');
  assert.doesNotMatch(text.stdout, /EB Garamond/);
  const fromParent = run(['font', 'add', path.basename(dir), 'Cinzel'], path.dirname(dir));
  assert.equal(fromParent.status, 0, fromParent.stderr);
  assert.ok(readJSON(dir, 'course.json').theme.fonts.some((font: { family: string }) => font.family === 'Cinzel'));
  const unknown = run(['font', 'add', 'Papyrus']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /✘ "Papyrus" is not a vetted font/);
  const weights = run(['font', 'add', 'Lato', '--weights', 'bold']);
  assert.equal(weights.status, 2);
  assert.match(weights.stderr, /^--weights takes weights such as 400,700 \(not bold\) for "elabora font add"/);
});

test('MCP: elabora_list_fonts and elabora_add_font', async () => {
  const dir = course();
  const server = createMcpServer(dir);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'font-test', version: '1.0.0' });
  await client.connect(clientTransport);
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((result.content as { text: string }[])[0].text);
  const listed = text(await client.callTool({ name: 'elabora_list_fonts', arguments: { category: 'monospace' } }));
  assert.deepEqual(listed.families.map((font: { family: string }) => font.family), ['JetBrains Mono']);
  assert.equal(listed.families[0].license, 'OFL-1.1');
  assert.deepEqual(listed.families[0].subsets, ['latin', 'latin-ext']);
  assert.deepEqual(listed.subsets.map((subset: { name: string }) => subset.name), ['latin', 'latin-ext']);
  const added = text(await client.callTool({ name: 'elabora_add_font', arguments: { family: 'Merriweather', for: ['body'], subsets: ['latin', 'latin-ext'] } }));
  assert.equal(added.ok, true);
  assert.deepEqual(added.font.faces.map((face: { subset: string }) => face.subset), ['latin', 'latin-ext', 'latin', 'latin-ext']);
  assert.equal(added.font.family, 'Merriweather');
  assert.deepEqual(Object.keys(added.tokens), ['font.body']);
  assert.ok(added.change.seq >= 1);
  assert.equal(readJSON(dir, 'course.json').theme.tokens['font.body'], vetted('Merriweather').stack);
  const refused = await client.callTool({ name: 'elabora_add_font', arguments: { family: 'Lato', weights: [250] } });
  assert.equal(refused.isError, true);
  await client.close();
});

test('the engine runs add_font as a change of the app', async () => {
  const dir = course();
  const session = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
  try {
    await session.flush();
    const result = await session.run('add_font', { family: 'Nunito', styles: ['normal'] }, { kind: 'human' });
    assert.deepEqual(result.files, ['course.json', 'theme/fonts/nunito/OFL.txt', 'theme/fonts/nunito/nunito-latin-wght-normal.woff2']);
    assert.equal((result.result.font as { family: string }).family, 'Nunito');
    const license = session.readFile('theme/fonts/nunito/OFL.txt');
    assert.ok(license.kind === 'text' && license.text.startsWith('Copyright'));
    assert.deepEqual(session.readFile('theme/fonts/nunito/nunito-latin-wght-normal.woff2'), { path: 'theme/fonts/nunito/nunito-latin-wght-normal.woff2', kind: 'binary', size: vetted('Nunito').files[0].bytes, hash: vetted('Nunito').files[0].hash });
    assert.equal(readJSON(dir, 'course.json').theme.fonts[0].weight, '200 900');
  } finally {
    await session.close();
  }
});
