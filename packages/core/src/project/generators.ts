import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { canonicalJSON, parseJSON } from '../util/json.ts';
import { sha256 } from '../util/sha256.ts';
import { join, dirname } from '../util/paths.ts';
import { filesIn, readText, getFile, fileHash, projectPath } from './files.ts';
import type { ProjectFiles } from './files.ts';
import type { Course, Project } from './model.ts';
import { generatorTokens } from '../validate/theme.ts';

// Asset generators: scripts that produce course assets (SVG figures, diagrams, data files) from
// code, the course theme and the plan, so that figures stay editable and follow the charter.
//
//   generators/<name>.mjs   ES module: export default async function ({ tokens, course, plan, language, write, read }) {…}
//                           optional: export const meta = { description: '…' }
//   generators/_<name>.mjs, generators/<folder>/…   helpers imported by generators (not run themselves)
//   generators/provenance.json   written by `elabora assets`: for every generated asset, the generator,
//                           the hash of its inputs (code, imported files, tokens) and of the output.
//
// `elabora validate` recomputes the input hashes: a changed generator, imported file or theme token
// makes its assets stale (W_GENERATED_ASSET_STALE); a generated file edited by hand is reported
// (W_GENERATED_ASSET_EDITED) because the next run would overwrite it. Running generators is the
// job of @elabora/node (generators.ts); everything here reads the files snapshot only.

export const GENERATORS_DIR = 'generators';
export const PROVENANCE_FILE = 'generators/provenance.json';

export interface ProvenanceEntry {
  generator: string;
  inputsHash: string;
  outputHash: string;
}

export interface Provenance {
  format: string;
  assets: Record<string, ProvenanceEntry>;
}

export function listGenerators(project: Pick<Project, 'files'>): string[] {
  return filesIn(project.files, GENERATORS_DIR).filter((n) => /\.(mjs|js)$/.test(n) && !n.startsWith('_')).map((n) => `${GENERATORS_DIR}/${n}`);
}

export function readProvenance(project: Pick<Project, 'files'>): Provenance {
  const text = readText(project.files, PROVENANCE_FILE);
  const r = text === null ? null : parseJSON(text);
  const value = r?.value as Partial<Provenance> | undefined;
  return !r || r.error !== undefined || !value?.assets ? { format: 'elabora-generated/1', assets: {} } : (value as Provenance);
}

// Files a module may import without an extension, in the order a bundler tries them (esbuild's
// defaults, which `elabora assets` used to find the inputs before the core did it alone).
const RESOLVE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.css', '.json'];
const isRelative = (spec: string): boolean => spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');

function resolveImport(files: ProjectFiles, fromDir: string, spec: string): string | null {
  const base = projectPath(join(fromDir, spec));
  if (base === null) return null;
  if (files.has(base)) return base;
  for (const ext of RESOLVE_EXTENSIONS) if (files.has(`${base}${ext}`)) return `${base}${ext}`;
  for (const ext of RESOLVE_EXTENSIONS) if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  return null;
}

// Module specifiers of a script: static imports, re-exports, import('…') and require('…') with a
// literal argument. Parsed once per source text: an editor validates the project after every edit,
// and generators rarely change.
const specifiers = new Map<string, string[]>();
function importSpecifiers(code: string): string[] {
  const known = specifiers.get(code);
  if (known) return known;
  const found = parseSpecifiers(code);
  if (specifiers.size >= 64) specifiers.delete(specifiers.keys().next().value as string);
  specifiers.set(code, found);
  return found;
}

function parseSpecifiers(code: string): string[] {
  const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  const out: string[] = [];
  const literal = (node: acorn.AnyNode | null | undefined) => { if (node?.type === 'Literal' && typeof node.value === 'string') out.push(node.value); };
  walk.full(ast, (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ImportExpression') literal(node.source);
    else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) literal(node.arguments[0]);
  });
  return out;
}

// The project files a generator depends on: itself and the relative files it imports,
// transitively. Packages and Node built-ins are not project files.
export function generatorInputs(files: ProjectFiles, entry: string): { inputs: string[]; error?: undefined } | { inputs?: undefined; error: string } {
  if (!getFile(files, entry)) return { error: `Could not resolve "${entry}"` };
  const seen = new Set<string>();
  const errors: string[] = [];
  const visit = (rel: string) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    if (!/\.(mjs|cjs|js)$/.test(rel)) return;
    let specifiers: string[];
    try { specifiers = importSpecifiers(readText(files, rel) ?? ''); } catch (e) { errors.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`); return; }
    for (const spec of specifiers) {
      if (!isRelative(spec)) continue;
      const target = resolveImport(files, dirname(rel), spec);
      if (target === null) errors.push(`Could not resolve "${spec}"`);
      else visit(target);
    }
  };
  visit(entry);
  return errors.length ? { error: errors.join('; ') } : { inputs: [...seen].sort() };
}

// Hash of what a generator's output depends on: its input files, the theme tokens, the language.
export function generatorInputsHash(files: ProjectFiles, course: Course | null | undefined, rel: string): { hash: string; inputs: string[]; error?: undefined } | { hash?: undefined; inputs?: undefined; error: string } {
  const r = generatorInputs(files, rel);
  if (r.error !== undefined) return { error: r.error };
  const hashes = Object.fromEntries(r.inputs.map((f) => [f, fileHash(files, f)]));
  return { hash: `sha256:${sha256(canonicalJSON({ files: hashes, tokens: generatorTokens(course), language: course?.language || 'en' }))}`, inputs: r.inputs };
}
