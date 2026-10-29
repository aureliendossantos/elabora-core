import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import type { Course, Plan } from '@elabora/format';
import { generatorTokens } from '@elabora/core/validate/theme';
import { listGenerators, readProvenance, generatorInputsHash, GENERATORS_DIR, PROVENANCE_FILE } from '@elabora/core/project/generators';
import type { Provenance } from '@elabora/core/project/generators';
import { toolDir } from './data-dir.ts';
import { readProjectFiles } from './project-reader.ts';
import { bundleErrorMessage } from './bundles.ts';
import { writeJSONFile, sha256Hex } from './util/fs.ts';
import { fieldOf, errorMessage } from './util/values.ts';

// Running asset generators (`elabora assets`): the core lists them and hashes their inputs from the
// files snapshot (project/generators.ts, where the format of generators is described); here they
// are bundled with esbuild and run, and what they write goes into assets/ with its provenance.

export { GENERATORS_DIR, PROVENANCE_FILE };

// What a generator receives: export default async function ({ tokens, course, plan, language, write, read }).
export interface GeneratorApi {
  tokens: Record<string, string | number>;
  course: Course | null;
  plan: Plan | null;
  language: string;
  // write('images/x.svg', content): only inside assets/.
  write(target: string, content: string | Uint8Array): void;
  // A project file, by path from the project root.
  read(target: string): Buffer;
}

type Generator = (api: GeneratorApi) => unknown;

export type GeneratorResult =
  | { generator: string; outputs: string[]; description: string | null; error?: undefined }
  | { generator: string; error: string; outputs?: undefined };

export interface GeneratorOptions {
  course: Course | null;
  plan: Plan | null;
  only?: string; // run the generators whose file name contains this text
}

const hashOf = (bytes: Uint8Array): string => `sha256:${sha256Hex(bytes)}`;

// The generator and the relative files it imports, as one module (packages stay imports).
function bundle(dir: string, rel: string): string {
  return esbuild.buildSync({
    entryPoints: [path.join(dir, rel)], bundle: true, platform: 'node', format: 'esm', packages: 'external',
    write: false, logLevel: 'silent', absWorkingDir: dir
  }).outputFiles[0].text;
}

// Runs the generators (all, or the ones whose file name contains `only`).
export async function runGenerators(dir: string, { course, plan, only }: GeneratorOptions): Promise<{ results: GeneratorResult[]; provenance: Provenance }> {
  const { root, files } = readProjectFiles(dir);
  const provenance = readProvenance({ files });
  const tokens: Record<string, string | number> = generatorTokens(course);
  const results: GeneratorResult[] = [];
  for (const rel of listGenerators({ files }).filter((generator) => !only || generator.includes(only))) {
    const inputs = generatorInputsHash(files, course, rel);
    if (inputs.error !== undefined) { results.push({ generator: rel, error: inputs.error }); continue; }
    const { hash } = inputs;
    let code: string;
    try { code = bundle(root, rel); } catch (error) { results.push({ generator: rel, error: bundleErrorMessage(error) }); continue; }
    // Inside the project, not in projectDataDir: the module resolves the packages it imports
    // (left out of the bundle) from its own location, as the generator would.
    const moduleFile = path.join(toolDir(root), 'generators', `${path.basename(rel).replace(/\.[^.]+$/, '')}-${hash.slice(7, 19)}.mjs`);
    fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
    fs.writeFileSync(moduleFile, code);
    const written: string[] = [];
    // The tokens it reads: by name; listing them all (Object.keys…), or reading course.theme, counts as all.
    const read = new Set<string>();
    let readAll = false;
    const watchedTokens = new Proxy(tokens, {
      get(target, key, receiver) { if (typeof key === 'string') read.add(key); return Reflect.get(target, key, receiver); },
      has(target, key) { if (typeof key === 'string') read.add(key); return Reflect.has(target, key); },
      ownKeys(target) { readAll = true; return Reflect.ownKeys(target); }
    });
    const watchedCourse = course ? new Proxy(course, { get(target, key, receiver) { if (key === 'theme') readAll = true; return Reflect.get(target, key, receiver); } }) : course;
    const api: GeneratorApi = {
      tokens: watchedTokens, course: watchedCourse, plan, language: course?.language || 'en',
      write(target, content) {
        const normalized = path.posix.normalize(String(target).replace(/^assets\//, ''));
        if (normalized.startsWith('..') || path.posix.isAbsolute(normalized) || !/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error(`write("${target}"): use a portable path inside assets/`);
        const file = path.join(root, 'assets', normalized);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        written.push(normalized);
        provenance.assets[normalized] = { generator: rel, inputsHash: hash, outputHash: hashOf(fs.readFileSync(file)) };
      },
      read(target) { return fs.readFileSync(path.join(root, target)); }
    };
    try {
      const module: unknown = await import(pathToFileURL(moduleFile).href);
      const run = fieldOf(module, 'default');
      if (typeof run !== 'function') throw new Error('the module must export a default function');
      await (run as Generator)(api); // the author's function: its signature cannot be checked at run time
      for (const [asset, entry] of Object.entries(provenance.assets)) if (entry.generator === rel && !written.includes(asset)) delete provenance.assets[asset];
      // Its assets depend on the tokens it read, not on the others.
      // A token read before it exists counts too: adding it later makes the assets stale.
      const names = readAll ? null : [...read].sort();
      const narrowed = names ? generatorInputsHash(files, course, rel, names) : null;
      for (const asset of written) {
        const entry = provenance.assets[asset];
        if (!entry) continue;
        if (names && narrowed?.hash) { entry.tokens = names; entry.inputsHash = narrowed.hash; } else delete entry.tokens;
      }
      const description = fieldOf(fieldOf(module, 'meta'), 'description');
      results.push({ generator: rel, outputs: written, description: typeof description === 'string' && description ? description : null });
    } catch (error) {
      results.push({ generator: rel, error: errorMessage(error) });
    }
  }
  provenance.assets = Object.fromEntries(Object.entries(provenance.assets).sort(([a], [b]) => a.localeCompare(b)));
  writeJSONFile(path.join(root, PROVENANCE_FILE), provenance);
  return { results, provenance };
}
