import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Browser, Page } from 'playwright-core';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { startCanvasHost } from '@elabora/node/canvas/host';
import type { CanvasHost } from '@elabora/node/canvas/host';
import { launchBrowser } from '@elabora/node/emulator/browser';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { CanvasApi } from '@elabora/player/canvas';
import type { CanvasMessage } from '@elabora/player/canvas-protocol';
import { EXAMPLE } from '../helpers.ts';

type CanvasWindow = Window & typeof globalThis & { __elaboraCanvas: CanvasApi };

// What the canvas answers about what it shows, asked both ways a host has: by the Node host (the
// desktop app's offscreen pages: a question as a server-sent event, the answer by POST), and by
// postMessage from the page that embeds it (the web app's).
// A question of the host to the page: the page's own waits (3 s for the render, 4 s for its objects) are by timers a
// page busy starting a free object's WebGL in software delays by many seconds on a loaded computer, so the test
// waits for the answer as long as a failing run may take, and only a page that never answers fails it.
const PATIENT = { timeoutMs: 120000 };

async function withCanvas(run: (canvas: { host: CanvasHost; page: Page; project: ReturnType<typeof loadProjectFromDir>; context: ReturnType<typeof createRenderContext>; browser: Browser }) => Promise<void>) {
  const project = loadProjectFromDir(EXAMPLE);
  const context = createRenderContext(project, { fields: true });
  const host = await startCanvasHost({ root: project.root });
  const browser = await launchBrowser('chromium');
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    await page.goto(host.url);
    await page.waitForFunction(() => (window as CanvasWindow).__elaboraCanvas);
    await run({ host, page, project, context, browser });
  } finally {
    await browser.close();
    await host.close();
  }
}

test('canvas asks: by the Node host, a render shown and ready, its texts measured, a block previewed then cleared, a mark put and taken away', { timeout: 120000 }, async () => {
  await withCanvas(async ({ host, page, project, context }) => {
    const screen = project.screens.get('accueil')!.data;
    host.push(renderScreen(project, 'accueil', {}, context), { id: 'one' });
    assert.equal(await host.ask('shown', { id: 'one' }, PATIENT), true);
    // A render that never comes: false once the canvas has waited for it (3 s).
    assert.equal(await host.ask('shown', { id: 'never' }, PATIENT), false);

    // The sizes of the texts the canvas marks are the layout's, and the page's overflow its own.
    const measure = (await host.ask('measure', { id: 'one' }, PATIENT))!;
    const layout = await page.evaluate(() => (window as CanvasWindow).__elaboraCanvas.layout());
    const expected = layout.blocks.flatMap((block) => (block.fields ?? []).map((field) => ({ block: block.id, path: field.path, width: field.rect.width, height: field.rect.height })));
    assert.ok(expected.length > 0);
    assert.deepEqual(measure.fields, expected);
    assert.equal(measure.overflow, await page.evaluate(() => Math.max(0, Math.round(document.documentElement.scrollHeight - innerHeight))));
    assert.equal(await host.ask('measure', { id: 'not shown' }, PATIENT), null);

    // A block previewed: where it is, the blocks beside it faded; cleared, as they were and at the top.
    const block = screen.blocks[0]!.id;
    const other = screen.blocks[1]!.id;
    const opacity = (id: string) => page.evaluate((target) => getComputedStyle(document.querySelector(`#t-main .t-block[data-block="${target}"]`)!).opacity, id);
    const preview = (await host.ask('block-preview', { id: 'one', block, slides: false }, PATIENT))!;
    assert.ok(preview.block && preview.block.width > 0 && preview.block.height > 0, JSON.stringify(preview));
    assert.equal(preview.overflow, false);
    assert.equal(await opacity(other), '0.32');
    assert.equal(await opacity(block), '1');
    assert.equal(await host.ask('block-preview-clear', { id: 'one' }, PATIENT), true);
    assert.equal(await opacity(other), '1');
    assert.equal(await page.evaluate(() => scrollY), 0);
    // A block that is not on the screen has no box.
    assert.equal((await host.ask('block-preview', { id: 'one', block: 'no-such-block', slides: false }, PATIENT))!.block, null);

    // The mark: a square in the corner of the colour asked, then none.
    assert.equal(await host.ask('mark', { rgb: [19, 245, 135] }, PATIENT), true);
    assert.equal(await page.evaluate(() => { const mark = document.getElementById('elabora-drawn'); return mark && getComputedStyle(mark).backgroundColor; }), 'rgb(19, 245, 135)');
    assert.equal(await host.ask('mark', { rgb: null }, PATIENT), true);
    assert.equal(await page.evaluate(() => document.getElementById('elabora-drawn')), null);
  });
});

test('canvas asks: by postMessage, the page that embeds the canvas asks the same and is answered; another window, or a message without the token, is not', { timeout: 120000 }, async () => {
  await withCanvas(async ({ host, project, context, browser }) => {
    const token = new URL(host.url).searchParams.get('token')!;
    const app = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    // The app's page: localhost, another origin than the canvas (127.0.0.1), with the canvas in a frame, and a second frame that is not its parent.
    const page = `<!doctype html><iframe id="canvas" src="${host.url}" style="width:1280px;height:700px"></iframe><iframe id="other" srcdoc="<p>other</p>"></iframe>`;
    const server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(page));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await app.addInitScript(() => {
      const received: unknown[] = [];
      (window as unknown as { received: unknown[] }).received = received;
      addEventListener('message', (event) => { received.push(event.data); });
    });
    await app.goto(`http://localhost:${(server.address() as { port: number }).port}/`);
    await app.waitForFunction(() => (window as unknown as { received: { type?: string }[] }).received.some((message) => message.type === 'elabora/ready'));
    const render = renderScreen(project, 'accueil', {}, context);
    // The render itself by postMessage, as the web app does.
    const post = (message: Record<string, unknown>, from: 'parent' | 'other' = 'parent') => app.evaluate(({ message, from }) => {
      const target = (document.getElementById('canvas') as HTMLIFrameElement).contentWindow!;
      if (from === 'parent') target.postMessage(message, '*');
      else ((document.getElementById('other') as HTMLIFrameElement).contentWindow as unknown as { eval(code: string): void }).eval(`parent.frames[0].postMessage(${JSON.stringify(message)}, '*')`);
    }, { message, from });
    const answer = async (request: number) => {
      const handle = await app.waitForFunction((wanted) => (window as unknown as { received: { type?: string; request?: number }[] }).received.find((message) => message.type === 'elabora/answer' && message.request === wanted), request, { timeout: 120000 });
      return (await handle.jsonValue()) as Extract<CanvasMessage, { type: 'elabora/answer' }>;
    };
    await post({ type: 'elabora/render', id: 'by-message', token, render });
    await post({ type: 'elabora/ask', request: 1001, token, ask: 'shown', params: { id: 'by-message' } });
    assert.deepEqual(await answer(1001), { type: 'elabora/answer', request: 1001, result: true });
    await post({ type: 'elabora/ask', request: 1002, token, ask: 'measure', params: { id: 'by-message' } });
    const measured = (await answer(1002)) as { result: { overflow: number; fields: unknown[] } };
    assert.ok(measured.result.fields.length > 0);
    // The same question by the other way gets the same answer (the page's answer reaches its parent too: a host that uses both numbers its questions apart).
    host.push(render, { id: 'by-message' });
    assert.deepEqual(await host.ask('measure', { id: 'by-message' }, PATIENT), measured.result);

    // Not answered: no token, the wrong token, a window that is not the page's parent, a question that is malformed.
    await post({ type: 'elabora/ask', request: 1003, ask: 'shown', params: { id: 'by-message' } });
    await post({ type: 'elabora/ask', request: 1004, token: 'wrong', ask: 'shown', params: { id: 'by-message' } });
    await post({ type: 'elabora/ask', request: 1005, token, ask: 'shown', params: { id: 'by-message' } }, 'other');
    await post({ type: 'elabora/ask', request: 1006, token, ask: 'mark', params: { rgb: ['red'] } });
    await post({ type: 'elabora/ask', request: 1007, token, ask: 'nothing', params: {} });
    // One answered after them says the others had their turn.
    await post({ type: 'elabora/ask', request: 1008, token, ask: 'shown', params: { id: 'by-message' } });
    assert.deepEqual(await answer(1008), { type: 'elabora/answer', request: 1008, result: true });
    const silent = await app.evaluate(() => (window as unknown as { received: { type?: string; request?: number }[] }).received.filter((message) => message.type === 'elabora/answer').map((message) => message.request));
    assert.deepEqual(silent.filter((request) => request! >= 1000), [1001, 1002, 1008]);
    server.close();
  });
});
