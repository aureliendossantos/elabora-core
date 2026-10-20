import type { LmsProfile } from '@elabora/format';
import type { DiagnosticFields } from '../diagnostics/index.ts';
import { PRESET_NAMES } from '../media/presets.ts';
import type { PresetName } from '../media/presets.ts';
import { listProfiles, lmsName } from './profiles.ts';

// The limits LMSs put on a package (checklist item 8): the size of its ZIP, its size once
// extracted, its number of files, its compression ratio. The limit of an LMS the course targets
// stops the build. With no LMS chosen (the unknown profile), no limit is assumed: those of the
// documented LMSs that the package passes are warnings naming them, so that the author chooses the
// LMS rather than shrinking the course for a limit it may not have.

export type PackageMeasure = 'zip' | 'unzipped' | 'files' | 'compressionRatio';

const MEASURES: readonly PackageMeasure[] = ['zip', 'unzipped', 'files', 'compressionRatio'];

export interface PackageFacts {
  zipBytes: number;
  unzippedBytes: number;
  files: number;
}

// An LMS and its limit, in the unit of the measure: bytes, files or a ratio.
export interface LmsLimit {
  id: string;
  name: string; // as people say it (lmsName)
  max: number;
}

export interface PackageBreach {
  measure: PackageMeasure;
  value: number; // bytes, files or a ratio
  max: number; // the lowest of the limits passed
  lms: LmsLimit[]; // the LMSs whose limit it passes, lowest first
  chosen: boolean; // false: no LMS is chosen, and lms are documented LMSs that would refuse it
}

// The package at one media quality (docs/architecture/media.md).
export interface QualitySize {
  quality: PresetName;
  bytes: number; // the ZIP
  estimated: boolean; // some media sizes estimated from bitrates (renditions not made yet)
}

export type PackageFileKind = 'video' | 'audio' | 'image' | 'font' | 'other';

export interface PackageFile {
  path: string; // in the package
  asset?: string; // the project's file it comes from (assets/…), when it is an asset or its rendition
  bytes: number; // in the ZIP; for the compression ratio, once extracted
  kind: PackageFileKind;
  seconds?: number; // a video's or a sound's duration
}

// details of E_PACKAGE_TOO_LARGE, E_PACKAGE_TOO_MANY_FILES, E_COMPRESSION_RATIO and of their
// warnings when no LMS is chosen (W_…_FOR_SOME_LMS).
export interface PackageLimitDetails extends PackageBreach {
  quality: PresetName; // the media quality of this build
  qualities?: QualitySize[]; // zip and unzipped: the package at each media quality
  fits?: PresetName | null; // zip and unzipped: the best other quality under the limit; null: none
  files?: PackageFile[]; // zip and unzipped: the heaviest files; compressionRatio: those that shrink most
}

export const PACKAGE_LIMIT_CODES: Readonly<Record<PackageMeasure, { error: string; warning: string }>> = {
  zip: { error: 'E_PACKAGE_TOO_LARGE', warning: 'W_PACKAGE_TOO_LARGE_FOR_SOME_LMS' },
  unzipped: { error: 'E_PACKAGE_TOO_LARGE', warning: 'W_PACKAGE_TOO_LARGE_FOR_SOME_LMS' },
  files: { error: 'E_PACKAGE_TOO_MANY_FILES', warning: 'W_PACKAGE_TOO_MANY_FILES_FOR_SOME_LMS' },
  compressionRatio: { error: 'E_COMPRESSION_RATIO', warning: 'W_COMPRESSION_RATIO_FOR_SOME_LMS' }
};

const MB = 1024 * 1024;
const UNKNOWN = 'unknown';

function limitOf(profile: LmsProfile, measure: PackageMeasure): number | null {
  const packaging = profile.packaging;
  const number = (value: number | null | undefined, unit = 1) => (typeof value === 'number' ? value * unit : null);
  if (measure === 'zip') return number(packaging?.maxZipMB, MB);
  if (measure === 'unzipped') return number(packaging?.maxUnzippedMB, MB);
  if (measure === 'files') return number(packaging?.maxFiles);
  return number(packaging?.maxCompressionRatio);
}

function valueOf(facts: PackageFacts, measure: PackageMeasure): number {
  if (measure === 'zip') return facts.zipBytes;
  if (measure === 'unzipped') return facts.unzippedBytes;
  if (measure === 'files') return facts.files;
  return facts.zipBytes > 0 ? facts.unzippedBytes / facts.zipBytes : 0;
}

// The limits a package passes: those of the LMSs targeted (chosen), and, when the unknown LMS is
// among the targets, those of the other documented LMSs (not chosen).
export function packageBreaches(targets: readonly LmsProfile[], facts: PackageFacts, documented: readonly LmsProfile[] = listProfiles()): PackageBreach[] {
  const chosen = targets.filter((profile) => profile.id !== UNKNOWN);
  const assumed = targets.some((profile) => profile.id === UNKNOWN);
  const others = documented.filter((profile) => profile.id !== UNKNOWN && !chosen.some((target) => target.id === profile.id));
  const breaches: PackageBreach[] = [];
  for (const measure of MEASURES) {
    const value = valueOf(facts, measure);
    const over = (profiles: readonly LmsProfile[]): LmsLimit[] => profiles.flatMap((profile) => {
      const max = limitOf(profile, measure);
      return max !== null && value > max ? [{ id: profile.id, name: lmsName(profile), max }] : [];
    }).sort((a, b) => a.max - b.max || a.name.localeCompare(b.name));
    const refused = over(chosen);
    if (refused.length) breaches.push({ measure, value, max: refused[0]!.max, lms: refused, chosen: true });
    const would = assumed ? over(others) : [];
    if (would.length) breaches.push({ measure, value, max: would[0]!.max, lms: would, chosen: false });
  }
  return breaches;
}

export interface PackageContext {
  quality: PresetName;
  qualities: QualitySize[] | null; // null: the package has no media
  heaviest: PackageFile[]; // by size in the ZIP, heaviest first
  shrinking: PackageFile[]; // by what deflate saves, most first
}

// A finding for each breach: its code, an English message complete enough for an agent, and the
// details the app puts into words.
export function packageLimitFindings(breaches: readonly PackageBreach[], context: PackageContext, facts: PackageFacts): { code: string; fields: DiagnosticFields }[] {
  return breaches.map((breach) => {
    const code = breach.chosen ? PACKAGE_LIMIT_CODES[breach.measure].error : PACKAGE_LIMIT_CODES[breach.measure].warning;
    const details: PackageLimitDetails = { ...breach, lms: breach.lms.map((lms) => ({ ...lms })), quality: context.quality };
    const sized = breach.measure === 'zip' || breach.measure === 'unzipped';
    if (sized) {
      // Extracted, a package weighs its ZIP plus what deflate saved on files other than media.
      const extra = breach.measure === 'unzipped' ? facts.unzippedBytes - facts.zipBytes : 0;
      if (context.qualities) {
        details.qualities = context.qualities.map((size) => ({ ...size }));
        details.fits = PRESET_NAMES.find((preset) => preset !== context.quality && (context.qualities!.find((size) => size.quality === preset)?.bytes ?? Infinity) + extra <= breach.max) ?? null;
      }
      // The files that make the weight: 1 % of the package at least, five at most.
      details.files = context.heaviest.filter((file, index) => index === 0 || file.bytes >= breach.value / 100).slice(0, 5);
    } else if (breach.measure === 'compressionRatio') {
      details.files = context.shrinking.slice(0, 5);
    }
    const fields: DiagnosticFields = {
      measured: breach.measure === 'zip' || breach.measure === 'unzipped' ? `${megabytes(breach.value)} MB` : breach.measure === 'compressionRatio' ? Math.round(breach.value) : breach.value,
      limit: breach.measure === 'zip' || breach.measure === 'unzipped' ? `${breach.max / MB} MB` : breach.max,
      profile: breach.chosen ? breach.lms.map((lms) => lms.id).join(', ') : UNKNOWN,
      message: packageLimitMessage(details),
      details: details as unknown as Record<string, unknown>
    };
    return { code, fields };
  });
}

const megabytes = (bytes: number) => (bytes / MB).toFixed(1);
// A size as people read it: 131.6 MB, 2.3 GB; a limit: 100 MB, 2 GB.
export function sizeText(bytes: number): string {
  return bytes >= 1024 * MB ? `${(bytes / 1024 / MB).toFixed(1).replace(/\.0$/, '')} GB` : `${megabytes(bytes)} MB`;
}
const limitText = (bytes: number) => (bytes >= 1024 * MB && bytes % (1024 * MB) === 0 ? `${bytes / 1024 / MB} GB` : `${Math.round(bytes / MB)} MB`);
const count = (value: number) => value.toLocaleString('en-US');

// Who sets the limit: « Teach Up accepts 100 MB », « Docebo and Rise Up accept 1 GB, Teach Up 100 MB ».
function whoAccepts(lms: readonly LmsLimit[], unit: (max: number) => string): string {
  const groups = new Map<number, string[]>();
  for (const one of lms) groups.set(one.max, [...(groups.get(one.max) ?? []), one.name]);
  const list = (names: string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
  return [...groups].map(([max, names], index) => `${list(names)}${index === 0 ? (names.length === 1 ? ' accepts ' : ' accept ') : ' '}${unit(max)}`).join(', ');
}

export function packageLimitMessage(details: PackageLimitDetails): string {
  const { measure, value, lms, chosen, quality } = details;
  const choose = ' No LMS is chosen: set delivery.lms in course.json (elabora profiles lists them), or build with --profile <lms>, so the build checks the limits of that LMS.';
  if (measure === 'files') {
    return `The package has ${count(value)} files; ${whoAccepts(lms, count)}.${chosen ? '' : choose} Merge assets or split the course.`;
  }
  if (measure === 'compressionRatio') {
    const files = details.files?.length ? ` Files that shrink most: ${details.files.map((file) => `${file.path} (${sizeText(file.bytes)})`).join(', ')}.` : '';
    return `The package's compression ratio is ${Math.round(value)}:1; ${whoAccepts(lms, (max) => `${max}:1`)}.${chosen ? '' : choose}${files} Store already-compressed data, or split very repetitive files.`;
  }
  const what = measure === 'zip' ? `The package weighs ${sizeText(value)}` : `Extracted, the package weighs ${sizeText(value)}`;
  let message = `${what} at the ${quality} media quality; ${whoAccepts(lms, limitText)}${measure === 'unzipped' ? ' extracted' : ''}.${chosen ? '' : choose}`;
  const others = (details.qualities ?? []).filter((size) => size.quality !== quality);
  if (others.length) message += ` Other qualities: ${others.map((size) => `${size.quality} ${size.estimated ? 'about ' : ''}${sizeText(size.bytes)}${size.estimated ? ' (estimated)' : ''}`).join(', ')}.`;
  if (details.fits) message += ` Build with --media-quality ${details.fits}, or set delivery.mediaQuality to "${details.fits}" in course.json.`;
  const heaviest = details.files?.[0];
  if (details.fits === null || !details.qualities) {
    const lower = details.qualities ? ` Even the ${PRESET_NAMES[PRESET_NAMES.length - 1]} media quality is not enough:` : '';
    message += heaviest?.kind === 'video'
      ? `${lower} shorten or split ${heaviest.asset ?? heaviest.path}, or host it on a video platform and link to it from the course (a video block plays a file of the package); otherwise split the course.`
      : `${lower} lighten the heaviest files or split the course.`;
  }
  if (details.files?.length) message += ` Heaviest files: ${details.files.map((file) => `${file.asset ?? file.path} (${sizeText(file.bytes)})`).join(', ')}.`;
  return message;
}

// The kind of a file of the package, by its extension.
export function packageFileKind(path: string): PackageFileKind {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  if (['mp4', 'webm', 'mov', 'm4v'].includes(extension)) return 'video';
  if (['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav'].includes(extension)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'].includes(extension)) return 'image';
  if (['woff2', 'woff', 'ttf', 'otf'].includes(extension)) return 'font';
  return 'other';
}
