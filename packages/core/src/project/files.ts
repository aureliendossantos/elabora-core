import { normalize, extname } from '../util/paths.ts';
import { sha256 } from '../util/sha256.ts';
import type { FileMedia } from '../media/conformance.ts';

// The files of a project, in memory: an immutable map from a project-relative POSIX path to its
// content. Text files carry their text; binary files (images, video, fonts…) only their size, the
// hash of their bytes and, for media, what a probe found. Nothing else is ever read: the core sees a
// project only through a snapshot, so it runs the same over a folder, a browser store or a server.
//
// The snapshot leaves out tool folders (.elabora/, dist/, node_modules/, .git/), OS files and the
// artefacts of sync services (conflict copies, cloud placeholders), which are reported instead.

export type FileHash = `sha256:${string}`;

export interface TextFile {
  readonly kind: 'text';
  readonly text: string;
}

// hash: the store that made the snapshot may compute it on first read (the Node reader hashes a
// file only when something needs it, from a cache keyed by size and modification time).
// media: for media files in assets/, the probe (ffprobe on Node) and the verdict against the
// canonical formats of docs/architecture/media.md (core/media/conformance.ts).
export interface BinaryFile {
  readonly kind: 'binary';
  readonly size: number;
  readonly hash?: FileHash;
  readonly media?: FileMedia;
}

export type SourceFile = TextFile | BinaryFile;
export type ProjectFiles = ReadonlyMap<string, SourceFile>;

// What the store knows of the project's media beyond the files themselves: outputs of media jobs
// not done yet (references to them are expected), media files a probe could not read, and whether
// media could be probed at all (no ffprobe: no media information).
export interface MediaStatus {
  processing: readonly string[]; // project-relative paths
  unreadable: readonly { path: string; message: string }[];
  toolsMissing: boolean;
}

// A file a sync service left next to the project's own files: reported, never loaded.
export interface SyncArtefact {
  path: string;
  kind: 'conflict-copy' | 'cloud-placeholder';
  original?: string; // the file a conflict copy duplicates, or the file a placeholder stands for
}

const TEXT_EXTENSIONS = new Set(['.json', '.md', '.css', '.html', '.htm', '.js', '.mjs', '.svg', '.xlf', '.vtt', '.txt', '.csv']);
export const isTextPath = (p: string): boolean => TEXT_EXTENSIONS.has(extname(p).toLowerCase());

export const textFile = (text: string): TextFile => Object.freeze({ kind: 'text', text });
export const binaryFile = (size: number, extra: { hash?: FileHash; media?: FileMedia } = {}): BinaryFile => Object.freeze({ kind: 'binary', size, ...extra });

// A snapshot from entries; a string is the text of a text file.
export function createProjectFiles(entries: Iterable<readonly [string, SourceFile | string]>): ProjectFiles {
  const files = new Map<string, SourceFile>();
  for (const [p, f] of entries) {
    const key = projectPath(p);
    if (key === null || key !== p) throw new Error(`Not a project-relative POSIX path: "${p}"`);
    files.set(p, typeof f === 'string' ? textFile(f) : f);
  }
  return files;
}

// The author's sources (docs/decisions.md D49): the files a course is made from (a client's brief, a
// deck, recordings), at the top of the course folder, with their readable versions. They are not the
// course: no snapshot holds them, so nothing validates, journals, backs up or packages them.
export const SOURCES_DIR = 'sources';
export const isSourcePath = (p: string): boolean => p === SOURCES_DIR || p.startsWith(`${SOURCES_DIR}/`);

// The key of a path in a snapshot, normalised the way node:path joins it to the project folder
// (theme/../assets/x.svg → assets/x.svg, /x.css → x.css), or null when it leaves the project.
export function projectPath(rel: string): string | null {
  const p = normalize(rel.replace(/^\/+/, ''));
  if (p === '.' || p === '..' || p.startsWith('../') || p.endsWith('/')) return null;
  return p;
}

export function getFile(files: ProjectFiles, rel: string): SourceFile | undefined {
  const p = projectPath(rel);
  return p === null ? undefined : files.get(p);
}

export const hasFile = (files: ProjectFiles, rel: string): boolean => getFile(files, rel) !== undefined;

// Text of a text file; null when the file is missing or binary.
export function readText(files: ProjectFiles, rel: string): string | null {
  const f = getFile(files, rel);
  return f?.kind === 'text' ? f.text : null;
}

const textHashes = new WeakMap<TextFile, FileHash>();

// Hash of a file's bytes: computed for text files (UTF-8), given by the snapshot for binary files
// (null when the store did not provide it).
export function fileHash(files: ProjectFiles, rel: string): FileHash | null {
  const f = getFile(files, rel);
  if (!f) return null;
  if (f.kind === 'binary') return f.hash ?? null;
  let h = textHashes.get(f);
  if (!h) { h = `sha256:${sha256(f.text)}`; textHashes.set(f, h); }
  return h;
}

// Paths under a folder ("components" → "components/x/component.json"…), sorted.
export function pathsUnder(files: ProjectFiles, folder: string): string[] {
  const prefix = `${folder}/`;
  return [...files.keys()].filter((p) => p.startsWith(prefix)).sort();
}

// Names of the files directly in a folder ("screens" → "intro.json"…), sorted.
export function filesIn(files: ProjectFiles, folder: string): string[] {
  const prefix = `${folder}/`;
  return [...files.keys()].filter((p) => p.startsWith(prefix) && !p.includes('/', prefix.length)).map((p) => p.slice(prefix.length)).sort();
}

// Names of the folders directly in a folder ("objects" → "planetary-lab"…), sorted.
export function foldersIn(files: ProjectFiles, folder: string): string[] {
  const prefix = `${folder}/`;
  const names = new Set<string>();
  for (const p of files.keys()) {
    if (!p.startsWith(prefix)) continue;
    const slash = p.indexOf('/', prefix.length);
    if (slash > 0) names.add(p.slice(prefix.length, slash));
  }
  return [...names].sort();
}
