import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, LaunchOptions } from 'playwright-core';
import { CHROMIUM_CHANNELS, launchChromium } from '@elabora/node/emulator/browser';

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
