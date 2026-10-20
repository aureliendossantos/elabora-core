import fs from 'node:fs';
import path from 'node:path';
import { createRenderContext, renderScreen } from '@elabora/core/render/screen';
import type { RenderedScreen } from '@elabora/core/render/screen';
import { screenOrder } from '@elabora/core/project/load';
import type { Project } from '@elabora/core/project/model';
import { canonicalJSON, sha256 } from '@elabora/core/util/json';
import { projectDataDir } from './data-dir.ts';
import { isRecord } from './util/values.ts';
import type { BrowserIdentity } from './emulator/electron.ts';

// The fit of each screen, kept in the project's machine-local data (.elabora/cache/fit/) with what
// it was measured from: a screen whose key is unchanged is not measured again. The key is what a
// measure depends on: the screen as the player shows it (renderScreen: its course data, the
// stylesheets, the outline of the bars, and the hash of every file it loads: images, fonts, objects'
// code and frames), the code that measures and runs it (codeVersion: player included), the browser,
// the system, the window size and its role, and the presentation.

// What fit reads of a course: its presentation and its screens, in learner order.
export interface FitCourse { presentation: { mode?: 'scroll' | 'slides'; fit?: { reference?: string; minimum?: string } }; ids: string[] }

// Each screen of a course folder rendered as the player shows it, for its key; null when
// the course does not render (the build then says why).
export function screenRenders(project: Project): (FitCourse & { renders: Map<string, RenderedScreen> }) | null {
  try {
    const context = createRenderContext(project);
    const ids = screenOrder(project).map((entry) => entry.id).filter((id) => project.screens.has(id));
    const renders = new Map(ids.map((id) => [id, renderScreen(project, id, {}, context)]));
    return { presentation: context.head.presentation || {}, ids, renders };
  } catch {
    return null;
  }
}

export interface FitKeyParts {
  render: RenderedScreen;
  code: string;
  browser: BrowserIdentity;
  size: string;
  role: string;
  mode: string;
  platform?: string; // default: this system (its fonts and its rendering)
}

export function fitKey({ render, code, browser, size, role, mode, platform = `${process.platform}-${process.arch}` }: FitKeyParts): string {
  // The build id is the canvas's ('canvas'), not the package's: it says nothing of the screen.
  const { build: _build, ...course } = render.course;
  return sha256(canonicalJSON({ render: { ...render, course }, code, browser, size, role, mode, platform }));
}

export interface KeptFit<Fit> {
  key: string;
  at: string; // when it was measured
  fit: Fit;
}

const keptFile = (projectDir: string, size: string, role: string, screen: string) => path.join(projectDataDir(projectDir), 'cache', 'fit', `${role}-${size}`, `${screen}.json`);

export function readKeptFit<Fit>(projectDir: string, size: string, role: string, screen: string): KeptFit<Fit> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(keptFile(projectDir, size, role, screen), 'utf8'));
    return isRecord(value) && typeof value.key === 'string' && typeof value.at === 'string' && isRecord(value.fit) ? value as unknown as KeptFit<Fit> : null;
  } catch { return null; }
}

export function writeKeptFit<Fit>(projectDir: string, size: string, role: string, screen: string, kept: KeptFit<Fit>): void {
  const file = keptFile(projectDir, size, role, screen);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(kept)}\n`);
}
