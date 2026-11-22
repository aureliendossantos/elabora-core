// The web app's three hosts as the relay's tests and trials serve them (docs/architecture/rendering.md): the
// app's page with a stand-in for the engine, the canvas host and the frames host with their Workers' headers
// and the relay, a review page and a space. Everything is built once, from this checkout.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as esbuild from 'esbuild';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { compileObjectCode, canvasPageHtml, relayFiles, runtimeBundle, runtimeFiles, vendorThree } from '@elabora/node/bundles';
import { renderScreen, createRenderContext } from '@elabora/core/render/screen';
import type { Handler } from './relay-hosts.ts';
import { EXAMPLE, ROOT } from './helpers.ts';
import { bundleForBrowser } from './browser-bundle.ts';

export const APP = 'https://app.elabora.studio';
export const CANVAS = 'https://canvas.elabora.page';
export const FRAMES = 'https://frames.elabora.page';
export const REVIEW = 'https://review.elabora.studio';
export const SPACE = 'https://space.elabora.page';
// The hosts' policies, as the hosts' Workers send them (elabora-cloud C105).
const COMMON = "base-uri 'none'; form-action 'none'; object-src 'none'";
export const POLICY = {
  canvas: `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; frame-src 'self' ${FRAMES}; worker-src 'self'; ${COMMON}; frame-ancestors ${APP}`,
  frames: `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'none'; worker-src 'self'; ${COMMON}; frame-ancestors ${CANVAS} ${APP}`
};

export const MODULES: Record<string, { root: string; object: string; screen: string; more?: string[] }> = {
  // more: other screens the tests show (this one has pictures: a first draw asks for files the first screen does not).
  a: { root: EXAMPLE, object: 'diagnostic-reseau', screen: 'simulation', more: ['accueil'] },
  b: { root: path.join(ROOT, 'examples', 'clockwork'), object: 'clockwork', screen: 'centre' }
};

// Everything the hosts serve, made once.
export const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-relay-test-'));
const mime = (file: string) => ({ '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4a': 'audio/mp4' } as Record<string, string>)[path.extname(file)] ?? 'application/octet-stream';
const renders = new Map<string, string>();
const compiled = new Map<string, string>();
for (const [name, module] of Object.entries(MODULES)) {
  const project = loadProjectFromDir(module.root);
  for (const screen of [module.screen, ...(module.more ?? [])]) {
    const shown = renderScreen(project, screen, {}, createRenderContext(project));
    renders.set(`${name}/${screen}`, JSON.stringify({ screen: shown.screen, course: shown.course, view: shown.view, styles: shown.styles, files: shown.files.map(({ path: file, kind, hash }) => ({ path: file, kind, hash })), ...(shown.outline ? { outline: shown.outline } : {}) }));
  }
  compiled.set(`${name}/${module.object}`, await compileObjectCode(path.join(module.root, 'objects', module.object)));
}
// A video of the module's, 20 s, for the ranges: written where the module's files are read from.
const video = path.join(scratch, 'essai.webm');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '20', '-c:v', 'libvpx', '-b:v', '300k', '-g', '15', '-c:a', 'libopus', video]);
const appScript = (await esbuild.build({ entryPoints: [path.join(ROOT, 'test/fixtures/relay-app.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false, logLevel: 'error' })).outputFiles[0].text;
const thumbsScript = (await esbuild.build({ entryPoints: [path.join(ROOT, 'test/fixtures/thumbs-app.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false, logLevel: 'error' })).outputFiles[0].text;
const runtime = await runtimeFiles();
const relayBuilt = await relayFiles();
const three = vendorThree();
const player = new Map<string, { body: string | Buffer; type: string }>([
  ['/canvas/index.html', { body: canvasPageHtml('relay'), type: 'text/html; charset=utf-8' }],
  ['/canvas/elabora/canvas.js', { body: await runtimeBundle('canvas.ts'), type: 'text/javascript' }],
  ['/canvas/elabora/player.css', { body: runtime['elabora/player.css']!, type: 'text/css' }],
  ['/canvas/elabora/object-frame.js', { body: runtime['elabora/object-frame.js']!, type: 'text/javascript' }],
  ['/canvas/elabora/vendor/three-r186.js', { body: three['elabora/vendor/three-r186.js']!, type: 'text/javascript' }],
  ['/relay-page.js', { body: relayBuilt['relay-page.js']!, type: 'text/javascript' }],
  ['/relay.html', { body: relayBuilt['relay.html']!, type: 'text/html; charset=utf-8' }]
]);

export const relay = relayBuilt;
let relayScript = relayBuilt['relay.js']!;
// The relay's script as the canvas and frames hosts serve it now (a test replaces it).
export const setRelayScript = (script: string): void => { relayScript = script; };
export const reached: string[] = [];
// What an author could write into the module a test shows (the review's cases): files of the module, an object's code instead of
// the compiled one, and a change of what the screen's render says (an object's sandbox words).
export const authorFiles = new Map<string, string>();
export const objectCode = new Map<string, string>();
let renderPatch: ((render: { course?: { objects?: Record<string, { permissions?: string[] }> } }) => void) | null = null;
export const setRenderPatch = (patch: typeof renderPatch): void => { renderPatch = patch; };
// The engine's Worker as a browser runs it (a test that has the engine answer the ports, not the stand-in): its code, made when first asked
// for, and the media its copy takes from the app's site, by hash.
export const engineMedia = new Map<string, Buffer>();
let engineCode: Promise<string> | null = null;
const engineWorker = (): Promise<string> => (engineCode ??= bundleForBrowser({ source: `import { provideMedia } from './packages/engine/src/browser/worker.ts';
provideMedia(async (hash) => { const response = await fetch('/media/' + encodeURIComponent(hash)); return response.ok ? response.blob() : null; });` }).then((bundle) => bundle.code));
// How long the hosts take to give the relay's script (a slow network on a first visit: the pages load before the relay controls them).
let relayDelay = 0;
export const setRelayDelay = (ms: number): void => { relayDelay = ms; };
const serveBytes = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, file: string, headers: Record<string, string> = {}) => {
  const stat = fs.statSync(file);
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  const base = { 'content-type': mime(file), 'accept-ranges': 'bytes', ...headers };
  if (!range) { response.writeHead(200, { ...base, 'content-length': stat.size }); fs.createReadStream(file).pipe(response); return; }
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
  response.writeHead(206, { ...base, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
  fs.createReadStream(file, { start, end }).pipe(response);
};

export const handlers = (): Record<string, Handler> => {
  const relayHost = (host: 'canvas' | 'frames'): Handler => (request, response) => {
    const url = new URL(request.url ?? '/', 'https://x');
    const base = { 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'cross-origin', 'content-security-policy': POLICY[host], 'cache-control': 'no-cache' };
    // The host's Worker: the relay's script after one line that says its policy, no other script of a worker.
    if (url.pathname === '/relay.js') {
      const line = `self.ELABORA_HOST = Object.freeze(${JSON.stringify({ policy: POLICY[host], frameAncestors: POLICY[host].split('; ').find((part) => part.startsWith('frame-ancestors')), ...(host === 'frames' ? { appOrigin: APP } : {}) })});\n`;
      setTimeout(() => response.writeHead(200, { ...base, 'content-type': 'text/javascript', 'service-worker-allowed': '/' }).end(line + relayScript), relayDelay);
      return;
    }
    const file = player.get(url.pathname);
    if (request.headers['service-worker'] || !file) { reached.push(`${host}${url.pathname}`); response.writeHead(404, { ...base, 'content-type': 'text/plain' }).end('network: not found'); return; }
    response.writeHead(200, { ...base, 'content-type': file.type }).end(file.body);
  };
  const app: Handler = (request, response) => {
    const url = new URL(request.url ?? '/', 'https://x');
    const isolation = { 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cache-control': 'no-store' };
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/') { response.writeHead(200, { ...isolation, 'content-type': 'text/html' }).end('<!doctype html><title>app</title><body><script src="/app.js"></script></body>'); return; }
    if (url.pathname === '/engine-worker.js') { void engineWorker().then((code) => response.writeHead(200, { ...isolation, 'content-type': 'text/javascript' }).end(code)); return; }
    if (parts[0] === 'media' && parts[1]) { const bytes = engineMedia.get(decodeURIComponent(parts[1])); response.writeHead(bytes ? 200 : 404, { ...isolation, 'content-type': 'application/octet-stream' }).end(bytes); return; }
    if (url.pathname === '/thumbs') { response.writeHead(200, { ...isolation, 'content-type': 'text/html' }).end('<!doctype html><title>thumbs</title><body><script src="/thumbs.js"></script></body>'); return; }
    if (url.pathname === '/thumbs.js') { response.writeHead(200, { ...isolation, 'content-type': 'text/javascript' }).end(thumbsScript); return; }
    if (url.pathname === '/app.js') { response.writeHead(200, { ...isolation, 'content-type': 'text/javascript' }).end(appScript); return; }
    if (parts[0] === 'render' && parts[2]) { let body = renders.get(`${parts[1]}/${parts[2]!.replace(/\.json$/, '')}`); if (body && renderPatch) { const render = JSON.parse(body); renderPatch(render); body = JSON.stringify(render); } response.writeHead(body ? 200 : 404, { ...isolation, 'content-type': 'application/json' }).end(body ?? ''); return; }
    if (parts[0] === 'compiled' && parts[2]) { const key = `${parts[1]}/${parts[2]!.replace(/\.js$/, '')}`; const body = objectCode.get(key) ?? compiled.get(key); response.writeHead(body ? 200 : 404, { ...isolation, 'content-type': 'text/javascript' }).end(body ?? ''); return; }
    if (parts[0] === 'module' && parts[1] && MODULES[parts[1]]) {
      const rel = decodeURIComponent(parts.slice(2).join('/'));
      const written = parts[1] === 'a' ? authorFiles.get(rel) : undefined;
      if (written !== undefined) { response.writeHead(200, { ...isolation, 'content-type': mime(rel) }).end(written); return; }
      const file = rel === 'assets/video/essai.webm' ? video : path.join(MODULES[parts[1]]!.root, rel);
      if (rel.split('/').includes('..') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404, isolation).end(); return; }
      serveBytes(request, response, file, isolation);
      return;
    }
    response.writeHead(404, isolation).end();
  };
  // The review page of the same site as the app frames a space, which frames what it likes.
  const review: Handler = (_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>review</title><iframe id="space" src="${SPACE}/"></iframe>`);
  const space: Handler = (_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>space</title><script>addEventListener("message",(e)=>{ if(e.data&&e.data.frame){ const f=document.createElement("iframe"); f.id="target"; f.src=e.data.frame; document.body.append(f); } })</script>');
  return { 'app.elabora.studio': app, 'canvas.elabora.page': relayHost('canvas'), 'frames.elabora.page': relayHost('frames'), 'review.elabora.studio': review, 'space.elabora.page': space };
};

