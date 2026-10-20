// A write right after a project opens: is the watcher's event there without the periodic listing?
// Opens sessions one after the other in one process, the earlier ones kept open (as the engine
// tests do, and as an app with several projects would), with the 15 s listing turned off; after the
// session's first look at the folder (flush), writes a screen and waits for the watcher's change.
//   node packages/engine/bench/watch-ready.ts [--sessions 40] [--load 4]
// --load starts busy processes, to see the window under load. Prints open times and missed writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openProject } from '../src/session.ts';
import type { Session } from '../src/session.ts';
import type { EngineEvent } from '../src/protocol.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EXAMPLE = path.join(ROOT, 'test/fixtures/format-0.1/diagnostic-reseau');
const args = process.argv.slice(2);
const option = (name: string, fallback: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const count = option('--sessions', 40);
const load = option('--load', 0);

if (process.env.WATCH_READY_BUSY) {
  for (;;) Math.sqrt(Math.random());
}
const busy = Array.from({ length: load }, () => fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, WATCH_READY_BUSY: '1' } }));

const sessions: Session[] = [];
const dirs: string[] = [];
const opens: number[] = [];
let missed = 0;
try {
  for (let i = 0; i < count; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-watch-ready-'));
    fs.cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !/[\\/](dist|\.elabora)([\\/]|$)/.test(src.slice(EXAMPLE.length)) });
    dirs.push(dir);
    const started = performance.now();
    const session = await openProject(dir, { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 });
    opens.push(performance.now() - started);
    sessions.push(session);
    const events: EngineEvent[] = [];
    session.subscribe(({ event }) => events.push(event));
    await session.flush();
    const file = path.join(dir, 'screens/accueil.json');
    const screen = JSON.parse(fs.readFileSync(file, 'utf8'));
    screen.title = `Écrit à l'ouverture ${i}`;
    fs.writeFileSync(file, `${JSON.stringify(screen, null, 2)}\n`);
    const deadline = Date.now() + 2000;
    while (!events.some((event) => event.type === 'changed' && event.source === 'watcher') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!events.some((event) => event.type === 'changed' && event.source === 'watcher')) missed++;
  }
} finally {
  for (const child of busy) child.kill();
  for (const session of sessions) await session.close().catch(() => {});
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}
const sorted = [...opens].sort((a, b) => a - b);
const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(0);
console.log(`${count} sessions, load ${load}: writes missed ${missed}; open median ${at(0.5)} ms, p90 ${at(0.9)} ms, max ${at(1)} ms`);
