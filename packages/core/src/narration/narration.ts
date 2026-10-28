// Narration lines and their audio (docs/decisions.md D24). The script lives in the screen
// (narration.lines); the audio of a line in a language lives next to it by convention:
//   assets/narration/<language>/<screen>/<line>.m4a   the voice, AAC in M4A, mono
//   assets/narration/<language>/<screen>/<line>.json  its sidecar (schema narration-audio)
// A line is out of date when its text, its audio or its speaker's voice changed since the sidecar was
// written, and for a generated voice when what it was told to say (the pronunciations) or how (the
// voice's settings, the line's delivery) changed; missing without both files. The validator, the build, `elabora timeline` and the voice tools
// read lines through here. Lines of every track count (voice-lines.ts: the screen's narration, each
// layer's, D62): ids are unique in the screen, so a line's audio keeps its path whatever holds it.

import type { Course, NarrationAudio, Screen, Speaker } from '@elabora/format';
import { fileHash, getFile, readText } from '../project/files.ts';
import type { FileHash, ProjectFiles } from '../project/files.ts';
import type { Project } from '../project/model.ts';
import { readXliff } from '../i18n/xliff.ts';
import { canonicalJSON, parseJSON } from '../util/json.ts';
import { sha256 } from '../util/sha256.ts';
import { objectsIn } from '../util/values.ts';
import { screenTimeline } from './timeline.ts';
import { isMouth } from './mouth.ts';
import { screenVoiceLines, soundLinesOf, timelineOf } from './voice-lines.ts';
import { soundAssets } from '../sounds/sounds.ts';
import type { VoiceTrack } from './voice-lines.ts';
import { hasDirections, outsideDirections } from './directions.ts';
import type { TimelineLayout, TimelineLine } from './timeline.ts';

export type { NarrationAudio };
export type Narration = NonNullable<Screen['narration']>;
// A line of a narration as written: a voice's (NarrationLine), or a sound's (D67).
export type WrittenNarrationLine = Narration['lines'][number];
export type NarrationLine = Extract<WrittenNarrationLine, { text: string }>;
export type NarrationSoundLine = Extract<WrittenNarrationLine, { sound: string }>;
export const isSoundLine = (line: unknown): line is NarrationSoundLine => !!line && typeof line === 'object' && typeof (line as { sound?: unknown }).sound === 'string';

export const NARRATION_DIR = 'assets/narration';

export const narrationAudioPath = (language: string, screen: string, line: string): string => `${NARRATION_DIR}/${language}/${screen}/${line}.m4a`;
export const narrationSidecarPath = (language: string, screen: string, line: string): string => `${NARRATION_DIR}/${language}/${screen}/${line}.json`;
// The folder of a screen's lines in a language.
export const narrationFolder = (language: string, screen: string): string => `${NARRATION_DIR}/${language}/${screen}`;

// The text a voice says, as its hash sees it: Unicode NFC, whitespace runs made one space, trimmed.
export const normalizeNarrationText = (text: string): string => text.normalize('NFC').replace(/\s+/gu, ' ').trim();

export const narrationTextHash = (text: string): FileHash => `sha256:${sha256(normalizeNarrationText(text))}`;

// What a generated voice is told to say: the text with the pronunciations of the line, then those of
// the course, in that language (whole words, case-sensitive; within a list the longest text first).
// Captions and the transcript keep the text. Stage directions stay as they are (D29): a voice that
// cannot play them drops them itself.
export type Pronunciation = { text: string; say: string };

export function applyPronunciations(text: string, entries: readonly Pronunciation[]): string {
  // Never inside a stage direction (D29).
  if (hasDirections(text)) return outsideDirections(text, (part) => applyPronunciations(part, entries));
  const usable = entries.filter((entry) => typeof entry?.text === 'string' && entry.text && typeof entry.say === 'string');
  if (!usable.length) return text;
  const says = new Map(usable.map((entry) => [entry.text, entry.say]));
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = [...says.keys()].sort((a, b) => b.length - a.length).map(escape).join('|');
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'gu'), (found) => says.get(found) ?? found);
}

const pronunciationsIn = (value: unknown, language: string): Pronunciation[] => {
  const list = value && typeof value === 'object' ? (value as Record<string, unknown>)[language] : undefined;
  return Array.isArray(list) ? list.filter((entry): entry is Pronunciation => !!entry && typeof entry === 'object') : [];
};

export function spokenTextOf(course: Course | null | undefined, line: Pick<NarrationLine, 'pronunciations'>, text: string, language: string): string {
  return applyPronunciations(applyPronunciations(text, pronunciationsIn(line.pronunciations, language)), pronunciationsIn(course?.pronunciations, language));
}

// The settings a generated voice says a line with: its speaker's voice settings in that language,
// the line's delivery in that language over them; and their hash.
export function deliveryOf(course: Course | null | undefined, line: Pick<NarrationLine, 'speaker' | 'delivery'>, language: string): { settings: Record<string, unknown>; hash: FileHash } {
  const voice = lineSpeaker(course, line)?.voices?.[language];
  const own = line.delivery?.[language];
  const settings = { ...(voice?.settings && typeof voice.settings === 'object' ? voice.settings : {}), ...(own && typeof own === 'object' ? own : {}) };
  return { settings, hash: `sha256:${sha256(canonicalJSON(settings))}` };
}

// A cue as tools write it on the command line: "l2" (the line starts), "l2:end" (it ends).
export function lineAnchor(text: string): { line: string; edge: 'start' | 'end' } | null {
  const match = /^([a-z][a-z0-9-]{0,47})(?::(start|end))?$/.exec(text.trim());
  return match ? { line: match[1], edge: match[2] === 'end' ? 'end' : 'start' } : null;
}

// The steps of a screen: those of its blocks (layers aside) and of its narration lines.
export function screenSteps(screen: Pick<Screen, 'blocks' | 'narration'> | null | undefined): number[] {
  const steps = new Set<number>();
  for (const block of objectsIn(screen?.blocks)) steps.add(typeof block.step === 'number' ? block.step : 1);
  for (const line of objectsIn(screen?.narration?.lines)) steps.add(typeof line.step === 'number' ? line.step : 1);
  if (!steps.size) steps.add(1);
  return [...steps].sort((a, b) => a - b);
}

// The speaker of a line: its own, else the course's first.
export function lineSpeaker(course: Course | null | undefined, line: Pick<NarrationLine, 'speaker'>): Speaker | null {
  const speakers = objectsIn(course?.speakers);
  if (line.speaker) return speakers.find((speaker) => speaker.id === line.speaker) ?? null;
  return speakers[0] ?? null;
}

export type NarrationLineStatus = 'ok' | 'missing' | 'stale' | 'untranslated';

// Why, as codes an editor words in its own language: not translated; no audio file, no sidecar (or
// an unreadable one); and out of date: the text, the audio replaced without its sidecar, a sidecar
// written for another line, the speaker's voice, the pronunciations, the delivery.
export type NarrationCause = 'untranslated' | 'no-audio' | 'no-sidecar' | 'text' | 'audio-replaced' | 'elsewhere' | 'voice' | 'pronunciation' | 'delivery';

export interface NarrationLineInfo {
  id: string;
  // Where it is said (the screen's narration, a layer's: D62), the translation unit of its text and
  // where it is written in the screen's file.
  track: VoiceTrack;
  unit: string;
  path: string;
  step: number;
  pauseBefore?: number;
  speaker: string | null;
  // The speaker's name in that language.
  speakerName: string | null;
  // The text in that language; null while it is not translated.
  text: string | null;
  textHash: FileHash | null;
  // What a generated voice is told to say (the text after the pronunciations) and its hash; the
  // settings it says it with (the voice's, the line's delivery over them) and their hash.
  spoken: string | null;
  spokenHash: FileHash | null;
  settings: Record<string, unknown>;
  settingsHash: FileHash;
  audio: string;
  sidecar: string;
  status: NarrationLineStatus;
  // Why the line is missing, out of date or untranslated, in words; and as codes.
  reasons: string[];
  causes: NarrationCause[];
  // Seconds of audio (the file's probe, else its sidecar); null without audio.
  duration: number | null;
  // The voice its speaker has in that language, what a generation would say it with (null: none);
  // provider and voice below are those of the audio there is.
  speakerVoice: { provider: string; voice: string } | null;
  // What the sidecar says made it.
  provider: string | null;
  voice: string | null;
  generated: boolean | null;
  words: NarrationAudio['words'] | null;
  // What timed its words (the sidecar's aligner); null: none, or not said.
  aligner: string | null;
  take: number | null;
  credit: string | null;
  model: string | null;
  // A sound line (D67): the sound it says, at what volume; its audio is the sound's file, its text
  // its caption (null: none), it has no speaker and no voice.
  sound?: { id: string; volume: number };
  // The mouth's envelope of its audio (the sidecar's: narration/mouth.ts); null: none measured yet.
  mouth: string | null;
}

// Reads a sidecar; error when it does not parse or does not follow the schema.
export function readNarrationSidecar(files: ProjectFiles, path: string): { sidecar: NarrationAudio | null; error: string | null } {
  const text = readText(files, path);
  if (text === null) return { sidecar: null, error: null };
  const parsed = parseJSON(text);
  if (parsed.error !== undefined) return { sidecar: null, error: parsed.error };
  const problem = sidecarProblem(parsed.value);
  return problem ? { sidecar: null, error: problem } : { sidecar: parsed.value as NarrationAudio, error: null };
}

// What the reader needs of a sidecar, checked by hand (the schema compiler needs eval, which the
// desktop app's pages refuse); the validator checks the whole schema.
function sidecarProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const record = value as Record<string, unknown>;
  for (const field of ['screen', 'line', 'language', 'textHash', 'provider', 'voice'] as const) if (typeof record[field] !== 'string') return `${field} must be a string`;
  if (typeof record.duration !== 'number' || !(record.duration > 0)) return 'duration must be a number of seconds';
  if (typeof record.generated !== 'boolean') return 'generated must be true or false';
  return null;
}

// The translations of a language, by unit id: the target of every unit translated from its current source.
function translatedTexts(project: Project, language: string): Map<string, { source: string; target: string | null }> {
  const entry = project.translations.get(language);
  if (!entry) return new Map();
  try { return readXliff(entry.xliff).units; } catch { return new Map(); }
}

// The voice lines of a screen in a language (default: the course's), every track counted (the
// screen's narration, then each layer's), each with its text in that language, its audio files and
// whether they are there and up to date. null when the screen has no voice line.
export function narrationLines(project: Project, screenId: string, language = project.course?.language ?? ''): NarrationLineInfo[] | null {
  const entries = screenVoiceLines(project, screenId);
  if (!entries.length) return null;
  const course = project.course;
  const source = !course || language === course.language;
  const units = source ? null : translatedTexts(project, language);
  const translated = (id: string, text: string): string | null => {
    if (source) return text;
    const unit = units?.get(id);
    return unit?.target && unit.source === text ? unit.target : null;
  };
  return entries.map(({ line, track, step, unit, path }) => {
    const speaker = lineSpeaker(course, line);
    const text = typeof line.text === 'string' ? translated(unit, line.text) : null;
    const audio = narrationAudioPath(language, screenId, line.id);
    const sidecarPath = narrationSidecarPath(language, screenId, line.id);
    const audioFile = getFile(project.files, audio);
    const { sidecar, error } = readNarrationSidecar(project.files, sidecarPath);
    const reasons: string[] = [];
    const causes: NarrationCause[] = [];
    const because = (cause: NarrationCause, reason: string) => { causes.push(cause); reasons.push(reason); };
    let status: NarrationLineStatus = 'ok';
    const textHash = text === null ? null : narrationTextHash(text);
    const spoken = text === null ? null : spokenTextOf(course, line, text, language);
    const spokenHash = spoken === null ? null : narrationTextHash(spoken);
    const delivery = deliveryOf(course, line, language);
    if (text === null) { status = 'untranslated'; because('untranslated', `not translated into ${language} yet`); }
    if (!audioFile || audioFile.kind !== 'binary') { status = status === 'ok' ? 'missing' : status; because('no-audio', `no audio file ${audio}`); }
    if (!sidecar) { status = status === 'ok' ? 'missing' : status; because('no-sidecar', error ? `${sidecarPath} unreadable: ${error}` : `no sidecar ${sidecarPath}`); }
    if (status === 'ok' && sidecar) {
      if (textHash && sidecar.textHash !== textHash) because('text', 'the text changed since the audio was made');
      const hash = fileHash(project.files, audio);
      if (sidecar.audioHash && hash && sidecar.audioHash !== hash) because('audio-replaced', 'the audio file was replaced without its sidecar');
      if (sidecar.screen !== screenId || sidecar.line !== line.id || sidecar.language !== language) because('elsewhere', `the sidecar was written for ${sidecar.language}/${sidecar.screen}/${sidecar.line}`);
      const voice = speaker?.voices?.[language];
      if (sidecar.generated && voice && (voice.provider !== sidecar.provider || voice.voice !== sidecar.voice)) because('voice', `made with ${sidecar.provider} ${sidecar.voice}, the speaker's voice is now ${voice.provider} ${voice.voice}`);
      if (sidecar.generated && sidecar.spokenHash && spokenHash && sidecar.spokenHash !== spokenHash && sidecar.textHash === textHash) because('pronunciation', 'the pronunciation of its words changed (pronunciations of the line or of the course)');
      if (sidecar.generated && sidecar.settingsHash && sidecar.settingsHash !== delivery.hash) because('delivery', 'its delivery changed (the settings of the speaker\'s voice or the line\'s delivery)');
      if (reasons.length) status = 'stale';
    }
    const probed = audioFile?.kind === 'binary' ? audioFile.media?.duration ?? null : null;
    const name = speaker ? (source ? speaker.name : translated(`course.speaker.${speaker.id}.name`, speaker.name) ?? speaker.name) : null;
    return {
      id: line.id, track, unit, path, step, ...(typeof line.pauseBefore === 'number' ? { pauseBefore: line.pauseBefore } : {}),
      speaker: speaker?.id ?? null, speakerName: name, text, textHash, spoken, spokenHash, settings: delivery.settings, settingsHash: delivery.hash, audio, sidecar: sidecarPath, status, reasons, causes,
      duration: audioFile?.kind === 'binary' ? probed ?? sidecar?.duration ?? null : null,
      speakerVoice: speakerVoiceOf(speaker?.voices?.[language]),
      provider: sidecar?.provider ?? null, voice: sidecar?.voice ?? null, generated: sidecar?.generated ?? null, words: Array.isArray(sidecar?.words) ? sidecar.words : null, aligner: sidecar?.aligner ?? null,
      take: sidecar?.take ?? null, credit: sidecar?.credit ?? null, model: sidecar?.model ?? null,
      mouth: typeof sidecar?.mouth === 'string' && isMouth(sidecar.mouth) ? sidecar.mouth : null
    };
  });
}

const speakerVoiceOf = (voice: { provider?: unknown; voice?: unknown } | null | undefined): NarrationLineInfo['speakerVoice'] =>
  voice && typeof voice.provider === 'string' && typeof voice.voice === 'string' ? { provider: voice.provider, voice: voice.voice } : null;

// The lines laid on one timeline of a screen (layer null: the screen's), in the order they are
// written: its voice lines (narrationLines) and its sound lines (D67), whose audio is their sound's
// file and text their caption in that language.
export function timelineLines(project: Project, screenId: string, language = project.course?.language ?? '', layer: string | null = null): NarrationLineInfo[] {
  const screen = project.screens.get(screenId)?.data;
  if (!screen) return [];
  const voices = new Map((narrationLines(project, screenId, language) ?? []).filter((info) => timelineOf(info.track)?.layer === layer).map((info) => [info.id, info]));
  const sounds = soundLinesOf(screen, screenId).filter((entry) => (entry.track.kind === 'layer' ? entry.track.layer : null) === layer);
  if (!sounds.length) return [...voices.values()];
  const assets = soundAssets(project);
  const units = !project.course || language === project.course.language ? null : translatedTexts(project, language);
  const soundInfos = new Map(sounds.map(({ line, track, step, unit, path }): [string, NarrationLineInfo] => {
    const asset = assets.get(line.sound);
    const file = asset ? getFile(project.files, asset.path) : undefined;
    const caption = typeof line.caption === 'string' ? (units?.get(unit)?.source === line.caption ? units.get(unit)?.target ?? line.caption : line.caption) : null;
    const missing = !file || file.kind !== 'binary';
    return [line.id, {
      id: line.id, track, unit, path, step, ...(typeof line.pauseBefore === 'number' ? { pauseBefore: line.pauseBefore } : {}),
      speaker: null, speakerName: null, text: caption, textHash: null, spoken: null, spokenHash: null, settings: {}, settingsHash: 'sha256:' as FileHash,
      audio: asset?.path ?? `assets/sounds/${line.sound}`, sidecar: asset?.sidecar ?? `assets/sounds/${line.sound}.json`,
      status: missing ? 'missing' : 'ok', reasons: missing ? [`no sound "${line.sound}" in assets/sounds/`] : [], causes: missing ? ['no-audio'] : [],
      duration: file?.kind === 'binary' ? file.media?.duration ?? null : null, speakerVoice: null, provider: null, voice: null, generated: false, words: null, aligner: null, take: null, credit: null, model: null, mouth: null,
      sound: { id: line.sound, volume: typeof line.volume === 'number' ? line.volume : 1 }
    }];
  }));
  const holder = layer === null ? screen.narration : objectsIn(screen.layers).find((candidate) => candidate.id === layer)?.narration;
  return objectsIn(holder?.lines).map((line) => voices.get(line.id) ?? soundInfos.get(line.id)).filter((info): info is NarrationLineInfo => !!info);
}

// What a generated voice is told to say for a line in a language (default: the course's), and its
// hash: what the voice tools give the voice. null for a line without text in that language.
export function spokenText(project: Project, screenId: string, lineId: string, language?: string): { text: string; spoken: string; hash: FileHash; settings: Record<string, unknown>; settingsHash: FileHash } | null {
  const line = narrationLines(project, screenId, language)?.find((candidate) => candidate.id === lineId);
  if (!line || line.text === null || line.spoken === null || line.spokenHash === null) return null;
  return { text: line.text, spoken: line.spoken, hash: line.spokenHash, settings: line.settings, settingsHash: line.settingsHash };
}

// The timeline of a narrated screen in a language from what the project holds: the lines' durations
// from their audio (estimates without), their words' times, the screen's steps and the moments
// anchored to them (narration/timeline.ts). durations: measured by the build, by line id; gaps: the
// silences it wrote. null when the screen is not narrated (screenTimeline also lays out screens
// timed in seconds).
export type ScreenTimedLine = TimelineLine & { info: NarrationLineInfo };
export type ScreenTiming = Omit<TimelineLayout, 'lines'> & { lines: ScreenTimedLine[] };

// layer: the timeline of that layer of the screen (D62).
export function screenTiming(project: Project, screenId: string, { language, durations, gaps, layer }: { language?: string; durations?: ReadonlyMap<string, number>; gaps?: readonly number[]; layer?: string | null } = {}): ScreenTiming | null {
  const timeline = screenTimeline(project, screenId, { language, durations, gaps, layer });
  if (!timeline?.narrated) return null;
  const { infos, screen: _screen, language: _language, narrated: _narrated, layer: _layer, ...layout } = timeline;
  return { ...layout, lines: timeline.lines.map((line) => ({ ...line, info: infos.get(line.id)! })) };
}
