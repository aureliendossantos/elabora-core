import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { ZipReader } from '../packaging/zip-reader.ts';
import type { ZipReaderEntry } from '../packaging/zip-reader.ts';

// What an importer reads from: an archive (a .story, a published course zipped, a SCORM package)
// or a folder (a published course unzipped), seen the same way: POSIX paths, small text files read
// whole, media copied by streams (a 300 MB video is never held in memory). Paths never leave the
// source: names with `..`, absolute names or backslashes are left out of the listing.

export interface ImportSource {
  readonly file: string;
  readonly container: 'zip' | 'folder';
  paths(): readonly string[];
  has(file: string): boolean;
  size(file: string): number;
  readText(file: string, maxBytes?: number): Promise<string>;
  copyTo(file: string, target: string): Promise<void>; // target must not exist
  hash(file: string, algorithm: 'md5' | 'sha256'): Promise<string>; // hex
  close(): Promise<void>;
}

const SAFE = (name: string) => !!name && !name.startsWith('/') && !name.includes('\\') && !/^[a-z]:/i.test(name) && !name.split('/').some((part) => part === '..' || part === '.');
const MAX_TEXT = 64 * 1024 * 1024;

export async function openSource(file: string): Promise<ImportSource> {
  const resolved = path.resolve(file);
  if (fs.statSync(resolved).isDirectory()) return folderSource(resolved);
  return zipSource(resolved);
}

async function zipSource(file: string): Promise<ImportSource> {
  const reader = await ZipReader.open(file);
  const entries = new Map<string, ZipReaderEntry>();
  for (const entry of reader.entries) if (!entry.name.endsWith('/') && SAFE(entry.name)) entries.set(entry.name, entry);
  const list = [...entries.keys()].sort();
  const entry = (name: string) => {
    const found = entries.get(name);
    if (!found) throw new Error(`${name} is not in ${path.basename(file)}.`);
    return found;
  };
  return {
    file, container: 'zip',
    paths: () => list,
    has: (name) => entries.has(name),
    size: (name) => entries.get(name)?.size ?? 0,
    readText: async (name, maxBytes = MAX_TEXT) => (await reader.readEntry(entry(name), maxBytes)).toString('utf8'),
    copyTo: async (name, target) => { await reader.extractEntry(entry(name), target); },
    hash: (name, algorithm) => reader.hashEntry(entry(name), algorithm),
    close: () => reader.close()
  };
}

function folderSource(root: string): ImportSource {
  const list: string[] = [];
  const sizes = new Map<string, number>();
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 12) return;
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.DS_Store', 'Thumbs.db', '__MACOSX', '.git', 'node_modules'].includes(dirent.name)) continue;
      const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      const full = path.join(dir, dirent.name);
      // Symbolic links are not followed: what is read stays inside the folder.
      if (dirent.isDirectory()) walk(full, relative, depth + 1);
      else if (dirent.isFile()) { list.push(relative); sizes.set(relative, fs.statSync(full).size); }
    }
  };
  walk(root, '', 0);
  list.sort();
  const known = new Set(list);
  const full = (name: string) => {
    if (!known.has(name)) throw new Error(`${name} is not in ${root}.`);
    return path.join(root, ...name.split('/'));
  };
  return {
    file: root, container: 'folder',
    paths: () => list,
    has: (name) => known.has(name),
    size: (name) => sizes.get(name) ?? 0,
    readText: async (name, maxBytes = MAX_TEXT) => {
      if ((sizes.get(name) ?? 0) > maxBytes) throw new Error(`${name} is larger than ${maxBytes} bytes.`);
      return fs.promises.readFile(full(name), 'utf8');
    },
    copyTo: async (name, target) => { await fs.promises.copyFile(full(name), target, fs.constants.COPYFILE_EXCL); },
    hash: async (name, algorithm) => {
      const hash = crypto.createHash(algorithm);
      for await (const chunk of fs.createReadStream(full(name))) hash.update(chunk as Buffer);
      return hash.digest('hex');
    },
    close: async () => {}
  };
}

// A view of a source under one of its folders (a published course zipped with its folder).
export function within(source: ImportSource, prefix: string): ImportSource {
  if (!prefix) return source;
  const base = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const list = source.paths().filter((name) => name.startsWith(base)).map((name) => name.slice(base.length));
  return {
    file: source.file, container: source.container,
    paths: () => list,
    has: (name) => source.has(base + name),
    size: (name) => source.size(base + name),
    readText: (name, maxBytes) => source.readText(base + name, maxBytes),
    copyTo: (name, target) => source.copyTo(base + name, target),
    hash: (name, algorithm) => source.hash(base + name, algorithm),
    close: () => source.close()
  };
}
