import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodePackage from '../package.json' with { type: 'json' };

// Which Elabora code is running, for a process that outlives the command that started it (the look
// server, look.ts): the core's version is the same for weeks of development, so it is followed by a
// hash of what runs. From the sources, that is the content of every package's sources and templates
// (a few megabytes, hashed in a few milliseconds); from a packaged app's bundles, the bundles beside
// the entry that started the command line (cli/elabora.js and cli/core.js), where no source is.
// Two states of the code, two versions: a process of an older one is replaced by the next command.

// The folders of the sources a look depends on, by package.
const SOURCES = ['cli/bin', 'cli/src', 'core/src', 'engine/src', 'fonts/src', 'format/src', 'node/src', 'node/templates', 'player/src'];

function hashFiles(hash: crypto.Hash, files: string[], base: string): void {
  for (const file of files.sort()) {
    hash.update(path.relative(base, file));
    hash.update('\0');
    try { hash.update(fs.readFileSync(file)); } catch { hash.update('?'); }
    hash.update('\0');
  }
}

function listFiles(folder: string, into: string[] = []): string[] {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) listFiles(full, into);
    else if (entry.isFile()) into.push(full);
  }
  return into;
}

// The hash of the sources under packages/ (the folder holding node/); or, where this file is not on
// disk (a packaged app: import.meta.url is a place in its core/ folder, whose few files are not the
// code), of the bundles beside the entry (process.argv[1]); bundled says which, for a test. null when
// neither can be read.
export function codeHash({ packages, entry = process.argv[1], bundled }: { packages?: string; entry?: string; bundled?: boolean } = {}): string | null {
  const here = fileURLToPath(import.meta.url);
  const hash = crypto.createHash('sha256');
  try {
    if (!(bundled ?? !fs.existsSync(here))) {
      const root = packages ?? path.resolve(path.dirname(here), '../..');
      hashFiles(hash, SOURCES.flatMap((folder) => (fs.existsSync(path.join(root, folder)) ? listFiles(path.join(root, folder)) : [])), root);
      return hash.digest('hex').slice(0, 12);
    }
    if (!entry) return null;
    const folder = path.dirname(entry);
    const bundles = fs.readdirSync(folder).filter((name) => name.endsWith('.js')).map((name) => path.join(folder, name));
    if (!bundles.length) return null;
    hashFiles(hash, bundles, folder);
    return hash.digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

// Computed when the module is loaded, not at the first look: a long-lived process (the MCP server)
// tells the code it started with, whatever is edited on disk afterwards.
const current: string = ((): string => {
  const hash = codeHash();
  return hash ? `${nodePackage.version}+${hash}` : nodePackage.version;
})();

// "0.1.0+3fa9c1d20b7e": the version of the package and a hash of the code that runs (the version
// alone when the code cannot be read).
export const codeVersion = (): string => current;
