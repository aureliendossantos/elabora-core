import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, BrowserContextOptions, ElectronApplication, Page } from 'playwright-core';
import { localDataRoot } from '../data-dir.ts';

export interface ElectronRuntime {
  executable: string;
  // Development: the worker script. Packaged: the app entry dispatches this switch.
  entry?: string;
}

export const browserRuntimeFile = (): string => path.join(localDataRoot(), 'browser-runtime.json');

export function findElectronRuntime({ env = process.env, file = browserRuntimeFile() }: { env?: NodeJS.ProcessEnv; file?: string } = {}): ElectronRuntime | null {
  if (env.ELABORA_BROWSER === 'external') return null;
  if (env.ELABORA_ELECTRON_EXECUTABLE) return {
    executable: env.ELABORA_ELECTRON_EXECUTABLE,
    ...(env.ELABORA_ELECTRON_ENTRY ? { entry: env.ELABORA_ELECTRON_ENTRY } : {})
  };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.protocol !== 1 || typeof value.executable !== 'string' || !path.isAbsolute(value.executable) || !fs.existsSync(value.executable)) return null;
    // Only installed apps register here. Development workers are configured explicitly.
    return { executable: value.executable };
  } catch { return null; }
}

export interface BrowserIdentity { engine: string; version: string }
const identities = new WeakMap<Browser, BrowserIdentity>();
export function browserIdentity(browser: Browser): BrowserIdentity {
  return identities.get(browser) ?? { engine: browser.browserType().name(), version: browser.version() };
}
// The same, with the version of Elabora's Electron, which a worker tells once started (a page opened).
export async function openedBrowserIdentity(browser: Browser): Promise<BrowserIdentity> {
  if (!browserIdentity(browser).version) await (await browser.newPage()).close();
  return browserIdentity(browser);
}

// A worker's environment (its own temporary user data) and its command line.
function workerEnv(folder: string, headed: boolean): Record<string, string> {
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ELABORA_BROWSER_USER_DATA: folder, ELABORA_BROWSER_HEADED: headed ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}
const workerArgs = (runtime: ElectronRuntime): string[] => [...(runtime.entry ? [runtime.entry] : []), '--elabora-browser-worker'];

// How long a page may take to print (A4 pages of text: a fraction of a second).
const PRINT_TIMEOUT_MS = 60_000;

// A page (an HTML file) printed to PDF by Electron itself, webContents.printToPDF in a worker's main
// process, in an offscreen window of the given size: Electron's DevTools protocol has no
// Page.printToPDF, so Playwright's page.pdf() fails there. The app prints the plan's document the
// same way, with the same options and window (docs/decisions.md D48): the same Electron, the same bytes.
export async function printWithElectron(playwright: typeof import('playwright-core'), runtime: ElectronRuntime, file: string, options: object, size: { width: number; height: number }): Promise<{ pdf: Uint8Array; version: string }> {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-browser-'));
  let application: ElectronApplication;
  try {
    application = await playwright._electron.launch({ executablePath: runtime.executable, args: workerArgs(runtime), env: workerEnv(folder, false), timeout: 30000 });
  } catch (error) { fs.rmSync(folder, { recursive: true, force: true }); throw error; }
  const child = application.process();
  // A page that hangs or a renderer that stops cannot hold the command: the worker is stopped, its
  // evaluation fails.
  const deadline = setTimeout(() => child.kill('SIGKILL'), PRINT_TIMEOUT_MS);
  deadline.unref();
  try {
    const printed = await application.evaluate(async ({ app, BrowserWindow }, { file, options, size }) => {
      await app.whenReady();
      const window = new BrowserWindow({ show: false, ...size, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await window.loadFile(file);
        await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
        return { pdf: (await window.webContents.printToPDF(options)).toString('base64'), version: process.versions.chrome ?? '' };
      } finally { window.destroy(); }
    }, { file, options, size });
    return { pdf: new Uint8Array(Buffer.from(printed.pdf, 'base64')), version: printed.version };
  } finally {
    clearTimeout(deadline);
    // A worker that does not quit cannot hold the command.
    const force = setTimeout(() => child.kill('SIGKILL'), 3000);
    force.unref();
    await application.close().catch(() => {});
    clearTimeout(force);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

// Electron has no Target.createTarget or incognito browser contexts. Each test context therefore
// owns a separate worker with temporary user data. Playwright still drives its real pages/frames;
// only window creation and process lifetime are adapted. Killing one never kills the editor.
export async function launchElectron(playwright: typeof import('playwright-core'), runtime: ElectronRuntime, args: string[], headed: boolean): Promise<Browser> {
  const opened = new Set<BrowserContext>();
  const pending = new Set<Promise<BrowserContext>>();
  const events = new EventEmitter();
  let closed = false;
  const identity: BrowserIdentity = { engine: 'electron', version: '' };
  const makeContext = async (options: BrowserContextOptions = {}): Promise<BrowserContext> => {
    if (closed) throw new Error('The Elabora browser has been closed');
    // A worker's window is a desktop window: Playwright cannot turn its pages into a phone's (tap()
    // refuses a context launched without hasTouch), so a page asked for as one is refused, not given
    // a mouse and a fine pointer. Phones are emulated by an external Chromium (launchBrowser's channels).
    if (options.hasTouch || options.isMobile) throw new Error('Elabora’s browser cannot emulate a phone (hasTouch, isMobile): use an external Chromium');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-browser-'));
    const env = workerEnv(folder, headed);
    let application: ElectronApplication;
    try {
      application = await playwright._electron.launch({ executablePath: runtime.executable,
        args: [...workerArgs(runtime), ...args, ...(options.reducedMotion === 'reduce' ? ['--force-prefers-reduced-motion'] : [])], env, timeout: 30000,
        colorScheme: options.colorScheme, locale: options.locale,
        // Accepted unless refused, as in a context of Playwright's Chromium: Electron's own default is a
        // save dialog, which a hidden window never shows, and the page's download never comes.
        acceptDownloads: options.acceptDownloads ?? true });
    } catch (error) { fs.rmSync(folder, { recursive: true, force: true }); throw error; }
    const cleanup = () => fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    try {
      identity.version = await application.evaluate(async ({ app }) => { await app.whenReady(); return process.versions.chrome ?? ''; });
    } catch (error) {
      application.process().kill('SIGKILL');
      await cleanup();
      throw error;
    }
    const context = application.context();
    // A hidden window never has the focus: Tab moves nothing, focus events and :focus-visible never
    // come. Playwright emulates a focused page in every Chromium it launches, but not in Electron's
    // context; each page here gets the same, through a session kept for the page's life (an
    // emulation ends with its session).
    const focused = new WeakMap<Page, Promise<unknown>>();
    const emulateFocus = (page: Page): Promise<unknown> => {
      let pending = focused.get(page);
      if (!pending) {
        pending = context.newCDPSession(page).then(session => session.send('Emulation.setFocusEmulationEnabled', { enabled: true })).catch(() => {});
        focused.set(page, pending);
      }
      return pending;
    };
    // Offscreen popups start with a zero viewport on Windows until metrics are supplied.
    // Give every page the context's viewport, as well as its motion preference (Electron's
    // launch API exposes neither). newPage also awaits these before returning its page.
    context.on('page', page => {
      void page.setViewportSize(options.viewport ?? { width: 1280, height: 720 }).catch(() => {});
      if (options.reducedMotion) void page.emulateMedia({ reducedMotion: options.reducedMotion }).catch(() => {});
      void emulateFocus(page);
    });
    const closeContext = context.close.bind(context);
    const child = application.process();
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => closing ??= (async () => {
      // A renderer in an infinite loop cannot block worker cleanup indefinitely.
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      force.unref();
      try { await closeContext(); } finally {
        clearTimeout(force);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        opened.delete(context);
        await cleanup();
      }
    })();
    context.close = close;
    context.browser = () => browser;
    context.newPage = async () => {
      if (closing || closed) throw new Error('The Elabora browser context has been closed');
      const waiting = context.waitForEvent('page', { timeout: 30000 });
      // Handle rejection even if window creation fails before the wait is awaited.
      waiting.catch(() => {});
      await application.evaluate(({ BrowserWindow }, size) => {
        const window = new BrowserWindow({ show: process.env.ELABORA_BROWSER_HEADED === '1',
          // The page's size is the window's content (macOS would take a title bar's height off it).
          width: size.width, height: size.height, useContentSize: true,
          // Hidden native Windows windows can stop producing surfaces after a CDP capture.
          // Offscreen rendering keeps repeated captures and contrast measurements advancing.
          webPreferences: { offscreen: process.platform === 'win32' && process.env.ELABORA_BROWSER_HEADED !== '1',
            sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
        void window.loadURL('about:blank');
      }, options.viewport ?? { width: 1280, height: 720 });
      const page = await waiting;
      await page.setViewportSize(options.viewport ?? { width: 1280, height: 720 });
      if (options.reducedMotion) await page.emulateMedia({ reducedMotion: options.reducedMotion });
      await emulateFocus(page);
      if (options.deviceScaleFactor !== undefined && options.deviceScaleFactor !== 1) {
        const session = await context.newCDPSession(page);
        const viewport = page.viewportSize()!;
        await session.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: options.deviceScaleFactor, mobile: !!options.isMobile });
        await session.detach();
      }
      return page;
    };
    child.once('exit', () => { opened.delete(context); void cleanup().catch(() => {}); });
    opened.add(context);
    if (closed) { await close(); throw new Error('The Elabora browser has been closed'); }
    return context;
  };
  const newContext = (options?: BrowserContextOptions): Promise<BrowserContext> => {
    const promise = makeContext(options);
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  // This facade supplies the Browser operations used by Elabora; the contexts, pages, frames and
  // CDP sessions are Playwright's. Electron's own context.browser() otherwise returns null.
  const browser = {
    newContext,
    async newPage(options?: BrowserContextOptions) {
      const context = await newContext(options);
      try {
        const page = await context.newPage();
        const closePage = page.close.bind(page);
        page.close = async (closeOptions) => { try { await closePage(closeOptions); } finally { await context.close(); } };
        return page;
      } catch (error) { await context.close(); throw error; }
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled([...pending]);
      await Promise.allSettled([...opened].map(context => context.close()));
      events.emit('disconnected');
    },
    contexts: () => [...opened],
    version: () => identity.version,
    isConnected: () => !closed,
    browserType: () => playwright.chromium,
    on: events.on.bind(events), once: events.once.bind(events), off: events.off.bind(events)
  } as unknown as Browser;
  identities.set(browser, identity);
  return browser;
}
