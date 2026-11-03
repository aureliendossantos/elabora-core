// A course's charter (docs/design.md, the design layer): its theme (tokens, fonts, stylesheet, named
// styles, effects, backdrop and its variants), its components, the decoration its backdrop mounts,
// the presentation's widths and the player's bars, with the files they use (fonts and their licences,
// the stylesheets' pictures, the logo, the generators of those pictures). What a course says is not
// its charter: its screens, plan, narration, sounds, sources, translations, and the free objects its
// blocks place. `elabora projects create --charter` (and the library's createProject the app calls)
// makes a new course from a blank one and another course's charter (D69): a template's or a module's,
// with one screen to start from.

import fs from 'node:fs';
import path from 'node:path';
import { stringifyJSON } from '@elabora/core/util/json';
import { fieldOf, isRecord } from './util/values.ts';

export interface CharterCopy {
  files: string[]; // course-relative paths copied, sorted
  components: string[];
  object: string | null; // the backdrop's decoration
  generators: string[];
}

const PROVENANCE = 'generators/provenance.json';
const LICENCE = /^(?:ofl|licen[cs]e|eula|copying|readme)(?:[._-].*)?$/i;
// The course's own files a charter never takes, wherever they are found.
const SKIPPED = /(?:^|\/)(?:\.DS_Store|Thumbs\.db)$/;

// Copies the charter of the course in `source` into the course in `target`, a course just made
// (initProject): its course.json takes the source's theme, presentation (the mode the author chose
// kept: `presentation`) and player bars, and the files they use are copied beside its own. A file
// the target has already is replaced. `source` is read as it is: a module being edited is copied
// under its library lock (createProject).
export function copyCharter(source: string, target: string, { presentation }: { presentation?: 'slides' | 'scroll' } = {}): CharterCopy {
  const from = path.resolve(source);
  const to = path.resolve(target);
  const course = readJSON(path.join(from, 'course.json'));
  const theme = fieldOf(course, 'theme');
  const files = new Set<string>();
  const add = (file: string | null) => { if (file && !SKIPPED.test(file) && isFile(from, file)) files.add(file); };
  const addTree = (folder: string) => { for (const file of walk(from, folder)) add(file); };

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
    const folder = path.posix.dirname(src);
    for (const file of list(from, folder)) if (LICENCE.test(path.posix.basename(file))) add(file);
  }
  // Components: block types and screen layouts, all of them (a course's « Blocs du module »).
  addTree('components');
  const components = fs.existsSync(path.join(from, 'components')) ? fs.readdirSync(path.join(from, 'components'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : [];
  // The backdrop's decoration: a free object mounted behind the course.
  const objectId = fieldOf(fieldOf(fieldOf(theme, 'backdrop'), 'object'), 'id');
  const object = typeof objectId === 'string' && /^[a-z][a-z0-9-]*$/.test(objectId) && fs.existsSync(path.join(from, 'objects', objectId)) ? objectId : null;
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
      for (const used of referencesOf(from, file)) if (!files.has(used)) { add(used); more = true; }
    }
  }

  // Generators of the pictures taken, with their provenance, when what they import is taken too
  // (a generator that draws from a free object of the course's subject stays behind: its picture
  // comes as a plain file).
  const provenance = readProvenance(from);
  const kept: Record<string, unknown> = {};
  const generators = new Set<string>();
  for (const [asset, entry] of Object.entries(provenance)) {
    if (!files.has(`assets/${asset}`)) continue;
    const generator = fieldOf(entry, 'generator');
    if (typeof generator !== 'string' || !inside(generator) || !isFile(from, generator)) continue;
    const imports = importsOf(from, generator);
    if (imports.some((file) => file.startsWith('objects/') && !files.has(file))) continue;
    kept[asset] = entry;
    generators.add(generator);
    add(generator);
    for (const file of imports) add(file);
  }

  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    fs.cpSync(path.join(from, file), path.join(to, file), { mode: fs.constants.COPYFILE_FICLONE, force: true });
  }
  if (Object.keys(kept).length) {
    const own = readProvenance(to);
    fs.mkdirSync(path.join(to, 'generators'), { recursive: true });
    fs.writeFileSync(path.join(to, PROVENANCE), stringifyJSON({ format: 'elabora-generated/1', assets: { ...own, ...kept } }));
    files.add(PROVENANCE);
  }

  const made = readJSON(path.join(to, 'course.json'));
  if (isRecord(theme)) made.theme = theme;
  const shown = fieldOf(course, 'presentation');
  if (isRecord(shown)) made.presentation = { ...shown, ...(presentation ? { mode: presentation } : {}) };
  const player = fieldOf(course, 'player');
  if (isRecord(player)) made.player = player;
  fs.writeFileSync(path.join(to, 'course.json'), stringifyJSON(made));

  return { files: [...files].sort(), components, object, generators: [...generators].sort() };
}

// The course's files a file names: a stylesheet's url() (relative to it), the assets a JSON file
// names by a path under assets/, the modules a script imports by a relative path.
function referencesOf(root: string, file: string): string[] {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const dir = path.posix.dirname(file);
  const found: string[] = [];
  const relative = (target: string) => {
    const clean = target.split(/[?#]/)[0]!;
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) return;
    const resolved = path.posix.normalize(path.posix.join(dir, clean));
    if (inside(resolved)) found.push(resolved);
  };
  if (file.endsWith('.css')) for (const match of text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) relative(match[2]!);
  if (/\.(?:m?js)$/.test(file)) found.push(...importsOf(root, file));
  if (/\.(?:json|html)$/.test(file)) {
    for (const match of text.matchAll(/"((?:[\w.-]+\/)*[\w.-]+\.[a-z0-9]{2,5})"/gi)) {
      const asset = match[1]!;
      if (inside(asset) && isFile(root, `assets/${asset}`)) found.push(`assets/${asset}`);
    }
  }
  return found;
}

// The course files a script imports by a relative path (generators, free objects).
function importsOf(root: string, file: string): string[] {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  const dir = path.posix.dirname(file);
  const found: string[] = [];
  for (const match of text.matchAll(/(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    const resolved = path.posix.normalize(path.posix.join(dir, match[1] ?? match[2]!));
    if (inside(resolved) && isFile(root, resolved)) found.push(resolved);
  }
  return found;
}

function readProvenance(root: string): Record<string, unknown> {
  const file = path.join(root, PROVENANCE);
  if (!fs.existsSync(file)) return {};
  const assets = fieldOf(readJSON(file), 'assets');
  return isRecord(assets) ? assets : {};
}

const inside = (file: string): boolean => !!file && !path.posix.isAbsolute(file) && !path.posix.normalize(file).startsWith('..');
const isFile = (root: string, file: string): boolean => { try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; } };
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function readJSON(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isRecord(value)) throw new Error(`${file}: not a JSON object`);
  return value;
}

function list(root: string, folder: string): string[] {
  try {
    return fs.readdirSync(path.join(root, folder), { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => `${folder}/${entry.name}`);
  } catch {
    return [];
  }
}

function walk(root: string, folder: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(path.join(root, folder), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const file = `${folder}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(root, file));
    else if (entry.isFile()) out.push(file);
  }
  return out;
}
