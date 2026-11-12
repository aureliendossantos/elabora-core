import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { binaryFile, isTextPath, textFile } from '@elabora/core/project/files';
import type { FileHash, SourceFile } from '@elabora/core/project/files';

// The sample courses as a project snapshot made with node:fs only, the way a Worker is given one: no
// @elabora/node, no media probe. Used to validate a project where code generation is forbidden.
export const EXAMPLES_DIR = path.resolve(import.meta.dirname, '../examples');
export const exampleNames = (): string[] => fs.readdirSync(EXAMPLES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

export function snapshotOfExample(name: string): Map<string, SourceFile> {
  const root = path.join(EXAMPLES_DIR, name);
  const files = new Map<string, SourceFile>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (isTextPath(rel)) files.set(rel, textFile(fs.readFileSync(full, 'utf8')));
      else {
        const bytes = fs.readFileSync(full);
        files.set(rel, binaryFile(bytes.length, { hash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` as FileHash }));
      }
    }
  };
  walk(root);
  return files;
}
