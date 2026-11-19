import fs from 'node:fs';
import path from 'node:path';
import type { HostNeeds } from '@elabora/core/commands/host';
import type { AddResourceRequest } from '@elabora/core/commands/resources';
import { binaryFile, isTextPath, textFile } from '@elabora/core/project/files';
import type { SourceFile } from '@elabora/core/project/files';
import { CommandError } from '@elabora/core/commands/context';
import { hashBytes } from '../blobs.ts';
import { pdfTitleOf } from '../sources/pdf-title.ts';

// « Ajouter une ressource » (docs/decisions.md D58, add_resource): the file read from this computer.
// Unlike a media import, nothing is converted: the file is the learner's to open or download as it
// is. The copy is part of the change: an undo removes it (its bytes stay in the project's blob
// store, as a font's do, so that a redo or a version brings it back).

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function resourceFile<R>(_dir: string, args: AddResourceRequest, _options: unknown, use: (given: HostNeeds['resourceFile']) => R): R {
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
  return use({ name, file: content, pdfTitle: /\.pdf$/i.test(name) ? pdfTitleOf(bytes) : null, ...(sources.size ? { bytes: sources } : {}) });
}
