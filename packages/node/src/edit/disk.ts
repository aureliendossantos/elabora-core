import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ChangeLike, FileContent, Files, Op } from '@elabora/core/ops/types';
import { touchedFiles } from '@elabora/core/ops/apply';
import { documentOf, formatJson, isJsonPath, sameContent, sameJson } from '@elabora/core/ops/json';
import { textFile } from '@elabora/core/project/files';
import { blobPath, hasBlob, putBytes, readBlob, type BlobHash } from '../blobs.ts';
import { writeFileAtomic } from '../util/fs.ts';
import { copyFileCloneSync } from '../util/copy-sync.ts';

// What an edit reads and writes on disk, besides the snapshot (project-reader.ts).

// Paths whose file on disk is no longer what the snapshot read: another program (an agent's own
// tools, an editor) wrote it while the edit was computed. Only the files the edit touches matter.
export function changedOnDisk(root: string, before: Files, paths: readonly string[]): string[] {
  return paths.filter((rel) => {
    const read = before.get(rel);
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return read !== undefined;
    if (!read) return true;
    if (read.kind === 'text') return fs.readFileSync(file, 'utf8') !== read.text;
    return read.hash !== hashFileSync(file);
  });
}

// Writes the touched files as they are after the edit: text atomically, binary contents from the
// blob store (where storeChangeBlobsSync put them), deletions last.
export function writeFiles(root: string, before: Files, after: Files, ops: readonly Op[]): void {
  const paths = touchedFiles(ops);
  for (const rel of paths) {
    const file = after.get(rel);
    if (!file || sameContent(file, before.get(rel))) continue;
    const target = path.join(root, rel);
    if (file.kind === 'text') writeFileAtomic(target, file.text);
    else copyBlobToSync(root, file.hash as BlobHash, target);
  }
  for (const rel of paths) if (!after.has(rel)) fs.rmSync(path.join(root, rel), { force: true });
}

function copyBlobToSync(root: string, hash: BlobHash, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    copyFileCloneSync(blobPath(root, hash), tmp);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// JSON files are written with Elabora's formatting. A touched file written another way (by hand,
// by an agent's own tools) keeps its text in the blob store under the hash the journal records as
// its "before", so that undoing the change gives the file back exactly as it was.
export function keepOriginalTexts(root: string, before: Files, ops: readonly Op[]): void {
  for (const rel of touchedFiles(ops)) {
    const file = before.get(rel);
    if (file?.kind !== 'text' || !isJsonPath(rel)) continue;
    const value = documentOf(rel, file);
    if (value !== undefined && formatJson(value) !== file.text) putBytes(root, file.text);
  }
}

// After an undo: a JSON file back to the value it had before the oldest undone change gets the
// text it had then, when it was kept.
export function restoreOriginalTexts(root: string, files: Files, changes: readonly ChangeLike[], ops: readonly Op[]): Files {
  const out = new Map(files);
  for (const rel of touchedFiles(ops)) {
    const file = files.get(rel);
    if (file?.kind !== 'text' || !isJsonPath(rel)) continue;
    let hash: string | null = null;
    for (const change of changes) hash = change.files.find((f) => f.path === rel)?.before ?? hash; // newest first: the last found is the oldest
    if (!hash || !hasBlob(root, hash as BlobHash)) continue;
    const original = readBlob(root, hash as BlobHash).toString('utf8');
    const value = documentOf(rel, textFile(original) as FileContent);
    const now = documentOf(rel, file);
    if (value !== undefined && now !== undefined && sameJson(value, now)) out.set(rel, textFile(original));
  }
  return out;
}

function hashFileSync(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return `sha256:${hash.digest('hex')}`;
}

