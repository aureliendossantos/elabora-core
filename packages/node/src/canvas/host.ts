import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ObjectManifest } from '@elabora/format';
import type { RenderedFileKind, RenderedScreen } from '@elabora/core/render/screen';
import type { HostMessage, RenderView, ScreenRender } from '@elabora/player/canvas-protocol';
import { projectPath } from '@elabora/core/project/files';
import { startServer } from '../emulator/server.ts';
import type { RouteHandler } from '../emulator/server.ts';
import { runtimeFiles, runtimeBundle, vendorThree, compileObjectCode, objectFrameHtml, bundleErrorMessage } from '../bundles.ts';
import { errorMessage } from '../util/values.ts';
import { serveFile, mimeType } from './files.ts';

// The Node host of the editor canvas: what the engine drives. It serves, under /canvas/:
//   index.html                the canvas page (elabora/player.css, elabora/canvas.js, the connector)
//   elabora/…                   the player stylesheet, canvas.js, object-frame.js, three.js
//   elabora/events              render data, as server-sent events (push sends them)
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
// A narration line's audio (docs/decisions.md D24), which no render lists: the editor plays it.
const NARRATION_AUDIO = /^assets\/narration\/[^/]+\/[^/]+\/[^/]+\.m4a$/;
// A sound of the course (D67): the editor's sound browser and inspector play it on any screen, and a
// sound just added or made is in no render yet.
const COURSE_SOUND = /^assets\/sounds\/[^/]+\.(?:flac|m4a|mp3|ogg|oga|opus|wav)$/;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

// The connector of the page served by this host: render data arrives as server-sent events.
const CONNECT_SCRIPT = `// Connects the canvas page to its Node host: messages arrive as server-sent events.
(function () {
  var source = new EventSource('elabora/events');
  source.onmessage = function (event) { window.__elaboraCanvas.receive(JSON.parse(event.data)); };
})();
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Elabora canvas</title>
<link rel="stylesheet" href="elabora/player.css">
</head>
<body>
<div id="elabora-app"></div>
<script src="elabora/canvas.js"></script>
<script src="elabora/canvas-connect.js"></script>
</body>
</html>
`;

interface Page {
  response: ServerResponse;
  // Hash of the styles it has: unchanged styles are left out of what it is sent.
  styles: string;
}

export function createCanvasHandler({ root, debug = true, token = crypto.randomBytes(16).toString('hex') }: CanvasHostOptions): CanvasHandler {
  const folder = path.resolve(root);
  const pages = new Set<Page>();
  // Project files the renders listed, by path: the only ones served.
  const allowed = new Map<string, RenderedFileKind>();
  let last: { id?: string | number; render: ScreenRender } | null = null;
  let language = 'en';
  const runtime = new Map<string, Promise<string | Buffer>>();
  const objectCode = new Map<string, { signature: string; code: Promise<string> }>();

  const send = (page: Page, message: HostMessage) => { page.response.write(`data: ${JSON.stringify(message)}\n\n`); };
  const sendRender = (page: Page, id: string | number | undefined, render: ScreenRender) => {
    const styles = render.styles && render.styles.hash !== page.styles ? render.styles : undefined;
    if (styles) page.styles = styles.hash;
    const files = render.files?.map(({ path, kind, hash }) => ({ path, kind, hash }));
    send(page, { type: 'elabora/render', ...(id !== undefined ? { id } : {}), render: { screen: render.screen, course: render.course, view: render.view, ...(styles ? { styles } : {}), ...(files ? { files } : {}), ...(render.outline ? { outline: render.outline } : {}) } });
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

  // object.js of an object, bundled again when a file of its folder changed.
  function compiledObject(id: string): Promise<string> {
    const dir = path.join(folder, 'objects', id);
    const signature = folderSignature(dir);
    const cached = objectCode.get(id);
    if (cached && cached.signature === signature) return cached.code;
    const code = compileObjectCode(dir, { minify: !debug });
    objectCode.set(id, { signature, code });
    return code;
  }

  async function answer(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const text = (status: number, body: string) => { response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(body); };
    // Only this computer's pages, by name: a page of another site that rebinds a name to 127.0.0.1
    // must not read the project.
    if (!LOCAL_HOST.test(request.headers.host ?? '')) return text(403, 'forbidden');
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'method not allowed');
    let name: string;
    try { name = decodeURIComponent(url.pathname).slice(PREFIX.length); } catch { return text(400, 'bad path'); }
    if (name === '' || name === 'index.html') { response.writeHead(200, { 'content-type': mimeType('index.html'), 'cache-control': 'no-store' }).end(PAGE); return; }
    if (name === 'elabora/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      response.write('retry: 500\n\n');
      const page: Page = { response, styles: '' };
      pages.add(page);
      request.on('close', () => pages.delete(page));
      if (last) sendRender(page, last.id, last.render);
      return;
    }
    const runtimeContent = name.startsWith('elabora/') ? runtimeFile(name) : null;
    if (runtimeContent) {
      const content = await runtimeContent;
      response.writeHead(200, { 'content-type': mimeType(name), 'cache-control': 'no-cache' }).end(request.method === 'HEAD' ? undefined : content);
      return;
    }
    const rel = projectPath(name);
    const kind = rel === null ? undefined : allowed.get(rel) ?? (NARRATION_AUDIO.test(rel) || COURSE_SOUND.test(rel) ? 'asset' : undefined);
    if (rel === null || !kind) return text(404, 'not found');
    const object = /^objects\/([^/]+)\//.exec(rel)?.[1];
    if (object && kind === 'object-frame') {
      const manifest = readManifest(path.join(folder, 'objects', object, 'object.manifest.json'));
      if (!manifest) return text(404, 'no object manifest');
      response.writeHead(200, { 'content-type': mimeType(rel), 'cache-control': 'no-store' }).end(objectFrameHtml(manifest, { language }));
      return;
    }
    if (object && kind === 'object-code') {
      try {
        const code = await compiledObject(object);
        response.writeHead(200, { 'content-type': mimeType(rel), 'cache-control': 'no-store' }).end(request.method === 'HEAD' ? undefined : code);
      } catch (error) {
        text(500, `Build of objects/${object}/object.js failed: ${bundleErrorMessage(error)}`);
      }
      return;
    }
    serveFile(request, response, path.join(folder, ...rel.split('/')));
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
      last = { ...(id !== undefined ? { id } : {}), render };
      for (const page of pages) sendRender(page, id, render);
      return pages.size;
    },
    view(view, { id } = {}) {
      if (last) last = { ...last, render: { ...last.render, view: { ...last.render.view, ...view } } };
      for (const page of pages) send(page, { type: 'elabora/view', ...(id !== undefined ? { id } : {}), view });
      return pages.size;
    },
    close() { for (const page of pages) page.response.end(); pages.clear(); }
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
    handle: handler.handle, push: handler.push, view: handler.view,
    close: async () => { handler.close(); await server.close(); }
  };
}

function readManifest(file: string): ObjectManifest | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as ObjectManifest; } catch { return null; }
}

// Paths, sizes and modification times of the files of a folder: it changes when one of them does.
function folderSignature(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) { try { const stat = fs.statSync(file); parts.push(`${file}:${stat.size}:${stat.mtimeMs}`); } catch { /* removed meanwhile */ } }
    }
  };
  walk(dir);
  return parts.join('|');
}
