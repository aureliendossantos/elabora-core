import fs from 'node:fs';
import type { FileInfo } from '@elabora/core/project/store';
import type { SessionStore } from './disk.ts';
import type { OpenOptions } from './session.ts';

// FsStore gives up on its probe at 2 s.
const WATCH_READY_MS = 3000;

// Observes the folder and journal; Session performs all queued, locked reconciliation.
export class SessionMonitor {
  readonly #dirty = new Set<string>();
  readonly #stats: Map<string, FileInfo>;
  #rescanNeeded = false;
  #journalDirty = false;
  #debounceTimer: NodeJS.Timeout | null = null;
  #firstDirtyAt: number | null = null;
  #interval: NodeJS.Timeout | null = null;
  #unwatch: (() => void)[] = [];
  readonly store: SessionStore;
  readonly journalDir: string;
  readonly options: OpenOptions;
  readonly closing: () => boolean;
  readonly refresh: () => Promise<void>;
  readonly reportError: (error: unknown, context: string) => void;
  constructor(store: SessionStore, journalDir: string, stats: Map<string, FileInfo>, options: OpenOptions, closing: () => boolean, refresh: () => Promise<void>, reportError: (error: unknown, context: string) => void) {
    this.store = store; this.journalDir = journalDir; this.#stats = stats; this.options = options; this.closing = closing; this.refresh = refresh; this.reportError = reportError;
  }
  get needsRescan(): boolean { return this.#rescanNeeded; }
  requestRescan(): void { this.#rescanNeeded = true; }
  finishRescan(): void { this.#rescanNeeded = false; }
  requestJournal(): void { this.#journalDirty = true; }
  consumeJournal(): boolean { const dirty = this.#journalDirty; this.#journalDirty = false; return dirty; }
  observe(path: string): void { this.#dirty.add(path); }
  observeAll(paths: Iterable<string>): void { for (const path of paths) this.#dirty.add(path); }
  forget(path: string): void { this.#dirty.delete(path); }
  forgetAll(): void { this.#dirty.clear(); }
  pending(): string[] { return [...this.#dirty]; }
  takePending(exclude: (path: string) => boolean): string[] {
    const paths = this.pending().filter((path) => !exclude(path));
    for (const path of paths) this.#dirty.delete(path);
    return paths;
  }
  stat(path: string): FileInfo | undefined { return this.#stats.get(path); }
  recordStat(path: string, info: FileInfo): void { this.#stats.set(path, info); }
  forgetStat(path: string): void { this.#stats.delete(path); }
  async start(): Promise<void> {
    if (this.options.watch !== false) {
      // The journal's watcher is a shortcut: what another Elabora tool journals it also writes in the
      // folder, whose watcher reports it, and the journal is read before the files. On macOS it
      // shares the process's FSEvents stream with the process's other watchers (a preview, other
      // projects), built again whenever one starts or stops; the folder's has a thread of its own
      // (FsStore), whose probe says when it reports.
      try {
        const watcher = fs.watch(this.journalDir, () => this.#onJournal());
        watcher.on('error', (error) => this.reportError(error, 'watching the journal'));
        this.#unwatch.push(() => watcher.close());
      } catch (error) {
        this.reportError(error, 'watching the journal');
      }
      const store = this.store;
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
    const rescanMs = this.options.rescanIntervalMs ?? 15_000;
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
    if (this.closing()) return;
    if (!paths.length) this.#rescanNeeded = true;
    for (const rel of paths) this.#dirty.add(rel);
    this.schedule();
  }

  #onJournal(): void {
    if (this.closing()) return;
    this.#journalDirty = true;
    this.schedule();
  }

  // Waits for a quiet moment (a burst of writes becomes one change), at most maxDelayMs.
  schedule(delay?: number): void {
    if (this.closing()) return;
    const now = Date.now();
    this.#firstDirtyAt ??= now;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    const quiet = delay ?? this.options.debounceMs ?? 60;
    const wait = Math.max(0, Math.min(quiet, this.#firstDirtyAt + (this.options.maxDelayMs ?? 600) - now));
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      this.#firstDirtyAt = null;
      void this.refresh().catch((error) => this.reportError(error, 'reconciling changes'));
    }, wait);
  }

  scheduleRetry(): void {
    if (this.closing() || this.#debounceTimer) return;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.refresh().catch((error) => this.reportError(error, 'reconciling changes'));
    }, 250);
  }

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
