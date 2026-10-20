import { validateSchema } from '@elabora/format';
import type { LmsProfile } from '@elabora/format';
import lms360learning from '../../profiles/360learning.json' with { type: 'json' };
import cornerstone from '../../profiles/cornerstone.json' with { type: 'json' };
import docebo from '../../profiles/docebo.json' with { type: 'json' };
import moodle from '../../profiles/moodle.json' with { type: 'json' };
import riseUp from '../../profiles/rise-up.json' with { type: 'json' };
import scormCloud from '../../profiles/scorm-cloud.json' with { type: 'json' };
import successfactors from '../../profiles/successfactors.json' with { type: 'json' };
import teachUp from '../../profiles/teach-up.json' with { type: 'json' };
import totara from '../../profiles/totara.json' with { type: 'json' };
import unknownLms from '../../profiles/unknown.json' with { type: 'json' };
import workday from '../../profiles/workday.json' with { type: 'json' };

// LMS profiles: the facts Elabora compiles and tests against, one JSON file per LMS in profiles/
// (sources and dates; unknown values are null and listed in toMeasure; never invent a value).
// They are imported as data, in file name order; a unit test checks every file is listed here.
export const PROFILE_FILES: readonly (readonly [string, unknown])[] = [
  ['360learning.json', lms360learning],
  ['cornerstone.json', cornerstone],
  ['docebo.json', docebo],
  ['moodle.json', moodle],
  ['rise-up.json', riseUp],
  ['scorm-cloud.json', scormCloud],
  ['successfactors.json', successfactors],
  ['teach-up.json', teachUp],
  ['totara.json', totara],
  ['unknown.json', unknownLms],
  ['workday.json', workday]
];

export type { LmsProfile };

// SCORM 1.2 specification values, used when a profile does not document a limit.
export const SCORM12_SPEC = { suspendDataMax: 4096, lessonLocationMax: 255 };

let cache: LmsProfile[] | undefined;
export function listProfiles(): LmsProfile[] {
  if (cache) return cache;
  cache = PROFILE_FILES.map(([f, p]) => {
    const errors = validateSchema('lms-profile', p) as { path: string; message: string }[];
    if (errors.length) throw new Error(`Invalid LMS profile ${f}: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    return p as LmsProfile;
  });
  return cache;
}

export function getProfile(id: string): LmsProfile {
  const p = listProfiles().find((x) => x.id === id);
  if (!p) throw new Error(`Unknown LMS profile "${id}". Known profiles: ${listProfiles().map((x) => x.id).join(', ')}`);
  return p;
}

export function resolveProfiles(ids?: readonly string[] | null): LmsProfile[] {
  const list = !ids || ids.length === 0 ? ['unknown'] : ids;
  if (list.includes('all')) return listProfiles();
  return list.map(getProfile);
}

// The LMSs a course targets: the ids asked for (--profile), else course.json delivery.lms, else
// the unknown LMS (no LMS chosen).
export function targetProfileIds(course: { delivery?: { lms?: readonly string[] } } | null | undefined, ids?: readonly string[] | null): string[] {
  if (ids?.length) return [...ids];
  const chosen = course?.delivery?.lms;
  return Array.isArray(chosen) && chosen.length && chosen.every((id) => typeof id === 'string') ? [...chosen] : ['unknown'];
}

// A profile's name as people say it: « Teach Up », not « Teach Up (import) ».
export function lmsName(profile: Pick<LmsProfile, 'name'>): string {
  return profile.name.replace(/\s*(\(|—).*$/, '').trim() || profile.name;
}

export interface Scorm12Limits {
  suspendDataMax: number;
  suspendDataSource: string;
  lessonLocationMax: number;
  maxZipMB: number | null;
  maxFiles: number | null;
  maxCompressionRatio: number | null;
  asciiFilenames: boolean;
  forbiddenExtensions: string[];
}

// Compile towards the strictest constraint of the selected profiles (checklist item 3).
export function scorm12Limits(profiles: readonly LmsProfile[]): Scorm12Limits {
  const pick = (vals: (number | null | undefined)[], fallback: number) => {
    const known = vals.filter((v): v is number => typeof v === 'number');
    return { value: known.length ? Math.min(...known, ...(vals.some((v) => v == null) ? [fallback] : [])) : fallback, unknown: vals.some((v) => v == null) };
  };
  const sd = pick(profiles.map((p) => p.datamodel?.suspendDataMax?.scorm12), SCORM12_SPEC.suspendDataMax);
  const loc = pick(profiles.map((p) => p.datamodel?.lessonLocationMax), SCORM12_SPEC.lessonLocationMax);
  const numbers = (vals: (number | null | undefined)[]) => vals.filter((v): v is number => typeof v === 'number');
  const zip = numbers(profiles.map((p) => p.packaging?.maxZipMB));
  const files = numbers(profiles.map((p) => p.packaging?.maxFiles));
  const ratio = numbers(profiles.map((p) => p.packaging?.maxCompressionRatio));
  return {
    suspendDataMax: sd.value,
    suspendDataSource: profiles.map((p) => `${p.id}:${p.datamodel?.suspendDataMax?.scorm12 ?? 'unknown→spec 4096'}`).join(', '),
    lessonLocationMax: loc.value,
    maxZipMB: zip.length ? Math.min(...zip) : null,
    maxFiles: files.length ? Math.min(...files) : null,
    maxCompressionRatio: ratio.length ? Math.min(...ratio) : null,
    asciiFilenames: profiles.some((p) => p.packaging?.asciiFilenames),
    forbiddenExtensions: [...new Set(profiles.flatMap((p) => p.packaging?.forbiddenExtensions || []))]
  };
}
