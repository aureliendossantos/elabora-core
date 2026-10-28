import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Elabora's library of sounds, « Sons courants » (docs/decisions.md D67): CC0 or public-domain sounds
// in packages/node/sounds/files/, their catalogue written by `pnpm run sounds`. Offline. Another
// library may join it (ELABORA_SOUND_LIBRARIES: folders, separated as PATH is, each with its own
// catalogue.json and files/, written by `pnpm run sounds -- --library <dir>`): the desktop app's, whose
// CC BY sounds carry the credit they ask for. Ids are unique across libraries: the core's first.

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
  // The credit line a CC BY sound asks for, as it should read (else « “Title”, Author — CC BY 4.0 — url »).
  credit?: string;
  tags: string[];
  // The folder of the library it comes from (its file is relative to it).
  library: string;
}

export const LIBRARY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sounds');
export const SOUND_CATEGORIES = ['telephone', 'doors-footsteps', 'office', 'notifications', 'impacts', 'transitions', 'nature', 'crowds-places', 'stingers'] as const;

// The libraries searched: the core's, then those ELABORA_SOUND_LIBRARIES names (a missing folder or
// catalogue is left out: the app's library may not be installed in a checkout).
export function libraryDirs(): string[] {
  const extra = (process.env.ELABORA_SOUND_LIBRARIES ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir));
  return [LIBRARY_DIR, ...extra.filter((dir) => dir !== LIBRARY_DIR && fs.existsSync(path.join(dir, 'catalogue.json')))];
}

let cached: { key: string; sounds: LibrarySound[] } | null = null;
export function librarySounds(): LibrarySound[] {
  const dirs = libraryDirs();
  const key = dirs.join('\n');
  if (cached?.key === key) return cached.sounds;
  const sounds: LibrarySound[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const catalogue = JSON.parse(fs.readFileSync(path.join(dir, 'catalogue.json'), 'utf8')) as { sounds: Omit<LibrarySound, 'library'>[] };
    for (const sound of catalogue.sounds) if (!seen.has(sound.id)) { seen.add(sound.id); sounds.push({ ...sound, library: dir }); }
  }
  cached = { key, sounds };
  return sounds;
}
export const libraryFile = (sound: LibrarySound): string => path.join(sound.library, sound.file);

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
