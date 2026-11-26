// A course's charter (docs/design.md, the design layer): its theme (tokens, fonts, stylesheet, named styles,
// effects, backdrop and its variants), its components, the decoration its backdrop mounts, the presentation's
// widths and the player's bars, with the files they use (fonts and their licences, the stylesheets' pictures,
// the logo, the generators of those pictures). What a course says is not its charter: its screens, plan,
// narration, sounds, sources, translations, and the free objects its blocks place.
//
// charterOf picks those files from a course however its files are read: a folder on a computer
// (@elabora/node copyCharter, D69) or a team's project as its room gives it (a browser's « Comme un module… »,
// D136), so that both copy the same files.

import { basename, dirname, isAbsolute, join, normalize } from '../util/paths.ts';
import { stringifyJSON } from '../util/json.ts';

// A course's files as charterOf reads them. Paths are the course's, relative, with forward slashes.
export interface CharterSource {
  course: Record<string, unknown>; // its course.json
  isFile(path: string): boolean;
  text(path: string): string; // a text file's text (only a stylesheet, a script, a JSON or an HTML file is read)
  list(folder: string): string[]; // the files directly in a folder
  walk(folder: string): string[]; // the files in a folder and its folders
}

export interface CharterFiles {
  files: string[]; // the course's paths the charter takes, sorted (the provenance of its pictures apart)
  provenance: Record<string, unknown>; // the provenance's entries of the pictures it takes with their generator
  components: string[];
  object: string | null; // the backdrop's decoration
  generators: string[];
}

export const PROVENANCE = 'generators/provenance.json';
const LICENCE = /^(?:ofl|licen[cs]e|eula|copying|readme)(?:[._-].*)?$/i;
// The course's own files a charter never takes, wherever they are found.
const SKIPPED = /(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/;

export function charterOf(source: CharterSource): CharterFiles {
  const { course } = source;
  const theme = fieldOf(course, 'theme');
  const files = new Set<string>();
  const add = (file: string | null) => { if (file && !SKIPPED.test(file) && source.isFile(file)) files.add(file); };
  const addTree = (folder: string) => { for (const file of source.walk(folder)) add(file); };

  // The theme: its folder (the stylesheet, the fonts and what sits beside them), the pictures the
  // stylesheet draws, fonts kept elsewhere with their licences.
  const stylesheet = fieldOf(theme, 'stylesheet');
  if (typeof stylesheet === 'string') {
    const folder = stylesheet.split('/')[0]!;
    if (stylesheet.includes('/')) addTree(folder); else add(stylesheet);
  }
  for (const face of arrayOf(fieldOf(theme, 'fonts'))) {
    const src = fieldOf(face, 'src');
    if (typeof src !== 'string' || !inside(src)) continue;
    add(src);
    for (const file of source.list(dirname(src))) if (LICENCE.test(basename(file))) add(file);
  }
  // Components: block types and screen layouts, all of them (a course's « Blocs du module »).
  addTree('components');
  const components = [...new Set(source.walk('components').map((file) => file.split('/')[1]!).filter((name) => source.walk(`components/${name}`).length > 0))].sort();
  // The backdrop's decoration: a free object mounted behind the course.
  const objectId = fieldOf(fieldOf(fieldOf(theme, 'backdrop'), 'object'), 'id');
  const object = typeof objectId === 'string' && /^[a-z][a-z0-9-]*$/.test(objectId) && source.walk(`objects/${objectId}`).length > 0 ? objectId : null;
  if (object) addTree(`objects/${object}`);
  // The player's logo.
  for (const bar of ['top', 'bottom']) {
    for (const item of arrayOf(fieldOf(fieldOf(fieldOf(course, 'player'), bar), 'items'))) {
      const asset = fieldOf(fieldOf(item, 'options'), 'asset');
      if (typeof asset === 'string' && inside(asset)) add(`assets/${asset}`);
    }
  }
  // What those files use: a stylesheet's url(), an asset a component or the decoration names by
  // default, a module the decoration imports from outside its folder.
  const read = new Set<string>();
  for (let more = true; more;) {
    more = false;
    for (const file of [...files]) {
      if (read.has(file)) continue;
      read.add(file);
      for (const used of referencesOf(source, file)) if (!files.has(used)) { add(used); more = true; }
    }
  }

  // Generators of the pictures taken, with their provenance, when what they import is taken too
  // (a generator that draws from a free object of the course's subject stays behind: its picture
  // comes as a plain file).
  const provenance: Record<string, unknown> = {};
  const generators = new Set<string>();
  for (const [asset, entry] of Object.entries(provenanceOf(source))) {
    if (!files.has(`assets/${asset}`)) continue;
    const generator = fieldOf(entry, 'generator');
    if (typeof generator !== 'string' || !inside(generator) || !source.isFile(generator)) continue;
    const imports = importsOf(source, generator);
    if (imports.some((file) => file.startsWith('objects/') && !files.has(file))) continue;
    provenance[asset] = entry;
    generators.add(generator);
    add(generator);
    for (const file of imports) add(file);
  }
  files.delete(PROVENANCE);
  return { files: [...files].sort(), provenance, components, object, generators: [...generators].sort() };
}

// The provenance of a course's generated pictures, with those a charter brings (its entries over the course's own).
export function provenanceText(own: Record<string, unknown>, brought: Record<string, unknown>): string {
  return stringifyJSON({ format: 'elabora-generated/1', assets: { ...own, ...brought } });
}

// The entries of a course's generators/provenance.json, none when it has none.
export function provenanceOf(source: Pick<CharterSource, 'isFile' | 'text'>): Record<string, unknown> {
  if (!source.isFile(PROVENANCE)) return {};
  const assets = fieldOf(JSON.parse(source.text(PROVENANCE)) as unknown, 'assets');
  return isRecord(assets) ? assets : {};
}

// The course's files a file names: a stylesheet's url() (relative to it), the assets a JSON file
// names by a path under assets/, the modules a script imports by a relative path.
function referencesOf(source: CharterSource, file: string): string[] {
  const isCss = file.endsWith('.css');
  const isScript = /\.(?:m?js)$/.test(file);
  const isData = /\.(?:json|html)$/.test(file);
  if (!isCss && !isScript && !isData) return [];
  const text = source.text(file);
  const dir = dirname(file);
  const found: string[] = [];
  const relative = (target: string) => {
    const clean = target.split(/[?#]/)[0]!;
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) return;
    const resolved = normalize(join(dir, clean));
    if (inside(resolved)) found.push(resolved);
  };
  if (isCss) for (const match of text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) relative(match[2]!);
  if (isScript) found.push(...importsOf(source, file));
  if (isData) {
    for (const match of text.matchAll(/"((?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]{2,5})"/gi)) {
      const asset = match[1]!;
      if (inside(asset) && source.isFile(`assets/${asset}`)) found.push(`assets/${asset}`);
    }
  }
  return found;
}

// The course files a script imports by a relative path (generators, free objects).
function importsOf(source: CharterSource, file: string): string[] {
  const text = source.text(file);
  const dir = dirname(file);
  const found: string[] = [];
  for (const match of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const resolved = normalize(join(dir, match[1] ?? match[2]!));
    if (inside(resolved) && source.isFile(resolved)) found.push(resolved);
  }
  return found;
}

const inside = (file: string): boolean => !!file && !isAbsolute(file) && !normalize(file).startsWith('..');
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fieldOf = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
