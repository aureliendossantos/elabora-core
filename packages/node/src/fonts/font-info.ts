import zlib from 'node:zlib';

// What a font file says about itself, read from its tables: the family, the weights it covers (the
// wght axis of a variable font, or its weight class), its style, the copyright and licence notices
// of its name table, and a guess of its category for the fallbacks of its stack. Reads WOFF2
// (brotli), WOFF (zlib) and plain TrueType or OpenType files; glyphs are never decoded.

export interface FontInfo {
  format: 'woff2' | 'woff' | 'sfnt';
  family: string | null;
  weight: string; // "400", or "100 900" for a variable font: multiples of 100, as course.json declares them
  style: 'normal' | 'italic';
  category: 'serif' | 'sans-serif' | 'monospace' | 'handwriting' | null;
  copyright: string | null;
  license: string | null; // name ID 13
  licenseUrl: string | null; // name ID 14
}

export class FontFileError extends Error {}

// Tags of the tables WOFF2 names by index (WOFF2 specification, 5.1).
const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'
];
const WANTED = new Set(['name', 'OS/2', 'fvar', 'post', 'head']);

export function readFontInfo(bytes: Uint8Array): FontInfo {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 12) throw new FontFileError('Not a font file.');
  const signature = data.toString('latin1', 0, 4);
  const { format, tables } = signature === 'wOF2' ? { format: 'woff2' as const, tables: woff2Tables(data) }
    : signature === 'wOFF' ? { format: 'woff' as const, tables: woffTables(data) }
    : ['\0\x01\0\0', 'OTTO', 'true'].includes(signature) ? { format: 'sfnt' as const, tables: sfntTables(data) }
    : (() => { throw new FontFileError('Not a WOFF2, WOFF, TrueType or OpenType file.'); })();
  const names = nameTable(tables.get('name'));
  const os2 = tables.get('OS/2');
  const axes = fvarAxes(tables.get('fvar'));
  const wght = axes.get('wght');
  const hundreds = (value: number, round: (n: number) => number) => Math.min(900, Math.max(100, round(value / 100) * 100));
  const weight = wght ? `${hundreds(wght.min, Math.floor)} ${hundreds(wght.max, Math.ceil)}` : String(hundreds(os2 && os2.length >= 6 ? os2.readUInt16BE(4) : 400, Math.round));
  const range = weight.split(' ');
  const italic = (os2 && os2.length >= 64 && (os2.readUInt16BE(62) & 1) === 1) || ((tables.get('head')?.length ?? 0) >= 46 && (tables.get('head')!.readUInt16BE(44) & 2) === 2);
  return {
    format,
    family: familyOf(names.get(16) ?? names.get(1)),
    weight: range[0] === range[1] ? range[0] : weight,
    style: italic ? 'italic' : 'normal',
    category: category(os2, tables.get('post')),
    copyright: names.get(0) ?? null,
    license: names.get(13) ?? null,
    licenseUrl: names.get(14) ?? null
  };
}

// Subset files often lose the typographic family (name ID 16): their family name (ID 1) then ends
// with the weight or the optical size of the file ("Lato Black", "Merriweather Light 18pt").
const STYLE_WORD = /^(\d+pt|thin|hairline|(extra|ultra|semi|demi)?(light|bold)|regular|normal|book|medium|black|heavy|(extra|ultra)black|italic|oblique)$/i;
function familyOf(name: string | undefined): string | null {
  const words = (name ?? '').split(/\s+/).filter(Boolean);
  while (words.length > 1 && STYLE_WORD.test(words[words.length - 1])) words.pop();
  return words.length ? words.join(' ') : null;
}

function woff2Tables(data: Buffer): Map<string, Buffer> {
  const count = data.readUInt16BE(12);
  const compressedSize = data.readUInt32BE(20);
  if (data.readUInt32BE(4) === 0x74746366) throw new FontFileError('WOFF2 font collections are not supported: take one font of it.');
  let offset = 48;
  const base128 = (): number => {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = data[offset++];
      if (i === 0 && byte === 0x80) throw new FontFileError('Damaged WOFF2 table directory.');
      value = value * 128 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new FontFileError('Damaged WOFF2 table directory.');
  };
  const entries: { tag: string; length: number }[] = [];
  for (let i = 0; i < count; i++) {
    const flags = data[offset++];
    const tag = (flags & 0x3f) === 0x3f ? data.toString('latin1', offset, (offset += 4)) : KNOWN_TAGS[flags & 0x3f];
    const transform = flags >> 6;
    const original = base128();
    // glyf and loca are transformed unless their version is 3; other tables when it is not 0.
    const transformed = tag === 'glyf' || tag === 'loca' ? transform !== 3 : transform !== 0;
    entries.push({ tag, length: transformed ? base128() : original });
  }
  let stream: Buffer;
  try {
    stream = zlib.brotliDecompressSync(data.subarray(offset, offset + compressedSize));
  } catch {
    throw new FontFileError('Damaged WOFF2 file: its tables do not decompress.');
  }
  const tables = new Map<string, Buffer>();
  let at = 0;
  for (const entry of entries) {
    if (WANTED.has(entry.tag)) tables.set(entry.tag, stream.subarray(at, at + entry.length));
    at += entry.length;
  }
  return tables;
}

function woffTables(data: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  for (let i = 0, count = data.readUInt16BE(12); i < count; i++) {
    const record = 44 + i * 20;
    const tag = data.toString('latin1', record, record + 4);
    if (!WANTED.has(tag)) continue;
    const [offset, compressed, original] = [data.readUInt32BE(record + 4), data.readUInt32BE(record + 8), data.readUInt32BE(record + 12)];
    const raw = data.subarray(offset, offset + compressed);
    tables.set(tag, compressed < original ? zlib.inflateSync(raw) : raw);
  }
  return tables;
}

function sfntTables(data: Buffer): Map<string, Buffer> {
  const tables = new Map<string, Buffer>();
  for (let i = 0, count = data.readUInt16BE(4); i < count; i++) {
    const record = 12 + i * 16;
    const tag = data.toString('latin1', record, record + 4);
    if (WANTED.has(tag)) tables.set(tag, data.subarray(data.readUInt32BE(record + 8), data.readUInt32BE(record + 8) + data.readUInt32BE(record + 12)));
  }
  return tables;
}

// Name records by name ID, in English: Windows Unicode (UTF-16BE) first, then Macintosh Roman.
function nameTable(table: Buffer | undefined): Map<number, string> {
  const names = new Map<number, string>();
  if (!table || table.length < 6) return names;
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  const rank = new Map<number, number>();
  for (let i = 0; i < count && 6 + i * 12 + 12 <= table.length; i++) {
    const record = 6 + i * 12;
    const [platform, encoding, language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((at) => table.readUInt16BE(record + at));
    const score = platform === 3 && (encoding === 1 || encoding === 10) ? (language === 0x409 ? 3 : 2) : platform === 0 ? 2 : platform === 1 && encoding === 0 ? 1 : 0;
    if (!score || (rank.get(id) ?? 0) >= score) continue;
    const raw = table.subarray(storage + offset, storage + offset + length);
    const text = platform === 1 ? raw.toString('latin1') : Buffer.from(raw).swap16().toString('utf16le');
    names.set(id, text.trim());
    rank.set(id, score);
  }
  return names;
}

function fvarAxes(table: Buffer | undefined): Map<string, { min: number; max: number }> {
  const axes = new Map<string, { min: number; max: number }>();
  if (!table || table.length < 16) return axes;
  const [first, count, size] = [table.readUInt16BE(4), table.readUInt16BE(8), table.readUInt16BE(10)];
  for (let i = 0; i < count && first + i * size + 16 <= table.length; i++) {
    const axis = first + i * size;
    axes.set(table.toString('latin1', axis, axis + 4), { min: table.readInt32BE(axis + 4) / 65536, max: table.readInt32BE(axis + 12) / 65536 });
  }
  return axes;
}

// The IBM family class of the OS/2 table, then the PANOSE digits, then the fixed pitch of post.
function category(os2: Buffer | undefined, post: Buffer | undefined): FontInfo['category'] {
  if (post && post.length >= 16 && post.readUInt32BE(12) !== 0) return 'monospace';
  if (!os2 || os2.length < 42) return null;
  const familyClass = os2.readInt16BE(30) >> 8;
  if (familyClass >= 1 && familyClass <= 7) return 'serif';
  if (familyClass === 8) return 'sans-serif';
  if (familyClass === 10) return 'handwriting';
  const [kind, serif, proportion] = [os2[32], os2[33], os2[35]];
  if (kind === 2 && proportion === 9) return 'monospace';
  if (kind === 2 && serif >= 11 && serif <= 13) return 'sans-serif';
  if (kind === 2 && serif >= 2 && serif <= 10) return 'serif';
  if (kind === 3) return 'handwriting';
  return null;
}
