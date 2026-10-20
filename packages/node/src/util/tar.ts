import zlib from 'node:zlib';

// The regular files of a tar archive, gzipped or not (npm package tarballs: `npm pack`), by their
// path in the archive. Long names (GNU "L" entries, pax "path" records) are followed; links,
// folders and other entries are left out.
export function readTar(bytes: Uint8Array): Map<string, Buffer> {
  const data = bytes[0] === 0x1f && bytes[1] === 0x8b ? zlib.gunzipSync(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, Buffer>();
  let longName: string | null = null;
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('Not a tar archive: unreadable entry size.');
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') { longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? longName; continue; }
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = null;
    if (type === '0' || type === '7') files.set(name, Buffer.from(body));
  }
  return files;
}

const field = (header: Buffer, start: number, length: number): string => {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
};
