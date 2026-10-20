import { FORMAT } from '@elabora/format';
import { readText } from '../project/files.ts';
import type { ProjectFiles } from '../project/files.ts';
import { parseJSON } from '../util/json.ts';

// Format versions of course projects: `elabora/<major>.<minor>` in course.json `format`
// (docs/architecture/operations.md, Identifiers and format version).

export { FORMAT };

// The numbers of a format id (elabora/0.1 → [0, 1]), or null for anything else.
export function formatNumbers(format: string): number[] | null {
  return /^elabora\/(\d+(?:\.\d+)*)$/.exec(format)?.[1].split('.').map(Number) ?? null;
}

// elabora/0.10 is newer than elabora/0.9. Formats that are not elabora/<numbers> compare as equal.
export function compareFormats(a: string, b: string): number {
  const x = formatNumbers(a);
  const y = formatNumbers(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const difference = (x[i] ?? 0) - (y[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

// The format course.json declares; null when course.json is missing, does not parse or has no
// format string (validation reports those).
export function projectFormat(files: ProjectFiles): string | null {
  const text = readText(files, 'course.json');
  if (text === null) return null;
  const parsed = parseJSON(text);
  const course = parsed.value;
  if (!course || typeof course !== 'object' || Array.isArray(course)) return null;
  const format: unknown = Reflect.get(course, 'format');
  return typeof format === 'string' ? format : null;
}

// A format newer than the one this Elabora reads: it must not be loaded or written.
export function isNewerFormat(format: string): boolean {
  return formatNumbers(format) !== null && compareFormats(format, FORMAT) > 0;
}
