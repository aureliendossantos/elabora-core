import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Folder of an installed package, found the way Node finds it, even when its "exports" do not
// expose package.json or the file Elabora needs (scorm-again's browser build, axe-core's script).
export function packageDir(name: string): string | null {
  for (const base of require.resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}
