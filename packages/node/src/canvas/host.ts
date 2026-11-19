import crypto from 'node:crypto';
import { pipeline, Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RenderedFileKind, RenderedScreen } from '@elabora/core/render/screen';
import type { AnswerMessage, AskMessage, AskName, CanvasAsks, HostMessage, RenderView, ScreenRender } from '@elabora/player/canvas-protocol';
import { startServer } from '../emulator/server.ts';
import type { RouteHandler } from '../emulator/server.ts';
import { runtimeFiles, runtimeBundle, vendorThree, canvasPageHtml } from '../bundles.ts';
import { screenRenderOf } from '@elabora/core/render/screen';
import { parseRange, relayPathOf, relayRequestOf, relayResponse } from '@elabora/player/relay-protocol';
import type { RelayAnswer, RelayRange } from '@elabora/player/relay-protocol';
import { errorMessage } from '../util/values.ts';
import { mimeType } from './files.ts';
import { folderRelaySource } from './source.ts';

// The Node host of the editor canvas: what the engine drives. It serves, under /canvas/:
//   index.html                the canvas page (elabora/player.css, elabora/canvas.js, the connector)
//   elabora/…                   the player stylesheet, canvas.js, object-frame.js, three.js
//   elabora/events              render data, as server-sent events (push sends them), and the host's
//                             questions about what is on screen (ask)
//   elabora/answer              POST: a page's answer to one of them (with the page's token)
//   objects/<id>/frame.html   generated, object.js bundled from the object's folder (cached)
//   any other path            a file of the project folder that a render listed (assets, stylesheet
//                             files, fonts, object assets), the audio of a narration line
//                             (assets/narration/<language>/<screen>/<line>.m4a) or a sound of the
//                             course (assets/sounds/<id>.<ext>, D67), which the editor plays
//                             whatever the screen shown, streamed with range requests
// The page sits where the root of a package sits, so the paths of the course data resolve as in a
// package. Nothing is copied: media come from the project folder.

export interface CanvasHostOptions {
  // The project folder.
  root: string;
  // Unminified bundles (default true: readable stacks in the app's developer tools).
  debug?: boolean;
  // What messages posted to the page must carry (default: random); in the page URL.
  token?: string;
}

export interface CanvasHandler {
  readonly token: string;
  // The page, relative to the prefix the handler serves.
  readonly page: string;
  // Pages connected to the event stream.
  readonly pages: number;
  // Serves /canvas/…: a route of the emulator server, or of any Node HTTP server.
  handle: RouteHandler;
  // Sends render data to every connected page (and to pages that connect later); returns how many
  // got it. Its files may be served from then on.
  push(render: RenderedScreen, options?: { id?: string | number }): number;
  // Changes what the pages show of the screen (step, layer, state) without new data.
  view(view: Partial<RenderView>, options?: { id?: string | number }): number;
  // Asks the pages what is on screen (canvas-protocol.ts, CanvasAsks): the question goes to every page
  // connected (or, with none, to the first that connects); the first answer is the result. Rejects after
  // timeoutMs (default 30 s), when the host closes, or when every page it went to is gone.
  ask<Name extends AskName>(ask: Name, params: CanvasAsks[Name]['params'], options?: { timeoutMs?: number }): Promise<CanvasAsks[Name]['result']>;
  // Ends the event streams.
  close(): void;
}

export interface CanvasHost extends Omit<CanvasHandler, 'close'> {
  // http://127.0.0.1:<port>
  base: string;
  // The canvas page, with its token.
  url: string;
  close(): Promise<void>;
}

const PREFIX = '/canvas/';
const ANSWER_LIMIT = 1024 * 1024;
// A page waits 3 s for the render and 4 s for its images and objects, by timers of its own: a page whose main
// thread is busy (a free object's WebGL starting in software, 20 s or more on a loaded computer) answers late, not never.
// The wait here is a watchdog for a page that does not answer, not the page's own bound.
const ASK_TIMEOUT_MS = 30000;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

// The connector of the page served by this host: render data arrives as server-sent events, answers leave by POST.
const CONNECT_SCRIPT = `// Connects the canvas page to its Node host: messages arrive as server-sent events, answers leave by POST.
(function () {
  var token = new URLSearchParams(location.search).get('token') || '';
  var source = new EventSource('elabora/events');
  source.onmessage = function (event) { window.__elaboraCanvas.receive(JSON.parse(event.data)); };
  // The answers to the host's questions go back by POST.
  window.__elaboraCanvas.onMessage(function (message) {
    if (message.type !== 'elabora/answer') return;
    fetch('elabora/answer?token=' + encodeURIComponent(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) }).catch(function () {});
  });
})();
`;

interface Page {
  response: ServerResponse;
  // Hash of the styles it has: unchanged styles are left out of what it is sent.
  styles: string;
}

export function createCanvasHandler({ root, debug = true, token = crypto.randomBytes(16).toString('hex') }: CanvasHostOptions): CanvasHandler {
  const pages = new Set<Page>();
  // Project files the renders listed, by path: the only ones served.
  const allowed = new Map<string, RenderedFileKind>();
  let last: { id?: string | number; render: ScreenRender } | null = null;
  // The questions waiting for an answer, by request number.
  const asked = new Map<number, { message: AskMessage; to: Set<Page>; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  let requests = 0;
  let language = 'en';
  // What the folder answers of the relay's questions: the files the renders listed, an object's frame and code.
  const source = folderRelaySource({ root, debug, allowed: () => allowed, language: () => language });
  const runtime = new Map<string, Promise<string | Buffer>>();

  const send = (page: Page, message: HostMessage) => { page.response.write(`data: ${JSON.stringify(message)}\n\n`); };
  const sendRender = (page: Page, id: string | number | undefined, render: ScreenRender) => {
    const known = !!render.styles && render.styles.hash === page.styles;
    if (render.styles) page.styles = render.styles.hash;
    send(page, { type: 'elabora/render', ...(id !== undefined ? { id } : {}), render: known ? { ...render, styles: undefined } : render });
  };

  function runtimeFile(name: string): Promise<string | Buffer> | null {
    const known = runtime.get(name);
    if (known) return known;
    let file: Promise<string | Buffer> | null = null;
    if (name === 'elabora/canvas.js') file = runtimeBundle('canvas.ts', { minify: !debug });
    else if (name === 'elabora/canvas-connect.js') file = Promise.resolve(CONNECT_SCRIPT);
    else if (name === 'elabora/player.css' || name === 'elabora/object-frame.js') file = runtimeFiles({ debug }).then((files) => files[name]);
    else if (name.startsWith('elabora/vendor/')) { const vendor = vendorThree()[name]; file = vendor ? Promise.resolve(vendor) : null; }
    if (file) runtime.set(name, file);
    return file;
  }

  async function answer(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const text = (status: number, body: string) => { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(body); };
    // Only this computer's pages, by name: a page of another site that rebinds a name to 127.0.0.1
    // must not read the project.
    if (!LOCAL_HOST.test(request.headers.host ?? '')) return text(403, 'forbidden');
    let name: string;
    try { name = decodeURIComponent(url.pathname).slice(PREFIX.length); } catch { return text(400, 'bad path'); }
    if (name === 'elabora/answer') return takeAnswer(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed');
    if (name === '' || name === 'index.html') { response.writeHead(200, { 'content-type': mimeType('index.html'), 'cache-control': 'no-store' }).end(canvasPageHtml()); return; }
    if (name === 'elabora/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      response.write('retry: 500\n\n');
      const page: Page = { response, styles: '' };
      pages.add(page);
      request.on('close', () => {
        pages.delete(page);
        // A question only this page had is not left for the next: it would reach a page that did not exist when it was asked.
        for (const waiting of asked.values()) {
          if (!waiting.to.delete(page) || waiting.to.size > 0) continue;
          clearTimeout(waiting.timer);
          asked.delete(waiting.message.request);
          waiting.reject(new Error(`The page went away before answering "${waiting.message.ask}"`));
        }
      });
      if (last) sendRender(page, last.id, last.render);
      for (const waiting of asked.values()) { send(page, waiting.message); waiting.to.add(page); }
      return;
    }
    const runtimeContent = name.startsWith('elabora/') ? runtimeFile(name) : null;
    if (runtimeContent) {
      const content = await runtimeContent;
      response.writeHead(200, { 'content-type': mimeType(name), 'cache-control': 'no-cache' }).end(request.method === 'HEAD' ? undefined : content);
      return;
    }
    const path = relayPathOf(url.pathname);
    if (path === null) return text(404, 'not found');
    const range = parseRange(request.headers.range);
    const answered = await source.get(relayRequestOf(path, range));
    sendAnswer(request, response, answered, range);
  }

  // The answer to a question as HTTP (relayResponse, which the relay's service worker uses too): 200, 206 for a range,
  // 304 when the page has the file, and what a refusal says.
  function sendAnswer(request: IncomingMessage, response: ServerResponse, answered: RelayAnswer, range: RelayRange | null): void {
    const head = request.method === 'HEAD';
    let http = relayResponse(answered, range, head);
    const etag = http.headers.etag;
    const cache = etag ? 'no-cache' : 'no-store';
    if (etag && request.headers['if-none-match'] === etag) { response.writeHead(304, { etag, 'cache-control': cache }).end(); return; }
    const ifRange = request.headers['if-range'];
    if (etag && ifRange && ifRange !== etag && range) http = relayResponse(answered, null, head);
    if (http.body === null && http.status !== 416 && !(head && http.status < 300)) {
      const words = answered.status === 'ok' ? 'unavailable' : answered.message && answered.status === 'failed' ? answered.message : { 'not-found': 'not found', refused: 'forbidden', unavailable: 'unavailable', failed: 'failed' }[answered.status];
      response.writeHead(http.status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(words);
      return;
    }
    response.writeHead(http.status, { ...http.headers, 'cache-control': cache });
    if (http.body === null || http.body.size === 0) { response.end(); return; }
    // A page that seeks closes the stream it no longer needs: nothing to report then.
    pipeline(Readable.fromWeb(http.body.stream() as import('node:stream/web').ReadableStream), response, () => {});
  }

  // A page's answer, posted with its token: it settles the question it names (one that is settled or
  // gone is ignored).
  async function takeAnswer(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const text = (status: number, body: string) => { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(body); };
    // Only JSON (a page of another site cannot post it without a preflight, which this host does not answer), and only with the token of the pages it serves.
    if (request.method !== 'POST' || !/^application\/json\b/i.test(request.headers['content-type'] ?? '')) return text(405, 'method not allowed');
    const given = Buffer.from(url.searchParams.get('token') ?? '');
    const wanted = Buffer.from(token);
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return text(403, 'forbidden');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > ANSWER_LIMIT) return text(413, 'too large');
      chunks.push(chunk as Buffer);
    }
    let answer: Partial<AnswerMessage> | null;
    try { answer = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Partial<AnswerMessage> | null; } catch { return text(400, 'bad json'); }
    const waiting = answer && answer.type === 'elabora/answer' && typeof answer.request === 'number' ? asked.get(answer.request) : undefined;
    if (waiting && answer) {
      clearTimeout(waiting.timer);
      asked.delete(waiting.message.request);
      if ('error' in answer && typeof answer.error === 'string') waiting.reject(new Error(answer.error));
      else waiting.resolve('result' in answer ? answer.result : null);
    }
    response.writeHead(204, { 'cache-control': 'no-store' }).end();
  }

  return {
    token,
    page: `index.html?token=${token}`,
    get pages() { return pages.size; },
    handle: (request, response, url) => answer(request, response, url).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(errorMessage(error));
    }),
    push(render, { id } = {}) {
      for (const file of render.files) allowed.set(file.path, file.kind);
      language = render.course.language;
      last = { ...(id !== undefined ? { id } : {}), render: screenRenderOf(render) };
      for (const page of pages) sendRender(page, id, render);
      return pages.size;
    },
    view(view, { id } = {}) {
      if (last) last = { ...last, render: { ...last.render, view: { ...last.render.view, ...view } } };
      for (const page of pages) send(page, { type: 'elabora/view', ...(id !== undefined ? { id } : {}), view });
      return pages.size;
    },
    ask(ask, params, { timeoutMs = ASK_TIMEOUT_MS } = {}) {
      const message = { type: 'elabora/ask', request: ++requests, ask, params } as AskMessage;
      return new Promise<never>((resolve, reject) => {
        const timer = setTimeout(() => { asked.delete(message.request); reject(new Error(`The canvas did not answer "${ask}" in ${timeoutMs} ms`)); }, timeoutMs);
        timer.unref?.();
        const waiting = { message, to: new Set<Page>(), resolve: resolve as (result: unknown) => void, reject, timer };
        asked.set(message.request, waiting);
        for (const page of pages) { send(page, message); waiting.to.add(page); }
      });
    },
    close() {
      for (const waiting of asked.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('The canvas host closed')); }
      asked.clear();
      for (const page of pages) page.response.end();
      pages.clear();
    }
  };
}

// A local server for the canvas (the emulator's server, with the canvas under /canvas/).
export async function startCanvasHost({ port = 0, ...options }: CanvasHostOptions & { port?: number }): Promise<CanvasHost> {
  const handler = createCanvasHandler(options);
  const server = await startServer({ port });
  server.route(PREFIX, handler.handle);
  return {
    token: handler.token, page: handler.page, base: server.base, url: `${server.base}${PREFIX}${handler.page}`,
    get pages() { return handler.pages; },
    handle: handler.handle, push: handler.push, view: handler.view, ask: handler.ask,
    close: async () => { handler.close(); await server.close(); }
  };
}
