import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SOURCES_DIR } from '@elabora/core/project/files';
import { hashFile, cloneFile } from '../blobs.ts';
import { writeFileAtomic } from '../util/fs.ts';
import { renameWithRetries } from '../library/files.ts';
import type { MediaTools } from '../media/tools.ts';
import { DOCX_READER, readDocx } from './docx.ts';
import { PPTX_READER, readPptx } from './pptx.ts';
import { RECORDING_READER, readRecording } from './recording.ts';
import { transcriberFor, transcriberInstalled } from '../transcribe/models.ts';
import { PARTS_SUFFIX, READABLE_SUFFIX, extensionOf, freeName, nameKey, sourceName } from './names.ts';
import type { ReaderContext, ReaderResult, SourceProgress } from './reader.ts';

// The author's sources (docs/decisions.md D49): the files a module is made from (a client's brief, a
// deck, a recorded interview), kept in sources/ at the top of the course folder, and each one's
// readable version beside it, which any agent can read: sources/<name>.md (Markdown: the text of a
// Word document with its comments and tracked changes, a deck's slides in reading order with their
// notes, a recording's transcript) and sources/<name>.files/ (its images: the deck's slides drawn,
// the pictures it holds, a video's frames). Readable versions are made on this computer and nothing
// leaves it: a brief may hold personal data. No program of the author's is used (D49, revised on
// 19 Oct 2026): they are rarely installed, cannot ship with Elabora and could not be tested.
//
// sources/ is not the course: no snapshot holds it, so it is never validated, journaled, backed up,
// built or published (project-files.ts; the validator and the build refuse what points into it,
// E_SOURCE_REFERENCED). A module's copy, its import from a folder and, when asked, its archive carry
// it (library/); the trash keeps it with the module.

export { SOURCES_DIR } from '@elabora/core/project/files';
export { READABLE_SUFFIX, PARTS_SUFFIX, sourceName } from './names.ts';
export type { SourceProgress } from './reader.ts';

export type SourceKind = 'word' | 'powerpoint' | 'pdf' | 'video' | 'audio' | 'image' | 'text' | 'other';

// ready: up to date · partial: made without a part that can be made later (a transcript before the
// transcriber is here) · stale: the file changed since, or Elabora reads it better now · missing: not
// made yet · failed: the file could not be read (its readable version says why) · native: read as it
// is (images, text, PDFs) · unsupported: Elabora does not read it (an older office format, whose notes
// say to save it as .docx or .pptx; other files).
export type ReadableStatus = 'ready' | 'partial' | 'stale' | 'missing' | 'failed' | 'native' | 'unsupported';

export interface ReadableView {
  status: ReadableStatus;
  path: string | null;     // what to read, relative to the course folder: sources/<name>.md, or the source itself
  parts: string[];         // its images and other files, relative to the course folder
  notes: string[];         // what the readable version lacks and why
  madeAt: string | null;
}

export interface SourceEntry {
  name: string;            // under sources/, POSIX ("brief.docx", "client/brief.docx")
  path: string;            // absolute
  size: number;
  modifiedAt: string;
  kind: SourceKind;
  readable: ReadableView;
}

export class SourceError extends Error {
  readonly code: 'E_NOT_A_COURSE' | 'E_SOURCE_NOT_FOUND' | 'E_SOURCE_NOT_A_FILE';
  readonly details: Record<string, unknown>;
  constructor(code: SourceError['code'], message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.details = details;
  }
}

const KINDS: [SourceKind, string[]][] = [
  ['word', ['.docx', '.docm', '.dotx', '.dotm', '.doc', '.dot', '.rtf', '.odt']],
  ['powerpoint', ['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.ppt', '.pps', '.odp', '.key']],
  ['pdf', ['.pdf']],
  ['video', ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.mts', '.m2ts', '.mpg', '.mpeg', '.3gp']],
  ['audio', ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wma', '.aif', '.aiff', '.amr']],
  ['image', ['.png', '.jpg', '.jpeg', '.gif', '.webp']],
  ['text', ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.xml', '.vtt', '.srt', '.svg']],
];
const KIND_OF = new Map(KINDS.flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind] as const)));
// Office Open XML, read by Elabora itself; the other office formats (.doc, .rtf, .odt, .ppt, .pps,
// .odp, .key) are not read: the author saves them as .docx or .pptx (or as PDF) from the application
// that made them.
const OPEN_XML = new Set(['.docx', '.docm', '.dotx', '.dotm', '.pptx', '.pptm', '.ppsx', '.ppsm', '.potx']);
const isOlderFormat = (name: string, kind: SourceKind): boolean => (kind === 'word' || kind === 'powerpoint') && !OPEN_XML.has(extensionOf(name));
const olderFormatNote = (name: string, kind: SourceKind): string =>
  `${extensionOf(name).slice(1).toUpperCase()} is an older ${kind === 'word' ? 'word-processing' : 'presentation'} format that Elabora does not read: save the file as ${kind === 'word' ? '.docx' : '.pptx'} (or as a PDF) from the application that made it, and add that file to the sources.`;
export const kindOf = (name: string): SourceKind => KIND_OF.get(extensionOf(name)) ?? 'other';

// The reader of each kind, versioned: a better reader makes earlier readable versions stale. Images,
// texts and PDFs have none: agents read them as they are.
const READERS: Partial<Record<SourceKind, string>> = { word: DOCX_READER, powerpoint: PPTX_READER, video: RECORDING_READER, audio: RECORDING_READER };

// The first line of a readable version: what it was made from, so that Elabora knows it from the
// author's own Markdown and tells whether it is up to date.
interface Marker {
  source: string;
  sha256: string;
  size: number;
  mtimeMs: number;
  reader: string;
  complete: boolean;
  failed?: boolean;
  notes: string[];
  madeAt: string;
}
const MARKER = /^<!-- elabora:readable (\{.*\}) -->\r?\n/;

function readMarker(file: string): Marker | null {
  let head: string;
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(8192);
      head = buffer.subarray(0, fs.readSync(handle, buffer, 0, buffer.length, 0)).toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  const match = MARKER.exec(head);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]) as Marker;
    return typeof value.source === 'string' && typeof value.sha256 === 'string' ? value : null;
  } catch {
    return null;
  }
}

const sourcesDir = (dir: string) => path.join(path.resolve(dir), SOURCES_DIR);
const relative = (name: string) => `${SOURCES_DIR}/${name}`;

function assertCourse(dir: string): string {
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, 'course.json'))) throw new SourceError('E_NOT_A_COURSE', `${root} has no course.json: it is not an Elabora course folder.`);
  return root;
}

interface Found { name: string; file: string; stat: fs.Stats }

// Every source of the folder, readable versions and hidden files left out.
function walkSources(root: string): Found[] {
  const base = path.join(root, SOURCES_DIR);
  const found: Found[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.map((entry) => nameKey(entry.name)));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || /^(Thumbs\.db|desktop\.ini|Icon\r)$/i.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const key = nameKey(entry.name);
      if (entry.isDirectory()) {
        // A source's parts, beside it; any other folder holds sources the author arranged by hand.
        if (key.endsWith(PARTS_SUFFIX) && names.has(key.slice(0, -PARTS_SUFFIX.length))) continue;
        walk(file, name);
      } else if (entry.isFile()) {
        if (key.endsWith(READABLE_SUFFIX) && names.has(key.slice(0, -READABLE_SUFFIX.length)) && readMarker(file)) continue;
        try { found.push({ name, file, stat: fs.statSync(file) }); } catch { /* removed meanwhile */ }
      }
    }
  };
  walk(base, '');
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

async function view(found: Found): Promise<ReadableView> {
  const kind = kindOf(found.name);
  const markdown = `${found.file}${READABLE_SUFFIX}`;
  const partsDir = `${found.file}${PARTS_SUFFIX}`;
  const parts = () => {
    try { return fs.readdirSync(partsDir).filter((name) => !name.startsWith('.')).sort().map((name) => relative(`${found.name}${PARTS_SUFFIX}/${name}`)); } catch { return []; }
  };
  // An older office format is not read, whatever readable version an earlier Elabora made of it.
  if (isOlderFormat(found.name, kind)) return { status: 'unsupported', path: null, parts: [], notes: [olderFormatNote(found.name, kind)], madeAt: null };
  const reader = READERS[kind];
  const marker = reader ? readMarker(markdown) : null;
  if (!marker) {
    if (kind === 'image' || kind === 'text') return { status: 'native', path: relative(found.name), parts: [], notes: [], madeAt: null };
    // Agents read PDFs themselves: Elabora makes no text of its own from them.
    if (kind === 'pdf') return { status: 'native', path: relative(found.name), parts: [], notes: ['Read the PDF itself: agents read PDFs directly, and Elabora keeps no readable version of one.'], madeAt: null };
    if (kind === 'other') return { status: 'unsupported', path: null, parts: [], notes: [`Elabora does not read ${extensionOf(found.name) || 'this kind of file'} files yet.`], madeAt: null };
    return { status: 'missing', path: null, parts: [], notes: [], madeAt: null };
  }
  const base = { path: relative(`${found.name}${READABLE_SUFFIX}`), parts: parts(), notes: marker.notes ?? [], madeAt: marker.madeAt ?? null };
  if (marker.reader !== reader) return { status: 'stale', ...base };
  if (marker.size !== found.stat.size) return { status: 'stale', ...base };
  if (marker.mtimeMs !== found.stat.mtimeMs) {
    // Copied, or touched: the same content is still up to date (and remembered with its new time).
    if (`sha256:${marker.sha256}` !== (await hashFile(found.file))) return { status: 'stale', ...base };
    try {
      const text = fs.readFileSync(markdown, 'utf8');
      writeFileAtomic(markdown, text.replace(MARKER, `${markerLine({ ...marker, mtimeMs: found.stat.mtimeMs })}\n`));
    } catch { /* read-only: hashed again next time */ }
  }
  if (marker.failed) return { status: 'failed', ...base };
  return { status: marker.complete ? 'ready' : 'partial', ...base };
}

const markerLine = (marker: Marker): string => `<!-- elabora:readable ${JSON.stringify(marker).replace(/--/g, '-\\u002d')} -->`;

async function entryOf(root: string, found: Found): Promise<SourceEntry> {
  return { name: found.name, path: found.file, size: found.stat.size, modifiedAt: new Date(found.stat.mtimeMs).toISOString(), kind: kindOf(found.name), readable: await view(found) };
}

// The sources of a course, each with the state of its readable version.
export async function listSources(dir: string): Promise<SourceEntry[]> {
  const root = assertCourse(dir);
  const out: SourceEntry[] = [];
  for (const found of walkSources(root)) out.push(await entryOf(root, found));
  return out;
}

// Every file of sources/, readable versions included, as course-relative POSIX paths: what a copy of
// the module or its archive carries. Hidden files are left out (Elabora's own work in progress among
// them), and symbolic links are never followed.
export function sourceFiles(dir: string): { path: string; size: number; mtimeMs: number }[] {
  const out: { path: string; size: number; mtimeMs: number }[] = [];
  const walk = (folder: string, rel: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || /^(Thumbs\.db|desktop\.ini|Icon\r)$/i.test(entry.name)) continue;
      const file = path.join(folder, entry.name);
      const name = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(file, name);
      else if (entry.isFile()) { try { const stat = fs.statSync(file); out.push({ path: name, size: stat.size, mtimeMs: stat.mtimeMs }); } catch { /* removed meanwhile */ } }
    }
  };
  walk(sourcesDir(dir), SOURCES_DIR);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// The bytes sources/ takes, readable versions included (the library shows it beside the module's).
export function sourcesSize(dir: string): { files: number; bytes: number } {
  const files = sourceFiles(dir);
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}

export interface AddedSource {
  from: string;                         // the file given
  name: string;                         // its name under sources/
  status: 'added' | 'already-there';    // already-there: a source with the same content was there (nothing copied)
  renamed: boolean;                     // the name differs from the file's (made portable, or numbered)
}

export interface AddSourcesOptions {
  onProgress?: (progress: SourceProgress) => void;
  signal?: AbortSignal;
}

// Copies files into sources/ (clones where the file system allows it: a 300 MB video costs no
// space on APFS). A folder given brings the files it holds. A file whose content is already there
// is not copied again; a name already taken by another file is numbered (« brief (2).docx »); a
// name Windows or macOS would refuse is made portable. Readable versions are made apart
// (makeSourcesReadable): this returns as soon as the files are copied.
export async function addSources(dir: string, files: readonly string[], options: AddSourcesOptions = {}): Promise<AddedSource[]> {
  const root = assertCourse(dir);
  const base = sourcesDir(root);
  const given: { from: string; file: string }[] = [];
  const expand = (from: string, file: string) => {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { throw new SourceError('E_SOURCE_NOT_FOUND', `${from} does not exist.`, { path: from }); }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || /^(Thumbs\.db|desktop\.ini|Icon\r)$/i.test(entry.name)) continue;
        if (entry.isDirectory() || entry.isFile()) expand(path.join(from, entry.name), path.join(file, entry.name));
      }
    } else if (stat.isFile()) given.push({ from, file });
    else throw new SourceError('E_SOURCE_NOT_A_FILE', `${from} is not a file.`, { path: from });
  };
  for (const from of files) expand(from, path.resolve(from));
  fs.mkdirSync(base, { recursive: true });

  const existing = walkSources(root);
  const taken = new Set<string>();
  for (const entry of fs.readdirSync(base)) taken.add(nameKey(entry));
  const hashes = new Map<string, Promise<string>>(); // existing sources by hash, computed for the sizes met
  const hashOf = (file: string) => { let known = hashes.get(file); if (!known) { known = hashFile(file); hashes.set(file, known); } return known; };
  const added: AddedSource[] = [];
  for (const { from, file } of given) {
    options.signal?.throwIfAborted();
    const stat = fs.statSync(file);
    // A file of sources/ itself is there already.
    const inside = path.relative(base, file);
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
      added.push({ from, name: inside.split(path.sep).join('/'), status: 'already-there', renamed: false });
      continue;
    }
    let duplicate: Found | undefined;
    let incoming: Promise<string> | null = null;
    for (const candidate of existing) {
      if (candidate.stat.size !== stat.size) continue;
      incoming ??= hashFile(file);
      if ((await hashOf(candidate.file)) === (await incoming)) { duplicate = candidate; break; }
    }
    if (duplicate) {
      added.push({ from, name: duplicate.name, status: 'already-there', renamed: false });
      continue;
    }
    options.onProgress?.({ source: path.basename(file), phase: 'copy' });
    const wanted = sourceName(path.basename(file));
    const temp = path.join(base, `.adding-${crypto.randomBytes(6).toString('hex')}`);
    try {
      if (!(await cloneFile(file, temp, stat.size))) await fs.promises.copyFile(file, temp, fs.constants.COPYFILE_EXCL);
      // The name is claimed by a hard link, which fails when another process took it meanwhile.
      let name = freeName(wanted, (key) => taken.has(key));
      for (let attempt = 0; ; attempt++) {
        try {
          await claim(temp, path.join(base, name));
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 50) throw error;
          taken.add(nameKey(name));
          name = freeName(wanted, (key) => taken.has(key));
        }
      }
      taken.add(nameKey(name));
      const final = path.join(base, name);
      existing.push({ name, file: final, stat: fs.statSync(final) });
      if (incoming) hashes.set(final, incoming);
      added.push({ from, name, status: 'added', renamed: name !== path.basename(file) });
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  return added;
}

async function claim(temp: string, target: string): Promise<void> {
  try {
    await fs.promises.link(temp, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // File systems without hard links (exFAT, some network shares): a rename after a check.
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'ENOSYS') throw error;
    if (fs.existsSync(target)) throw Object.assign(new Error(`${target} exists`), { code: 'EEXIST' });
    await fs.promises.rename(temp, target);
  }
}

// A source by what an agent or the author calls it: its name, sources/<name>, its path, or its
// readable version's name; without case when only one source matches.
export function resolveSource(dir: string, reference: string): Found {
  const root = assertCourse(dir);
  const all = walkSources(root);
  const base = sourcesDir(root);
  let wanted = reference.replace(/\\/g, '/');
  const absolute = path.resolve(root, reference);
  const inside = path.relative(base, absolute);
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) wanted = inside.split(path.sep).join('/');
  else if (wanted.startsWith(`${SOURCES_DIR}/`)) wanted = wanted.slice(SOURCES_DIR.length + 1);
  for (const suffix of [READABLE_SUFFIX, PARTS_SUFFIX]) {
    const stem = wanted.endsWith(suffix) ? wanted.slice(0, -suffix.length) : null;
    if (stem && !all.some((found) => found.name === wanted) && all.some((found) => found.name === stem)) wanted = stem;
  }
  const exact = all.find((found) => found.name === wanted || found.name.normalize('NFC') === wanted.normalize('NFC'));
  if (exact) return exact;
  const loose = all.filter((found) => nameKey(found.name) === nameKey(wanted));
  if (loose.length === 1) return loose[0];
  throw new SourceError('E_SOURCE_NOT_FOUND', `No source "${reference}" in ${SOURCES_DIR}/${all.length ? ` (there are: ${all.slice(0, 12).map((found) => found.name).join(', ')}${all.length > 12 ? '…' : ''})` : ' (it is empty)'}.`, { sources: all.map((found) => found.name) });
}

export interface ReadableOptions {
  install?: boolean;       // download the transcriber when a recording needs it (default: false; the CLI and MCP say true, as D46)
  language?: string;       // what recordings are heard as (default: the course's language)
  tools?: MediaTools;
  signal?: AbortSignal;
  onProgress?: (progress: SourceProgress) => void;
}

// Makes the readable versions that are missing, stale or partial (all of them with force; only
// those named with names), one source after the other. Returns the sources with their new state.
export async function makeSourcesReadable(dir: string, options: ReadableOptions & { names?: readonly string[]; force?: boolean } = {}): Promise<SourceEntry[]> {
  const root = assertCourse(dir);
  const chosen = options.names ? options.names.map((name) => resolveSource(root, name)) : walkSources(root);
  const out: SourceEntry[] = [];
  for (const found of chosen) {
    options.signal?.throwIfAborted();
    const current = await entryOf(root, found);
    const status = current.readable.status;
    const due = options.force ? status !== 'native' && status !== 'unsupported' : status === 'missing' || status === 'stale' || (status === 'partial' && completable(root, options));
    out.push(due ? await makeReadable(root, found, options) : current);
  }
  return out;
}

export interface SourceReading {
  source: SourceEntry;
  file: string | null;     // what to read (absolute): the readable version, or the source itself
  text: string | null;     // its text, when it is text
}

// A source's readable version, made first when it is missing or out of date (refresh: false only
// reads what is there). An image or a PDF is read as it is: its path, no text.
export async function readSource(dir: string, reference: string, options: ReadableOptions & { refresh?: boolean } = {}): Promise<SourceReading> {
  const root = assertCourse(dir);
  const found = resolveSource(root, reference);
  let source = await entryOf(root, found);
  const status = source.readable.status;
  if (options.refresh !== false && (status === 'missing' || status === 'stale' || (status === 'partial' && completable(root, options)))) source = await makeReadable(root, found, options);
  const target = source.readable.path ? path.join(root, ...source.readable.path.split('/')) : null;
  let text: string | null = null;
  if (target && (source.readable.status !== 'native' || source.kind === 'text')) {
    try { text = fs.readFileSync(target, 'utf8'); } catch { text = null; }
  }
  return { source, file: target, text };
}

// Deletes a source and its readable version for good: no backup holds sources (D49), so a brief
// with personal data is gone from the module once removed (a module in the trash keeps its own).
export async function removeSource(dir: string, reference: string): Promise<{ removed: string[] }> {
  const root = assertCourse(dir);
  const found = resolveSource(root, reference);
  const removed: string[] = [];
  for (const [target, name] of [[found.file, found.name], [`${found.file}${READABLE_SUFFIX}`, `${found.name}${READABLE_SUFFIX}`], [`${found.file}${PARTS_SUFFIX}`, `${found.name}${PARTS_SUFFIX}`]] as const) {
    if (!fs.existsSync(target)) continue;
    if (target !== found.file && target.endsWith(READABLE_SUFFIX) && !readMarker(target)) continue;
    await fs.promises.rm(target, { recursive: true, force: true });
    removed.push(relative(name));
  }
  return { removed };
}

// Copies a course's sources into another course folder (a module's copy, an import from a folder).
export async function copySources(fromDir: string, toDir: string, copy: (from: string, to: string) => Promise<void>): Promise<number> {
  const files = sourceFiles(fromDir);
  for (const file of files) await copy(path.join(path.resolve(fromDir), ...file.path.split('/')), path.join(path.resolve(toDir), ...file.path.split('/')));
  return files.length;
}

// ── Making a readable version ───────────────────────────────────────────

// A partial readable version lacks a transcript: made again once the transcriber can be had.
function completable(root: string, options: ReadableOptions): boolean {
  if (options.install) return true;
  const model = transcriberFor(options.language ?? courseLanguage(root));
  return !!model && transcriberInstalled(model);
}

const making = new Map<string, Promise<SourceEntry>>();

function makeReadable(root: string, found: Found, options: ReadableOptions): Promise<SourceEntry> {
  // One at a time per source in this process: the app may ask twice (a list, then a read).
  const key = found.file;
  const running = making.get(key);
  if (running) return running;
  const promise = writeReadable(root, found, options).finally(() => making.delete(key));
  making.set(key, promise);
  return promise;
}

function courseLanguage(root: string): string {
  try {
    const course = JSON.parse(fs.readFileSync(path.join(root, 'course.json'), 'utf8')) as { language?: unknown };
    return typeof course.language === 'string' && course.language ? course.language : 'fr';
  } catch {
    return 'fr';
  }
}

const KIND_LABEL: Record<SourceKind, string> = { word: 'Word document', powerpoint: 'PowerPoint deck', pdf: 'PDF', video: 'video', audio: 'recording', image: 'image', text: 'text', other: 'file' };

async function writeReadable(root: string, found: Found, options: ReadableOptions): Promise<SourceEntry> {
  const kind = kindOf(found.name);
  const folder = path.dirname(found.file);
  const base = path.basename(found.file);
  const staging = path.join(folder, `.elabora-readable-${crypto.randomBytes(6).toString('hex')}`);
  const partsStage = path.join(staging, 'parts');
  fs.mkdirSync(partsStage, { recursive: true });
  const before = fs.statSync(found.file);
  const sha256 = (await hashFile(found.file)).slice('sha256:'.length);
  const context: ReaderContext = {
    source: found.name, sourceFile: found.file, partsDir: partsStage, partsFolder: `${base}${PARTS_SUFFIX}`,
    language: options.language ?? courseLanguage(root), install: !!options.install,
    tools: options.tools, signal: options.signal, onProgress: options.onProgress
  };
  options.onProgress?.({ source: found.name, phase: 'read' });
  let result: ReaderResult;
  let failed = false;
  try {
    result = await readWith(kind, found.file, context);
  } catch (error) {
    if (options.signal?.aborted) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
    failed = true;
    const reason = (error as Error).message || String(error);
    result = { markdown: `Elabora could not read this file: ${reason}`, complete: true, notes: [], parts: [] };
    fs.rmSync(partsStage, { recursive: true, force: true });
    fs.mkdirSync(partsStage);
  }
  try {
    const marker: Marker = { source: base, sha256, size: before.size, mtimeMs: before.mtimeMs, reader: READERS[kind] ?? '', complete: result.complete, ...(failed ? { failed } : {}), notes: result.notes, madeAt: new Date().toISOString() };
    const header = [
      markerLine(marker),
      `# ${base}`,
      '',
      `> The readable version of \`${relative(found.name)}\` (${KIND_LABEL[kind]}), written by Elabora on this computer from the file as it was on ${marker.madeAt.slice(0, 10)}, and written again when the file changes: do not edit it. Sources are never published; a client's brief may hold personal data, so quote only what the module needs.`,
      ...result.notes.map((note) => `>\n> ${note}`),
      '',
    ].join('\n');
    const markdown = `${header}\n${result.markdown.trim()}\n`;
    // Into place: the parts first (a reader of the Markdown finds its images), then the Markdown.
    const partsTarget = `${found.file}${PARTS_SUFFIX}`;
    if (fs.existsSync(partsTarget)) await renameWithRetries(partsTarget, path.join(staging, 'old'));
    if (fs.readdirSync(partsStage).length) await renameWithRetries(partsStage, partsTarget);
    writeFileAtomic(`${found.file}${READABLE_SUFFIX}`, markdown);
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
  return entryOf(root, { ...found, stat: fs.statSync(found.file) });
}

async function readWith(kind: SourceKind, file: string, context: ReaderContext): Promise<ReaderResult> {
  if (kind === 'word') return readDocx(file, context);
  if (kind === 'powerpoint') return readPptx(file, context);
  if (kind === 'video' || kind === 'audio') return readRecording(file, context);
  throw new Error('Elabora does not read this kind of file.');
}
