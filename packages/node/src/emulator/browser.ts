import { createRequire } from 'node:module';
import type { Browser, BrowserType, LaunchOptions } from 'playwright-core';
import { errorMessage } from '../util/values.ts';
import { findElectronRuntime, launchElectron } from './electron.ts';
export { browserIdentity } from './electron.ts';

const require = createRequire(import.meta.url);

// How Chrome treats unload handlers: its default, unload deprecated (as in Chrome and Edge since
// 22 Sept 2026), or still allowed.
export type UnloadVariant = 'default' | 'deprecated' | 'allowed';

// How Chromium draws: in software (SwiftShader: the same pixels on every machine, what visual
// baselines of free objects need), or with the machine's GPU when it has one (SwiftShader
// otherwise). Software also composites every page on the CPU: a capture of a designed screen takes
// seconds there and a fraction of a second on the GPU.
export type Rendering = 'software' | 'gpu';

// Browsers by motion setting, started when first asked for: pages that show the course with its
// animations off (the default of captures) come from a browser that prefers reduced motion as a
// whole (launchBrowser's reducedMotion), the others from one that does not (Chrome's flag is the
// process's). Callers still give each page its own reducedMotion too.
export interface MotionBrowsers {
  for(motion: boolean): Promise<Browser>;
  // The browsers started so far, closed.
  close(): Promise<void>;
}

export function launchMotionBrowsers(options: { rendering?: Rendering } = {}): MotionBrowsers {
  const started: { reduced?: Promise<Browser>; moving?: Promise<Browser> } = {};
  return {
    for(motion) {
      const key = motion ? 'moving' : 'reduced';
      started[key] ??= launchBrowser('chromium', { ...options, reducedMotion: !motion });
      return started[key];
    },
    async close() {
      await Promise.allSettled(Object.values(started).map(async (browser) => (await browser).close()));
    }
  };
}

// The Chromiums tried, in this order, the first that starts serving: the installed Google Chrome,
// then Microsoft Edge (on every Windows 10 and 11, sometimes on macOS: a tester's computer without
// Chrome), then the Chromium Playwright downloads (developers: npx playwright install chromium).
// Edge is Chromium with the same SwiftShader: the same flags work, and in software it draws
// Chrome's pixels, free objects' snapshots included (test/e2e/edge.test.ts).
export type ChromiumChannel = 'chrome' | 'msedge' | 'playwright';
export const CHROMIUM_CHANNELS: readonly ChromiumChannel[] = ['chrome', 'msedge', 'playwright'];
const CHANNEL_NAMES: Record<ChromiumChannel, string> = { chrome: 'Google Chrome', msedge: 'Microsoft Edge', playwright: 'Playwright’s Chromium' };

// Browser launcher shared by the emulator, object tests and previews.
// Chromium is the first of `channels` that starts; Firefox and WebKit need
// `npx playwright install firefox webkit`. WebGL works headless in both renderings.
export async function launchBrowser(name = 'chromium', options: { headed?: boolean; unload?: UnloadVariant; rendering?: Rendering; reducedMotion?: boolean; channels?: readonly ChromiumChannel[] } = {}): Promise<Browser> {
  const { headed = false, unload = 'default', rendering = 'software', reducedMotion = false, channels = CHROMIUM_CHANNELS } = options;
  // An optional dependency, loaded when a browser is needed.
  let playwright: typeof import('playwright-core');
  try { playwright = require('playwright-core'); } catch { throw new Error('playwright-core is not installed: npm install playwright-core'); }
  if (['chromium', 'electron', 'chrome', 'msedge', 'playwright'].includes(name)) {
    // reducedMotion: the whole browser prefers reduced motion. A page's own setting (Playwright's
    // reducedMotion, emulated media) does not reach an SVG shown through <img> or a CSS image: its
    // own document starts its animations from nothing, and a figure that draws itself is captured empty.
    const args = ['--enable-unsafe-swiftshader', ...(rendering === 'software' ? ['--use-angle=swiftshader'] : []), '--ignore-gpu-blocklist', ...(reducedMotion ? ['--force-prefers-reduced-motion'] : [])];
    // Sandboxed frames stay in the page's process: in their own process, full-page screenshots
    // leave free objects unpainted below the first viewport.
    const disabled = ['IsolateSandboxedIframes'];
    if (unload === 'deprecated') args.push('--enable-features=DeprecateUnload');
    if (unload === 'allowed') disabled.push('DeprecateUnload', 'DeprecateUnloadByAllowList');
    args.push(`--disable-features=${disabled.join(',')}`);
    const runtime = (name === 'electron' || (name === 'chromium' && options.channels === undefined)) ? findElectronRuntime() : null;
    if (runtime) return launchElectron(playwright, runtime, args, headed);
    if (name === 'electron') throw new Error('Elabora’s bundled browser is unavailable. Open the installed Elabora app once, then run the command again.');
    return launchChromium(playwright.chromium, name === 'chromium' ? channels : [name as ChromiumChannel], { headless: !headed, args });
  }
  if (name === 'firefox') return playwright.firefox.launch({ headless: !headed });
  if (name === 'webkit') return playwright.webkit.launch({ headless: !headed });
  throw new Error(`Unknown browser ${name}`);
}

// The first of the channels that starts, each launched with the same options. Read by whoever runs
// the command, often a tester's agent on a computer without developer tools: which browsers were
// looked for, and what to install.
export async function launchChromium(chromium: Pick<BrowserType, 'launch'>, channels: readonly ChromiumChannel[], options: LaunchOptions): Promise<Browser> {
  const missing: string[] = [];
  const failed: string[] = [];
  for (const channel of channels) {
    try {
      return await chromium.launch({ ...options, ...(channel === 'playwright' ? {} : { channel }) });
    } catch (error) {
      const reason = errorMessage(error).split('\n')[0].replace(/^browserType\.launch: /, '');
      if (!/is not found at|executable doesn't exist/i.test(reason)) failed.push(`${CHANNEL_NAMES[channel]} did not start (${reason})`);
      else if (channel !== 'playwright') missing.push(CHANNEL_NAMES[channel]);
    }
  }
  const absent = missing.length ? [`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed on this computer`] : [];
  const chromeFailed = channels.includes('chrome') && !missing.includes(CHANNEL_NAMES.chrome);
  const developers = channels.includes('playwright') ? ' (developers: npx playwright install chromium works too)' : '';
  throw new Error(`Cannot open a browser: ${[...absent, ...failed].join('; ') || 'no browser to try'}. ${chromeFailed ? 'Update or reinstall' : 'Install'} Google Chrome (https://www.google.com/chrome/), then run the command again${developers}.`);
}
