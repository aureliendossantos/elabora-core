import type { Course } from '../project/model.ts';
import { CommandError, Draft, type CommandContext, type CommandOutput } from './context.ts';
import { codeInfo } from '../diagnostics/codes.ts';
import { keySubject } from '../diagnostics/index.ts';
import { isRecord } from '../util/values.ts';
import { applySet, type PathEdit } from './set-paths.ts';

// Settings of course.json that update_course replaces (sections included: reorders become moves).
export const COURSE_FIELDS = ['title', 'description', 'version', 'durationMinutes', 'theme', 'presentation', 'navigation', 'completion', 'tracking', 'delivery', 'ui', 'sections', 'speakers', 'pronunciations', 'narration', 'sounds'] as const;
// A field left out stays as it is; null removes it (the last pronunciation, the sounds), never one a course needs.
// The settings that are objects (delivery, navigation, narration…), changeable key by key with patch.
type ObjectField = { [K in (typeof COURSE_FIELDS)[number]]: NonNullable<Course[K]> extends readonly unknown[] ? never : NonNullable<Course[K]> extends Record<string, unknown> ? K : never }[(typeof COURSE_FIELDS)[number]];
type Speaker = NonNullable<Course['speakers']>[number];
// A speaker's fields changed one by one: its voices by language (null removes a field or a language).
export type SpeakerPatch = { [Key in Exclude<keyof Speaker, 'id' | 'voices'>]?: Speaker[Key] | null } & { voices?: { [language: string]: NonNullable<Speaker['voices']>[string] | null } };
export type UpdateCourseArgs = { [K in (typeof COURSE_FIELDS)[number]]?: Course[K] | null } & {
  // Keys of a setting changed one by one, on course.json as it is when the change is written (null
  // removes one; the setting goes when none is left): two keys changed close together both stay,
  // whatever the window had read before. A key may name an object inside a setting, its path in dots
  // ("theme.tokens": the colours, one by one). speakers: by id, the fields of each (a new id, with its
  // name, joins at the end; remove_speaker removes one).
  patch?: { [K in ObjectField]?: { [Key in keyof NonNullable<Course[K]>]?: NonNullable<Course[K]>[Key] | null } } & {
    'theme.tokens'?: { [token: string]: string | number | null };
    speakers?: { [id: string]: SpeakerPatch };
  };
  // Settings and their entries changed by their path, after the others (D89).
  set?: PathEdit[];
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
    for (const [path, keys] of Object.entries(fields.patch)) {
      if (keys === undefined) continue;
      if (path === 'speakers') { patchSpeakers(record, keys); continue; }
      const names = path.split('.');
      const [name] = names;
      if (!name || !(COURSE_FIELDS as readonly string[]).includes(name) || REQUIRED.has(name) || !isRecord(keys) || names.some((each) => !each)) throw new CommandError(`patch: "${path}" is not a setting changed key by key.`);
      // The objects along the path, made when missing; the emptied ones go, from the deepest up.
      const chain: Record<string, unknown>[] = [record];
      for (const each of names) {
        const parent = chain.at(-1)!;
        if (parent[each] !== undefined && !isRecord(parent[each])) throw new CommandError(`patch: "${path}" is not an object in course.json.`);
        chain.push(isRecord(parent[each]) ? { ...parent[each] } : {});
      }
      const value = chain.at(-1)!;
      for (const [key, each] of Object.entries(keys)) {
        if (each === null) delete value[key];
        else if (each !== undefined) value[key] = each;
      }
      for (let depth = names.length; depth > 0; depth--) {
        const parent = chain[depth - 1]!;
        const child = chain[depth]!;
        if (Object.keys(child).length) parent[names[depth - 1]!] = child;
        else delete parent[names[depth - 1]!];
      }
    }
  }
  applySet(record, fields.set, {
    what: 'the course', fields: COURSE_FIELDS,
    refuse: (path, value) => (path.length === 1 && value === null && REQUIRED.has(path[0] as string) ? 'a course needs it, so it cannot be removed (null).'
      : path[0] === 'sections' && (path.length <= 2 || path[2] === 'screens') ? 'sections and their screens change with sections given whole, or with create_screen, move_screen and delete_screen; set changes a section\'s own fields (sections[<id>].title).' : null)
  });
  draft.writeJson('course.json', course);
  return { files: draft.files(), result: {} };
}

// patch.speakers: by id, the fields of each speaker on the list as it is (null removes a field; voices
// by language). A new id needs its name and joins at the end; a speaker leaves with remove_speaker.
function patchSpeakers(record: Record<string, unknown>, patch: unknown): void {
  if (!isRecord(patch)) throw new CommandError('patch.speakers: by id, the fields to change.');
  if (record.speakers !== undefined && !Array.isArray(record.speakers)) throw new CommandError('patch.speakers: speakers is not a list in course.json.');
  const speakers = [...((record.speakers ?? []) as Record<string, unknown>[])];
  for (const [id, fields] of Object.entries(patch)) {
    if (!isRecord(fields)) throw new CommandError(`patch.speakers.${id}: the fields to change (remove_speaker removes a speaker).`);
    if ('id' in fields) throw new CommandError(`patch.speakers.${id}: a speaker keeps its id.`);
    const at = speakers.findIndex((speaker) => speaker.id === id);
    if (at < 0 && (typeof fields.name !== 'string' || !fields.name.trim())) throw new CommandError(`patch.speakers.${id}: a new speaker needs its name.`);
    const speaker: Record<string, unknown> = at < 0 ? { id } : { ...speakers[at] };
    for (const [key, each] of Object.entries(fields)) {
      if (key === 'voices' && isRecord(each)) {
        const voices: Record<string, unknown> = isRecord(speaker.voices) ? { ...speaker.voices } : {};
        for (const [language, voice] of Object.entries(each)) {
          if (voice === null) delete voices[language];
          else if (voice !== undefined) voices[language] = voice;
        }
        if (Object.keys(voices).length) speaker.voices = voices;
        else delete speaker.voices;
      } else if (each === null) {
        if (key === 'name') throw new CommandError(`patch.speakers.${id}: a speaker needs its name.`);
        delete speaker[key];
      } else if (each !== undefined) speaker[key] = each;
    }
    if (at < 0) speakers.push(speaker);
    else speakers[at] = speaker;
  }
  record.speakers = speakers;
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
