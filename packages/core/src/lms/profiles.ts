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
// SCORM 2004 3rd and 4th editions (cmi.suspend_data 64,000 characters, cmi.location 1,000).
export const SCORM2004_SPEC = { suspendDataMax: 64000, lessonLocationMax: 1000 };

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

// The delivery formats (formats.ts): profiles record the limits of SCORM's; cmi5 and xAPI keep the
// state in a document without a limit, counted as SCORM 2004's 64,000 so a module can change format.
export type LimitedFormat = 'scorm12' | 'scorm2004' | 'cmi5' | 'xapi';

export interface DeliveryLimits {
  suspendDataMax: number;
  suspendDataSource: string;
  lessonLocationMax: number;
  maxZipMB: number | null;
  maxFiles: number | null;
  maxCompressionRatio: number | null;
  asciiFilenames: boolean;
  forbiddenExtensions: string[];
}

// Compile towards the strictest constraint of the selected profiles (checklist item 3), for the
// package's format: SCORM 1.2 by default.
export function deliveryLimits(profiles: readonly LmsProfile[], format: LimitedFormat = 'scorm12'): DeliveryLimits {
  const pick = (vals: (number | null | undefined)[], fallback: number) => {
    const known = vals.filter((v): v is number => typeof v === 'number');
    return { value: known.length ? Math.min(...known, ...(vals.some((v) => v == null) ? [fallback] : [])) : fallback, unknown: vals.some((v) => v == null) };
  };
  const spec = format === 'scorm12' ? SCORM12_SPEC : SCORM2004_SPEC;
  const recorded = format === 'scorm12' || format === 'scorm2004' ? format : null;
  const sd = recorded ? pick(profiles.map((p) => p.datamodel?.suspendDataMax?.[recorded]), spec.suspendDataMax) : { value: spec.suspendDataMax, unknown: false };
  // Profiles record SCORM 1.2's lesson_location; SCORM 2004's cmi.location is the specification's.
  const loc = format === 'scorm12' ? pick(profiles.map((p) => p.datamodel?.lessonLocationMax), spec.lessonLocationMax) : { value: spec.lessonLocationMax };
  const numbers = (vals: (number | null | undefined)[]) => vals.filter((v): v is number => typeof v === 'number');
  const zip = numbers(profiles.map((p) => p.packaging?.maxZipMB));
  const files = numbers(profiles.map((p) => p.packaging?.maxFiles));
  const ratio = numbers(profiles.map((p) => p.packaging?.maxCompressionRatio));
  return {
    suspendDataMax: sd.value,
    suspendDataSource: recorded ? profiles.map((p) => `${p.id}:${p.datamodel?.suspendDataMax?.[recorded] ?? `unknown→spec ${spec.suspendDataMax}`}`).join(', ') : `${format}: ${spec.suspendDataMax}`,
    lessonLocationMax: loc.value,
    maxZipMB: zip.length ? Math.min(...zip) : null,
    maxFiles: files.length ? Math.min(...files) : null,
    maxCompressionRatio: ratio.length ? Math.min(...ratio) : null,
    asciiFilenames: profiles.some((p) => p.packaging?.asciiFilenames),
    forbiddenExtensions: [...new Set(profiles.flatMap((p) => p.packaging?.forbiddenExtensions || []))]
  };
}
