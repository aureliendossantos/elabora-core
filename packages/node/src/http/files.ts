import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Files served by the local servers (preview, LMS emulator, editor canvas): streamed from disk
// (never read whole, never copied), with HTTP range requests, which <video> and <audio> need to
// seek (and Safari to play at all), so a 300 MB course seeks in its videos at once.

export const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.aac': 'audio/aac', '.vtt': 'text/vtt; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.ktx2': 'image/ktx2', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  // The player's resources (D58, RESOURCE_TYPES): a PDF served as anything else is downloaded, and
  // its preview stays empty.
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.rtf': 'application/rtf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.odp': 'application/vnd.oasis.opendocument.presentation'
};

export const mimeType = (file: string): string => MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

// A byte range of a file of size bytes (inclusive), or null when the header asks for none we serve
// (several ranges: the whole file is sent, as RFC 9110 allows), or 'unsatisfiable'.
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | 'unsatisfiable' {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    // The last n bytes.
    const length = Number(match[2]);
    if (!length) return 'unsatisfiable';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

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
  const range = ifRange && ifRange !== etag ? null : byteRange(request.headers.range, stat.size);
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
