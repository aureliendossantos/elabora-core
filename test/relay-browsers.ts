import { chromium, firefox, webkit } from 'playwright-core';
import type { Browser, Frame, Page } from 'playwright-core';
import { launchChromium } from '@elabora/node/emulator/browser';
import type { Hosts } from './relay-hosts.ts';
import { CANVAS, FRAMES } from './relay-site.ts';

// The browsers of the relay's tests, on the app's names through the hosts' proxy. Playwright's Chromium and WebKit, and its Firefox
// (driven by Juggler: a page there is not controlled by a service worker after its first load, and a frame of another origin that a
// worker answers for shows as about:blank: the relay's scenario in Firefox is the WebDriver BiDi script of the web canvas report).
// ── Browsers ────────────────────────────────────────────────────────────────────────────────────
export async function launch(name: string, hosts: Hosts): Promise<Browser | null> {
  const proxy = { server: `http://127.0.0.1:${hosts.proxyPort}` };
  try {
    if (name === 'chromium') {
      // Playwright turns off Chrome's partitioning of a frame's storage by its top site; its own list again, without it.
      const features = '--disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints';
      return await launchChromium(chromium, ['playwright'], { headless: true, proxy, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', `--ignore-certificate-errors-spki-list=${hosts.spki}`, features] });
    }
    if (name === 'webkit') return await webkit.launch({ headless: true, proxy });
    if (name === 'firefox') return await firefox.launch({ headless: true, proxy });
  } catch (error) {
    console.log(`# ${name} did not start here: ${String(error).split('\n')[0]}`);
  }
  return null;
}

export const canvasFrame = (page: Page): Frame => page.frames().find((frame) => frame.url().startsWith(`${CANVAS}/canvas/index.html`))!;
export const objectFrames = (page: Page): Frame[] => page.frames().filter((frame) => frame.url().startsWith(`${FRAMES}/canvas/objects/`));

