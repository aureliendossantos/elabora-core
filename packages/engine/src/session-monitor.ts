import fs from 'node:fs';
import type { SessionStore } from './disk.ts';
import type { OpenOptions } from './session.ts';

// Longest wait at open for the store's watcher to report (FsStore gives up on its probe at 2 s).
const WATCH_READY_MS = 3000;

// What the watchers and the rescan timer report: the files to look at again, whether to list the
// folder or read the journal, and when. The session reconciles them, in its queue and under its lock.
export class SessionMonitor {
  readonly #dirty = new Set<string>();
  #rescanNeeded = false;
  #journalDirty = false;
  #debounceTimer: NodeJS.Timeout | null = null;
  #firstDirtyAt: number | null = null;
  #interval: NodeJS.Timeout | null = null;
  #unwatch: (() => void)[] = [];
  readonly #store: SessionStore;
  readonly #journalDir: string;
  readonly #options: OpenOptions;
  readonly #closing: () => boolean;
  readonly #refresh: () => Promise<void>;
  readonly #reportError: (error: unknown, context: string) => void;

  constructor(init: { store: SessionStore; journalDir: string; options: OpenOptions; closing: () => boolean; refresh: () => Promise<void>; reportError: (error: unknown, context: string) => void }) {
    this.#store = init.store;
    this.#journalDir = init.journalDir;
    this.#options = init.options;
    this.#closing = init.closing;
    this.#refresh = init.refresh;
    this.#reportError = init.reportError;
  }

  get needsRescan(): boolean { return this.#rescanNeeded; }
  requestRescan(): void { this.#rescanNeeded = true; }
  finishRescan(): void { this.#rescanNeeded = false; }
  requestJournal(): void { this.#journalDirty = true; }
  consumeJournal(): boolean { const dirty = this.#journalDirty; this.#journalDirty = false; return dirty; }
  observe(path: string): void { this.#dirty.add(path); }
  forget(path: string): void { this.#dirty.delete(path); }
  forgetAll(): void { this.#dirty.clear(); }
  pending(): string[] { return [...this.#dirty]; }
  // The paths to reconcile now, forgotten; observe brings back the ones that must wait.
  takePending(exclude: (path: string) => boolean): string[] {
    const paths = this.pending().filter((path) => !exclude(path));
    for (const path of paths) this.#dirty.delete(path);
    return paths;
  }

  // Watches the journal and the folder; resolves when the folder's watcher reports (3 s at most).
  async start(): Promise<void> {
    if (this.#options.watch !== false) {
      // The journal's watcher is a shortcut: what another Elabora tool journals it also writes in the
      // folder, whose watcher reports it, and the journal is read before the files. On macOS it
      // shares the process's FSEvents stream with the process's other watchers (a preview, other
      // projects), built again whenever one starts or stops; the folder's has a thread of its own
      // (FsStore), whose probe says when it reports.
      try {
        const watcher = fs.watch(this.#journalDir, () => this.#onJournal());
        watcher.on('error', (error) => this.#reportError(error, 'watching the journal'));
        this.#unwatch.push(() => watcher.close());
      } catch (error) {
        this.#reportError(error, 'watching the journal');
      }
      const store = this.#store;
      if (store.watch) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, WATCH_READY_MS); // a store that never says
          this.#unwatch.push(store.watch!((paths) => this.#onFiles(paths), () => {
            clearTimeout(timer);
            resolve();
          }));
        });
      }
      // What changed between reading the files and the watcher reporting them.
      this.#rescanNeeded = true;
      this.#journalDirty = true;
      this.schedule();
    }
    const rescanMs = this.#options.rescanIntervalMs ?? 15_000;
    if (rescanMs > 0) {
      const timer = setInterval(() => {
        this.#rescanNeeded = true;
        this.#journalDirty = true;
        this.schedule();
      }, rescanMs);
      timer.unref();
      this.#interval = timer;
    }
  }

  #onFiles(paths: string[]): void {
    if (this.#closing()) return;
    if (!paths.length) this.#rescanNeeded = true;
    for (const rel of paths) this.#dirty.add(rel);
    this.schedule();
  }

  #onJournal(): void {
    if (this.#closing()) return;
    this.#journalDirty = true;
    this.schedule();
  }

  // Waits for a quiet moment (a burst of writes becomes one change), at most maxDelayMs.
  schedule(delay?: number): void {
    if (this.#closing()) return;
    const now = Date.now();
    this.#firstDirtyAt ??= now;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    const quiet = delay ?? this.#options.debounceMs ?? 60;
    const wait = Math.max(0, Math.min(quiet, this.#firstDirtyAt + (this.#options.maxDelayMs ?? 600) - now));
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#firstDirtyAt = null;
      void this.#refresh().catch((error) => this.#reportError(error, 'reconciling changes'));
    }, wait);
  }

  // Looks again shortly at what could not be settled, unless a reconciliation is already waiting.
  scheduleRetry(): void {
    if (this.#closing() || this.#debounceTimer) return;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#refresh().catch((error) => this.#reportError(error, 'reconciling changes'));
    }, 250);
  }

  // Cancels the reconciliation waiting for a quiet moment (flush runs it now).
  clearScheduled(): void {
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = null;
    this.#firstDirtyAt = null;
  }

  stop(): void {
    for (const stop of this.#unwatch) stop();
    this.#unwatch = [];
    if (this.#interval) clearInterval(this.#interval);
    this.clearScheduled();
  }
}
