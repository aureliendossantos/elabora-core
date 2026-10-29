import fs from 'node:fs';
import path from 'node:path';
import { projectDataDir } from './data-dir.ts';
import { ACTIVITY_FAMILIES } from './activity-types.ts';
import type { ActivityEntry } from './activity-types.ts';

// What agents do in a course through Elabora's tools, reads included: a line when an operation
// starts and one when it ends, in <data>/activity.jsonl next to the journal. The app says it in
// words while the agent works (« Claude examine l'écran 2.1… »), whether the agent runs inside
// Elabora or in its own app (reports/chat-agentique, phase 1). Not the journal: nothing in it is
// undone, nothing of the course's text is kept, and it is kept a day.

export { ACTIVITY_FAMILIES } from './activity-types.ts';
export type { ActivityEntry, ActivityFamily } from './activity-types.ts';

export const ACTIVITY_FILE = 'activity.jsonl';
// Past this size the file keeps its last day, at most half the size: room for the next lines.
const MAX_BYTES = 256 * 1024;
const KEEP_MS = 24 * 60 * 60 * 1000;

export const activityPath = (root: string): string => path.join(projectDataDir(root), ACTIVITY_FILE);

// Appends a line. Never fails the operation it reports: a course on a read-only disk, a folder
// gone, are said nowhere. One short write per line, appended: agents in several processes interleave
// whole lines.
export function recordActivity(root: string, entry: ActivityEntry): void {
  try {
    const file = activityPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    if (fs.statSync(file).size > MAX_BYTES) trim(file);
  } catch {
    // Reported activity is a courtesy: the operation goes on.
  }
}

function trim(file: string): void {
  const since = Date.now() - KEEP_MS;
  const lines = parseActivity(fs.readFileSync(file, 'utf8')).filter((entry) => Date.parse(entry.at) >= since).map((entry) => `${JSON.stringify(entry)}\n`);
  let bytes = 0;
  let first = lines.length;
  while (first > 0 && bytes + Buffer.byteLength(lines[first - 1]!) <= MAX_BYTES / 2) bytes += Buffer.byteLength(lines[--first]!);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, lines.slice(first).join(''));
  fs.renameSync(temporary, file);
}

// The entries of a text, whole lines only (a line being written is left for later).
export function parseActivity(text: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ActivityEntry;
      if (entry && typeof entry.at === 'string' && typeof entry.op === 'string' && (ACTIVITY_FAMILIES as readonly string[]).includes(entry.family)) entries.push(entry);
    } catch {
      // A torn line: skipped.
    }
  }
  return entries;
}

// The last entries, oldest first.
export function readActivity(root: string, { limit = 500 }: { limit?: number } = {}): ActivityEntry[] {
  try {
    return parseActivity(fs.readFileSync(activityPath(root), 'utf8')).slice(-limit);
  } catch {
    return [];
  }
}
