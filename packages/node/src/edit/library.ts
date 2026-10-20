import fs from 'node:fs';
import path from 'node:path';
import { binaryFile, textFile, type ProjectFiles, type SourceFile } from '@elabora/core/project/files';
import { componentHash } from '@elabora/core/components/registry';
import type { ComponentSource } from '@elabora/core/project/model';
import { CommandError, type LibraryComponent } from '@elabora/core/commands/index';
import { stringifyJSON } from '@elabora/core/util/json';
import { hashBytes } from '../blobs.ts';

// Component libraries are folders outside the course (a client's design system): library.json
// ({ id, title }) and components/<id>/. Reading and publishing them is I/O outside the project.

export interface Library {
  root: string;
  id: string;
  title: string;
}

export function readLibrary(folder: string | undefined): Library {
  const root = path.resolve(folder || '');
  if (!folder || !fs.existsSync(root)) throw new CommandError(`Library folder ${folder} not found`);
  const metaFile = path.join(root, 'library.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) as { id?: string; title?: string } : {};
  return { root, id: meta.id || path.basename(root), title: meta.title || path.basename(root) };
}

export function folderFiles(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${rel}${entry.name}/`);
      else out.push(`${rel}${entry.name}`);
    }
  };
  if (fs.existsSync(folder)) walk(folder, '');
  return out.sort();
}

const TEXT_FILE = /\.(json|html|css|mjs|js|md|svg|txt)$/i;

// A library component as a snapshot of its folder, and where the bytes of its binary files are
// (the change brings them into the project's blob store).
export function libraryComponent(library: Library, component: string): { source: LibraryComponent; sources: Map<string, string> } {
  const folder = path.join(library.root, 'components', component);
  if (!fs.existsSync(path.join(folder, 'component.json'))) throw new CommandError(`Library ${library.id} has no component "${component}"`);
  const files = new Map<string, SourceFile>();
  const sources = new Map<string, string>();
  for (const name of folderFiles(folder)) {
    const file = path.join(folder, name);
    if (TEXT_FILE.test(name)) files.set(name, textFile(fs.readFileSync(file, 'utf8')));
    else {
      const bytes = fs.readFileSync(file);
      const hash = hashBytes(bytes);
      files.set(name, binaryFile(bytes.length, { hash }));
      sources.set(hash, file);
    }
  }
  return { source: { library: library.id, component, files: files as ProjectFiles }, sources };
}

// Copies a course component into a library (outside the course: not undoable). Refuses to replace
// the same version with other content.
export function publishToLibrary(library: Library, source: ComponentSource, folder: string): void {
  const manifest = source.manifest;
  if (!manifest) throw new CommandError(`No component "${source.id}" in components/`);
  const target = path.join(library.root, 'components', source.id);
  if (fs.existsSync(target)) {
    const theirs = JSON.parse(fs.readFileSync(path.join(target, 'component.json'), 'utf8')) as { version?: string };
    if (theirs.version === manifest.version && componentHashOfFolder(target) !== componentHash(source)) {
      throw new CommandError(`Library ${library.id} already has ${source.id} ${theirs.version} with other content: raise the version first.`);
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const name of folderFiles(folder)) {
    fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
    if (name === 'component.json') {
      const { origin: _origin, ...rest } = manifest;
      fs.writeFileSync(path.join(target, name), stringifyJSON(rest));
    } else fs.copyFileSync(path.join(folder, name), path.join(target, name));
  }
}

function componentHashOfFolder(folder: string): string {
  const read = (name: string) => (fs.existsSync(path.join(folder, name)) ? fs.readFileSync(path.join(folder, name), 'utf8') : null);
  const migrationsSource = read('migrations.mjs');
  return componentHash({ manifest: JSON.parse(read('component.json') as string), template: read('template.html'), css: read('component.css'), migrations: migrationsSource != null ? 'migrations.mjs' : null, migrationsSource });
}
