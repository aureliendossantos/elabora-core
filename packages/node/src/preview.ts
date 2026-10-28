import fs from 'node:fs';
import path from 'node:path';
import { build } from './build.ts';
import type { BuildResult, WebNavigation } from './build.ts';
import { startServer } from './emulator/server.ts';
import { projectDataDir } from './data-dir.ts';
import { escapeHtml } from '@elabora/core/util/html';
import { codeInfo } from '@elabora/core/diagnostics/codes';
import { getProfile, listProfiles, targetProfileIds } from '@elabora/core/lms/profiles';

export interface PreviewOptions {
  port?: number;
  profile?: string; // LMS profile of the emulator page (default: the course's first LMS, else unknown)
  navigation?: WebNavigation; // free: every screen open, whatever the course's rules (default authored)
  onRebuild?: (result: BuildResult) => void;
}

export interface Preview {
  result: BuildResult; // the first build
  urls: { standalone: string; lms: string };
  // The LMS the emulator page plays.
  profile: string;
  // The course's own navigation keeps screens closed (linear, or locked until complete): what free
  // navigation opens.
  readonly locks: boolean;
  readonly navigation: WebNavigation;
  // Built again with this navigation; its pages reload, on the screen they showed, with the same
  // learner (the Aperçu's « Déverrouiller la progression »: the course itself does not change).
  setNavigation(navigation: WebNavigation): Promise<BuildResult>;
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
// The emulator page plays the course's LMS (course.json delivery.lms, the first), launching the
// course in a frame as that LMS does (a frame in a frame for some); an LMS that opens it in a window
// of its own is played in a frame too.
export async function preview(dir: string, { port = 4807, profile, navigation: asked = 'authored', onRebuild }: PreviewOptions = {}): Promise<Preview> {
  const root = path.resolve(dir);
  const out = path.join(projectDataDir(root), 'preview');
  const chosen = profile ?? targetProfileIds(readCourse(root))[0];
  // An LMS Elabora has no profile for (the build says so): the unknown LMS.
  const lms = listProfiles().some((known) => known.id === chosen) ? chosen : 'unknown';
  let navigation = asked;
  const rebuild = () => build(root, { profiles: [lms], emit: 'dir', out, debug: true, writeLock: false, media: 'link', preview: true, ...(navigation === 'free' ? { navigation } : {}) });
  let last = await rebuild();
  const server = await startServer({ port, frames: true });
  const show = (result: BuildResult) => {
    if (result.dirPath) server.addPackage('preview', result.dirPath, result.media, { preview: true });
    else server.addPackage('preview', notBuiltPage(out, result), new Map(), { preview: true });
  };
  show(last);
  // One build at a time: a change and a new navigation wait for the build before them.
  let queue = Promise.resolve(last);
  const again = () => (queue = queue.then(async () => { last = await rebuild(); show(last); onRebuild?.(last); return last; }));
  const watched = ['course.json', 'plan.json', 'screens', 'objects', 'components', 'theme', 'assets'].map((name) => path.join(root, name)).filter((file) => fs.existsSync(file));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchers = watched.map((file) => fs.watch(file, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void again(), 250);
  }));
  const mode = getProfile(lms).launch.default === 'nested-iframe' ? 'nested-iframe' : 'iframe';
  return {
    result: last,
    urls: {
      standalone: `${server.base}/pkg/preview/index.html`,
      lms: `${server.base}/lms/launch.html?pkg=preview&profile=${lms}&mode=${mode}&reg=preview`
    },
    profile: lms,
    get locks() { return locks(readCourse(root)); },
    get navigation() { return navigation; },
    setNavigation: (next) => {
      if (next === navigation) return queue;
      navigation = next;
      return again();
    },
    close: async () => { clearTimeout(timer); for (const watcher of watchers) watcher.close(); await server.close(); }
  };
}

// course.json as it is (null when it cannot be read: the build says why).
function readCourse(root: string): { delivery?: { lms?: string[] }; navigation?: { mode?: string; lockUntilComplete?: boolean } } | null {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'course.json'), 'utf8')); } catch { return null; }
}

// Linear (the default) opens a screen once the one before it was seen; locked until complete, once
// it was completed.
function locks(course: ReturnType<typeof readCourse>): boolean {
  return (course?.navigation?.mode ?? 'linear') !== 'free' || course?.navigation?.lockUntilComplete === true;
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
