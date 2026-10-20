import type { Course } from '../project/model.ts';
import { CommandError, Draft, type CommandContext, type CommandOutput } from './context.ts';
import { codeInfo } from '../diagnostics/codes.ts';
import { keySubject } from '../diagnostics/index.ts';

// Settings of course.json that update_course replaces (sections included: reorders become moves).
export const COURSE_FIELDS = ['title', 'description', 'version', 'durationMinutes', 'theme', 'presentation', 'navigation', 'completion', 'tracking', 'delivery', 'ui', 'sections', 'speakers', 'pronunciations', 'narration'] as const;
export type UpdateCourseArgs = { [K in (typeof COURSE_FIELDS)[number]]?: Course[K] };

export function updateCourseSettings(context: CommandContext, fields: UpdateCourseArgs): CommandOutput<Record<string, never>> {
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const record = course as Record<string, unknown>;
  for (const key of COURSE_FIELDS) if (fields[key] !== undefined) record[key] = fields[key];
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
