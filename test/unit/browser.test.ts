import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { Browser, LaunchOptions } from 'playwright-core';
import { CHROMIUM_CHANNELS, chromiumArgs, closingWithin, launchChromium } from '@elabora/node/emulator/browser';

// A Playwright chromium whose channels are installed or not, or fail to start: what each launch got.
function fakeChromium(installed: Record<string, 'starts' | string>) {
  const launches: LaunchOptions[] = [];
  const browser = { close: async () => {} } as unknown as Browser;
  return {
    launches,
    launch: async (options: LaunchOptions = {}) => {
      launches.push(options);
      const channel = options.channel ?? 'playwright';
      const state = installed[channel];
      if (state === 'starts') return browser;
      if (state) throw new Error(`browserType.launch: ${state}\nCall log: …`);
      if (channel === 'playwright') throw new Error('browserType.launch: Executable doesn\'t exist at /cache/chromium_headless_shell-1243/chrome-mac/headless_shell');
      throw new Error(`browserType.launch: Chromium distribution '${channel}' is not found at /Applications/${channel}\nRun "npx playwright install ${channel}"`);
    }
  };
}

const options = { headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--disable-features=IsolateSandboxedIframes'] };

test('Chromium is the installed Google Chrome, else Microsoft Edge, else Playwright’s Chromium, each launched with the same options', async () => {
  const chrome = fakeChromium({ chrome: 'starts', msedge: 'starts' });
  await launchChromium(chrome, CHROMIUM_CHANNELS, options);
  assert.deepEqual(chrome.launches, [{ ...options, channel: 'chrome' }]);

  const edge = fakeChromium({ msedge: 'starts', playwright: 'starts' });
  await launchChromium(edge, CHROMIUM_CHANNELS, options);
  assert.deepEqual(edge.launches, [{ ...options, channel: 'chrome' }, { ...options, channel: 'msedge' }]);

  const own = fakeChromium({ playwright: 'starts' });
  await launchChromium(own, CHROMIUM_CHANNELS, options);
  assert.deepEqual(own.launches.map((launch) => launch.channel), ['chrome', 'msedge', undefined]);
  assert.ok(own.launches.every((launch) => launch.args === options.args && launch.headless === true));

  // An order of one's own: Edge alone.
  const only = fakeChromium({ chrome: 'starts', msedge: 'starts' });
  await launchChromium(only, ['msedge'], options);
  assert.deepEqual(only.launches.map((launch) => launch.channel), ['msedge']);
});

test('without a browser, the message says which were looked for and to install Google Chrome, npx only as an aside', async () => {
  await assert.rejects(launchChromium(fakeChromium({}), CHROMIUM_CHANNELS, options), (error: Error) => {
    assert.equal(error.message, 'Cannot open a browser: Google Chrome and Microsoft Edge are not installed on this computer. Install Google Chrome (https://www.google.com/chrome/), then run the command again (developers: npx playwright install chromium works too).');
    return true;
  });
  // A browser that is there but does not start says why, without Playwright's call log.
  await assert.rejects(launchChromium(fakeChromium({ chrome: 'Target page, context or browser has been closed' }), CHROMIUM_CHANNELS, options), (error: Error) => {
    assert.equal(error.message, 'Cannot open a browser: Microsoft Edge is not installed on this computer; Google Chrome did not start (Target page, context or browser has been closed). Update or reinstall Google Chrome (https://www.google.com/chrome/), then run the command again (developers: npx playwright install chromium works too).');
    return true;
  });
  await assert.rejects(launchChromium(fakeChromium({}), ['msedge'], options), /^Error: Cannot open a browser: Microsoft Edge is not installed on this computer\. Install Google Chrome \(https:\/\/www\.google\.com\/chrome\/\), then run the command again\.$/);
});

test('every Chromium is started without scrollbars: a classic one takes 15 px of a 375 px page, and a capture then lacks them', () => {
  assert.deepEqual(chromiumArgs(), ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--force-prefers-no-reduced-motion', '--disable-features=IsolateSandboxedIframes']);
  for (const rendering of ['software', 'gpu'] as const) for (const unload of ['default', 'deprecated', 'allowed'] as const) for (const reducedMotion of [false, true]) {
    assert.ok(chromiumArgs({ rendering, unload, reducedMotion }).includes('--hide-scrollbars'), JSON.stringify({ rendering, unload, reducedMotion }));
  }
  assert.equal(chromiumArgs({ rendering: 'gpu' }).includes('--use-angle=swiftshader'), false);
  // Either way, never the computer's own setting.
  assert.ok(chromiumArgs({ reducedMotion: true }).includes('--force-prefers-reduced-motion') && !chromiumArgs({ reducedMotion: true }).includes('--force-prefers-no-reduced-motion'));
  assert.ok(chromiumArgs({ unload: 'deprecated' }).includes('--enable-features=DeprecateUnload'));
  assert.ok(chromiumArgs({ unload: 'allowed' }).includes('--disable-features=IsolateSandboxedIframes,DeprecateUnload,DeprecateUnloadByAllowList'));
});

test('elabora test runs fewer packages side by side on a loaded machine', async () => {
  const { defaultParallel } = await import('@elabora/node/emulator/run');
  assert.equal(defaultParallel(2, 10), 4);
  assert.equal(defaultParallel(6, 10), 2);
  assert.equal(defaultParallel(13, 10), 1);
});

test('a Chromium that is slow to end does not hold its close: past the grace, its process is ended', async () => {
  // A browser whose process (a Node that waits a minute) ends only when killed: Chrome 155 on macOS 27.2
  // took ten seconds once its pages were gone.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const ended = once(child, 'exit');
  const sent: string[] = [];
  const browser = closingWithin({
    isConnected: () => true,
    newBrowserCDPSession: async () => ({
      send: async (method: string) => { sent.push(method); return { processInfo: [{ type: 'renderer', id: 1 }, { type: 'browser', id: child.pid }] }; },
      detach: async () => {}
    }),
    close: async () => { await ended; }
  } as unknown as Browser, 200);
  const begin = Date.now();
  await browser.close();
  assert.ok(Date.now() - begin < 5000, `closed in ${Date.now() - begin} ms`);
  // Windows has no signals: process.kill ends the process at once (TerminateProcess, exit code 1) and Node reports no signal.
  if (process.platform === 'win32') assert.ok(child.exitCode !== null && child.exitCode !== 0, `exit code ${child.exitCode}`);
  else assert.equal(child.signalCode, 'SIGKILL');
  assert.deepEqual(sent, ['SystemInfo.getProcessInfo']);

  // One that ends within the grace is left to end, and one that cannot say its process closes as before.
  let kills = 0;
  const quick = closingWithin({ isConnected: () => true, newBrowserCDPSession: async () => ({ send: async () => ({ processInfo: [{ type: 'browser', id: 999999 }] }), detach: async () => {} }), close: async () => {} } as unknown as Browser, 200);
  const kill = process.kill;
  process.kill = ((...args: Parameters<typeof process.kill>) => { kills++; return kill(...args); }) as typeof process.kill;
  try {
    await quick.close();
    await closingWithin({ isConnected: () => false, close: async () => {} } as unknown as Browser, 200).close();
  } finally {
    process.kill = kill;
  }
  assert.equal(kills, 0);
});
