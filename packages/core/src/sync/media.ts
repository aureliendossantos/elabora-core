// What a project's room knows of a medium without its bytes (D125): its size, which the room measures,
// and its facts, which a copy that holds the file gives. A browser's copy opens a module with its
// texts and takes a medium only when something needs it; validation, the timeline and the media
// panels need to know what each medium is before that.
//
// The facts are those of the bytes, so they go by hash, beside the reference: never in a write
// operation, never in the journal. They are MediaInfo without its size (the room's word on that), and
// without the conformance verdict, which depends on the path (a sound of assets/sounds/, D67) and on
// the core's rules: a copy computes it with fileMedia({ ...facts, size }, path).
//
// They are a member's claim, not a truth: no right, no limit and no package depends on them (a build
// reads the files). A room keeps the first facts of each version for a hash, and a higher version
// replaces a lower one: MEDIA_FACTS_VERSION moves when a prober's fault is mended or the facts gain a
// key. A new version only adds keys, never changes what an existing one means.

import type { MediaInfo } from '../media/conformance.ts';
import type { MediaKind } from '../media/presets.ts';

// The version of the facts this core writes and fully reads.
export const MEDIA_FACTS_VERSION = 1;

export interface MediaFacts extends Omit<MediaInfo, 'size'> {
  version: number;
}

// A medium as a room renders it beside a reference: its size, and its facts once a copy gave them.
export interface KnownMedium {
  size: number;
  facts?: MediaFacts;
}

// The media a message carries, by hash (sha256:…).
export type MediaMap<T> = Record<string, T>;

const KINDS: ReadonlySet<MediaKind> = new Set(['video', 'audio', 'image', 'vector']);
const CODEC = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const CONTAINER = /^[a-z0-9][a-z0-9_,.+-]{0,63}$/;
const PRINTABLE = /^[\x20-\x7e]{1,64}$/;
export const MEDIUM_HASH = /^sha256:[0-9a-f]{64}$/;

type Check = (value: unknown) => boolean;
const nullable = (check: Check): Check => (value) => value === null || check(value);
const number = (min: number, max: number): Check => (value) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const integer = (min: number, max: number): Check => (value) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (pattern: RegExp): Check => (value) => typeof value === 'string' && pattern.test(value);
const boolean: Check = (value) => typeof value === 'boolean';

// Version 1's keys and what each may hold: MediaInfo's, as ffprobe and the core give them, bounded.
const KEYS_1: Readonly<Record<keyof Omit<MediaFacts, 'version'>, Check>> = {
  kind: (value) => KINDS.has(value as MediaKind),
  container: text(CONTAINER),
  duration: nullable(number(0, 1e6)),
  bitrate: nullable(number(0, 1e11)),
  videoCodec: nullable(text(CODEC)),
  profile: nullable(text(PRINTABLE)),
  pixelFormat: nullable(text(CODEC)),
  width: nullable(integer(0, 65_535)),
  height: nullable(integer(0, 65_535)),
  rotation: number(-360, 360),
  pixelAspect: number(0, 100),
  fps: nullable(number(0, 1000)),
  videoBitrate: nullable(number(0, 1e11)),
  hdr: (value) => value === null || value === 'pq' || value === 'hlg',
  alpha: boolean,
  animated: boolean,
  audioCodec: nullable(text(CODEC)),
  audioBitrate: nullable(number(0, 1e10)),
  channels: nullable(integer(0, 64)),
  sampleRate: nullable(integer(0, 1_000_000)),
  coverArt: boolean,
  faststart: (value) => value === null || typeof value === 'boolean',
  location: boolean,
};

/**
 * Facts as data, checked: every key of version 1 present and within its bounds. `strict` (a room,
 * which keeps them): a version this core does not know, or a key it does not know, is refused, since
 * it cannot check them. `tolerant` (a copy reading what a room relays): a higher version is taken,
 * its keys this core knows checked and kept, the others left out. Null when they do not hold.
 */
export function readMediaFacts(value: unknown, mode: 'strict' | 'tolerant'): MediaFacts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const given = value as Record<string, unknown>;
  const version = given.version;
  if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > 1_000) return null;
  if (mode === 'strict' && (version as number) > MEDIA_FACTS_VERSION) return null;
  const facts: Record<string, unknown> = { version };
  for (const [key, check] of Object.entries(KEYS_1)) {
    if (!(key in given) || !check(given[key])) return null;
    facts[key] = given[key];
  }
  if (mode === 'strict' && Object.keys(given).some((key) => key !== 'version' && !(key in KEYS_1))) return null;
  return facts as unknown as MediaFacts;
}

/** The facts of a probe, as a copy that holds the file gives them. */
export function mediaFacts(info: MediaInfo): MediaFacts {
  const facts: Record<string, unknown> = { version: MEDIA_FACTS_VERSION };
  for (const key of Object.keys(KEYS_1)) facts[key] = info[key as keyof MediaInfo];
  return facts as unknown as MediaFacts;
}

/**
 * The media a room relays (KnownMedium by hash), read by a copy: an entry whose hash or size does not
 * hold is left out, facts that do not hold are left out of their entry.
 */
export function readKnownMedia(value: unknown): Map<string, KnownMedium> {
  const known = new Map<string, KnownMedium>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return known;
  for (const [hash, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!MEDIUM_HASH.test(hash) || !entry || typeof entry !== 'object') continue;
    const { size, facts } = entry as { size?: unknown; facts?: unknown };
    if (!Number.isSafeInteger(size) || (size as number) < 0) continue;
    const read = facts === undefined ? null : readMediaFacts(facts, 'tolerant');
    known.set(hash, { size: size as number, ...(read ? { facts: read } : {}) });
  }
  return known;
}

/** Whether facts given here would replace those a room holds: none there, or a lower version. */
export function replacesFacts(held: Pick<MediaFacts, 'version'> | undefined | null, given: Pick<MediaFacts, 'version'>): boolean {
  return !held || given.version > held.version;
}
