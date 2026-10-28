// A dialogue block's props as the walk reads them (D61): the mode's defaults resolved, every list
// read defensively (a block being written may not follow its schema yet), its speakers, its keys in
// elabora.lock.json and the highest sum of points its paths can reach. The compiler adds the HTML of
// its Markdown; the core's tools keep the stage directions to print the script.

import type { DialogueData, DialogueKeys, DialogueLineData, DialogueLineItem, DialogueNodeData, DialogueOptionData, DialogueEndingData, DialogueCondition, DialogueCueData, DialogueAction, DialogueSceneData, DialogueSpeakerData, DialogueValue, DialogueRevisit, DialogueScoring, DialogueFeedback, DialogueMode, LineVoiceData, CharacterManifest } from '@elabora/player/dialogue/types';
import { explorePaths, maxPointsOf } from '@elabora/player/dialogue/paths';
import type { DialogueEnv } from '@elabora/player/dialogue/walk';
import { withoutDirections } from '../narration/directions.ts';
import { narrationWords, findPhrase } from '../narration/words.ts';
import { isRecord, recordOf, recordsOf, textOf, optionalTextOf } from '../compile/values.ts';
import { objectsIn } from '../util/values.ts';
import type { Course } from '../project/model.ts';

// What each mode sets (D61 §4.6); a block's own revisit, feedback and scoring win.
export const MODE_DEFAULTS: Readonly<Record<DialogueMode, { revisit: DialogueRevisit; feedback: DialogueFeedback; scoring: DialogueScoring }>> = {
  practice: { revisit: 'after-end', feedback: 'both', scoring: 'none' },
  assessment: { revisit: 'none', feedback: 'debrief', scoring: 'quality' },
  exploration: { revisit: 'anytime', feedback: 'now', scoring: 'none' }
};

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback);
const isValue = (value: unknown): value is DialogueValue => typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string';

export interface DialogueDataOptions {
  course?: Course | null;
  keys?: DialogueKeys;
  // Package path of an asset (the compiler's); the core's tools keep the course's paths.
  assetPath?: (name: string) => string;
  // Stage directions kept in the lines' text (the script) or left out (what learners read).
  directions?: 'keep' | 'strip';
  // The HTML of a Markdown text (the compiler's renderer).
  markdown?: (text: string) => string;
  env?: DialogueEnv;
  // The voice of each line (the compiler's: its audio in the package, or the estimate), and of each
  // option the learner's voice says (learnerVoice; id "<node>.<option>"). text: as written, stage
  // directions kept. The core's tools leave it out.
  voice?: (line: { id: string; text: string; speaker?: string }) => LineVoiceData | undefined;
  // The length in seconds of a sound of the course (the compiler's), for a sound line (D67).
  soundLength?: (sound: string) => number | null;
  // The SVG of a speaker's look, sanitized for the page (the compiler's), with what its root declares.
  look?: (speaker: string, svg: string) => { inline: string; manifest: CharacterManifest } | null;
}

export const emptyKeys = (): DialogueKeys => ({ choices: {}, bits: {}, endings: {} });

export function dialogueData(props: Record<string, unknown>, { course, keys = emptyKeys(), assetPath = (name) => `assets/${name}`, directions = 'keep', markdown, env, voice, soundLength, look }: DialogueDataOptions = {}): DialogueData {
  const mode = oneOf(props.mode, ['practice', 'assessment', 'exploration'] as const, 'practice');
  const defaults = MODE_DEFAULTS[mode];
  const text = (value: unknown) => (directions === 'strip' ? withoutDirections(textOf(value)) : textOf(value));
  const conditions = (value: unknown): DialogueCondition[] | undefined => (Array.isArray(value) ? value.filter(isRecord) as unknown as DialogueCondition[] : undefined);
  const actions = (value: unknown): DialogueAction[] | undefined => (Array.isArray(value) ? recordsOf(value).filter((action) => typeof action.type === 'string') as unknown as DialogueAction[] : undefined);
  const scene = (value: unknown): DialogueSceneData | undefined => {
    if (!isRecord(value)) return undefined;
    const background = optionalTextOf(value.background);
    const cast = recordsOf(value.cast).filter((member) => typeof member.speaker === 'string').map((member) => ({ speaker: textOf(member.speaker), position: oneOf(member.position, ['left', 'right', 'center'] as const, 'left') }));
    return { ...(background ? { background: assetPath(background) } : {}), ...(cast.length ? { cast } : {}) };
  };
  const line = (value: Record<string, unknown>): DialogueLineItem => {
    if (typeof value.sound === 'string') {
      const length = soundLength?.(value.sound);
      return {
        id: textOf(value.id), sound: value.sound, ...(typeof value.caption === 'string' ? { caption: value.caption } : {}),
        ...(typeof value.volume === 'number' ? { volume: value.volume } : {}), ...(conditions(value.if) ? { if: conditions(value.if) } : {}),
        ...(typeof length === 'number' ? { duration: length } : {})
      };
    }
    const cues = recordsOf(value.cues).filter((cue) => isRecord(cue.at)).map((cue): DialogueCueData => ({
      at: cue.at as DialogueCueData['at'],
      ...(typeof cue.gesture === 'string' ? { gesture: cue.gesture } : {}),
      ...(typeof cue.expression === 'string' ? { expression: cue.expression } : {}),
      ...(actions(cue.do) ? { do: actions(cue.do) } : {})
    }));
    const id = textOf(value.id);
    const said = voice?.({ id, text: textOf(value.text), ...(typeof value.speaker === 'string' ? { speaker: value.speaker } : {}) });
    if (said) for (const cue of cues) cue.time = cueTime(cue.at, textOf(value.text), said, course?.language);
    return {
      id, ...(typeof value.speaker === 'string' ? { speaker: value.speaker } : {}), text: text(value.text),
      ...(typeof value.expression === 'string' ? { expression: value.expression } : {}),
      ...(cues.length ? { cues } : {}), ...(conditions(value.if) ? { if: conditions(value.if) } : {}),
      ...(said ? { voice: said } : {})
    };
  };
  const end = (value: unknown): true | string | undefined => (value === true ? true : typeof value === 'string' ? value : undefined);
  const learnerVoice = props.learnerVoice === true && typeof props.learner === 'string';
  const option = (value: Record<string, unknown>, node: string): DialogueOptionData => {
    const feedback = optionalTextOf(value.feedback);
    // The learner's own line, said by their voice: its stage directions are for the voice alone.
    const said = learnerVoice && typeof value.text === 'string' && value.fallback !== true ? voice?.({ id: `${node}.${textOf(value.id)}`, text: value.text, speaker: props.learner as string }) : undefined;
    const numbers = (record: unknown) => Object.fromEntries(Object.entries(recordOf(record)).filter(([, entry]) => typeof entry === 'number')) as Record<string, number>;
    const values = (record: unknown) => Object.fromEntries(Object.entries(recordOf(record)).filter(([, entry]) => isValue(entry))) as Record<string, DialogueValue>;
    return {
      id: textOf(value.id),
      ...(typeof value.text === 'string' ? { text: learnerVoice ? text(value.text) : value.text } : {}),
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
      ...(value.quality === 'good' || value.quality === 'ok' || value.quality === 'bad' ? { quality: value.quality } : {}),
      ...(typeof value.objective === 'string' ? { objective: value.objective } : {}),
      reply: recordsOf(value.reply).map(line),
      ...(feedback ? { feedback, ...(markdown ? { feedbackHtml: markdown(feedback) } : {}) } : {}),
      points: typeof value.points === 'number' ? value.points : 0,
      ...(isRecord(value.set) ? { set: values(value.set) } : {}),
      ...(isRecord(value.add) ? { add: numbers(value.add) } : {}),
      ...(actions(value.do) ? { do: actions(value.do) } : {}),
      ...(typeof value.next === 'string' ? { next: value.next } : {}),
      ...(end(value.end) !== undefined ? { end: end(value.end) } : {}),
      ...(value.retry === true ? { retry: true } : {}),
      ...(value.once === true ? { once: true } : {}),
      ...(value.fallback === true ? { fallback: true } : {}),
      ...(conditions(value.if) ? { if: conditions(value.if) } : {}),
      unavailable: value.unavailable === 'disable' ? 'disable' : 'hide',
      ...(typeof value.unavailableText === 'string' ? { unavailableText: value.unavailableText } : {}),
      ...(said ? { voice: said } : {})
    };
  };
  const node = (value: Record<string, unknown>): DialogueNodeData => {
    const next = typeof value.next === 'string' ? value.next : Array.isArray(value.next) ? recordsOf(value.next).filter((entry) => typeof entry.go === 'string').map((entry) => ({ go: textOf(entry.go), ...(conditions(entry.if) ? { if: conditions(entry.if) } : {}) })) : undefined;
    return {
      id: textOf(value.id), ...(typeof value.title === 'string' ? { title: value.title } : {}), ...(typeof value.objective === 'string' ? { objective: value.objective } : {}),
      ...(value.final === true ? { final: true } : {}), ...(scene(value.scene) ? { scene: scene(value.scene) } : {}),
      lines: recordsOf(value.lines).map(line), ...(typeof value.prompt === 'string' ? { prompt: value.prompt } : {}),
      options: recordsOf(value.options).map((entry) => option(entry, textOf(value.id))),
      ...(next !== undefined ? { next } : {}), ...(end(value.end) !== undefined ? { end: end(value.end) } : {})
    };
  };
  const ending = (value: Record<string, unknown>): DialogueEndingData => {
    const body = optionalTextOf(value.text);
    return {
      id: textOf(value.id), ...(typeof value.title === 'string' ? { title: value.title } : {}),
      ...(body ? { text: body, ...(markdown ? { textHtml: markdown(body) } : {}) } : {}),
      ...(conditions(value.if) ? { if: conditions(value.if) } : {}), ...(typeof value.score === 'number' ? { score: value.score } : {})
    };
  };
  const nodes = recordsOf(props.nodes).map(node);
  const learner = optionalTextOf(props.learner) ?? null;
  const data: DialogueData = {
    title: textOf(props.title), learner, learnerVoice: props.learnerVoice === true,
    style: oneOf(props.style, ['messaging', 'scene'] as const, 'messaging'), ...(scene(props.scene) ? { scene: scene(props.scene) } : {}),
    mode, revisit: oneOf(props.revisit, ['none', 'retry', 'after-end', 'anytime'] as const, defaults.revisit),
    scoring: oneOf(props.scoring, ['none', 'quality', 'points', 'ending'] as const, defaults.scoring),
    feedback: oneOf(props.feedback, ['now', 'debrief', 'both'] as const, defaults.feedback), debrief: props.debrief !== false,
    pace: oneOf(props.pace, ['auto', 'click'] as const, 'auto'), reveal: oneOf(props.reveal, ['ink', 'appear', 'instant'] as const, 'ink'),
    begins: oneOf(props.begins, ['auto', 'click', 'event'] as const, 'auto'),
    ...(typeof props.objective === 'string' ? { objective: props.objective } : {}),
    weight: typeof props.weight === 'number' && props.weight > 0 ? props.weight : 1,
    start: typeof props.start === 'string' ? props.start : nodes[0]?.id ?? '',
    vars: recordsOf(props.vars).filter((variable) => typeof variable.id === 'string' && isValue(variable.default)).map((variable) => ({ id: textOf(variable.id), default: variable.default as DialogueValue })),
    nodes, endings: recordsOf(props.endings).map(ending),
    speakers: {}, keys, maxPoints: null
  };
  data.speakers = speakersOf(data, course, assetPath, look);
  data.maxPoints = maxPointsOf(data, explorePaths(data, { env }));
  return data;
}

// The speakers a dialogue names (its learner, its lines, its cast), with their name, colour and look.
function speakersOf(data: DialogueData, course: Course | null | undefined, assetPath: (name: string) => string, look?: DialogueDataOptions['look']): Record<string, DialogueSpeakerData> {
  const named = new Set<string>();
  if (data.learner) named.add(data.learner);
  const lines = (list: readonly DialogueLineItem[]) => { for (const line of list) if (line.speaker) named.add(line.speaker); };
  for (const node of data.nodes) {
    lines(node.lines);
    for (const option of node.options) lines(option.reply);
    for (const member of node.scene?.cast ?? []) named.add(member.speaker);
  }
  for (const member of data.scene?.cast ?? []) named.add(member.speaker);
  const out: Record<string, DialogueSpeakerData> = {};
  for (const speaker of objectsIn(course?.speakers)) {
    if (!named.has(speaker.id)) continue;
    out[speaker.id] = speakerData(speaker, assetPath, look);
  }
  return Object.fromEntries(Object.keys(out).sort().map((id) => [id, out[id]]));
}

// What the player shows of a speaker of course.json (a dialogue's character, a speech block's, D63):
// its name, colour and look, its pictures as package paths and its SVG sanitized for the page.
export function speakerData(speaker: NonNullable<Course['speakers']>[number], assetPath: (name: string) => string, look?: DialogueDataOptions['look']): DialogueSpeakerData {
  const own = isRecord(speaker.look) ? speaker.look : null;
  const expressions = own && isRecord(own.expressions) ? Object.fromEntries(Object.entries(own.expressions).filter(([, file]) => typeof file === 'string').map(([name, file]) => [name, assetPath(file as string)])) : null;
  const drawn = own && typeof own.svg === 'string' ? look?.(speaker.id, own.svg) ?? null : null;
  return {
    name: speaker.name,
    ...(speaker.narrator === true ? { narrator: true } : {}),
    ...(typeof speaker.color === 'string' ? { color: speaker.color } : {}),
    ...(own ? { look: { ...(typeof own.svg === 'string' ? { svg: assetPath(own.svg) } : {}), ...(typeof own.portrait === 'string' ? { portrait: assetPath(own.portrait) } : {}), ...(expressions && Object.keys(expressions).length ? { expressions } : {}), ...(drawn ? drawn : {}) } } : {})
  };
}

// When a cue falls in its line, in seconds from the line's start, as the timeline resolves an anchor
// (narration/timeline.ts): the start of its words, or their end (edge end), shifted by offset; a
// word the line does not say falls back to the line's start or end (E_DIALOGUE_CUE says so).
export function cueTime(at: DialogueCueData['at'], text: string, voice: LineVoiceData, language?: string): number {
  const offset = typeof at.offset === 'number' ? at.offset : 0;
  const end = at.edge === 'end';
  const clamp = (time: number) => Math.round(Math.max(0, Math.min(voice.duration, time)) * 1000) / 1000;
  const found = typeof at.word === 'string' ? findPhrase(narrationWords(text, language), at.word, { occurrence: at.occurrence ?? 1, language }) : null;
  const first = found ? voice.words[found.index] : undefined;
  const last = found ? voice.words[found.index + found.count - 1] : undefined;
  if (!first || !last) return clamp((end ? voice.duration : 0) + offset);
  return clamp((end ? last[2] : first[1]) + offset);
}
