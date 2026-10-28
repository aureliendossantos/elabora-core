import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Elabora's library of sounds, « Sons courants » (docs/decisions.md D67): CC0 or public-domain sounds
// in packages/node/sounds/files/, their catalogue written by `npm run sounds`. Offline.

export interface LibrarySound {
  id: string;
  title: { en: string; fr: string };
  category: 'telephone' | 'doors-footsteps' | 'office' | 'notifications' | 'impacts' | 'transitions' | 'nature' | 'crowds-places' | 'stingers';
  kind: 'effect' | 'ambience';
  file: string; // files/<id>.<ext>, in the library's folder
  format: string;
  channels: number;
  sampleRate: number;
  duration: number;
  bytes: number;
  hash: `sha256:${string}`;
  source: string;
  url: string;
  author: string;
  license: string;
  licenseUrl: string;
  checked: string;
  caption?: Record<string, string>;
  tags: string[];
}

export const LIBRARY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sounds');
export const SOUND_CATEGORIES = ['telephone', 'doors-footsteps', 'office', 'notifications', 'impacts', 'transitions', 'nature', 'crowds-places', 'stingers'] as const;

let cached: LibrarySound[] | null = null;
export function librarySounds(): LibrarySound[] {
  cached ??= (JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, 'catalogue.json'), 'utf8')) as { sounds: LibrarySound[] }).sounds;
  return cached;
}
export const libraryFile = (sound: LibrarySound): string => path.join(LIBRARY_DIR, sound.file);

// Words a search compares, accents and case aside.
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (text: string): string[] => fold(text).split(/[^a-z0-9]+/).filter((word) => word.length > 1);

export interface SoundFilters {
  category?: string;
  kind?: 'effect' | 'ambience';
  maxDuration?: number;
}

// The library's sounds that say the words (in their titles, both languages, their tags, their
// category and id), best first; all of them, by category, without words.
export function searchLibrary(query: string, filters: SoundFilters = {}): LibrarySound[] {
  const wanted = words(query);
  const scored = librarySounds()
    .filter((sound) => (!filters.category || sound.category === filters.category) && (!filters.kind || sound.kind === filters.kind) && (filters.maxDuration === undefined || sound.duration <= filters.maxDuration))
    .map((sound) => {
      const haystack = words([sound.id.replace(/-/g, ' '), sound.title.en, sound.title.fr, sound.category.replace(/-/g, ' '), ...sound.tags].join(' '));
      // A word matches a word of the sound that starts with it (« sonn » finds « sonnerie »), or a
      // word of the sound that it starts with (« telephones » finds « telephone »).
      const score = wanted.reduce((sum, word) => sum + (haystack.some((candidate) => candidate === word) ? 2 : haystack.some((candidate) => candidate.startsWith(word) || (candidate.length > 3 && word.startsWith(candidate))) ? 1 : 0), 0);
      return { sound, score };
    })
    .filter(({ score }) => !wanted.length || score > 0);
  return scored.sort((a, b) => b.score - a.score || a.sound.category.localeCompare(b.sound.category) || a.sound.id.localeCompare(b.sound.id)).map(({ sound }) => sound);
}
