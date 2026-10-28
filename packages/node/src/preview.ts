import fs from 'node:fs';
import path from 'node:path';
import { build } from './build.ts';
import type { BuildResult } from './build.ts';
import { startServer } from './emulator/server.ts';
import { projectDataDir } from './data-dir.ts';
import { escapeHtml } from '@elabora/core/util/html';
import { codeInfo } from '@elabora/core/diagnostics/codes';

export interface PreviewOptions {
  port?: number;
  profile?: string; // LMS profile of the emulator page
  onRebuild?: (result: BuildResult) => void;
}

export interface Preview {
  result: BuildResult; // the first build
  urls: { standalone: string; lms: string };
  close(): Promise<void>;
}

// Live preview: rebuilds on every change and serves both the standalone player and the LMS emulator;
// its pages reload after each rebuild, on the screen they showed. Free objects load from a second
// port of the server (@elabora/player frames.ts), so browser panes that refuse frames of an opaque
// origin (the in-app browsers of agent apps) show them.
// Media are never copied: they are served from the project folder (masters), with range requests,
// and media a job is still writing show a placeholder until the job is done.
// The course shows with the errors that only stop a delivery (BuildOptions.preview); when it
// cannot be built at all, the pages say why, and show it once a change builds.
export async function preview(dir: string, { port = 4807, profile = 'unknown', onRebuild }: PreviewOptions = {}): Promise<Preview> {
  const root = path.resolve(dir);
  const out = path.join(projectDataDir(root), 'preview');
  const rebuild = () => build(root, { profiles: [profile], emit: 'dir', out, debug: true, writeLock: false, media: 'link', preview: true });
  let last = await rebuild();
  const server = await startServer({ port, frames: true });
  const show = (result: BuildResult) => {
    if (result.dirPath) server.addPackage('preview', result.dirPath, result.media, { preview: true });
    else server.addPackage('preview', notBuiltPage(out, result), new Map(), { preview: true });
  };
  show(last);
  const watched = ['course.json', 'plan.json', 'screens', 'objects', 'components', 'theme', 'assets'].map((name) => path.join(root, name)).filter((file) => fs.existsSync(file));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers = watched.map((file) => fs.watch(file, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { last = await rebuild(); show(last); onRebuild?.(last); }, 250);
  }));
  return {
    result: last,
    urls: {
      standalone: `${server.base}/pkg/preview/index.html`,
      lms: `${server.base}/lms/launch.html?pkg=preview&profile=${profile}&mode=iframe&reg=preview`
    },
    close: async () => { for (const watcher of watchers) watcher.close(); await server.close(); }
  };
}

// The page of a preview whose course cannot be built: the errors that stop it, in a folder next to
// the package's. Its server adds the reload of preview pages.
function notBuiltPage(out: string, result: BuildResult): string {
  const errors = result.diagnostics.filter((d) => d.severity === 'error' && !d.waived);
  const stopping = errors.some((d) => !d.rule) ? errors.filter((d) => !d.rule) : errors;
  const items = stopping.map((d) => `<li><strong>${escapeHtml(codeInfo(d.code).title)}</strong>${d.file ? ` <code>${escapeHtml(d.file)}</code>` : ''}<br>${escapeHtml(d.message)}</li>`);
  const dir = path.join(out, 'not-built');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Preview not built</title>
<style>body { font: 15px/1.5 system-ui, sans-serif; margin: 40px; max-width: 760px; color: #2c2a27; } li { margin: 0 0 12px; } code { font-size: 13px; }</style>
</head>
<body>
<h1>${stopping.length === 1 ? 'An error is preventing' : 'Errors are preventing'} this course from being shown</h1>
<p>Please ask your agent to fix ${stopping.length === 1 ? 'this error' : 'these errors'}:</p>
<ul>${items.join('\n')}</ul>
</body>
</html>
`);
  return dir;
}
