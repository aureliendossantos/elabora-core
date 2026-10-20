import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { blobPath, listBlobs, type BlobHash } from '../blobs.ts';
import { isIgnoredPath } from '../project-files.ts';
import { VERSION_REASONS, type BackupStatus, type FileEntry, type Version, type VersionDiff, type VersionSummary } from './types.ts';
import { projectDataDir } from '../data-dir.ts';

// Version manifests in .elabora/backups/versions/<UTC time>-<id>.json. The contents live in the blob
// store (.elabora/blobs), shared with the journal.

export const BACKUPS_DIR = 'backups';
export const VERSIONS_DIR = path.join(BACKUPS_DIR, 'versions');
export const FORMAT = 'elabora-backup/1';

const HASH = /^sha256:[0-9a-f]{64}$/;
const FILE_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d{3})?Z)-/;

export const newVersionId = (): string => crypto.randomBytes(4).toString('hex');

// Colons are not allowed in Windows file names; the fixed width keeps names in time order.
export const versionFileName = (version: Pick<Version, 'time' | 'id'>): string => `${version.time.replace(/:/g, '-')}-${version.id}.json`;

export const toMs = (time: Date | number | string): number => (typeof time === 'number' ? time : typeof time === 'string' ? Date.parse(time) : time.getTime());

// A path read from a manifest must stay inside the project and outside the tool folders, whatever
// the manifest says (it may come from another computer through a synced folder).
export function isSafeProjectPath(p: string): boolean {
  if (!p || p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) return false;
  return !isIgnoredPath(p);
}

function checkEntries(entries: unknown, where: string): Record<string, FileEntry> {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${where} is not an object`);
  const out: Record<string, FileEntry> = {};
  for (const [p, e] of Object.entries(entries as Record<string, { hash?: unknown; size?: unknown }>)) {
    if (!isSafeProjectPath(p)) throw new Error(`${where}: unsafe path ${JSON.stringify(p)}`);
    if (typeof e?.hash !== 'string' || !HASH.test(e.hash) || typeof e.size !== 'number') throw new Error(`${where}: bad entry for ${p}`);
    out[p] = { hash: e.hash as BlobHash, size: e.size };
  }
  return out;
}

// Parses and checks a manifest. Anything unexpected makes it unreadable: restore and garbage
// collection must never act on a manifest they do not fully understand.
export function parseVersion(text: string): Version {
  const v = JSON.parse(text) as Partial<Version> & Record<string, unknown>;
  if (v?.format !== FORMAT) throw new Error(`unknown format ${JSON.stringify(v?.format)}`);
  if (typeof v.id !== 'string' || !/^[0-9a-z]+$/.test(v.id)) throw new Error('bad id');
  if (typeof v.time !== 'string' || Number.isNaN(Date.parse(v.time))) throw new Error('bad time');
  if (!VERSION_REASONS.includes(v.reason as Version['reason'])) throw new Error(`unknown reason ${JSON.stringify(v.reason)}`);
  return {
    format: FORMAT,
    id: v.id,
    time: v.time,
    reason: v.reason as Version['reason'],
    name: typeof v.name === 'string' ? v.name : null,
    batch: typeof v.batch === 'string' ? v.batch : null,
    author: v.author && typeof v.author === 'object' ? v.author : null,
    files: checkEntries(v.files, 'files'),
    trimmed: checkEntries(v.trimmed ?? {}, 'trimmed'),
    skipped: Array.isArray(v.skipped) ? v.skipped : [],
  };
}

// Atomic and flushed: a crash leaves the previous manifest or the new one, never half of one.
export function writeVersion(projectDir: string, version: Version): void {
  const dir = path.join(projectDataDir(projectDir), VERSIONS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, versionFileName(version));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(version, null, 1)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function removeVersionFile(projectDir: string, version: Pick<Version, 'time' | 'id'>): void {
  fs.rmSync(path.join(projectDataDir(projectDir), VERSIONS_DIR, versionFileName(version)), { force: true });
}

const byTime = (a: Version, b: Version): number => Date.parse(a.time) - Date.parse(b.time) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Every version, oldest first. `strays` are readable manifests under another file name (a sync
// service's conflict copy of a manifest): not listed, but the blobs they name are kept. `problems`
// are manifests that could not be read.
export function loadVersions(projectDir: string): { versions: Version[]; strays: Version[]; problems: string[] } {
  const dir = path.join(projectDataDir(projectDir), VERSIONS_DIR);
  if (!fs.existsSync(dir)) return { versions: [], strays: [], problems: [] };
  const versions: Version[] = [];
  const strays: Version[] = [];
  const problems: string[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    let v: Version;
    try {
      v = parseVersion(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch (e) {
      problems.push(`${path.posix.join('.elabora/backups/versions', name)}: ${(e as Error).message}`);
      continue;
    }
    (name === versionFileName(v) ? versions : strays).push(v);
  }
  return { versions: versions.sort(byTime), strays, problems };
}

// The newest version, reading only its manifest: file names sort in time order.
export function newestVersion(projectDir: string): Version | null {
  const dir = path.join(projectDataDir(projectDir), VERSIONS_DIR);
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((n) => FILE_TIME.test(n) && n.endsWith('.json')).sort().reverse();
  for (const name of names) {
    try {
      const v = parseVersion(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (name === versionFileName(v)) return v;
    } catch {
      // unreadable: listed in problems by loadVersions; the next one is the newest readable
    }
  }
  return null;
}

// Time of the newest version from the file names alone (cheap: called before every CLI write).
export function newestVersionTime(projectDir: string): number | null {
  const dir = path.join(projectDataDir(projectDir), VERSIONS_DIR);
  if (!fs.existsSync(dir)) return null;
  let newest: number | null = null;
  for (const name of fs.readdirSync(dir)) {
    const m = FILE_TIME.exec(name);
    if (!m || !name.endsWith('.json')) continue;
    const t = Date.parse(`${m[1]}:${m[2]}:${m[3]}`);
    if (!Number.isNaN(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

export function summarize(v: Version): VersionSummary {
  let bytes = 0;
  for (const e of Object.values(v.files)) bytes += e.size;
  return {
    id: v.id,
    time: v.time,
    reason: v.reason,
    name: v.name,
    batch: v.batch,
    author: v.author,
    files: Object.keys(v.files).length,
    bytes,
    trimmed: Object.keys(v.trimmed).length,
    skipped: v.skipped.length,
  };
}

// Versions, oldest first.
export function listVersions(projectDir: string): VersionSummary[] {
  return loadVersions(projectDir).versions.map(summarize);
}

// A version by id, by a unique id prefix (4 characters or more), by file name, or by name (the
// newest version with that name). Null when nothing matches; an error when a prefix is ambiguous.
export function findVersion(projectDir: string, ref: string): Version | null {
  const { versions } = loadVersions(projectDir);
  const exact = versions.find((v) => v.id === ref || versionFileName(v) === ref || versionFileName(v) === `${ref}.json`);
  if (exact) return exact;
  if (/^[0-9a-f]{4,}$/.test(ref)) {
    const matches = versions.filter((v) => v.id.startsWith(ref));
    if (matches.length > 1) throw new Error(`Several versions start with ${ref}: ${matches.map((v) => v.id).join(', ')}`);
    if (matches.length === 1) return matches[0];
  }
  const named = versions.filter((v) => v.name === ref);
  return named.length ? named[named.length - 1] : null;
}

export function readVersion(projectDir: string, ref: string): Version {
  const v = findVersion(projectDir, ref);
  if (!v) throw new Error(`No backup version ${ref}`);
  return v;
}

// What changed from version a to version b. Trimmed files count with their recorded hash: the
// version still knows what they were.
export function diffVersions(a: Version, b: Version): VersionDiff {
  const before = { ...a.trimmed, ...a.files };
  const after = { ...b.trimmed, ...b.files };
  const diff: VersionDiff = { added: [], removed: [], changed: [] };
  for (const p of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const x = before[p];
    const y = after[p];
    if (!x) diff.added.push({ path: p, after: y });
    else if (!y) diff.removed.push({ path: p, before: x });
    else if (x.hash !== y.hash) diff.changed.push({ path: p, before: x, after: y });
  }
  return diff;
}

export function status(projectDir: string): BackupStatus {
  const { versions, problems } = loadVersions(projectDir);
  let storedBytes = 0;
  const blobs = listBlobs(projectDir);
  for (const hash of blobs) {
    try {
      storedBytes += fs.statSync(blobPath(projectDir, hash)).size;
    } catch {
      // removed by a concurrent garbage collection
    }
  }
  const oldest = versions.length ? summarize(versions[0]) : null;
  const newest = versions.length ? summarize(versions[versions.length - 1]) : null;
  return {
    versions: versions.length,
    named: versions.filter((v) => v.name !== null).length,
    oldest,
    newest,
    lastVersionTime: newest?.time ?? null,
    blobs: blobs.length,
    storedBytes,
    problems,
  };
}
