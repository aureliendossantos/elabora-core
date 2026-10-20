import fs from 'node:fs';
import path from 'node:path';
import { addResource as addResourceCommand } from '@elabora/core/commands/resources';
import type { AddResourceRequest, AddResourceResult } from '@elabora/core/commands/resources';
import { binaryFile, isTextPath, textFile } from '@elabora/core/project/files';
import type { SourceFile } from '@elabora/core/project/files';
import { CommandError } from '@elabora/core/commands/context';
import { hashBytes } from '../blobs.ts';
import { pdfTitleOf } from '../sources/pdf-title.ts';
import { runCommand, type EditOptions, type EditResult } from './executor.ts';

// « Ajouter une ressource » (docs/decisions.md D58): any file (a PDF, a spreadsheet, a document, an
// image) copied into assets/resources/ and added to the player's resources, in one journaled change
// (add_resource). Unlike a media import, nothing is converted: the file is the learner's to open or
// download as it is. Its title: the one given, else the title a PDF gives itself, else its name.
// The copy is part of the change: an undo removes it (its bytes stay in the project's blob store, as
// a font's do, so that a redo or a version brings it back).

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// A title from a file's name: « fiche_reflexe-impression v2.pdf » → « fiche reflexe-impression v2 ».
export const titleFromName = (name: string): string => name.replace(/\.[A-Za-z0-9]{1,8}$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

export function addResource(dir: string, args: AddResourceRequest, options?: EditOptions): EditResult & AddResourceResult & { titleFrom: 'given' | 'pdf' | 'name' } {
  const file = path.resolve(args.path);
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { throw new CommandError(`No file at ${args.path}.`); }
  if (!stat.isFile()) throw new CommandError(`${args.path} is not a file.`);
  const name = path.basename(file);
  const bytes = fs.readFileSync(file);
  // A text the course reads as text (CSV, Markdown, SVG…) is kept as text when it is UTF-8; any other
  // file, byte for byte.
  let content: SourceFile;
  const sources = new Map<string, Uint8Array | string>();
  let text: string | null = null;
  if (isTextPath(name)) { try { text = UTF8.decode(bytes); } catch { text = null; } }
  if (text !== null) content = textFile(text);
  else {
    const hash = hashBytes(bytes);
    sources.set(hash, file);
    content = binaryFile(bytes.length, { hash });
  }
  const pdf = /\.pdf$/i.test(name) ? pdfTitleOf(bytes) : null;
  const given = args.title?.trim();
  const title = given || pdf || titleFromName(name) || name;
  const result = runCommand(dir, { name: 'add_resource', args: { name, title, ...(args.description ? { description: args.description } : {}) }, run: (context) => addResourceCommand(context, { name, file: content, title, ...(args.description ? { description: args.description } : {}) }), sources }, options);
  return { ...result, titleFrom: given ? 'given' : pdf ? 'pdf' : 'name' };
}
