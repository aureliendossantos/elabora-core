// The course's sounds (docs/decisions.md D67): the files of assets/sounds/ named by their id, and the
// interface sounds the player makes.

import type { Project } from '../project/model.ts';
import type { BackgroundTrackData, InterfaceRole, SoundsData, SoundFileData } from '@elabora/player/course-data';
import type { Sound } from '@elabora/format';
import { classifyLicence, soundCredit } from './licences.ts';
import type { Licence } from './licences.ts';
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
export function soundAssets(project: Pick<Project, 'files'>): Map<string, SoundAsset> {
  const found = new Map<string, SoundAsset>();
  for (const path of [...project.files.keys()].sort()) {
    const match = SOUND_FILE.exec(path);
    if (!match || found.has(match[1])) continue;
    found.set(match[1], { id: match[1], path, asset: path.slice('assets/'.length), sidecar: `${SOUNDS_FOLDER}/${match[1]}.json` });
  }
  return found;
}

// Whether the module has sound (interface sounds' `when: auto`): a voice line whose audio is there
// (a narration, a layer's, a dialogue's), an audio or video block, a sound of the story, music or an
// ambience. A module still without its
// voices is silent, and so are its interface sounds until they come.
export function courseHasSound(project: Project): boolean {
  if (soundUses(project).some((use) => use.kind !== 'interface')) return true;
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
  const story = compileSoundFiles(project, assetPath);
  if (!settings.active && !story) return undefined;
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
  const background = backgroundTracks(project).filter((track) => story?.[track.sound]);
  const music = background.length > 0 || loopedActions(project);
  return {
    ...(settings.active ? { interface: { volume: settings.volume, files } } : {}),
    ...(story ? { files: story } : {}),
    ...(background.length ? { background } : {}),
    ...(music ? { music: true as const } : {})
  };
}

// The course's music and ambiences (sounds.background): each with the screens of its range, in the
// course's order. A range whose ends are not screens of the course, or that runs backwards, is left
// out (E_SOUND_BACKGROUND).
export function backgroundTracks(project: Project): BackgroundTrackData[] {
  const order = screenOrder(project).map(({ id }) => id);
  const tracks = isRecord(project.course?.sounds) && Array.isArray(project.course.sounds.background) ? project.course.sounds.background : [];
  return tracks.flatMap((track): BackgroundTrackData[] => {
    if (!isRecord(track) || typeof track.sound !== 'string' || typeof track.from !== 'string') return [];
    const from = order.indexOf(track.from);
    const to = order.indexOf(typeof track.to === 'string' ? track.to : track.from);
    if (from < 0 || to < from) return [];
    return [{ sound: track.sound, screens: order.slice(from, to + 1), volume: typeof track.volume === 'number' ? track.volume : DEFAULT_BACKGROUND_VOLUME, fade: typeof track.fade === 'number' ? track.fade : DEFAULT_BACKGROUND_FADE }];
  });
}
export const DEFAULT_BACKGROUND_VOLUME = 0.25;
export const DEFAULT_BACKGROUND_FADE = 2;

// Whether the course has music or ambiences that start by themselves (« Musique et ambiances »).
export const courseHasMusic = (project: Project): boolean => backgroundTracks(project).length > 0 || loopedActions(project);

// Whether a screen plays an ambience of its own (a play-sound with loop).
function loopedActions(project: Project): boolean {
  let found = false;
  const walk = (value: unknown): void => {
    if (found || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const record = value as Record<string, unknown>;
    if (record.type === 'play-sound' && record.loop === true) { found = true; return; }
    Object.values(record).forEach(walk);
  };
  for (const { id } of screenOrder(project)) walk(project.screens.get(id)?.data);
  return found;
}

// The player's files the course data names (the build ships them).
export const shippedPlayerSounds = (data: SoundsData | undefined): string[] => Object.values(data?.interface?.files ?? {}).filter((path): path is string => !!path && path.startsWith('elabora/sounds/')).sort();

// Where the course names a sound (D67): an interface role, a play-sound or stop-sound action, a
// sound line (a narration's, a layer's, a dialogue's), a track of music or ambience. path: a JSON
// pointer in file.
export interface SoundUse {
  id: string;
  file: string;
  path: string;
  kind: 'interface' | 'action' | 'line' | 'background';
  // A narration's sound line: the build lays it into the narration's track, it ships no file.
  inTrack?: true;
}
// Kept per project: validation and a build ask for them many times of one project.
const usesOf = new WeakMap<Project, readonly SoundUse[]>();
export function soundUses(project: Project): readonly SoundUse[] {
  let known = usesOf.get(project);
  if (!known) { known = findSoundUses(project); usesOf.set(project, known); }
  return known;
}
function findSoundUses(project: Project): SoundUse[] {
  const uses: SoundUse[] = [];
  const course = project.course;
  const replace = isRecord(course?.sounds) && isRecord(course.sounds.interface) && isRecord(course.sounds.interface.replace) ? course.sounds.interface.replace : {};
  for (const role of INTERFACE_ROLES) {
    const id = replace[role];
    if (typeof id === 'string') uses.push({ id, file: 'course.json', path: `/sounds/interface/replace/${role}`, kind: 'interface' });
  }
  const background = isRecord(course?.sounds) && Array.isArray(course.sounds.background) ? course.sounds.background : [];
  background.forEach((track, index) => { if (isRecord(track) && typeof track.sound === 'string') uses.push({ id: track.sound, file: 'course.json', path: `/sounds/background/${index}/sound`, kind: 'background' }); });
  // A screen's file, walked whole: actions are in events, cues, a dialogue's options and lines.
  const walk = (value: unknown, path: string, file: string) => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}/${index}`, file)); return; }
    if (!isRecord(value)) return;
    if (typeof value.sound === 'string') {
      if (value.type === 'play-sound' || value.type === 'stop-sound') uses.push({ id: value.sound, file, path: `${path}/sound`, kind: 'action' });
      else if (typeof value.id === 'string' && value.type === undefined) uses.push({ id: value.sound, file, path: `${path}/sound`, kind: 'line', ...(/\/narration\/lines\/\d+$/.test(path) ? { inTrack: true as const } : {}) });
    }
    for (const [key, child] of Object.entries(value)) if (child !== null && typeof child === 'object') walk(child, `${path}/${key}`, file);
  };
  for (const { id } of screenOrder(project)) {
    const entry = project.screens.get(id);
    if (entry) walk(entry.data, '', entry.file ?? `screens/${id}.json`);
  }
  return uses;
}

// The sidecar of a sound (assets/sounds/<id>.json), parsed; null when it is missing or not JSON.
export function soundSidecar(project: Project, asset: SoundAsset): Sound | null {
  const file = project.files.get(asset.sidecar);
  if (!file || file.kind !== 'text') return null;
  try {
    const value: unknown = JSON.parse(file.text);
    return isRecord(value) ? (value as Sound) : null;
  } catch {
    return null;
  }
}

// The course data's sounds the screens play, by id: their package path, length and loop.
export function compileSoundFiles(project: Project, assetPath: (name: string) => string): Record<string, SoundFileData> | undefined {
  const assets = soundAssets(project);
  const files: Record<string, SoundFileData> = {};
  for (const use of soundUses(project)) {
    if (use.kind === 'interface' || use.inTrack || files[use.id]) continue;
    const asset = assets.get(use.id);
    if (!asset) continue;
    const file = project.files.get(asset.path);
    const sidecar = soundSidecar(project, asset);
    const duration = (file?.kind === 'binary' ? file.media?.duration : null) ?? (typeof sidecar?.duration === 'number' ? sidecar.duration : null);
    files[use.id] = { src: assetPath(asset.asset), duration: duration ?? null, ...(sidecar?.loop === true ? { loop: true as const } : {}) };
  }
  return Object.keys(files).length ? Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) : undefined;
}

// The player's own interface sounds, as CREDITS.txt names them (src/interface-sounds/sources.json).
const PLAYER_SOUNDS_CREDIT = 'Interface Sounds 1.0 by Kenney (www.kenney.nl) — CC0 1.0 — https://kenney.nl/assets/interface-sounds';

// CREDITS.txt of a package (D67): every sound it ships, where it comes from and under what licence,
// for the LMS's administrators (learners read « IA et crédits »); null without sounds.
export function soundCreditsText(project: Project, data: SoundsData | undefined, packagePath: (asset: string) => string): string | null {
  if (!data) return null;
  const assets = soundAssets(project);
  const entries: string[] = [];
  const player = Object.values(data.interface?.files ?? {}).filter((src): src is string => !!src && src.startsWith('elabora/sounds/')).sort();
  if (player.length) entries.push([...player, `  ${PLAYER_SOUNDS_CREDIT}`].join('\n'));
  const uses = soundUses(project).filter((use) => use.kind !== 'interface' || data.interface);
  for (const id of [...new Set(uses.map((use) => use.id))].sort()) {
    const asset = assets.get(id);
    if (!asset) continue;
    const sidecar = soundSidecar(project, asset);
    const what = [sidecar?.title ? `“${sidecar.title}”` : id, sidecar?.author ? `by ${sidecar.author}` : null].filter(Boolean).join(' ');
    // A sound only a narration says is in its track (narration/<screen>.m4a), not in a file of its own.
    const own = uses.some((use) => use.id === id && !use.inTrack);
    const lines = [own ? packagePath(asset.asset) : `${id} (in the narration's track)`, `  ${[what, sidecar?.license ?? 'licence unknown', sidecar?.url ?? null].filter(Boolean).join(' — ')}`];
    if (sidecar?.generated) lines.push(`  Generated with ${[sidecar.generated.provider, sidecar.generated.model].filter(Boolean).join(' ')}.`);
    if (sidecar?.modified?.length) lines.push(`  Modified: ${sidecar.modified.join(', ')}.`);
    entries.push(lines.join('\n'));
  }
  if (!entries.length) return null;
  return `Sounds and music of “${project.course?.title ?? ''}”\n\n${entries.join('\n\n')}\n`;
}

// The course's sounds as `elabora sound list` gives them (D67): each file of assets/sounds/ with its
// sidecar, licence, the credit it asks for, and where the course uses it; the ids it names without a file.
export interface CourseSound {
  id: string;
  path: string | null;
  title: string | null;
  duration: number | null;
  license: string | null;
  licence: Licence;
  credit: string | null;
  generated: boolean;
  loop: boolean;
  uses: Omit<SoundUse, 'id'>[];
}
export function courseSounds(project: Project): CourseSound[] {
  const assets = soundAssets(project);
  const uses = soundUses(project);
  const ids = [...new Set([...assets.keys(), ...uses.map((use) => use.id)])].sort();
  return ids.map((id) => {
    const asset = assets.get(id);
    const sidecar = asset ? soundSidecar(project, asset) : null;
    const file = asset ? project.files.get(asset.path) : undefined;
    return {
      id, path: asset?.path ?? null, title: sidecar?.title ?? null,
      duration: (file?.kind === 'binary' ? file.media?.duration : null) ?? sidecar?.duration ?? null,
      license: sidecar?.license ?? null, licence: classifyLicence(sidecar?.license), credit: soundCredit(sidecar, project.course?.language ?? 'en'),
      generated: !!sidecar?.generated, loop: sidecar?.loop === true,
      uses: uses.filter((use) => use.id === id).map(({ id: _id, ...use }) => use)
    };
  });
}
