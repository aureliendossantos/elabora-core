// Refreshes the vetted fonts of @elabora/fonts from npm (Fontsource packages):
//   pnpm run fonts                 download the versions of packages/fonts/sources.json, check them
//                                 against the registry's integrity, copy their files of the subsets
//                                 (latin, latin-ext) and licences into packages/fonts/files/ and
//                                 write catalogue.json
//   pnpm run fonts -- --check      list the packages that have a newer version (changes nothing)
//   pnpm run fonts -- --update     move sources.json to the newest versions, then refresh
// Needs network access; nothing else does (courses, the CLI and the app read the files offline).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readTar } from '@elabora/node/util/tar';
import type { FontCatalogue, FontCategory, FontFamily, FontHash, FontLicense, FontStyle, FontSubset } from '@elabora/fonts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = path.join(ROOT, 'packages/fonts');
const SOURCES = path.join(PACKAGE, 'sources.json');
const CACHE = path.join(os.tmpdir(), 'elabora-fonts-cache');
// Licences the catalogue accepts, and the name their text file gets next to the fonts.
const LICENSES: Record<string, { file: string; mark: RegExp; url: string }> = {
  'OFL-1.1': { file: 'OFL.txt', mark: /SIL OPEN FONT LICENSE Version 1\.1/i, url: 'https://openfontlicense.org' },
  'Apache-2.0': { file: 'LICENSE.txt', mark: /Apache License,?\s+Version 2\.0/i, url: 'https://www.apache.org/licenses/LICENSE-2.0' }
};

interface SourceFamily {
  id: string;
  family: string;
  category: FontCategory;
  style: string;
  package: string;
  version: string;
  styles?: FontStyle[];                                  // variable: the styles to ship
  weights?: Partial<Record<FontStyle, number[]>>;        // static: the files to ship
  for: string[];
  stack: string;
  use: string;
  pairs: string[];
  specimen: Record<string, string>;
}

interface Sources {
  subsets: FontSubset[];
  pangrams: Record<string, string>;
  families: SourceFamily[];
}

interface Metadata {
  id: string;
  family: string;
  subsets: string[];
  weights: number[];
  styles: string[];
  variable?: Record<string, { min: string; max: string }> | false;
  version: string;
  lastModified: string;
  category: string;
  license: { type: string; url: string; attribution: string };
  source: string;
}

const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8')) as Sources;
const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--update') ? 'update' : 'refresh';

const registry = new Map<string, any>();
async function packument(name: string): Promise<any> {
  if (!registry.has(name)) {
    const response = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2F')}`);
    if (!response.ok) throw new Error(`${name}: the npm registry answered ${response.status}`);
    registry.set(name, await response.json());
  }
  return registry.get(name);
}

if (mode !== 'refresh') {
  let text = fs.readFileSync(SOURCES, 'utf8');
  let newer = 0;
  for (const family of sources.families) {
    const latest = (await packument(family.package))['dist-tags'].latest as string;
    if (latest === family.version) continue;
    newer++;
    console.log(`${family.package.padEnd(48)} ${family.version} → ${latest}`);
    if (mode === 'update') {
      const pinned = `"package": "${family.package}", "version": "${family.version}"`;
      if (!text.includes(pinned)) throw new Error(`sources.json: keep "package" and "version" of ${family.family} on one line, as ${pinned}`);
      text = text.replace(pinned, `"package": "${family.package}", "version": "${latest}"`);
      family.version = latest;
    }
  }
  console.log(newer ? `${newer} package(s) have a newer version.` : 'Every package is at its newest version.');
  if (mode === 'check') process.exit(0);
  fs.writeFileSync(SOURCES, text);
}

async function tarball(name: string, version: string): Promise<{ files: Map<string, Buffer>; tarball: string; integrity: string }> {
  const dist = (await packument(name)).versions?.[version]?.dist;
  if (!dist) throw new Error(`${name}@${version} is not on npm`);
  const cached = path.join(CACHE, `${name.replace('/', '__')}-${version}.tgz`);
  let bytes = fs.existsSync(cached) ? fs.readFileSync(cached) : null;
  if (!bytes) {
    const response = await fetch(dist.tarball);
    if (!response.ok) throw new Error(`${dist.tarball}: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const [algorithm, expected] = String(dist.integrity).split('-');
  if (crypto.createHash(algorithm).update(bytes).digest('base64') !== expected) throw new Error(`${name}@${version}: the tarball does not match the registry's integrity`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, bytes);
  return { files: readTar(bytes), tarball: dist.tarball, integrity: dist.integrity };
}

const hash = (bytes: Uint8Array): FontHash => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;

const families: FontFamily[] = [];
const filesDir = path.join(PACKAGE, 'files');
for (const source of sources.families) {
  const { files: entries, tarball: url, integrity } = await tarball(source.package, source.version);
  const read = (name: string) => {
    const bytes = entries.get(`package/${name}`);
    if (!bytes) throw new Error(`${source.package}@${source.version} has no ${name}`);
    return bytes;
  };
  const meta = JSON.parse(read('metadata.json').toString('utf8')) as Metadata;
  if (meta.family !== source.family) throw new Error(`${source.package}: the package is "${meta.family}", sources.json says "${source.family}"`);
  // Every subset of sources.json the package has (latin at least), each with its unicode range.
  const subsets = sources.subsets.map((subset) => subset.name).filter((subset) => meta.subsets.includes(subset));
  if (subsets[0] !== sources.subsets[0].name) throw new Error(`${source.family} has no ${sources.subsets[0].name} subset`);
  const ranges = JSON.parse(read('unicode.json').toString('utf8')) as Record<string, string>;
  for (const subset of subsets) if (typeof ranges[subset] !== 'string') throw new Error(`${source.package}@${source.version}: unicode.json gives no range for ${subset}`);
  const license = LICENSES[meta.license.type];
  if (!license) throw new Error(`${source.family} is under ${meta.license.type}: only ${Object.keys(LICENSES).join(' and ')} are accepted (ask the maintainers first)`);
  const licenseText = read('LICENSE').toString('utf8');
  if (!license.mark.test(licenseText)) throw new Error(`${source.family}: LICENSE does not hold the ${meta.license.type} text`);

  // The faces to ship: one variable file per style (weight axis only: lighter than the files with
  // every axis), or the static files of the weights listed; each face in every subset. The format
  // declares weights from 100 to 900 (Nunito's axis goes to 1000: 900 is its heaviest declared
  // weight).
  const wght = meta.variable ? meta.variable.wght : undefined;
  const range = wght ? `${Math.max(100, Number(wght.min))} ${Math.min(900, Number(wght.max))}` : '';
  const styles = wght
    ? (source.styles ?? ['normal']).map((style) => ({ part: 'wght', weight: range, style }))
    : (Object.entries(source.weights ?? {}) as [FontStyle, number[]][]).flatMap(([style, weights]) => weights.map((weight) => ({ part: String(weight), weight: String(weight), style })));
  const faces = styles.flatMap(({ part, weight, style }) => subsets.map((subset) => ({ name: `${meta.id}-${subset}-${part}-${style}.woff2`, subset, weight, style })));
  if (!faces.length) throw new Error(`${source.family}: no styles (variable) or weights (static) in sources.json`);
  if (!wght && source.styles) throw new Error(`${source.family} is static: list its files with weights, not styles`);
  if (wght && source.weights) throw new Error(`${source.family} is variable: list its styles, not weights`);

  const folder = path.join(filesDir, source.id);
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const files = faces.map((face) => {
    const bytes = read(`files/${face.name}`);
    fs.writeFileSync(path.join(folder, face.name), bytes);
    return { path: `files/${source.id}/${face.name}`, subset: face.subset, unicodeRange: ranges[face.subset], weight: face.weight, style: face.style, bytes: bytes.length, hash: hash(bytes) };
  });
  fs.writeFileSync(path.join(folder, license.file), licenseText);
  const weights = wght ? meta.weights : [...new Set(faces.map((face) => Number(face.weight)))].sort((a, b) => a - b);
  families.push({
    id: source.id, family: source.family, category: source.category, style: source.style, use: source.use, stack: source.stack,
    for: source.for, pairs: source.pairs, specimen: source.specimen,
    variable: !!wght, weights, styles: [...new Set(faces.map((face) => face.style))], subsets,
    files,
    license: { id: meta.license.type as FontLicense['id'], path: `files/${source.id}/${license.file}`, bytes: Buffer.byteLength(licenseText), hash: hash(Buffer.from(licenseText)), copyright: meta.license.attribution, url: license.url },
    bytes: files.reduce((sum, file) => sum + file.bytes, Buffer.byteLength(licenseText)),
    source: {
      package: source.package, version: source.version, tarball: url, integrity, page: `https://fontsource.org/fonts/${meta.id}`,
      upstream: meta.source, fontVersion: meta.version, lastModified: meta.lastModified
    }
  });
  console.log(`${source.family.padEnd(28)} ${source.package}@${source.version}  ${files.length} file(s), ${subsets.join(' ')}  ${kb(families.at(-1)!.bytes)}`);
}

for (const name of fs.readdirSync(filesDir)) if (!sources.families.some((family) => family.id === name)) fs.rmSync(path.join(filesDir, name), { recursive: true, force: true });

const bytes = families.reduce((sum, family) => sum + family.bytes, 0);
const catalogue: FontCatalogue & { generated: string } = {
  format: 'elabora-fonts/2',
  generated: 'by pnpm run fonts from sources.json: do not edit',
  subsets: sources.subsets, pangrams: sources.pangrams,
  bytes,
  families
};
const bySubset = (subset: string) => families.reduce((sum, family) => sum + family.files.filter((file) => file.subset === subset).reduce((total, file) => total + file.bytes, 0), 0);
const licenses = families.reduce((sum, family) => sum + family.license.bytes, 0);
const mb = (count: number) => `${(count / 1024 / 1024).toFixed(2)} MB`;
const sizes = `${sources.subsets.map((subset) => `${subset.name} ${mb(bySubset(subset.name))}`).join(', ')}, licences ${mb(licenses)}`;
fs.writeFileSync(path.join(PACKAGE, 'catalogue.json'), `${JSON.stringify(catalogue, null, 2)}\n`);
fs.writeFileSync(path.join(PACKAGE, 'README.md'), readme());
console.log(`${families.length} families, ${mb(bytes)}: ${sizes}.`);

function readme(): string {
  const [latin, ...others] = sources.subsets;
  // Static families may ship italics at fewer weights than their upright faces.
  const italics = (font: (typeof families)[number]) => {
    const weights = [...new Set(font.files.filter((file) => file.style === 'italic').map((file) => file.weight))];
    return !weights.length ? '—' : font.variable ? 'yes' : weights.join(', ');
  };
  const rows = families.map((font) => {
    const weights = font.variable ? font.files[0].weight.replace(' ', '–') : font.weights.join(', ');
    const npm = `[${font.source.package} ${font.source.version}](https://www.npmjs.com/package/${font.source.package}/v/${font.source.version})`;
    return `| ${font.family} | ${font.category} | ${font.style} | ${weights}${font.variable ? ' (variable)' : ''} | ${italics(font)} | ${font.subsets.join(', ')} | ${kb(font.bytes)} | ${font.license.id} | ${npm}, ${font.source.fontVersion} |`;
  });
  const lacking = (subset: string) => families.filter((font) => !font.subsets.includes(subset)).map((font) => font.family);
  return `# @elabora/fonts

Vetted free fonts for Elabora courses, shipped with Elabora so that they are there offline: in the desktop app, for the \`elabora\` command and the MCP server, for new projects. Each family is a few WOFF2 files with its licence next to them, in \`files/<id>/\`: each face in the **${latin.name} subset** (Western European languages: ${latin.languages.join(', ')})${others.map((subset) => ` and the **${subset.name} subset** (${subset.languages.join(', ')}, with ${latin.name})`).join('')}.

- **Agents and authors**: \`elabora font list\`, \`elabora font add [dir] "<family>"\` (MCP \`elabora_list_fonts\`, \`elabora_add_font\`) copy a font and its licence into \`theme/fonts/<id>/\`, declare its faces in \`course.json\` and give its stack to the tokens: the ${latin.name} files, and the ${others.map((subset) => subset.name).join(', ')} files too when a language of the course needs them (\`--subsets\` to choose). Any other font goes the same way with its licence: \`elabora font add --from <Fontsource package folder or .tgz>\` or \`--file <font.woff2> --license <file>\` (docs/design.md, *Fonts*).
- **The app and other code**: \`import { FONTS, FONT_CATALOGUE, findFont, selectFontFiles, languageSubsets } from '@elabora/fonts'\` gives the catalogue as data (family, category, style, use, weights, styles, subsets, files with their unicode ranges, licence, where each came from, specimens and pangrams to preview them). No Node API: a renderer can import it. File paths are relative to this folder (\`import.meta.resolve('@elabora/fonts/package.json')\`).

## How they were chosen

- Classic and modern serifs, humanist, grotesque and geometric sans, a monospace and a few display faces, for the courses Elabora makes (corporate, technical, history, accessibility).
- Licences: SIL Open Font License 1.1 or Apache 2.0 only; ask the maintainers before adding a font under any other licence.
- Files: the Fontsource npm packages, which take the fonts from Google Fonts. The ${sources.subsets.map((subset) => subset.name).join(' and ')} subsets, each file with its unicode range (from the package's \`unicode.json\`): a course declares one \`@font-face\` rule per file, and the browser downloads a file only for a page that uses one of its characters. Letters outside them (Greek, Cyrillic, Vietnamese…) fall back to the next fonts of the stack: take a font of that script with \`--from\` and \`--subsets\`. ${others.map((subset) => `${lacking(subset.name).length ? `${lacking(subset.name).join(', ')} ha${lacking(subset.name).length === 1 ? 's' : 've'} no ${subset.name} files.` : ''}`).join(' ')} Variable fonts keep their weight axis only: one file per style and subset covers every weight. Static fonts ship the weights listed in \`sources.json\`.

## Maintaining

- \`sources.json\`, by hand: the subsets and the languages each one writes, the families, their package and version, styles (variable) or weights (static), the tokens \`elabora font add\` sets, their stack with fallbacks, one line of use, pairings, specimens.
- \`pnpm run fonts\` downloads each package at its version from the npm registry, checks it against the registry's integrity, copies its files and its licence into \`files/\` and writes \`catalogue.json\` and this README. \`pnpm run fonts -- --check\` lists newer versions; \`pnpm run fonts -- --update\` moves \`sources.json\` to them and refreshes. Then run \`pnpm test\` (the catalogue test checks files, hashes, ranges, licences, names, weights and the total size) and look at the fonts (\`elabora font list\`, a course with \`elabora font add\`).

## The list: ${families.length} families, ${mb(bytes)}

${sizes}.

| Family | Category | Style | Weights | Italic | Subsets | Size | Licence | Files from |
|---|---|---|---|---|---|---|---|---|
${rows.join('\n')}

Sizes count the font files and the licence. The licence files keep the copyright line of each font.
`;
}
