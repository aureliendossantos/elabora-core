// The heavy tests' budget, one for the whole computer: a test that runs a browser, Electron, a video
// encoder or a model takes one of ELABORA_HEAVY_SLOTS slots (2 by default) and waits, in turn,
// while every slot is taken: by this core's e2e and matrix files, by the app's test:all scenarios,
// its try:, shoot:design and templates scripts and its browser test, whichever checkout or session
// runs them. Plain Node tests take none. ELABORA_HEAVY_SLOTS=0: no budget (each waits for nothing).
//
// A slot is a folder, slot-<n>, under ELABORA_HEAVY_SLOTS_DIR (the system's temporary folder by
// default), made with mkdir, which only one process wins; its owner.json names the process, its
// command and its folder. A slot whose process has ended (killed, crashed) is taken back by the next
// one that waits. Those that wait queue in queue/, by the time they asked: the first ones take the
// slots that free up, so that a run of many short checks does not starve a long one.
//
// A process that holds a slot hands it to what it starts: ELABORA_HEAVY_SLOT in their environment
// names the slot, and acquire() in a child, a grandchild, returns at once while the slot is still
// its holder's. So a try: script run by test:all, or the templates script run by try:templates, waits
// for nothing more.
//
// node --import ./scripts/heavy-slots.ts <script> takes a slot for <script>'s life (the app's
// package.json, for its heavy scripts); under node --test, for each test file's process, not for
// the runner's. Kept free of dependencies: the app imports this file from its sibling elabora-core.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = 1;
export const HELD = 'ELABORA_HEAVY_SLOT';

export function slotCount(): number {
  const count = Number(process.env.ELABORA_HEAVY_SLOTS ?? 2);
  return Number.isInteger(count) && count > 0 ? count : 2;
}

export function slotsDir(): string {
  return process.env.ELABORA_HEAVY_SLOTS_DIR ?? path.join(os.tmpdir(), `elabora-heavy-slots-v${VERSION}`);
}

export interface Owner { pid: number; token: string; label: string; cwd: string; since: number }
export interface Slot {
  /** The slot's folder, or null when the slot is a holder's up the process tree. */
  dir: string | null;
  /** What to put in a child's environment to hand it the slot. */
  env: Record<string, string>;
  /** How long it waited for the slot, in ms. */
  waited: number;
  release(): void;
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};
const readOwner = (dir: string): Owner | null => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) as Owner; } catch { return null; }
};
// A folder made but whose owner.json is not written yet is given a few seconds before it is called
// abandoned (its process died between the two).
const abandoned = (dir: string): boolean => {
  const owner = readOwner(dir);
  if (owner) return !alive(owner.pid);
  try { return Date.now() - fs.statSync(dir).mtimeMs > 10_000; } catch { return false; }
};

/** Who holds the slots now (for a message while one waits). */
export function holders(): Owner[] {
  const dir = slotsDir();
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((name) => /^slot-\d+$/.test(name)); } catch { /* no slot taken yet */ }
  return names.map((name) => readOwner(path.join(dir, name))).filter((owner): owner is Owner => !!owner && alive(owner.pid));
}

/** The slot held up the process tree, if ELABORA_HEAVY_SLOT names one that is still its holder's. */
function inherited(): Slot | null {
  const held = process.env[HELD];
  if (!held) return null;
  const [dir, token] = held.split('#');
  const owner = dir ? readOwner(dir) : null;
  if (!owner || owner.token !== token || !alive(owner.pid)) return null;
  return { dir: null, env: { [HELD]: held }, waited: 0, release: () => {} };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a slot of the computer's heavy tests and takes it. label says who takes it, in the
 * messages of those that wait. onWait is called once, when the slot is not free at once.
 */
export async function acquire(label: string, options: { onWait?: (holders: Owner[]) => void } = {}): Promise<Slot> {
  if (process.env.ELABORA_HEAVY_SLOTS === '0') return { dir: null, env: {}, waited: 0, release: () => {} };
  const handed = inherited();
  if (handed) return handed;
  const root = slotsDir();
  const queue = path.join(root, 'queue');
  fs.mkdirSync(queue, { recursive: true });
  const count = slotCount();
  const token = crypto.randomBytes(8).toString('hex');
  const started = Date.now();
  // Queued by the time asked (padded so that names sort by it), then pid and token.
  const ticket = path.join(queue, `${String(Date.now()).padStart(15, '0')}-${process.pid}-${token}`);
  fs.writeFileSync(ticket, '');
  let told = false;
  try {
    for (let round = 0; ; round++) {
      // The tickets ahead of this one whose process still lives.
      const ahead = fs.readdirSync(queue).sort().filter((name) => {
        if (path.join(queue, name) >= ticket) return false;
        const pid = Number(name.split('-')[1]);
        if (alive(pid)) return true;
        fs.rmSync(path.join(queue, name), { force: true });
        return false;
      }).length;
      const free: number[] = [];
      for (let n = 0; n < count; n++) {
        const dir = path.join(root, `slot-${n}`);
        if (!fs.existsSync(dir)) free.push(n);
        else if (abandoned(dir)) {
          // Taken back: renamed first, which only one of those that wait wins.
          const grave = `${dir}.ended-${token}`;
          try { fs.renameSync(dir, grave); fs.rmSync(grave, { recursive: true, force: true }); free.push(n); } catch { /* another took it back */ }
        }
      }
      if (ahead < free.length) {
        for (const n of free) {
          const dir = path.join(root, `slot-${n}`);
          try { fs.mkdirSync(dir); } catch { continue; }
          const owner: Owner = { pid: process.pid, token, label, cwd: process.cwd(), since: Date.now() };
          fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(owner));
          const release = () => {
            if (!held.delete(release)) return;
            if (readOwner(dir)?.token === token) fs.rmSync(dir, { recursive: true, force: true });
          };
          held.add(release);
          return { dir, env: { [HELD]: `${dir}#${token}` }, waited: Date.now() - started, release };
        }
      }
      if (!told && round > 0) { told = true; options.onWait?.(holders()); }
      await sleep(200 + Math.random() * 200);
    }
  } finally {
    fs.rmSync(ticket, { force: true });
  }
}

// The slots this process holds, given back when it exits. Ended by a signal, a process runs no 'exit'
// handler: they are given back first, then it ends as the signal would (unless something else
// listens for it, which then decides).
const held = new Set<() => void>();
const releaseAll = () => { for (const release of [...held]) release(); };
process.on('exit', releaseAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  const onSignal = () => {
    releaseAll();
    if (process.listenerCount(signal) === 1) { process.off(signal, onSignal); process.kill(process.pid, signal); }
  };
  process.on(signal, onSignal);
}

const describe = (owner: Owner) => `${owner.label} (pid ${owner.pid}, ${path.basename(path.dirname(owner.cwd))}/${path.basename(owner.cwd)})`;

// As node --import: a slot for the script's life. Under node --test, for each test file's process
// (NODE_TEST_CONTEXT; they get the runner's --import) that is an e2e, matrix or (the app's) desktop
// file (pnpm run test:file runs unit files too), never for the runner.
const preloaded = process.execArgv.some((arg, at) => /heavy-slots\.ts$/.test(arg) && (process.execArgv[at - 1] === '--import' || arg.startsWith('--import=')));
const testRunner = process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT;
const lightTestFile = !!process.env.NODE_TEST_CONTEXT && !/[\\/](e2e|matrix|desktop)[\\/][^\\/]+$/.test(process.argv[1] ?? '');
const asImport = preloaded && !testRunner && !lightTestFile;
if (asImport && process.env.ELABORA_HEAVY_SLOTS !== '0') {
  const label = path.relative(process.cwd(), process.argv[1] ?? '') || 'node';
  const slot = await acquire(label, { onWait: (taken) => process.stderr.write(`[heavy-slots] ${label} waits for a slot (${slotCount()}, taken by ${taken.map(describe).join(', ') || 'processes that end'})\n`) });
  if (slot.waited >= 1000) process.stderr.write(`[heavy-slots] ${label} waited ${(slot.waited / 1000).toFixed(1)} s for its slot\n`);
  Object.assign(process.env, slot.env);
}
