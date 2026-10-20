import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageDir } from '../util/package-dir.ts';
import { fieldOf } from '../util/values.ts';
import { getProfile } from '@elabora/core/lms/profiles';
import { MIME_TYPES, serveFile, servePlaceholder } from '../http/files.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HARNESS = path.join(PACKAGE_ROOT, 'emulator-harness');

// The content types of the local servers (http/files.ts), as the emulator names them.
export const TYPES = MIME_TYPES;

// Answers a request: status, body, content type and extra headers.
export type Send = (status: number, body: string | Uint8Array, type?: string, headers?: Record<string, string>) => void;
export type RouteHandler = (request: IncomingMessage, response: ServerResponse, url: URL, send: Send) => unknown;

// What the fake LMS stored for a registration: the last CMI committed (scorm-again's JSON) and
// every commit with its time.
export interface Registration {
  cmi: unknown;
  commits: { t: number; cmi: unknown }[];
}

// Files of a package served from elsewhere than its folder (the preview's media: the project's
// files or renditions), by path in the package; null: a media job is still writing it.
export type PackageFiles = ReadonlyMap<string, string | null>;

export interface PackageOptions {
  // A live preview (elabora preview): its course page asks for the frames of free objects from the
  // frames port of this server (startServer frames; @elabora/player frames.ts: browser panes that
  // refuse frames of an opaque origin show them), and reloads when the package is added again (a
  // rebuild).
  preview?: boolean;
}

export interface EmulatorServer {
  base: string; // http://127.0.0.1:<port>
  // The second port, serving the same, from which previews load object frames (null: none).
  framesPort: number | null;
  addPackage(name: string, dir: string, files?: PackageFiles, options?: PackageOptions): string;
  registration(reg: string): Registration | null;
  resetRegistration(reg: string): void;
  route(prefix: string, handler: RouteHandler): void;
  close(): Promise<void>;
}

// Local server for previews and the LMS emulator.
//   /pkg/<name>/…            files of a registered package folder (streamed, with range requests)
//   /preview-events/<name>   a preview's pages listen here (server-sent events) to reload
//   /lms/launch.html         fake LMS page (scorm-again Scorm12API + profile quirks)
//   /lms/state/<reg>         stored CMI of a registration (GET), /lms/commit/<reg> (POST)
//   /lms/profile/<id>        profile JSON
//   iisLike: only the MIME types of a default IIS, as some LMS servers have
//   frames: also listen on a second port, for the frames of free objects in previews
export async function startServer({ port = 0, iisLike = false, frames = false }: { port?: number; iisLike?: boolean; frames?: boolean } = {}): Promise<EmulatorServer> {
  const packages = new Map<string, { dir: string; files: PackageFiles; preview: boolean }>();
  // Pages of previews, by package: told to reload when it is built again.
  const listeners = new Map<string, Set<ServerResponse>>();
  const registrations = new Map<string, Registration>();
  const routes = new Map<string, RouteHandler>();

  let framesPort: number | null = null;
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send: Send = (status, body, type = 'text/plain; charset=utf-8', headers = {}) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      response.end(body);
    };
    try {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/pkg/')) {
        const [, , name, ...rest] = pathname.split('/');
        const registered = packages.get(name);
        if (!registered) return send(404, 'unknown package');
        const { dir, files, preview } = registered;
        if (preview && rest.join('/') === 'index.html') return send(200, previewPage(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), name, framesPort), TYPES['.html']);
        const mapped = files.get(rest.join('/'));
        const file = mapped ?? path.join(dir, ...rest);
        if (mapped === undefined && !file.startsWith(dir)) return send(404, 'not found');
        const extension = path.extname(rest.join('/')).toLowerCase();
        if (iisLike && !['.html', '.js', '.css', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.mp3', '.vtt', '.xml', '.txt'].includes(extension)) return send(404, 'MIME type not configured (IIS-like server)');
        if (mapped === null) return servePlaceholder(response, rest.join('/'));
        return serveFile(request, response, file, { type: TYPES[extension] || 'application/octet-stream' });
      }
      if (pathname.startsWith('/preview-events/')) {
        const name = pathname.split('/')[2];
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        response.write('retry: 1000\n\n');
        const pages = listeners.get(name) ?? new Set<ServerResponse>();
        listeners.set(name, pages);
        pages.add(response);
        request.on('close', () => pages.delete(response));
        return;
      }
      if (pathname === '/lms/scorm-again.js') return send(200, fs.readFileSync(path.join(packageDir('scorm-again') ?? '', 'dist/scorm12.js')), TYPES['.js']);
      if (pathname.startsWith('/lms/profile/')) return send(200, JSON.stringify(getProfile(pathname.split('/')[3])), TYPES['.json']);
      if (pathname.startsWith('/lms/state/')) {
        const reg = pathname.split('/')[3];
        return send(200, JSON.stringify(registrations.get(reg)?.cmi || null), TYPES['.json']);
      }
      if (pathname.startsWith('/lms/commit/') && request.method === 'POST') {
        const reg = pathname.split('/')[3];
        const body = await readBody(request);
        let data: unknown;
        try { data = JSON.parse(body); } catch { data = { raw: body }; }
        const registration = registrations.get(reg) || { cmi: null, commits: [] };
        const cmi = fieldOf(data, 'cmi') || data;
        registration.cmi = cmi;
        registration.commits.push({ t: Date.now(), cmi });
        registrations.set(reg, registration);
        return send(200, JSON.stringify({ result: true, errorCode: 0 }), TYPES['.json']);
      }
      if (pathname.startsWith('/lms/commits/')) {
        const reg = pathname.split('/')[3];
        return send(200, JSON.stringify(registrations.get(reg)?.commits || []), TYPES['.json']);
      }
      if (pathname.startsWith('/lms/')) {
        const file = path.join(HARNESS, pathname.slice('/lms/'.length));
        if (file.startsWith(HARNESS) && fs.existsSync(file)) return send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'text/plain');
      }
      for (const [prefix, handler] of routes) if (pathname.startsWith(prefix)) return handler(request, response, url, send);
      send(404, 'not found');
    } catch (error) {
      send(500, String((error instanceof Error && error.stack) || error));
    }
  };
  const listen = async (server: http.Server, wanted: number): Promise<number> => {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(wanted, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    return address !== null && typeof address === 'object' ? address.port : wanted;
  };
  const servers = [http.createServer(handle)];
  const base = `http://127.0.0.1:${await listen(servers[0], port)}`;
  if (frames) {
    servers.push(http.createServer(handle));
    framesPort = await listen(servers[1], 0);
  }
  return {
    base,
    framesPort,
    addPackage(name, dir, files = new Map(), { preview = false } = {}) {
      const known = packages.has(name);
      packages.set(name, { dir: path.resolve(dir), files, preview });
      if (known && preview) for (const page of listeners.get(name) ?? []) page.write('data: reload\n\n');
      return `${base}/pkg/${name}/`;
    },
    registration(reg) { return registrations.get(reg) || null; },
    resetRegistration(reg) { registrations.delete(reg); },
    route(prefix, handler) { routes.set(prefix, handler); },
    async close() {
      for (const page of [...listeners.values()].flatMap((pages) => [...pages])) page.end();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); })));
    }
  };
}

// The course page of a preview: object frames from the frames port, and a reload when the package
// is built again (the player resumes on the screen shown: the standalone adapter keeps the location
// for the tab; in the LMS emulator the launch page reloads, as a learner relaunching).
function previewPage(html: string, name: string, framesPort: number | null): string {
  const reload = `<script>new EventSource('/preview-events/${encodeURIComponent(name)}').onmessage = function () { try { window.top.location.reload(); } catch (error) { location.reload(); } };</script>`;
  const frames = framesPort ? `\n<meta name="elabora-object-frames" content="${framesPort}">` : '';
  return html.replace('<meta charset="utf-8">', `<meta charset="utf-8">${frames}`).replace('</body>', `${reload}\n</body>`);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}
