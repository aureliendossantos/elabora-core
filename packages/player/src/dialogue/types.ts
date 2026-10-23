// A dialogue block's data as the walk reads it (D61): what the compiler writes into the course data
// (@elabora/core dialogue/data.ts), and what the core builds from a block's props for its own tools
// (play, paths, the debrief, validation). Types only, JSON: the player and the core read the same.

export type DialogueStyle = 'messaging' | 'scene';
export type DialogueMode = 'practice' | 'assessment' | 'exploration';
export type DialogueRevisit = 'none' | 'retry' | 'after-end' | 'anytime';
export type DialogueScoring = 'none' | 'quality' | 'points' | 'ending';
export type DialogueFeedback = 'now' | 'debrief' | 'both';
export type DialogueQuality = 'good' | 'ok' | 'bad';
export type DialogueValue = number | boolean | string;
export type CompareOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';

export interface DialogueData {
  title: string;
  // The speaker the learner plays (null: « Vous »).
  learner: string | null;
  learnerVoice: boolean;
  style: DialogueStyle;
  scene?: DialogueSceneData;
  mode: DialogueMode;
  // Resolved from the mode when the block leaves them out.
  revisit: DialogueRevisit;
  scoring: DialogueScoring;
  feedback: DialogueFeedback;
  debrief: boolean;
  pace: 'auto' | 'click';
  reveal: 'ink' | 'appear' | 'instant';
  begins: 'auto' | 'click' | 'event';
  objective?: string;
  weight: number;
  // The first node (the first of nodes when the block names none).
  start: string;
  vars: { id: string; default: DialogueValue }[];
  nodes: DialogueNodeData[];
  endings: DialogueEndingData[];
  // The speakers its lines name, with what the player shows of them.
  speakers: Record<string, DialogueSpeakerData>;
  // Learner state: the key of each option (by "node.option") in the saved path, and the place of
  // each option and ending in the bit fields of what was explored and found (elabora.lock.json).
  keys: DialogueKeys;
  // The highest sum of points a path can reach (scoring points), computed on the graph; null when
  // no path gives points.
  maxPoints: number | null;
}

export interface DialogueKeys {
  choices: Record<string, string>;
  bits: Record<string, number>;
  endings: Record<string, number>;
}

export interface DialogueSpeakerData {
  name: string;
  narrator?: boolean;
  // A theme colour token (color.accent).
  color?: string;
  // Package paths: an SVG that follows the characters' convention, or pictures. The compiler adds the
  // SVG itself, sanitized (D33) with the class t-character (inline), and what its root declares
  // (manifest): @elabora/player character/ mounts either.
  look?: { svg?: string; portrait?: string; expressions?: Record<string, string>; inline?: string; manifest?: CharacterManifest };
}

// What a character's SVG root declares (docs/dialogues.md, characters): data-expressions,
// data-default-expression, data-gestures (seconds) and data-portrait (the face's box, null without).
export interface CharacterManifest {
  expressions: string[];
  defaultExpression: string;
  gestures: Record<string, number>;
  portrait: [number, number, number, number] | null;
}

// A line's voice in the package (filled by the compiler for every line of a dialogue, and for the
// options when learnerVoice): its audio in the package's language, or the core's estimate.
export interface LineVoiceData {
  // The audio's path in the package (null: no audio in this language).
  src: string | null;
  // Seconds: the audio's, or the core's estimate.
  duration: number;
  // When each word is said, [text, start, end] in seconds from the start of the line (aligned, or estimated).
  words: [string, number, number][];
  // The mouth's envelope, one letter per 1/30 s: c (closed), s (small), o (open), w (wide). null:
  // follow the words (open during a word, closed in silences over 250 ms).
  mouth: string | null;
  // No audio, or words not timed by alignment.
  estimated: boolean;
}

export interface DialogueSceneData {
  background?: string;
  cast?: { speaker: string; position: 'left' | 'right' | 'center' }[];
}

export interface DialogueLineData {
  id: string;
  speaker?: string;
  // What is shown (the compiler leaves stage directions out; the core's script keeps them).
  text: string;
  expression?: string;
  cues?: DialogueCueData[];
  if?: DialogueCondition[];
  // Its voice (the course data; the core's own tools leave it out).
  voice?: LineVoiceData;
}

export interface DialogueCueData {
  at: { line?: string; word?: string; occurrence?: number; edge?: 'start' | 'end'; offset?: number };
  // When the cue falls in its line, in seconds from the line's start, resolved by the compiler as the
  // timeline's anchors are (a word the line does not say: the line's start, or its end with edge end).
  // In the course data, with the line's voice.
  time?: number;
  gesture?: string;
  expression?: string;
  do?: DialogueAction[];
}

// Presentation actions only (the validator refuses the others).
export interface DialogueAction {
  type: string;
  block?: string;
  layer?: string;
  step?: number;
  props?: Record<string, unknown>;
}

export interface DialogueNodeData {
  id: string;
  title?: string;
  objective?: string;
  final?: boolean;
  scene?: DialogueSceneData;
  lines: DialogueLineData[];
  prompt?: string;
  options: DialogueOptionData[];
  next?: string | DialogueCase[];
  end?: true | string;
}

export interface DialogueCase {
  if?: DialogueCondition[];
  go: string;
}

export interface DialogueOptionData {
  id: string;
  text?: string;
  label?: string;
  quality?: DialogueQuality;
  objective?: string;
  reply: DialogueLineData[];
  // Markdown as written; the course data adds its HTML.
  feedback?: string;
  feedbackHtml?: string;
  points: number;
  set?: Record<string, DialogueValue>;
  add?: Record<string, number>;
  do?: DialogueAction[];
  next?: string;
  end?: true | string;
  retry?: boolean;
  once?: boolean;
  fallback?: boolean;
  if?: DialogueCondition[];
  unavailable: 'hide' | 'disable';
  unavailableText?: string;
  // The learner's line said by the learner's voice (learnerVoice; the course data).
  voice?: LineVoiceData;
}

export interface DialogueEndingData {
  id: string;
  title?: string;
  text?: string;
  textHtml?: string;
  if?: DialogueCondition[];
  score?: number;
}

export type DialogueCondition =
  | { chosen: string }
  | { seen: string }
  | { var: string; op: CompareOp; value: DialogueValue }
  | { variable: string; op: CompareOp; value: DialogueValue }
  | { score: { op: CompareOp; value: number } };

// Conditions of the course's events on a dialogue's scored run (event.schema.json condition).
export type DialogueEventCondition =
  | { dialogue: string; ending: string }
  | { dialogue: string; chosen: string }
  | { dialogue: string; score: { op: CompareOp; value: number } }
  | { dialogue: string; done: boolean };
