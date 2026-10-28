// The course's sounds (docs/decisions.md D67): the files of assets/sounds/ named by their id, and the
// interface sounds the player makes.

import type { Project } from '../project/model.ts';
import type { InterfaceRole, SoundsData } from '@elabora/player/course-data';
import { INTERFACE_ROLES, PLAYER_INTERFACE_SOUNDS } from '@elabora/player/sound-roles';
import { screenOrder, iterateBlocks } from '../project/load.ts';
import { narrationLines } from '../narration/narration.ts';
import { isRecord } from '../compile/values.ts';

export { INTERFACE_ROLES };
export type { InterfaceRole };

export const SOUNDS_FOLDER = 'assets/sounds';
// What a sound may be stored as (D67): lossless FLAC for what was lossless, the original's own bytes
// for what came lossy (Vorbis, Opus, MP3, AAC), never transcoded from one lossy format to another
// before the build; WAV is accepted and stored as FLAC by `elabora sound add`.
export const SOUND_EXTENSIONS = ['flac', 'ogg', 'opus', 'm4a', 'mp3', 'wav', 'webm'] as const;
const SOUND_FILE = new RegExp(`^${SOUNDS_FOLDER}/([a-z][a-z0-9-]{0,47})\\.(${SOUND_EXTENSIONS.join('|')})$`);

// The sound files of the course by id (assets/sounds/<id>.<ext>, its sidecar <id>.json).
export interface SoundAsset {
  id: string;
  path: string; // project path of the audio file
  asset: string; // relative to assets/ (sounds/<id>.<ext>)
  sidecar: string; // project path of <id>.json
}
export function soundAssets(project: Project): Map<string, SoundAsset> {
  const found = new Map<string, SoundAsset>();
  for (const path of [...project.files.keys()].sort()) {
    const match = SOUND_FILE.exec(path);
    if (!match || found.has(match[1])) continue;
    found.set(match[1], { id: match[1], path, asset: path.slice('assets/'.length), sidecar: `${SOUNDS_FOLDER}/${match[1]}.json` });
  }
  return found;
}

// Whether the module has sound (interface sounds' `when: auto`): a voice line whose audio is there
// (a narration, a layer's, a dialogue's), or an audio or video block. A module still without its
// voices is silent, and so are its interface sounds until they come.
export function courseHasSound(project: Project): boolean {
  for (const { block } of iterateBlocks(project)) if (block.type === 'audio' || block.type === 'video') return true;
  for (const { id } of screenOrder(project)) {
    for (const line of narrationLines(project, id) ?? []) if (project.files.has(line.audio)) return true;
  }
  return false;
}

// The interface sounds as the course sets them: whether they sound, their volume, and each role's
// source: the player's own file, a sound of the course, or none (muted by the author).
export type InterfaceSource = { kind: 'player' } | { kind: 'sound'; id: string } | null;
export interface InterfaceSounds {
  when: 'auto' | 'on' | 'off';
  active: boolean;
  volume: number;
  roles: Record<InterfaceRole, InterfaceSource>;
}
export const DEFAULT_INTERFACE_VOLUME = 0.5;

export function interfaceSounds(project: Project, { hasSound = courseHasSound }: { hasSound?: (project: Project) => boolean } = {}): InterfaceSounds {
  const settings = isRecord(project.course?.sounds) && isRecord(project.course.sounds.interface) ? project.course.sounds.interface : {};
  const when = settings.when === 'on' || settings.when === 'off' ? settings.when : 'auto';
  const volume = typeof settings.volume === 'number' && settings.volume >= 0 && settings.volume <= 1 ? settings.volume : DEFAULT_INTERFACE_VOLUME;
  const replace: Record<string, unknown> = isRecord(settings.replace) ? settings.replace : {};
  const roles = Object.fromEntries(INTERFACE_ROLES.map((role): [InterfaceRole, InterfaceSource] => {
    if (!(role in replace)) return [role, { kind: 'player' }];
    const value = replace[role];
    return [role, typeof value === 'string' ? { kind: 'sound', id: value } : null];
  })) as Record<InterfaceRole, InterfaceSource>;
  const active = when === 'on' || (when === 'auto' && hasSound(project));
  return { when, active, volume, roles };
}

// The player's file of a role, in the package (elabora/sounds/, D67).
export const playerSoundPath = (role: InterfaceRole) => `elabora/sounds/${role}.m4a`;

// The course data's sounds: interface sounds when they sound; none otherwise (the bytes of a course
// without sound do not change).
// settings: interfaceSounds(project), when the caller has it already.
export function compileSounds(project: Project, { assetPath, settings = interfaceSounds(project) }: { assetPath: (name: string) => string; settings?: InterfaceSounds }): SoundsData | undefined {
  if (!settings.active) return undefined;
  const assets = soundAssets(project);
  const files: Partial<Record<InterfaceRole, string>> = {};
  for (const role of INTERFACE_ROLES) {
    const source = settings.roles[role];
    if (source?.kind === 'player' && PLAYER_INTERFACE_SOUNDS.includes(role)) files[role] = playerSoundPath(role);
    else if (source?.kind === 'sound') {
      const asset = assets.get(source.id);
      if (asset) files[role] = assetPath(asset.asset);
    }
  }
  return { interface: { volume: settings.volume, files } };
}

// The player's files the course data names (the build ships them).
export const shippedPlayerSounds = (data: SoundsData | undefined): string[] => Object.values(data?.interface?.files ?? {}).filter((path): path is string => !!path && path.startsWith('elabora/sounds/')).sort();
