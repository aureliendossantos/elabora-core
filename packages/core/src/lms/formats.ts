import type { LmsProfile } from '@elabora/format';
import { listProfiles, lmsName, resolveProfiles, targetProfileIds } from './profiles.ts';

// The delivery formats of a module for an LMS (docs/delivery.md). Authors rarely know them: Elabora
// picks one for the LMSs of the module (course.json delivery.lms) from their profiles, and the module
// may force another (course.json delivery.format).
//   scorm12    SCORM 1.2: one SCO, accepted by every LMS. The safest, the default without an LMS.
//   scorm2004  SCORM 2004 (4th edition, or 3rd for LMSs that stop there): one SCO, no sequencing
//              beyond the simplest; completion and success apart, a scaled score, 64,000 characters of
//              suspend data.
export const DELIVERY_FORMATS = ['scorm12', 'scorm2004'] as const;
export type DeliveryFormat = (typeof DELIVERY_FORMATS)[number];
// What course.json delivery.format says: a format, or auto (Elabora picks).
export type FormatSetting = DeliveryFormat | 'auto';

export type Scorm2004Edition = '3rd' | '4th';

export const isDeliveryFormat = (value: unknown): value is DeliveryFormat => typeof value === 'string' && (DELIVERY_FORMATS as readonly string[]).includes(value);

// How an LMS takes a format, from its profile: yes, no, or not sure (a plugin, discouraged, beta,
// undocumented). The unknown LMS is never sure: it is no LMS in particular.
export type FormatSupport = 'yes' | 'no' | 'unsure';

export function formatSupport(profile: LmsProfile, format: DeliveryFormat): FormatSupport {
  if (profile.id === 'unknown') return format === 'scorm12' ? 'yes' : 'unsure';
  const standards = profile.standards;
  if (format === 'scorm12') return standards.scorm12 ? 'yes' : 'no';
  const editions = standards.scorm2004;
  if (editions == null) return 'unsure';
  return editions.includes('4th') || editions.includes('3rd') ? 'yes' : 'no';
}

// The SCORM 2004 edition a package declares for these LMSs: the 4th, unless one of them documents
// the 3rd and not the 4th (Docebo). One SCO without sequencing calls the same API in both.
export function scorm2004Edition(profiles: readonly LmsProfile[]): Scorm2004Edition {
  const preferred = profiles.map((profile) => profile.bestFormat?.format === 'scorm2004' ? profile.bestFormat.edition : undefined);
  if (preferred.some((edition) => edition === '3rd')) return '3rd';
  return profiles.some((profile) => profile.id !== 'unknown' && profile.standards.scorm2004?.includes('3rd') && !profile.standards.scorm2004.includes('4th')) ? '3rd' : '4th';
}

export interface FormatChoice {
  format: DeliveryFormat;
  edition?: Scorm2004Edition; // scorm2004 only
  // auto: Elabora picked it; forced: course.json delivery.format (or the build's option) says it.
  how: 'auto' | 'forced';
  // Why, for the author: the LMS it is the best for, the safest without an LMS, a format several LMSs
  // share, or the module's choice.
  why: 'lms' | 'common' | 'safest' | 'forced';
  lms: string[]; // the names of the LMSs it was picked for (none without an LMS)
  // What Elabora would pick by itself (the same as format when how is auto).
  auto: { format: DeliveryFormat; edition?: Scorm2004Edition; why: 'lms' | 'common' | 'safest' };
}

// Picks the format for these LMSs: the best of the profile for one LMS, the best format all of them
// take for several (SCORM 2004, else SCORM 1.2), SCORM 1.2 without an LMS (the unknown profile).
// forced (course.json delivery.format, a build option) wins; auto or nothing lets Elabora pick.
export function chooseFormat(profiles: readonly LmsProfile[], forced?: FormatSetting | null): FormatChoice {
  const named = profiles.filter((profile) => profile.id !== 'unknown');
  const names = named.map(lmsName);
  const auto = autoFormat(named);
  if (forced && forced !== 'auto') {
    return { format: forced, ...(forced === 'scorm2004' ? { edition: scorm2004Edition(named) } : {}), how: 'forced', why: 'forced', lms: names, auto };
  }
  return { format: auto.format, ...(auto.edition ? { edition: auto.edition } : {}), how: 'auto', why: auto.why, lms: names, auto };
}

function autoFormat(named: readonly LmsProfile[]): FormatChoice['auto'] {
  if (!named.length) return { format: 'scorm12', why: 'safest' };
  const best = named.map((profile) => profile.bestFormat?.format ?? 'scorm12');
  if (best.every((format) => format === best[0])) {
    const format = best[0];
    return { format, ...(format === 'scorm2004' ? { edition: scorm2004Edition(named) } : {}), why: named.length === 1 ? 'lms' : 'common' };
  }
  // LMSs that differ: the richer format they all take.
  if (named.every((profile) => formatSupport(profile, 'scorm2004') === 'yes') && best.every((format) => format !== 'scorm12')) return { format: 'scorm2004', edition: scorm2004Edition(named), why: 'common' };
  return { format: 'scorm12', why: 'common' };
}

// The format's name, as authors and LMS screens write it.
export function formatName(format: DeliveryFormat, edition?: Scorm2004Edition): string {
  if (format === 'scorm2004') return edition === '3rd' ? 'SCORM 2004 (3rd edition)' : edition === '4th' ? 'SCORM 2004 (4th edition)' : 'SCORM 2004';
  return 'SCORM 1.2';
}

// The file name part of the package (<id>-<version>-<format>.zip).
export const formatSlug = (format: DeliveryFormat): string => format;

// The format of a forced setting that the LMSs do not take: an error for an LMS that says no, a
// warning for an LMS that is not sure. The builds of an LMS that says no still run (the author may
// know better), the error says it.
export interface FormatMismatch {
  profile: LmsProfile;
  support: Exclude<FormatSupport, 'yes'>;
}

export function formatMismatches(profiles: readonly LmsProfile[], format: DeliveryFormat): FormatMismatch[] {
  const out: FormatMismatch[] = [];
  for (const profile of profiles) {
    const support = formatSupport(profile, format);
    if (support !== 'yes') out.push({ profile, support });
  }
  return out;
}

// The format of a module: course.json delivery.format, else the one Elabora picks for its LMSs
// (course.json delivery.lms, or the ids asked for). LMSs no profile has are left out (validation
// reports them, E_LMS_UNKNOWN).
export function courseFormat(course: { delivery?: { lms?: readonly string[]; format?: string } } | null | undefined, ids?: readonly string[] | null): FormatChoice {
  const known = targetProfileIds(course, ids).filter((id) => id === 'all' || listProfiles().some((profile) => profile.id === id));
  const setting = course?.delivery?.format;
  return chooseFormat(resolveProfiles(known.length ? known : ['unknown']), setting === 'auto' || isDeliveryFormat(setting) ? setting : null);
}

// Why the format, in a few English words (the CLI, the proof dossier in English).
export function formatReason({ why, lms }: Pick<FormatChoice, 'why' | 'lms'>): string {
  const names = lms.join(', ');
  if (why === 'lms') return `the best for ${names}`;
  if (why === 'common') return `shared by ${names}`;
  if (why === 'safest') return 'the safest without an LMS chosen: every LMS takes it';
  return 'chosen for the module';
}
