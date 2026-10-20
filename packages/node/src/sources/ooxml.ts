import path from 'node:path';
import { ZipReader, ZipFormatError } from '../packaging/zip-reader.ts';
import type { ZipReaderEntry } from '../packaging/zip-reader.ts';
import { parseXml, elements } from './xml.ts';
import type { XmlElement } from './xml.ts';

// An Office Open XML package (.docx, .pptx): a ZIP of XML parts tied by relationships. Parts are read
// one at a time, never the whole file: a deck may carry hundreds of megabytes of video.

export class OfficeFileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Relationship {
  id: string;
  type: string; // the last segment of the relationship type: image, slide, notesSlide, comments…
  target: string; // a part name (no leading slash), or a URL when external
  external: boolean;
}

// Parts above this are not read as XML (a document.xml of a few hundred pages is a few megabytes).
const MAX_XML_BYTES = 64 * 1024 * 1024;

export class OfficePackage {
  readonly #reader: ZipReader;
  readonly #entries: Map<string, ZipReaderEntry>;

  private constructor(reader: ZipReader) {
    this.#reader = reader;
    this.#entries = new Map(reader.entries.map((entry) => [entry.name, entry]));
  }

  static async open(file: string): Promise<OfficePackage> {
    let reader: ZipReader;
    try {
      reader = await ZipReader.open(file);
    } catch (error) {
      // An encrypted Office file is an OLE container, not a ZIP: the author protected it with a password.
      if (error instanceof ZipFormatError) throw new OfficeFileError('E_SOURCE_UNREADABLE', `${path.basename(file)} cannot be opened: it is protected by a password or damaged (${error.message})`);
      throw error;
    }
    return new OfficePackage(reader);
  }

  has(part: string): boolean {
    return this.#entries.has(part);
  }

  get parts(): string[] {
    return [...this.#entries.keys()];
  }

  async bytes(part: string, maxBytes = MAX_XML_BYTES): Promise<Buffer | null> {
    const entry = this.#entries.get(part);
    if (!entry) return null;
    return this.#reader.readEntry(entry, maxBytes);
  }

  // The first bytes of a part (a picture's header), or null when the package has no such part.
  async head(part: string, bytes: number): Promise<Buffer | null> {
    const entry = this.#entries.get(part);
    return entry ? this.#reader.readPrefix(entry, bytes) : null;
  }

  async extract(part: string, target: string): Promise<boolean> {
    const entry = this.#entries.get(part);
    if (!entry) return false;
    await this.#reader.extractEntry(entry, target);
    return true;
  }

  async xml(part: string): Promise<XmlElement | null> {
    const bytes = await this.bytes(part);
    return bytes ? parseXml(bytes.toString('utf8')) : null;
  }

  // The relationships of a part (word/document.xml → word/_rels/document.xml.rels), by id.
  async relationships(part: string): Promise<Map<string, Relationship>> {
    const dir = path.posix.dirname(part);
    const relsPart = `${dir === '.' ? '' : `${dir}/`}_rels/${path.posix.basename(part)}.rels`;
    const root = await this.xml(relsPart);
    const out = new Map<string, Relationship>();
    if (!root) return out;
    for (const rel of elements(root, 'rel:Relationship')) {
      const id = rel.attributes.Id;
      const target = rel.attributes.Target;
      if (!id || target === undefined) continue;
      const external = rel.attributes.TargetMode === 'External';
      out.set(id, {
        id,
        type: (rel.attributes.Type ?? '').split('/').pop() ?? '',
        target: external ? target : resolvePart(dir, target),
        external
      });
    }
    return out;
  }

  close(): Promise<void> {
    return this.#reader.close();
  }
}

// A relationship's target as a part name: relative to the part's folder, or absolute from the root.
export function resolvePart(dir: string, target: string): string {
  const decoded = safeDecode(target);
  const joined = decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(dir === '.' ? '' : dir, decoded);
  return path.posix.normalize(joined).replace(/^(\.\.\/)+/, '');
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

// Text of the docProps/core.xml fields an author fills (title, subject, creator), when there.
export async function coreProperties(pkg: OfficePackage): Promise<{ title?: string; subject?: string; creator?: string }> {
  const root = await pkg.xml('docProps/core.xml');
  if (!root) return {};
  const text = (local: string) => {
    const found = root.children.find((node): node is XmlElement => typeof node !== 'string' && node.name.split(':').pop() === local);
    const value = found?.children.filter((node): node is string => typeof node === 'string').join('').trim();
    return value || undefined;
  };
  return { title: text('title'), subject: text('subject'), creator: text('creator') };
}
