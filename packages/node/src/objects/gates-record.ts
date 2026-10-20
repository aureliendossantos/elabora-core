import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { isRecord } from '../util/values.ts';
import { projectDataDir } from '../data-dir.ts';
import { canonicalJSON } from '@elabora/core/util/json';

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

// ── A run kept on this computer, to skip an unchanged object ──
// What a run's verdicts depend on beyond the object folder (its fingerprint): what the course gives
// it (theme tokens, fonts and their files, language), the code that runs the gates (codeVersion),
// the browser and the system. Machine-local, so it is kept in the project's data, not in the record
// committed with the course: another computer, another browser or another core runs the gates again.
export interface ObjectTestInputs {
  tokens: Record<string, string | number>;
  fonts: { family: string; src: string; weight: string; style: string; unicodeRange?: string; hash: string | null }[];
  language: string;
  code: string;
  platform: string;
  browser: string; // the browser asked (chromium, electron, firefox…), and headed
  tools: Record<string, string | boolean>; // esbuild, three.js, axe-core, the snapshot comparison
}

export interface KeptTestRun<Result> {
  object: string;
  fingerprint: string; // objectFingerprint after the run
  inputs: string; // hash of ObjectTestInputs
  browser: { engine: string; version: string } | null;
  at: string; // the run's date, as object.gates.json records it
  result: Result;
}

export const inputsHash = (inputs: ObjectTestInputs): string => `sha256:${crypto.createHash('sha256').update(canonicalJSON(inputs)).digest('hex')}`;

const keptRunFile = (projectDir: string, objectId: string) => path.join(projectDataDir(projectDir), 'cache', 'objects', `${objectId}.json`);

export function readKeptRun<Result>(projectDir: string, objectId: string): KeptTestRun<Result> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(keptRunFile(projectDir, objectId), 'utf8'));
    return isRecord(value) && value.object === objectId && typeof value.fingerprint === 'string' && typeof value.inputs === 'string' && typeof value.at === 'string' && isRecord(value.result) ? value as unknown as KeptTestRun<Result> : null;
  } catch { return null; }
}

export function writeKeptRun<Result>(projectDir: string, run: KeptTestRun<Result>): void {
  const file = keptRunFile(projectDir, run.object);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(run)}\n`);
}

// The date of the record committed with the course, when it still describes the object folder.
export function recordedAt(dir: string): string | null {
  try {
    const record: unknown = JSON.parse(fs.readFileSync(path.join(dir, GATES_FILE), 'utf8'));
    return isRecord(record) && typeof record.at === 'string' && record.fingerprint === objectFingerprint(dir) ? record.at : null;
  } catch { return null; }
}
