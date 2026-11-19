import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { bundleForBrowser } from '../browser-bundle.ts';
import { FAILED, range, type DrawOptions } from '../sync/convergence.ts';

// The convergence bench (test/sync/bench.ts) in a Worker of Chromium, as a browser engine will run the
// core's copy of a project: bundled for a browser without Node (test/browser-bundle.ts), the same draws
// as in Node give the same verdicts. A few hundred draws; Node runs them by thousands.
const DRAWS = Number(process.env.ELABORA_SYNC_BROWSER_DRAWS ?? 300);
const ORIGIN = 'http://bench.elabora.test';

test('sync bench in a browser\'s Worker: alone, copies that converge, a stale write merged from its version', { timeout: 600_000 }, async () => {
  const worker = await bundleForBrowser({ file: 'test/sync/convergence-worker.ts' });
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage();
    await page.route(`${ORIGIN}/**`, (route) => {
      const asked = new URL(route.request().url()).pathname;
      return asked === '/worker.js'
        ? route.fulfill({ contentType: 'text/javascript', body: worker.code })
        : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>bench</title>' });
    });
    await page.goto(`${ORIGIN}/`);
    await page.evaluate(() => {
      const w = new Worker('/worker.js', { type: 'module' });
      (window as unknown as { draw: unknown }).draw = (seeds: number[], options: unknown) => new Promise((resolve) => {
        w.onmessage = ({ data }) => resolve(data);
        w.onerror = (event) => resolve({ error: event.message });
        w.postMessage({ seeds, options });
      });
    });
    const draw = async (seeds: number[], options: DrawOptions = {}): Promise<string[]> => {
      const answer = await page.evaluate(([s, o]) => (window as unknown as { draw: (seeds: number[], options: DrawOptions) => Promise<{ failures?: string[]; error?: string }> }).draw(s, o), [seeds, options] as const);
      assert.equal(answer.error, undefined, answer.error);
      return answer.failures!;
    };
    assert.deepEqual(await draw(range(1, 30), { solo: true }), []);
    assert.deepEqual(await draw([...FAILED, ...range(1000, DRAWS)]), []);
    assert.ok((await draw(range(1, 60), { external: 'current' })).some((failure) => failure.includes('-files) replaced')));
  } finally {
    await browser.close();
  }
});
