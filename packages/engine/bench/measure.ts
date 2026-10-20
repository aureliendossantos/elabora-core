// Measures a session on a large course: open time (cold and warm hash caches), command → change
// event → diagnostics event, external edit → events, an edit of the elabora command in another process
// → event, memory. It edits the course: run it on a copy.
//   node scripts/make-large-course.ts /tmp/elabora-large-engine
//   node packages/engine/bench/measure.ts /tmp/elabora-large-engine [--rounds 30]
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openProject } from '../src/session.ts';
import type { Session } from '../src/session.ts';
import type { EngineEvent } from '../src/protocol.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const run = promisify(execFile);
const args = process.argv.slice(2);
const dir = path.resolve(args[0] ?? '/tmp/elabora-large-engine');
const roundsAt = args.indexOf('--rounds');
const rounds = roundsAt >= 0 ? Number(args[roundsAt + 1]) : 30;

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`;
// With --expose-gc, memory is measured after a collection: what the session keeps, not its garbage.
const collect = (globalThis as { gc?: () => void }).gc;
const memoryLine = (label: string, base?: NodeJS.MemoryUsage) => {
  collect?.();
  const now = process.memoryUsage();
  const delta = (key: 'rss' | 'heapUsed' | 'heapTotal') => (base ? ` (+${mb(now[key] - base[key])})` : '');
  console.log(`memory ${label}: rss ${mb(now.rss)}${delta('rss')}, heap used ${mb(now.heapUsed)}${delta('heapUsed')}, heap total ${mb(now.heapTotal)}${delta('heapTotal')}, peak rss ${mb(process.resourceUsage().maxRSS * 1024)}${collect ? '' : ' (run with --expose-gc to collect first)'}`);
  return now;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return `median ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms, max ${sorted[sorted.length - 1].toFixed(1)} ms (n=${sorted.length})`;
};

function listen(session: Session) {
  const events: { at: number; event: EngineEvent }[] = [];
  session.subscribe(({ event }) => events.push({ at: performance.now(), event }));
  const next = async (match: (event: EngineEvent) => boolean, since: number, timeoutMs = 10000): Promise<number> => {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const found = events.find(({ at, event }) => at >= since && match(event));
      if (found) return found.at;
      if (performance.now() > deadline) throw new Error(`timeout waiting for an event after ${since}`);
      await sleep(1);
    }
  };
  return { events, next };
}

const screens = fs.readdirSync(path.join(dir, 'screens')).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
console.log(`${dir}: ${screens.length} screens, ${mb(Number(fs.readdirSync(path.join(dir, 'assets/video')).reduce((n, name) => n + fs.statSync(path.join(dir, 'assets/video', name)).size, 0)))} of video`);

// Open, cold: no hash cache yet (every video is hashed once), and warm.
fs.rmSync(path.join(dir, '.elabora/cache'), { recursive: true, force: true });
const baseline = memoryLine('before opening');
for (const label of ['cold', 'warm']) {
  const started = performance.now();
  const session = await openProject(dir, { backups: { enabled: false, prune: false }, media: { enabled: false } });
  console.log(`open (${label} hash cache): ${(performance.now() - started).toFixed(0)} ms`);
  await session.close();
}

const openStarted = performance.now();
const session = await openProject(dir);
console.log(`open (all on: media queue, backup schedule): ${(performance.now() - openStarted).toFixed(0)} ms`);
const { next } = listen(session);
// The open version (the first one hashes and clones every file) and the media probes run in the background.
const versionStarted = performance.now();
await next((event) => event.type === 'backupTaken', 0, 120000).then((at) => console.log(`  first auto version in the background: ${(at - versionStarted).toFixed(0)} ms`), () => console.log('  (no version due on open)'));
await sleep(1500);
await session.flush({ rescan: true });
const afterOpen = memoryLine('after open', baseline);

// Commands: each adds or removes an image whose asset is missing, so the findings change.
const changed: number[] = [];
const validated: number[] = [];
const resolved: number[] = [];
for (let i = 0; i < rounds; i++) {
  const screen = screens[(i * 7) % screens.length];
  const id = `bench-${i}`;
  const started = performance.now();
  const result = await session.run('add_block', { screen, block: { id, type: 'image', props: { asset: `images/bench-${i}.svg`, alt: 'Bench' } } });
  resolved.push(performance.now() - started);
  const changeAt = await next((event) => event.type === 'changed' && event.change.id === result.change?.id, started);
  const diagnosticsAt = await next((event) => event.type === 'diagnostics' && screen in event.screens, started);
  changed.push(changeAt - started);
  validated.push(diagnosticsAt - started);
  await session.run('remove_block', { block: id });
}
console.log(`command → changed event: ${stats(changed)}`);
console.log(`command → diagnostics event: ${stats(validated)}`);
console.log(`command → run() resolved: ${stats(resolved)}`);
await sleep(500);

// External edits: a plain file write of a screen (an agent's own tools).
const external: number[] = [];
const externalDiagnostics: number[] = [];
for (let i = 0; i < Math.min(rounds, 20); i++) {
  const screen = screens[(i * 11 + 3) % screens.length];
  const file = path.join(dir, 'screens', `${screen}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.blocks.push({ id: `external-${i}`, type: 'image', props: { asset: `images/external-${i}.svg`, alt: 'External' } });
  const started = performance.now();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  const changeAt = await next((event) => event.type === 'changed' && event.source === 'watcher', started);
  const diagnosticsAt = await next((event) => event.type === 'diagnostics' && screen in event.screens, started);
  external.push(changeAt - started);
  externalDiagnostics.push(diagnosticsAt - started);
  await sleep(150);
}
console.log(`external write → changed event: ${stats(external)}`);
console.log(`external write → diagnostics event: ${stats(externalDiagnostics)}`);

// A project-level edit (course.json): everything is validated again.
const full: number[] = [];
for (let i = 0; i < 10; i++) {
  const started = performance.now();
  await session.run('update_course', { description: `Bench ${i}` });
  full.push(performance.now() - started);
}
console.log(`course.json edit (full validation) → run() resolved: ${stats(full)}`);

// The elabora command in another process: the session sees its change from the journal (often
// before the process has exited: it still prunes the project's data).
const cliEvent: number[] = [];
const cliExit: number[] = [];
for (let i = 0; i < 5; i++) {
  const started = performance.now();
  const child = run(process.execPath, [path.join(ROOT, 'bin/elabora.js'), 'block', 'duplicate', dir, `external-${i}`, '--id', `cli-copy-${i}`], { env: { ...process.env, ELABORA_AUTHOR: 'agent:bench' } });
  const at = await next((event) => event.type === 'changed' && event.source === 'journal' && event.change.author.name === 'bench' && event.change.command?.name === 'duplicate_block', started, 30000);
  await child;
  cliExit.push(performance.now() - started);
  cliEvent.push(at - started);
  await sleep(200);
}
console.log(`elabora CLI edit, from spawning it → changed event: ${stats(cliEvent)} (the process itself runs ${stats(cliExit)})`);

memoryLine(`after ${rounds * 2 + 30} commands and 20 external edits`, afterOpen);
const closing = performance.now();
const { version } = await session.close();
console.log(`close (close version ${version}): ${(performance.now() - closing).toFixed(0)} ms`);
