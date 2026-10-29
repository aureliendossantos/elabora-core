import fs from 'node:fs';
import path from 'node:path';
import { ACTIVITY_FILE, activityPath, parseActivity, readActivity } from '@elabora/node/activity';
import type { ActivityEntry } from '@elabora/node/activity';
import type { EngineEvent } from './protocol.ts';

// What agents do in the course (@elabora/node/activity), as they do it: the file next to the journal
// is watched, and each line appended goes to the window as an 'activity' event, which says it in
// words while the agent works, inside Elabora or in its own app. What was there before the session
// is read on request (recent). Nothing here changes the course.
export class SessionActivity {
  readonly #root: string;
  readonly #file: string;
  readonly #emit: (event: EngineEvent) => void;
  readonly #reportError: (error: unknown, context: string) => void;
  #offset = 0;
  #ino = 0;
  // The newest line sent: the file trimmed (a new file under the same name) keeps lines already sent.
  #lastAt = '';
  #reading: Promise<void> | null = null;
  #again = false;
  #unwatch: (() => void) | null = null;

  constructor(init: { root: string; emit: (event: EngineEvent) => void; reportError: (error: unknown, context: string) => void }) {
    this.#root = init.root;
    this.#file = activityPath(init.root);
    this.#emit = init.emit;
    this.#reportError = init.reportError;
  }

  // From the end of the file as it is: what comes next is news.
  start(watch: boolean): void {
    const stat = fs.statSync(this.#file, { throwIfNoEntry: false });
    if (stat) {
      this.#offset = stat.size;
      this.#ino = stat.ino;
      this.#lastAt = readActivity(this.#root, { limit: 1 })[0]?.at ?? '';
    }
    if (!watch) return;
    try {
      const watcher = fs.watch(path.dirname(this.#file), (_event, name) => {
        if (!name || name === ACTIVITY_FILE) this.poke();
      });
      watcher.on('error', (error) => this.#reportError(error, 'watching the agents\' activity'));
      this.#unwatch = () => watcher.close();
    } catch (error) {
      this.#reportError(error, 'watching the agents\' activity');
    }
  }

  // The file changed: reads what was appended (one read at a time, one more if it changed meanwhile).
  poke(): Promise<void> {
    if (this.#reading) {
      this.#again = true;
      return this.#reading;
    }
    this.#reading = (async () => {
      do {
        this.#again = false;
        const entries = await this.#read().catch((error) => { this.#reportError(error, 'reading the agents\' activity'); return []; });
        if (entries.length) this.#emit({ type: 'activity', entries });
      } while (this.#again);
    })().finally(() => { this.#reading = null; });
    return this.#reading;
  }

  async #read(): Promise<ActivityEntry[]> {
    const stat = await fs.promises.stat(this.#file).catch(() => null);
    if (!stat) return [];
    const replaced = stat.ino !== this.#ino || stat.size < this.#offset;
    if (replaced) this.#offset = 0;
    this.#ino = stat.ino;
    if (stat.size <= this.#offset) return [];
    const handle = await fs.promises.open(this.#file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - this.#offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.#offset);
      const end = bytesRead > 0 ? buffer.lastIndexOf(0x0a, bytesRead - 1) : -1;
      if (end < 0) return [];
      this.#offset += end + 1;
      const entries = parseActivity(buffer.subarray(0, end).toString('utf8'));
      const fresh = replaced ? entries.filter((entry) => entry.at > this.#lastAt) : entries;
      const last = fresh.at(-1);
      if (last && last.at > this.#lastAt) this.#lastAt = last.at;
      return fresh;
    } finally {
      await handle.close();
    }
  }

  // The last lines, for a window that opens while an agent works (or to put steps under its cards).
  recent(limit = 500): ActivityEntry[] {
    return readActivity(this.#root, { limit });
  }

  stop(): void {
    this.#unwatch?.();
    this.#unwatch = null;
  }
}
