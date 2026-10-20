import fs from 'node:fs/promises';
import zlib from 'node:zlib';

// A PDF's own title, so that a file the author drops (a resource of the player, a source) is named by
// it (docs/decisions.md D58): the document's XMP metadata (dc:title), else its information dictionary
// (/Title). No dependency and no text extraction (D49 reads a PDF as it is): the catalog and the
// information dictionary are found from the trailer, in an object stream when the PDF packs them
// (inflated with zlib), and the metadata stream is XML. The title is null when the PDF says none, is
// encrypted, is not a PDF, or says one a program put there rather than its author: « Untitled »,
// « Microsoft Word - brief.docx », a file name.

// A large PDF is read at both ends: the trailer, the catalog and the metadata of nearly every PDF are
// there (a linearised PDF puts them first, an edited one appends them last).
const WHOLE = 32 * 1024 * 1024;
const END = 4 * 1024 * 1024;

export async function pdfTitle(file: string): Promise<string | null> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= WHOLE) return pdfTitleOf(await handle.readFile());
    const head = Buffer.alloc(END);
    const tail = Buffer.alloc(END);
    await handle.read(head, 0, END, 0);
    await handle.read(tail, 0, END, size - END);
    return pdfTitleOf(Buffer.concat([head, Buffer.from('\n'), tail]));
  } finally {
    await handle.close();
  }
}

// Bounds: what inflating may produce (a stream, all of them), and how many object streams are read.
const INFLATED_STREAM = 4 * 1024 * 1024;
const INFLATED_TOTAL = 16 * 1024 * 1024;
const OBJECT_STREAMS = 64;
// The title as learners read it: course.json resources titles hold 120 characters.
const TITLE_MAX = 120;

// Never throws: a file that does not read as expected has no title.
export function pdfTitleOf(bytes: Buffer): string | null {
  try {
    return readTitle(bytes);
  } catch {
    return null;
  }
}

function readTitle(bytes: Buffer): string | null {
  if (!bytes.subarray(0, 1024).includes('%PDF-')) return null;
  const pdf = new Reader(bytes);
  // The last trailer is the latest revision's.
  const root = pdf.lastRef('Root');
  const catalog = root === null ? null : pdf.object(root);
  const metadata = catalog === null ? null : refIn(catalog.text, 'Metadata');
  if (metadata !== null) {
    const title = xmpTitle(pdf.stream(metadata, INFLATED_STREAM));
    if (title !== null) return title;
  }
  if (pdf.encrypted) return null;
  const info = pdf.lastRef('Info');
  const dictionary = info === null ? null : pdf.object(info);
  const raw = dictionary === null ? null : stringAfter(dictionary.text, 'Title');
  return raw === null ? null : authored(decodeText(raw));
}

const refIn = (text: string, key: string): number | null => {
  const match = new RegExp(`/${key}\\s+(\\d{1,10})\\s+\\d{1,5}\\s+R\\b`).exec(text);
  return match ? Number(match[1]) : null;
};

class Reader {
  readonly bytes: Buffer;
  readonly text: string;
  readonly encrypted: boolean;
  // Where each object's dictionary starts (after « N G obj »), the last one written of each number,
  // found in one pass; and the objects that are object streams.
  private readonly starts = new Map<number, number>();
  private readonly streams: number[] = [];
  private packed: Map<number, string> | null = null;
  constructor(bytes: Buffer) {
    this.bytes = bytes;
    // latin1 keeps one character per byte: offsets in the text are offsets in the bytes.
    this.text = bytes.toString('latin1');
    this.encrypted = /\/Encrypt\s+(?:\d{1,10}\s+\d{1,5}\s+R|<<)/.test(this.text);
    const text = this.text;
    for (let at = text.indexOf('obj'); at >= 0; at = text.indexOf('obj', at + 3)) {
      // « obj » as a keyword (not endobj, not objstm), after « N G » within a few characters.
      if (/[A-Za-z]/.test(text[at - 1] ?? '') || /[A-Za-z]/.test(text[at + 3] ?? '')) continue;
      const head = /(?:^|[^\d])(\d{1,10})\s+\d{1,5}\s+$/.exec(text.slice(Math.max(0, at - 24), at));
      if (!head) continue;
      const id = Number(head[1]);
      this.starts.set(id, at + 3);
      if (/^\s*<<[^]{0,400}?\/Type\s*\/ObjStm\b/.test(text.slice(at + 3, at + 420))) this.streams.push(id);
    }
  }
  lastRef(key: string): number | null {
    let found: number | null = null;
    for (const match of this.text.matchAll(new RegExp(`/${key}\\s+(\\d{1,10})\\s+\\d{1,5}\\s+R\\b`, 'g'))) found = Number(match[1]);
    return found;
  }
  // An object's text (its dictionary, and where its stream starts), the last one written of that
  // number, else the one an object stream holds.
  object(id: number): { text: string; at: number } | null {
    const at = this.starts.get(id);
    if (at !== undefined) {
      const end = this.text.indexOf('endobj', at);
      return { text: this.text.slice(at, end < 0 ? Math.min(this.text.length, at + 65536) : end), at };
    }
    const text = this.objectStreams().get(id);
    return text === undefined ? null : { text, at: -1 };
  }
  // A stream's bytes, inflated when it is compressed with Flate (the only filter read here), up to
  // limit bytes: more is not read.
  stream(id: number, limit: number): Buffer | null {
    const found = this.object(id);
    if (!found || found.at < 0) return null;
    const keyword = /stream\r?\n/.exec(found.text);
    if (!keyword) return null;
    const start = found.at + keyword.index + keyword[0].length;
    const end = this.text.indexOf('endstream', start);
    if (end < 0) return null;
    const data = this.bytes.subarray(start, end);
    const dictionary = found.text.slice(0, keyword.index);
    if (!/\/Filter/.test(dictionary)) return data.length <= limit ? data : null;
    if (!/\/Filter\s*\[?\s*\/FlateDecode\s*\]?/.test(dictionary)) return null;
    try {
      return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: limit });
    } catch {
      return null;
    }
  }
  // The objects packed in object streams (PDF 1.5 and later), by number: the last streams first
  // (an edited PDF appends its own), within the bounds above.
  private objectStreams(): Map<number, string> {
    if (this.packed) return this.packed;
    this.packed = new Map();
    if (this.encrypted) return this.packed;
    let budget = INFLATED_TOTAL;
    for (const id of this.streams.slice(-OBJECT_STREAMS).reverse()) {
      const head = this.object(id);
      const data = head && budget > 0 ? this.stream(id, Math.min(INFLATED_STREAM, budget)) : null;
      if (!head || !data) continue;
      budget -= data.length;
      const count = Math.min(Number(/\/N\s+(\d{1,6})/.exec(head.text)?.[1] ?? 0), 100000);
      const first = Number(/\/First\s+(\d{1,9})/.exec(head.text)?.[1] ?? 0);
      const body = data.toString('latin1');
      const numbers = body.slice(0, first).trim().split(/\s+/).map(Number);
      for (let index = 0; index < count && index * 2 + 1 < numbers.length; index++) {
        const from = first + numbers[index * 2 + 1];
        const to = index + 1 < count && index * 2 + 3 < numbers.length ? first + numbers[index * 2 + 3] : body.length;
        if (!this.packed.has(numbers[index * 2])) this.packed.set(numbers[index * 2], body.slice(from, to));
      }
    }
    return this.packed;
  }
}

// The x-default title of an XMP packet, else its first; read with indexOf, not patterns that could
// backtrack on a crafted packet.
function xmpTitle(data: Buffer | null): string | null {
  if (!data) return null;
  const xml = data.toString('utf8');
  const open = xml.indexOf('<dc:title');
  if (open < 0) return null;
  const close = xml.indexOf('</dc:title>', open);
  if (close < 0) return null;
  const title = xml.slice(xml.indexOf('>', open) + 1, close);
  let chosen: string | null = null;
  for (let at = title.indexOf('<rdf:li'); at >= 0; at = title.indexOf('<rdf:li', at + 7)) {
    const tagEnd = title.indexOf('>', at);
    const end = title.indexOf('</rdf:li>', tagEnd);
    if (tagEnd < 0 || end < 0) break;
    const value = title.slice(tagEnd + 1, end);
    if (/xml:lang\s*=\s*["']x-default["']/.test(title.slice(at, tagEnd))) { chosen = value; break; }
    chosen ??= value;
  }
  return chosen === null ? null : authored(unescapeXml(chosen));
}

// A character reference that names no character is dropped.
const codePoint = (value: number): string => (Number.isInteger(value) && value >= 0x20 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : '');
const unescapeXml = (text: string): string => text
  .replace(/&#x([0-9a-f]{1,8});/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
  .replace(/&#(\d{1,10});/g, (_, digits: string) => codePoint(Number(digits)))
  .replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name] ?? '');

// The raw bytes of the string after /key: a literal (…) with its escapes, or <hex>.
function stringAfter(text: string, key: string): Buffer | null {
  const match = new RegExp(`/${key}\\s*([(<])`).exec(text);
  if (!match) return null;
  let index = match.index + match[0].length;
  if (match[1] === '<') {
    const end = text.indexOf('>', index);
    if (end < 0) return null;
    const hex = text.slice(index, end).replace(/\s+/g, '');
    return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
  }
  const out: number[] = [];
  let depth = 1;
  while (index < text.length) {
    const char = text[index++];
    if (char === '\\') {
      const next = text[index++];
      const escapes: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (next in escapes) out.push(escapes[next]);
      else if (/[0-7]/.test(next)) {
        let octal = next;
        while (octal.length < 3 && /[0-7]/.test(text[index])) octal += text[index++];
        out.push(parseInt(octal, 8) & 0xff);
      } else if (next === '\r') { if (text[index] === '\n') index++; } else if (next !== '\n') out.push(next.charCodeAt(0));
      continue;
    }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return Buffer.from(out);
    out.push(char.charCodeAt(0));
  }
  return null;
}

// PDFDocEncoding where it is not Latin-1 (PDF 32000-1, annex D).
const PDF_DOC: Readonly<Record<number, string>> = {
  0x80: '•', 0x81: '†', 0x82: '‡', 0x83: '…', 0x84: '—', 0x85: '–', 0x86: 'ƒ', 0x87: '⁄', 0x88: '‹', 0x89: '›', 0x8a: '−', 0x8b: '‰',
  0x8c: '„', 0x8d: '“', 0x8e: '”', 0x8f: '‘', 0x90: '’', 0x91: '‚', 0x92: '™', 0x93: 'ﬁ', 0x94: 'ﬂ', 0x95: 'Ł', 0x96: 'Œ', 0x97: 'Š',
  0x98: 'Ÿ', 0x99: 'Ž', 0x9a: 'ı', 0x9b: 'ł', 0x9c: 'œ', 0x9d: 'š', 0x9e: 'ž', 0xa0: '€'
};

// A text string: UTF-16BE or UTF-8 after their byte order mark, else PDFDocEncoding.
function decodeText(bytes: Buffer): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  return [...bytes].map((byte) => PDF_DOC[byte] ?? String.fromCharCode(byte)).join('');
}

// Titles a program writes on its own, in the languages of the player's labels.
const GENERIC = /^(?:untitled(?: document)?|sans titre|ohne titel|sin t[ií]tulo|senza titolo|sem t[ií]tulo|zonder titel|document\s*\d*|dokument\s*\d*|documento\s*\d*|presentation\s*\d*|pr[ée]sentation(?: powerpoint)?\s*\d*|powerpoint presentation|präsentation\s*\d*|titre|title|titel|t[ií]tulo|titolo|slide\s*\d+|diapositive\s*\d+|folie\s*\d+|diapositiva\s*\d+)$/i;
const FILE_NAME = /\.(?:docx?|pptx?|xlsx?|pdf|rtf|odt|odp|pages|key|indd|txt|html?|tex|ai|psd)$/i;

// The title as the author wrote it, or null when a program wrote it (a file name, a form's code).
function authored(raw: string): string | null {
  const title = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^Microsoft (?:Word|PowerPoint|Excel) - /i, '');
  if (!title || title.length > 300 || GENERIC.test(title) || FILE_NAME.test(title) || /^[\w-]+$/.test(title) && title.includes('_') || /^[A-Z0-9.-]+$/.test(title) && /\d/.test(title)) return null;
  if (title.length <= TITLE_MAX) return title;
  // Longer than a resource's title may be: cut at a word, with an ellipsis.
  const cut = title.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '');
  return `${cut.length >= TITLE_MAX / 2 ? cut : title.slice(0, TITLE_MAX - 1)}…`;
}
