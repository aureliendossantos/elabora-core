import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { launchBrowser } from '@elabora/node/emulator/browser';

// A page of a browser (ELABORA_BROWSER: chromium, firefox, webkit) whose origin has a private file
// system, as an author's has: Playwright's WebKit has none in a throwaway profile, so it gets a profile
// on disk, removed when the page closes. ELABORA_PRIVATE=1: a private window's instead (WebKit's
// context without a profile, Firefox's private browsing; Chromium's context is always off the record).
export async function pageWithStorage(name: string): Promise<{ page: Page; close(): Promise<void> }> {
  if (process.env.ELABORA_PRIVATE === '1' && (name === 'webkit' || name === 'firefox')) {
    const playwright = await import('playwright-core');
    const browser = name === 'webkit' ? await playwright.webkit.launch() : await playwright.firefox.launch({ firefoxUserPrefs: { 'browser.privatebrowsing.autostart': true } });
    return { page: await (await browser.newContext()).newPage(), close: () => browser.close() };
  }
  if (name !== 'webkit') {
    const browser = await launchBrowser(name);
    return { page: await browser.newPage(), close: () => browser.close() };
  }
  const { webkit } = await import('playwright-core');
  webkitBefore = new Set(processes().filter((row) => WEBKIT.test(row.command)).map((row) => row.pid));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-webkit-'));
  const context = await webkit.launchPersistentContext(profile, {});
  return {
    page: context.pages()[0] ?? await context.newPage(),
    close: async () => { await context.close(); fs.rmSync(profile, { recursive: true, force: true }); }
  };
}

// What the app's host serves its pages with (C105): the page isolated, so that onnxruntime-web runs
// on several threads.
export const ISOLATED = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp' };

// The page's origin emptied of what an earlier run kept: WebKit under macOS keeps an origin's private
// file system outside the profile it is given, so a new profile still finds it.
export async function emptyStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // A private window has no private file system: nothing kept there.
    const root = await navigator.storage.getDirectory().catch(() => null);
    if (root) for await (const name of (root as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) await root.removeEntry(name, { recursive: true });
    for (const { name } of await indexedDB.databases()) if (name) indexedDB.deleteDatabase(name);
  });
}

// Playwright's WebKit runs its pages in XPC services that launchd starts, not under the browser: known
// by their path, those that were not there before this process launched its WebKit (another WebKit
// started meanwhile would be counted too).
const WEBKIT = /ms-playwright\/webkit-[^/]+\/com\.apple\.WebKit\./;
let webkitBefore: Set<number> | null = null;

const processes = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' }).trim().split('\n').map((row) => {
  const [pid, ppid, rss, ...command] = row.trim().split(/\s+/);
  return { pid: Number(pid), ppid: Number(ppid), rss: Number(rss), command: command.join(' ') };
});

// The memory of the browser this process started, at its peak: the resident memory of every process
// under this one, and of its WebKit's services, summed (pages they share counted in each), sampled
// every quarter of a second. mark(name) starts a phase: phases() says each one's peak and its last
// sample, in MB.
export function watchMemory(): { mark(name: string): void; phases(): { name: string; peak: number; end: number }[]; stop(): number } {
  let peak = 0;
  const phases: { name: string; peak: number; end: number }[] = [{ name: 'start', peak: 0, end: 0 }];
  const sample = () => {
    const rows = processes();
    const children = new Map<number, number[]>();
    for (const { pid, ppid } of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    const rss = new Map(rows.map(({ pid, rss: kb }) => [pid, kb]));
    let total = 0;
    const walk = (pid: number) => { for (const child of children.get(pid) ?? []) { total += rss.get(child) ?? 0; walk(child); } };
    walk(process.pid);
    if (webkitBefore) for (const row of rows) if (WEBKIT.test(row.command) && !webkitBefore.has(row.pid)) total += row.rss;
    peak = Math.max(peak, total);
    const phase = phases.at(-1)!;
    phase.peak = Math.max(phase.peak, total);
    phase.end = total;
  };
  sample();
  const timer = setInterval(sample, 250);
  const mb = (kb: number) => Math.round(kb / 1024);
  return {
    mark: (name) => { sample(); phases.push({ name, peak: 0, end: 0 }); sample(); },
    phases: () => phases.map((phase) => ({ name: phase.name, peak: mb(phase.peak), end: mb(phase.end) })),
    stop: () => { clearInterval(timer); sample(); return mb(peak); }
  };
}
