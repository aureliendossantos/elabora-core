import fs from 'node:fs';
import path from 'node:path';
import { canonicalJSON } from '@elabora/core/util/json';
import { readLock } from '@elabora/core/compile/state-model';
import type { Project } from '@elabora/core/project/model';
import { projectDataDir } from '../data-dir.ts';
import { sha256Hex, writeJSONFile } from '../util/fs.ts';
import type { Visibility } from './types.ts';

// What this computer published of a course (docs/decisions.md D43), in the project's machine-local
// data (<data>/cloud/publications.json): each version with the course version it was built from and
// a hash of every screen's source then. A review comment names the version it was written on; this
// record tells whether its screen has changed since, so that an author or their AI does not fix a
// remark twice. Nothing secret: no token, no link.

const FORMAT = 'elabora-cloud-record/1';
const KEPT_VERSIONS = 50;

export interface PublishedVersion {
  version: string; // the publication's version (16 hex digits)
  course: string; // course.json version
  publishedAt: string;
  screens: Record<string, string>; // permanent key (D4) → sha256 of the screen's canonical JSON
}

export interface PublicationRecord {
  api: string;
  space: string;
  name: string;
  visibility: Visibility;
  versions: PublishedVersion[];
}

interface RecordFile {
  format: typeof FORMAT;
  publications: PublicationRecord[];
}

const recordFile = (courseDir: string): string => path.join(projectDataDir(courseDir), 'cloud', 'publications.json');

export function readRecords(courseDir: string): PublicationRecord[] {
  try {
    const value = JSON.parse(fs.readFileSync(recordFile(courseDir), 'utf8')) as Partial<RecordFile>;
    return value.format === FORMAT && Array.isArray(value.publications) ? value.publications : [];
  } catch { return []; }
}

// The screens' hashes by permanent key, as the course's sources hold them now.
export function screenHashes(project: Pick<Project, 'files' | 'screens'>): Record<string, string> {
  const keys = readLock(project).keys;
  const hashes: Record<string, string> = {};
  for (const [id, entry] of project.screens) {
    const key = keys[`screen:${id}`];
    if (key !== undefined) hashes[key] = sha256Hex(canonicalJSON(entry.data));
  }
  return hashes;
}

export function recordPublished(courseDir: string, publication: Omit<PublicationRecord, 'versions'>, version: PublishedVersion): void {
  const records = readRecords(courseDir);
  let record = records.find((r) => r.api === publication.api && r.space === publication.space && r.name === publication.name);
  if (!record) { record = { ...publication, versions: [] }; records.push(record); }
  record.visibility = publication.visibility;
  record.versions = [...record.versions.filter((v) => v.version !== version.version), version].slice(-KEPT_VERSIONS);
  writeJSONFile(recordFile(courseDir), { format: FORMAT, publications: records } satisfies RecordFile);
}

export function findPublishedVersion(courseDir: string, api: string, space: string, name: string, version: string): PublishedVersion | null {
  const record = readRecords(courseDir).find((r) => r.api === api && r.space === space && r.name === name);
  return record?.versions.find((v) => v.version === version) ?? null;
}
