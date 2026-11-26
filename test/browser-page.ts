import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { launchBrowser } from '@elabora/node/emulator/browser';

// A page of a browser (ELABORA_BROWSER: chromium, firefox, webkit) whose origin has a private file
// system, as an author's has: Playwright's WebKit has none in a throwaway profile, so it gets a profile
// on disk, removed when the page closes.
export async function pageWithStorage(name: string): Promise<{ page: Page; close(): Promise<void> }> {
  if (name !== 'webkit') {
    const browser = await launchBrowser(name);
    return { page: await browser.newPage(), close: () => browser.close() };
  }
  const { webkit } = await import('playwright-core');
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
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) await root.removeEntry(name, { recursive: true });
    for (const { name } of await indexedDB.databases()) if (name) indexedDB.deleteDatabase(name);
  });
}
