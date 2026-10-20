import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isRecord } from '../util/values.ts';

// Result of the last full run of the automated gates (2–6), kept next to the object so the proof
// dossier can tell "passed on <date>" from "not run" or "stale". Committed with the course: the
// dossier is often built on another machine than the one that ran the gates.
export const GATES_FILE = 'object.gates.json';
const SKIP = new Set([GATES_FILE, 'object.notes.md']);

// What `elabora object test` records (the fingerprint is added when it is written).
export interface GatesRecord {
  object: string;
  version?: string;
  elabora: string;
  at: string;
  ok: boolean;
  gates: Record<string, string>; // gate → passed, failed, not-run (why)…
  perf?: { bootMs?: number; [measure: string]: unknown } | null;
  tests?: { name: string; ok: boolean }[];
  browser?: { engine: string; version: string };
}

export type GatesStatus =
  | { status: 'not-run' }
  | { status: 'passed' | 'failed' | 'stale'; at: string | null; elabora: string | null; gates: Record<string, string>; bootMs: number | null };

// Fingerprint of what the gates exercise: every file of the object folder (code, manifest, tests,
// snapshots, assets) except the record itself and the notes. text(file) may give the content of a
// file (path in the folder) instead of the disk: what the folder will hold once an edit is written.
export function objectFingerprint(dir: string, text?: (file: string) => string | undefined): string {
  const hash = crypto.createHash('sha256');
  const walk = (rel: string) => {
    const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (!SKIP.has(child)) { hash.update(`${child}\0`); hash.update(text?.(child) ?? fs.readFileSync(path.join(dir, child))); hash.update('\0'); }
    }
  };
  walk('');
  return `sha256:${hash.digest('hex')}`;
}

export function writeGatesRecord(dir: string, record: GatesRecord): GatesRecord & { fingerprint: string } {
  const body = { ...record, fingerprint: objectFingerprint(dir) };
  fs.writeFileSync(path.join(dir, GATES_FILE), `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

// status: passed | failed | stale (the object changed since the run) | not-run.
export function gatesStatus(dir: string): GatesStatus {
  const file = path.join(dir, GATES_FILE);
  if (!fs.existsSync(file)) return { status: 'not-run' };
  let record: unknown;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { status: 'not-run' }; }
  if (!isRecord(record)) return { status: 'not-run' };
  const bootMs = isRecord(record.perf) ? record.perf.bootMs : undefined;
  const base = {
    at: typeof record.at === 'string' && record.at ? record.at : null,
    elabora: typeof record.elabora === 'string' && record.elabora ? record.elabora : null,
    gates: isRecord(record.gates) ? Object.fromEntries(Object.entries(record.gates).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
    bootMs: typeof bootMs === 'number' ? bootMs : null
  };
  if (record.fingerprint !== objectFingerprint(dir)) return { ...base, status: 'stale' };
  return { ...base, status: record.ok ? 'passed' : 'failed' };
}
