import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Diagnostic } from '@elabora/format';
import { build } from './build.ts';
import type { PackageFiles } from './emulator/server.ts';

// Builds a course folder into a temporary folder for a capture or a measure (or uses pkgDir, an
// already built package).
// Media stay where they are (files: their package paths, served from the project).
export async function packageFolder(dir: string | null, pkgDir: string | undefined, prefix: string): Promise<{ root: string; temporary: string | null; files: PackageFiles } | { diagnostics: Diagnostic[] }> {
  if (pkgDir) return { root: pkgDir, temporary: null, files: new Map() };
  if (!dir) throw new Error('Give a course folder or pkgDir, a built package.');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const result = await build(dir, { emit: 'dir', out, debug: true, writeLock: false, media: 'link' });
  if (!result.ok || !result.dirPath) { fs.rmSync(out, { recursive: true, force: true }); return { diagnostics: result.diagnostics }; }
  return { root: result.dirPath, temporary: out, files: result.media };
}

// In the page: every screen visited and complete (free navigation), the preview banner removed;
// returns the screen ids.
export function openAllScreens(): string[] {
  const elabora = window.__elabora;
  for (const screen of elabora.engine.screens) { elabora.engine.st.visited.add(screen.key); elabora.engine.st.completed.add(screen.key); }
  document.querySelector('.t-banner')?.remove();
  return elabora.engine.screens.map((screen) => screen.id);
}
