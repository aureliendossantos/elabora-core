import fs from 'node:fs';
import path from 'node:path';
import { libraryFile, librarySounds, searchLibrary } from './library.ts';
import type { LibrarySound } from './library.ts';
import { openverseSound, searchOpenverse } from './openverse.ts';
import type { OpenverseSound } from './openverse.ts';
import { ELABORA_VERSION, playerSoundFile } from '../bundles.ts';
import type { SoundFound, SoundSearchParams } from './types.ts';

// The sounds one may add, as a sound browser lists them (docs/decisions.md D67): the library's
// (« Sons courants », the core's and those ELABORA_SOUND_LIBRARIES adds) or Openverse's, in one shape,
// each with what add_sound takes (from), its licence and who to credit.

export async function searchSounds(params: SoundSearchParams, { signal }: { signal?: AbortSignal } = {}): Promise<SoundFound[]> {
  const text = (params.text ?? '').trim();
  if (params.source === 'openverse') {
    if (!text) return [];
    return (await searchOpenverse(text, { ...(params.maxDuration !== undefined ? { maxDuration: params.maxDuration } : {}), signal })).map(fromOpenverse);
  }
  const language = params.language?.split('-')[0] === 'fr' ? 'fr' : 'en';
  return searchLibrary(text, { ...(params.category ? { category: params.category } : {}), ...(params.kind ? { kind: params.kind } : {}), ...(params.maxDuration !== undefined ? { maxDuration: params.maxDuration } : {}) })
    .map((sound) => fromLibrary(sound, language));
}

export function fromLibrary(sound: LibrarySound, language: 'fr' | 'en' = 'en'): SoundFound {
  return {
    from: sound.id, title: sound.title.en, label: sound.title[language] || sound.title.en, category: sound.category, kind: sound.kind, duration: sound.duration,
    author: sound.author, license: sound.license, licenseUrl: sound.licenseUrl || null, url: sound.url || null, source: 'library',
    credit: sound.credit ?? null, caption: sound.caption ?? null, loop: sound.kind === 'ambience'
  };
}

export function fromOpenverse(sound: OpenverseSound): SoundFound {
  return {
    from: sound.id, title: sound.title, label: sound.title, category: null, kind: null, duration: sound.duration,
    author: sound.author, license: sound.license, licenseUrl: sound.licenseUrl, url: sound.url, source: sound.source,
    credit: null, caption: null, loop: false
  };
}

const TYPES: Record<string, string> = { '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.oga': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm' };

// A sound's bytes to hear it before adding it: the library's file, Openverse's (an MP3 or Ogg preview
// for Freesound, the original for Commons), or the player's own interface sound (elabora:<role>).
// Nothing is kept.
const PREVIEW_MAX = 40 * 1024 * 1024;
export async function soundPreview(from: string, { signal }: { signal?: AbortSignal } = {}): Promise<{ audio: Uint8Array; type: string }> {
  const role = /^elabora:([a-z]+)$/.exec(from)?.[1];
  if (role) return { audio: new Uint8Array(playerSoundFile(`elabora/sounds/${role}.m4a`)), type: 'audio/mp4' };
  const library = librarySounds().find((sound) => sound.id === from);
  if (library) {
    const file = libraryFile(library);
    return { audio: new Uint8Array(fs.readFileSync(file)), type: TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' };
  }
  if (!from.startsWith('openverse:')) throw new Error(`No library sound or Openverse sound "${from}".`);
  const found = await openverseSound(from, { signal });
  const response = await fetch(found.file, { headers: { 'user-agent': `Elabora/${ELABORA_VERSION} (+https://elabora.studio)` }, signal: signal ?? AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`The sound could not be downloaded from ${new URL(found.file).host} (${response.status}).`);
  const tooLarge = () => new Error(`The sound on ${new URL(found.file).host} is too large to hear here: open its page.`);
  if (Number(response.headers.get('content-length') ?? 0) > PREVIEW_MAX) throw tooLarge();
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() || TYPES[path.extname(new URL(found.file).pathname).toLowerCase()] || 'audio/mpeg';
  // Read up to the cap, whether or not the server said the length.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > PREVIEW_MAX) throw tooLarge(); // leaving the loop cancels the download
    chunks.push(chunk);
  }
  return { audio: Buffer.concat(chunks), type };
}
