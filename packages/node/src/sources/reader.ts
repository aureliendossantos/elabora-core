import fs from 'node:fs';
import path from 'node:path';
import type { MediaTools } from '../media/tools.ts';
import type { OfficePackage } from './ooxml.ts';
import { image, partLink } from './markdown.ts';
import { HEADER_BYTES, imageSize, smallPicture } from './image-size.ts';
import type { PixelSize, Placement } from './image-size.ts';
import { moveFile } from '../library/files.ts';

// What a reader of one kind of source is given and gives back (docs/decisions.md D49).

export type SourceProgress =
  | { source: string; phase: 'copy' | 'read' }
  | { source: string; phase: 'install'; received: number; total: number }
  | { source: string; phase: 'transcribe'; fraction: number };

export interface ReaderContext {
  source: string;          // the source's name under sources/
  sourceFile: string;      // its absolute path
  partsDir: string;        // where its images and other parts are written (a staging folder)
  partsFolder: string;     // that folder's name next to the Markdown: "<source>.files"
  language: string;        // the course's language: what a recording is heard as
  install: boolean;        // download the transcriber when it is not here (else the transcript waits)
  tools?: MediaTools;
  signal?: AbortSignal;
  onProgress?: (progress: SourceProgress) => void;
}

export interface ReaderResult {
  markdown: string;        // the body, after the header the readable version starts with
  complete: boolean;       // false: a part could not be made here (no transcriber yet); made again later
  notes: string[];         // what the reader of the Markdown should know (what is left out and why)
  parts: string[];         // names of the files in partsDir
}

// Images of Office files the agents read (PNG, JPEG, GIF, WebP, SVG); EMF, WMF and TIFF drawings are
// named, not extracted.
const VIEWABLE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);

// The images of one source, each extracted once whatever the number of places it appears in.
export class SourceParts {
  readonly #context: ReaderContext;
  readonly #names = new Map<string, string>();
  readonly #pixels = new Map<string, PixelSize | null>();
  readonly written: string[] = [];
  // The pictures a slide places that were left out as too small to matter (smallPicture), by place.
  skipped = 0;
  #images = 0;

  constructor(context: ReaderContext) {
    this.#context = context;
    fs.mkdirSync(context.partsDir, { recursive: true });
  }

  link(name: string): string {
    return partLink(this.#context.partsFolder, name);
  }

  // Moves a file into the parts (a video frame made in a temporary folder, maybe on another
  // volume than the library) and gives its link.
  async add(name: string, from: string): Promise<string> {
    await moveFile(from, path.join(this.#context.partsDir, name));
    this.written.push(name);
    return this.link(name);
  }

  // The Markdown of an image of the package: extracted on first use.
  async image(pkg: OfficePackage, part: string, alt: string): Promise<string> {
    // Without a placement nothing is left out, so there is always a Markdown.
    return (await this.placed(pkg, part, alt, undefined))!;
  }

  // The Markdown of a picture a slide places, or null when it is too small to matter there (`placement`:
  // the box it is shown in; null for a background, which has none). Every place of a picture is judged
  // by its own box: a logo left out as a dot in a corner is kept where it fills the slide.
  async placed(pkg: OfficePackage, part: string, alt: string, placement: Placement | null | undefined): Promise<string | null> {
    const extension = path.posix.extname(part).toLowerCase();
    const label = alt.trim() || 'Image';
    if (!VIEWABLE.has(extension)) return `*(${label}: an image in ${extension.slice(1).toUpperCase() || 'an unknown format'}, not extracted)*`;
    if (placement !== undefined) {
      if (!this.#pixels.has(part)) {
        const head = extension === '.svg' ? null : await pkg.head(part, HEADER_BYTES);
        this.#pixels.set(part, head ? imageSize(head) : null);
      }
      if (smallPicture(this.#pixels.get(part) ?? null, placement)) { this.skipped++; return null; }
    }
    let name = this.#names.get(part);
    if (!name) {
      name = `image-${String(this.#images + 1).padStart(2, '0')}${extension === '.jpeg' ? '.jpg' : extension}`;
      if (!(await pkg.extract(part, path.join(this.#context.partsDir, name)))) return `*(${label}: missing from the file)*`;
      this.#images++;
      this.#names.set(part, name);
      this.written.push(name);
    }
    return image(label, this.link(name));
  }
}
