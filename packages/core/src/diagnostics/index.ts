import { sha256 } from '../util/sha256.ts';
import type { CourseIgnored, Diagnostic, PlanWaiver } from '@elabora/format';
import { codeInfo } from './codes.ts';

export type { Diagnostic };
export type Severity = Diagnostic['severity'];

// What an emitter says about a finding; the catalogue gives the rest (severity, title, fix, rule).
export interface DiagnosticFields {
  severity?: Severity;
  message?: string;
  file?: string;
  path?: string;
  target?: string;
  measured?: unknown;
  limit?: unknown;
  profile?: string;
  details?: Record<string, unknown>; // structured facts, by code (docs/diagnostics.md)
  key?: string; // what the finding is about, @ a fingerprint of what was found: the author may ignore it (D31)
  fix?: string;
  rule?: string;
}

export interface Reporter {
  items: Diagnostic[];
  emit(code: string, fields?: DiagnosticFields): Diagnostic;
  merge(list: Iterable<Diagnostic>): void;
  readonly errors: Diagnostic[];
  readonly warnings: Diagnostic[];
}

const LOCATION_FIELDS = ['file', 'path', 'target', 'measured', 'limit', 'profile', 'details', 'key'] as const;

// Collects diagnostics with stable codes. Every emitter in the toolchain uses it,
// so validator, compiler, object gates and LMS emulation produce the same shape.
export function createReporter(): Reporter {
  const items: Diagnostic[] = [];
  return {
    items,
    emit(code, fields = {}) {
      const info = codeInfo(code);
      const d: Diagnostic = {
        code,
        severity: fields.severity || info.severity,
        message: fields.message || info.title,
        ...pick(fields, LOCATION_FIELDS),
        fix: fields.fix || info.fix || undefined,
        rule: fields.rule || info.rule || undefined
      };
      for (const k of Object.keys(d) as (keyof Diagnostic)[]) if (d[k] === undefined) delete d[k];
      items.push(d);
      return d;
    },
    merge(list) { for (const d of list) items.push(d); },
    get errors() { return items.filter((d) => d.severity === 'error' && !d.waived); },
    get warnings() { return items.filter((d) => d.severity === 'warning' && !d.waived && !d.ignored); }
  };
}

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Partial<Pick<T, K>> {
  const out: Partial<Pick<T, K>> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// Plan waivers turn a pedagogical finding into an approved exception (listed in the proof report).
// Contract-layer and delivery errors cannot be waived.
const NOT_WAIVABLE = /^E_(PLAN_|SCHEMA|JSON|FILE|FORMAT|DUPLICATE|SUSPEND|PACKAGE|MANIFEST|OBJECT_FORBIDDEN|OBJECT_NONDETERMINISM|LOCKED|UNKNOWN|ASSET|LMS_)/;

export function applyWaivers(items: Diagnostic[], waivers: readonly PlanWaiver[] = []): Diagnostic[] {
  for (const d of items) {
    if (NOT_WAIVABLE.test(d.code)) continue;
    const w = waivers.find((w) => w.code === d.code && (!w.target || w.target === d.target));
    if (w) d.waived = { reason: w.reason, approvedBy: w.approvedBy };
  }
  return items;
}

// Warnings the author ignored (course.json ignored, D31): the finding of that code and that key,
// found again as it was, is marked ignored and counts no more; found otherwise (another take of the
// line), its key differs and it comes back. Errors are never ignored.
export function applyIgnored(items: Diagnostic[], ignored: readonly CourseIgnored[] = []): Diagnostic[] {
  if (!ignored.length) return items;
  const keys = new Set(ignored.map((entry) => `${entry.code} ${entry.key}`));
  for (const d of items) if (d.key && d.severity !== 'error' && keys.has(`${d.code} ${d.key}`)) d.ignored = true;
  return items;
}

// The key of a finding the author may ignore (D31): what it is about, then a fingerprint of what was
// found (the first 12 hex digits of the SHA-256 of the text the check read), so that the finding
// comes back when that text changes. « evaluation-q1/stem@3f2a9c41d0be »
export const findingKey = (subject: string, found: string): string => `${subject}@${sha256(found).slice(0, 12)}`;

// What a key is about (before its last @): ignoring a finding replaces an older choice about the same.
export const keySubject = (key: string): string => (key.includes('@') ? key.slice(0, key.lastIndexOf('@')) : key);

export interface Summary {
  errors: number;
  warnings: number;
  infos: number;
  waived: number;
  // Findings the author ignored (D31), counted apart like waived ones.
  ignored: number;
}

export function summarize(items: readonly Diagnostic[]): Summary {
  const active = items.filter((d) => !d.waived && !d.ignored);
  return {
    errors: active.filter((d) => d.severity === 'error').length,
    warnings: active.filter((d) => d.severity === 'warning').length,
    infos: active.filter((d) => d.severity === 'info').length,
    waived: items.filter((d) => d.waived).length,
    ignored: items.filter((d) => d.ignored && !d.waived).length
  };
}

const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
export function sortDiagnostics(items: readonly Diagnostic[]): Diagnostic[] {
  return [...items].sort((a, b) => (RANK[a.severity] - RANK[b.severity]) || (a.file || '').localeCompare(b.file || '') || a.code.localeCompare(b.code));
}

export function formatDiagnostic(d: Diagnostic): string {
  const sev = d.waived ? 'waived' : d.ignored ? 'ignored' : d.severity;
  const where = [d.file, d.path].filter(Boolean).join(' ');
  const extra = d.measured !== undefined ? ` (measured ${JSON.stringify(d.measured)}${d.limit !== undefined ? `, limit ${JSON.stringify(d.limit)}` : ''})` : '';
  // A key: the author may ignore the finding (D31), with « Ignorer » in the editor or elabora ignore.
  const key = d.key && !d.ignored && d.severity !== 'error' ? `\n        key: ${d.key} (the author may ignore it: elabora ignore . ${d.code} ${d.key})` : '';
  return `${sev.padEnd(7)} ${d.code}${where ? `  ${where}` : ''}\n        ${d.message}${extra}${d.fix ? `\n        fix: ${d.fix}` : ''}${key}`;
}
