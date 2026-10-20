import fs from 'node:fs';
import path from 'node:path';
import type { BlockLayout } from '@elabora/player/canvas-protocol';
import type { ReadyReport } from './emulator/page-globals.ts';
import type { ImageType } from './preview.ts';
import type { BrowserIdentity } from './emulator/electron.ts';
import type { StyleConflict } from './style-cascade.ts';
import type { MotionReport } from './motion-report.ts';
import { projectDataDir } from './data-dir.ts';
import { codeVersion } from './code-version.ts';

// The client side of looks (look.ts): what elabora look and the MCP tool elabora_look need to find the
// look server of a project, start it, and ask it for a look. Light on purpose: a look command
// starts in a tenth of a second, without the build, the validator or the browser.

export interface LookRequest {
  screen?: string; // default: the screen of the last look, else the first screen of the course
  width?: number; // default 1600
  height?: number; // default 900
  // 'answered': every activity shows its tallest outcome and concealed blocks are shown.
  state?: 'initial' | 'answered';
  step?: number; // steps revealed up to this one (default: all)
  layer?: string; // a layer opened over the screen (the window is captured)
  // A narrated screen as it is when a line starts: "l2" (or ends: "l2:end"), its caption shown; the
  // window is captured, with the bar.
  at?: string;
  // A contact sheet of a timed screen: one capture of the window per mark (its start, each block
  // that comes or goes, each cue, each step's end: @elabora/core timelineMarks), captioned.
  sheet?: boolean;
  language?: string; // a translation (default: the course language)
  full?: boolean; // the whole page (default), or the window
  motion?: boolean; // animations on (default: reduced motion, transitions settled)
  // The window scrolled to a position, animations on: px ("1800"), a percentage of the page ("100%"),
  // or a block's id (the block in view). Several, or with sheet on a screen without a timeline: a
  // filmstrip down the page (default 0, 25, 50, 75 and 100 %).
  scroll?: string[];
  // A close-up: the capture cropped to this block (with a small margin), in view (scrolled to it
  // unless scroll says where). With scroll, motion or block, the result says what moves (motion).
  block?: string;
  scale?: 1 | 2; // a close-up drawn at twice its size
  // Actions played in order inside the frame of the free object block before the capture (parseLookAction).
  act?: string[];
  // JPEG by default (PNG for a close-up up to 2 megapixels): designed pages (textures, gradients) take seconds to encode as PNG.
  type?: ImageType;
}

// An action on a free object (elabora look --act): click:<text>, click:role=<role>[name=<name>],
// key:<key> (Playwright's names: Enter, ArrowRight, a), drag:x,y->x,y (0 to 1 across the object).
export type LookAction =
  | { kind: 'click'; source: string; text?: string; role?: string; name?: string }
  | { kind: 'key'; source: string; key: string }
  | { kind: 'drag'; source: string; from: [number, number]; to: [number, number] };

export function parseLookAction(source: string): LookAction | { error: string } {
  const [, kind = '', rest = ''] = /^([a-z]+):(.*)$/s.exec(source.trim()) ?? [];
  if (kind === 'click' && rest.trim()) {
    const role = /^role=([a-z]+)(?:\[name=(.+)\])?$/.exec(rest.trim());
    if (role) return { kind, source, role: role[1], ...(role[2] ? { name: role[2] } : {}) };
    return { kind, source, text: rest.trim() };
  }
  if (kind === 'key' && rest.trim()) return { kind, source, key: rest.trim() };
  const share = '(0|1|0?\\.\\d+|1\\.0+)';
  const drag = new RegExp(`^${share},${share}->${share},${share}$`).exec(rest.replace(/\s+/g, ''));
  if (kind === 'drag' && drag) return { kind, source, from: [Number(drag[1]), Number(drag[2])], to: [Number(drag[3]), Number(drag[4])] };
  return { error: `Action "${source}": click:<text>, click:role=<role>[name=<name>], key:<key> or drag:x,y->x,y (0 to 1 across the object).` };
}

export type LookResult =
  | {
    ok: true;
    screen: string;
    width: number;
    height: number;
    state: 'initial' | 'answered';
    step: number | null;
    layer: string | null;
    presentation: 'scroll' | 'slides';
    type: ImageType;
    image: Buffer;
    // Free objects of the screen, and how many frames started for this look (new blocks, or their
    // code or assets changed); the others kept running.
    objects: ReadyReport['objects'];
    started: number;
    // Length of the page; overflow: px of scrolling (a slide that does not fit at this size).
    page: { height: number; windows: number; overflow: number };
    // Where every block is, in px of the page.
    blocks: BlockLayout[];
    // With sheet: the marks captured, in the order of the sheet.
    marks?: { time: number; label: string }[];
    // Down the page (scroll, sheet): where the window stood, px from the top, for each capture.
    scrolled?: { top: number; label: string }[];
    // A close-up: the part of the page captured (px of the page) and its scale.
    clip?: { x: number; y: number; width: number; height: number; scale: number };
    // What moves and where the blocks are in the window (scroll, block, motion: motion-report.ts).
    motion?: MotionReport;
    // After act: the object's state (getState) and the events it emitted during the actions.
    act?: { actions: string[]; state: unknown; events: { name: string; payload: unknown }[] };
    // Component rules the theme overrides, theme rules a component overrides (style-cascade.ts,
    // D32), as the page shows the screen: W_STYLE_COMPONENT_OVERRIDDEN, W_STYLE_THEME_UNDER_COMPONENT.
    styles: StyleConflict[];
    consoleErrors: string[];
    browser?: BrowserIdentity;
    ms: number;
  }
  | { ok: false; error: string };

export interface LookServerInfo {
  pid: number;
  base: string;
  token: string;
  url: string; // the page that follows the looks (Looker.url)
  // The code the server runs (codeVersion): a command whose own differs stops it and starts another.
  version: string;
  root: string;
}

export const TOKEN_HEADER = 'x-elabora-look';
export const lookFolder = (root: string): string => path.join(projectDataDir(path.resolve(root)), 'look');
export const lookServerFile = (root: string): string => path.join(lookFolder(root), 'server.json');

// The look server of a project, when one answers.
export async function findLookServer(dir: string): Promise<LookServerInfo | null> {
  let info: LookServerInfo;
  try { info = JSON.parse(fs.readFileSync(lookServerFile(dir), 'utf8')) as LookServerInfo; } catch { return null; }
  try {
    const response = await fetch(`${info.base}/look/info`, { headers: { [TOKEN_HEADER]: info.token }, signal: AbortSignal.timeout(3000) });
    return response.ok ? info : null;
  } catch {
    return null;
  }
}

// A look through the project's look server, started first (start: spawns `elabora look --serve`)
// when none answers or it runs other code than this command's (another version of Elabora, or the same
// version edited since: a server started by older code would go on rendering with it).
export async function lookThroughServer(dir: string, request: LookRequest, { start, timeoutMs = 120_000 }: { start: () => void; timeoutMs?: number }): Promise<{ result: LookResult; server: LookServerInfo }> {
  const server = await ensureLookServer(dir, start);
  const response = await fetch(`${server.base}/look/shot`, { method: 'POST', headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`The look server answered ${response.status}: ${await response.text()}`);
  const answer = await response.json() as Exclude<LookResult, { ok: true }> | (Omit<Extract<LookResult, { ok: true }>, 'image'> & { image: string });
  const result: LookResult = answer.ok ? { ...answer, image: Buffer.from(answer.image, 'base64') } : answer;
  return { result, server };
}

export async function ensureLookServer(dir: string, start: () => void, { waitMs = 30_000 }: { waitMs?: number } = {}): Promise<LookServerInfo> {
  const root = path.resolve(dir);
  const found = await findLookServer(root);
  if (found && found.version === codeVersion()) return found;
  if (found) {
    await stopLookServer(root);
    // One that does not stop when asked (stuck, or too old to answer the stop): its process, by its pid.
    const stuck = await findLookServer(root);
    if (stuck) {
      const alive = () => { try { process.kill(stuck.pid, 0); return true; } catch { return false; } };
      try { process.kill(stuck.pid); } catch { /* gone already */ }
      // Its own handler of the signal is the stop that did not work: killed for good after a grace.
      for (const begin = Date.now(); Date.now() - begin < 3000 && alive(); ) await new Promise((resolve) => setTimeout(resolve, 100));
      if (alive()) try { process.kill(stuck.pid, 'SIGKILL'); } catch { /* gone */ }
      fs.rmSync(lookServerFile(root), { force: true });
    }
  }
  fs.mkdirSync(lookFolder(root), { recursive: true });
  // One start at a time: looks asked for together wait for the server the first one starts.
  const starting = path.join(lookFolder(root), 'starting');
  const claim = () => { try { fs.writeFileSync(starting, String(process.pid), { flag: 'wx' }); return true; } catch { return false; } };
  let mine = claim();
  if (!mine && Date.now() - (fs.statSync(starting, { throwIfNoEntry: false })?.mtimeMs ?? 0) > waitMs) {
    fs.rmSync(starting, { force: true });
    mine = claim();
  }
  try {
    if (mine) start();
    for (const begin = Date.now(); Date.now() - begin < waitMs; await new Promise((resolve) => setTimeout(resolve, 100))) {
      const started = await findLookServer(root);
      if (started) return started;
    }
  } finally {
    if (mine) fs.rmSync(starting, { force: true });
  }
  throw new Error(`The look server did not start in ${waitMs / 1000} s: see ${path.join(lookFolder(root), 'server.log')}.`);
}

// Stops the project's look server; false when none answered.
export async function stopLookServer(dir: string): Promise<boolean> {
  const server = await findLookServer(dir);
  if (!server) return false;
  await fetch(`${server.base}/look/stop`, { method: 'POST', headers: { [TOKEN_HEADER]: server.token }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
  // Until it no longer answers.
  for (const begin = Date.now(); Date.now() - begin < 10_000 && await findLookServer(dir); ) await new Promise((resolve) => setTimeout(resolve, 100));
  return true;
}
