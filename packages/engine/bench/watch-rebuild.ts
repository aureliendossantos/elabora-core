// Writes of an open project while other watchers of the process start and stop: are they all seen
// without the periodic listing? On macOS the watchers of a process share one FSEvents stream, built
// again whenever one starts or stops (D23). Opens a project (the 15 s listing off); another process
// (an agent) writes a new file in it about every millisecond; meanwhile this process starts and
// stops a preview of the project, or opens and closes another project, again and again. At the end,
// the files the session never saw were lost by the watcher.
//   node packages/engine/bench/watch-rebuild.ts [--mode preview|session|none] [--cycles 10] [--hold 300] [--gap 300]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { openProject } from '../src/session.ts';

// The preview is imported by a name the compiler does not follow: its page scripts need the DOM
// types, which the engine's compilation leaves out.
const PREVIEW = '@elabora/node/preview';
const { preview } = await import(PREVIEW) as { preview: (dir: string, options: { port: number }) => Promise<{ close(): Promise<void> }> };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EXAMPLE = path.join(ROOT, 'test/fixtures/format-0.1/diagnostic-reseau');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const mode = option('--mode', 'preview');
const cycles = Number(option('--cycles', '10'));
const hold = Number(option('--hold', '300'));
const gap = Number(option('--gap', '300'));
const SESSION = { backups: { enabled: false, onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 } as const;

// The agent: a new file about every millisecond until told to stop, then how many it wrote.
if (process.env.WATCH_REBUILD_WRITER) {
  const dir = path.join(process.env.WATCH_REBUILD_WRITER, 'notes');
  let stop = false;
  process.on('message', () => { stop = true; });
  let written = 0;
  while (!stop) {
    fs.writeFileSync(path.join(dir, `w-${written}.md`), `# ${written}\n`);
    written++;
    await sleep(1);
  }
  process.send!(written);
  process.exit(0);
}

const copy = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-watch-rebuild-'));
  fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(src.slice(EXAMPLE.length)) });
  fs.mkdirSync(path.join(dir, 'notes'));
  return dir;
};
const dirs = [copy(), copy()];
const [dir, other] = dirs;
const session = await openProject(dir, SESSION);
await session.flush();
const writer = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, WATCH_REBUILD_WRITER: dir } });
const started = performance.now();
try {
  await sleep(200);
  for (let i = 0; i < cycles; i++) {
    if (mode === 'preview') {
      const running = await preview(dir, { port: 0 });
      await sleep(hold);
      await running.close();
    } else if (mode === 'session') {
      const opened = await openProject(other, SESSION);
      await sleep(hold);
      await opened.close();
    } else {
      await sleep(hold);
    }
    await sleep(gap);
  }
  const written = await new Promise<number>((resolve) => {
    writer.once('message', (count) => resolve(Number(count)));
    writer.send('stop');
  });
  const seconds = (performance.now() - started) / 1000;
  // What the watcher reported is reconciled; nothing is listed.
  await sleep(1000);
  await session.flush();
  const missed: number[] = [];
  for (let n = 0; n < written; n++) if (!session.files.has(`notes/w-${n}.md`)) missed.push(n);
  console.log(`${mode}, ${cycles} cycles: ${written} files written in ${seconds.toFixed(1)} s; never reported ${missed.length}${missed.length ? ` (${runs(missed)})` : ''}`);
} finally {
  writer.kill();
  await session.close().catch(() => {});
  for (const folder of dirs) fs.rmSync(folder, { recursive: true, force: true });
}

// 3, 4, 5, 9 → "3-5, 9": the lost writes come in runs, one per rebuild of the stream.
function runs(values: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < values.length; i++) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    parts.push(i === j ? `${values[i]}` : `${values[i]}-${values[j]}`);
    i = j;
  }
  return parts.join(', ');
}
