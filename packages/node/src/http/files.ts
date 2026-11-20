import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mediaTypeOf } from '@elabora/core/util/media-types';
import { parseRange, resolveRange } from '@elabora/player/relay-protocol';

// Files served by the local servers (preview, LMS emulator, editor canvas): streamed from disk
// (never read whole, never copied), with HTTP range requests, which <video> and <audio> need to
// seek (and Safari to play at all), so a 300 MB course seeks in its videos at once.

export { MIME_TYPES } from '@elabora/core/util/media-types';

export const mimeType = (file: string): string => mediaTypeOf(file);

// Answers a GET or HEAD for a file: 200, 206 for a range, 304 when the page has it, 404, 416.
// Files change while the app runs (an agent writes them): the page revalidates them every time.
export function serveFile(request: IncomingMessage, response: ServerResponse, file: string, { type }: { type?: string } = {}): void {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
  if (!stat.isFile()) { response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found'); return; }
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    'content-type': type ?? mimeType(file), 'accept-ranges': 'bytes', etag, 'last-modified': stat.mtime.toUTCString(), 'cache-control': 'no-cache'
  };
  if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers).end(); return; }
  const ifRange = request.headers['if-range'];
  const asked = ifRange && ifRange !== etag ? null : parseRange(request.headers.range);
  const range = asked === null ? null : resolveRange(asked, stat.size);
  if (range === 'unsatisfiable') { response.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` }).end(); return; }
  const { start, end } = range || { start: 0, end: stat.size - 1 };
  const length = stat.size ? end - start + 1 : 0;
  response.writeHead(range ? 206 : 200, { ...headers, 'content-length': String(length), ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}) });
  if (request.method === 'HEAD' || !length) { response.end(); return; }
  // A page that seeks closes the stream it no longer needs: nothing to report then.
  pipeline(fs.createReadStream(file, { start, end }), response, () => {});
}

// What a page shows for a media file a job is still writing: images get a placeholder picture;
// video and audio a 503 that says to try again (the player shows its own state).
export function servePlaceholder(response: ServerResponse, file: string): void {
  if (mimeType(file).startsWith('image/')) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#e9ecef"/><text x="160" y="96" font-family="system-ui,sans-serif" font-size="16" text-anchor="middle" fill="#495057">Converting…</text></svg>';
    response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' }).end(svg);
    return;
  }
  response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5' }).end(`${path.basename(file)} is being converted (elabora media status).`);
}
