import type { Course } from '../project/model.ts';
import { CommandError, Draft, type CommandContext, type CommandOutput } from './context.ts';
import { codeInfo } from '../diagnostics/codes.ts';
import { keySubject } from '../diagnostics/index.ts';
import { isRecord } from '../util/values.ts';

// Settings of course.json that update_course replaces (sections included: reorders become moves).
export const COURSE_FIELDS = ['title', 'description', 'version', 'durationMinutes', 'theme', 'presentation', 'navigation', 'completion', 'tracking', 'delivery', 'ui', 'sections', 'speakers', 'pronunciations', 'narration', 'sounds'] as const;
// A field left out stays as it is; null removes it (the last pronunciation, the sounds), never one a course needs.
// The settings that are objects (delivery, navigation, narration…), changeable key by key with patch.
type ObjectField = { [K in (typeof COURSE_FIELDS)[number]]: NonNullable<Course[K]> extends readonly unknown[] ? never : NonNullable<Course[K]> extends Record<string, unknown> ? K : never }[(typeof COURSE_FIELDS)[number]];
export type UpdateCourseArgs = { [K in (typeof COURSE_FIELDS)[number]]?: Course[K] | null } & {
  // Keys of a setting changed one by one, on course.json as it is when the change is written (null
  // removes one; the setting goes when none is left): two keys changed close together both stay,
  // whatever the window had read before.
  patch?: { [K in ObjectField]?: { [Key in keyof NonNullable<Course[K]>]?: NonNullable<Course[K]>[Key] | null } };
};
const REQUIRED: ReadonlySet<string> = new Set(['title', 'version', 'sections']);

export function updateCourseSettings(context: CommandContext, fields: UpdateCourseArgs): CommandOutput<Record<string, never>> {
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const record = course as Record<string, unknown>;
  for (const key of COURSE_FIELDS) {
    const value = fields[key];
    if (value === undefined) continue;
    if (value !== null) record[key] = value;
    else if (REQUIRED.has(key)) throw new CommandError(`${key}: a course needs it, so it cannot be removed (null).`);
    else delete record[key];
  }
  if (fields.patch !== undefined) {
    if (!isRecord(fields.patch)) throw new CommandError('patch: by setting, the keys to change (null removes one).');
    for (const [name, keys] of Object.entries(fields.patch)) {
      if (!(COURSE_FIELDS as readonly string[]).includes(name) || REQUIRED.has(name) || !isRecord(keys)) throw new CommandError(`patch: "${name}" is not a setting changed key by key.`);
      if (record[name] !== undefined && !isRecord(record[name])) throw new CommandError(`patch: "${name}" is not an object in course.json.`);
      const value: Record<string, unknown> = isRecord(record[name]) ? { ...record[name] } : {};
      for (const [key, each] of Object.entries(keys)) {
        if (each === null) delete value[key];
        else if (each !== undefined) value[key] = each;
      }
      if (Object.keys(value).length) record[name] = value;
      else delete record[name];
    }
  }
  draft.writeJson('course.json', course);
  return { files: draft.files(), result: {} };
}

export interface IgnoreFindingsArgs {
  // Each a warning or an information (errors are never ignored) and its key (Diagnostic.key).
  findings: { code: string; key: string }[];
  ignored?: boolean; // false: they count again (default true)
}

// The author ignores findings they looked at, or brings them back (course.json ignored, D31), in one
// change: the validator then marks the findings of those codes and keys ignored. An older choice about
// the same subject (the key before its @: the same word of the same line, in another take) gives way.
export function ignoreFindings(context: CommandContext, { findings, ignored = true }: IgnoreFindingsArgs): CommandOutput<{ ignored: boolean; count: number }> {
  if (!Array.isArray(findings) || !findings.length) throw new CommandError('Name the findings to ignore: [{ code, key }].');
  for (const { code, key } of findings) {
    if (typeof code !== 'string' || !/^[WI]_[A-Z0-9_]+$/.test(code) || codeInfo(code).severity === 'error') throw new CommandError(`Only a warning or an information may be ignored, not "${code}".`);
    if (typeof key !== 'string' || !key.trim() || key.length > 300) throw new CommandError('A finding is ignored by its key (Diagnostic.key, at most 300 characters): the validator gives one to the findings that may be ignored.');
  }
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  // Entries edited by hand that are not { code, key } go.
  let kept = (Array.isArray(course.ignored) ? course.ignored : []).filter((entry) => typeof entry?.code === 'string' && typeof entry.key === 'string');
  for (const { code, key } of findings) {
    const subject = keySubject(key);
    kept = kept.filter((entry) => !(entry.code === code && (entry.key === key || (ignored && keySubject(entry.key) === subject))));
    if (ignored) kept.push({ code, key });
  }
  if (kept.length) course.ignored = kept;
  else delete course.ignored;
  draft.writeJson('course.json', course);
  return { files: draft.files(), result: { ignored, count: findings.length } };
}
