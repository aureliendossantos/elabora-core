// What the parts of a dialogue's view share (D61). view.ts makes them for each dialogue block and hands
// them to its parts: the thread's box (box.ts), the scene's backdrop and characters (cast.ts), the
// lines and their ink (lines.ts), the room under the thread (room.ts), the run and its saved progress
// (moves.ts). Not part of the pure walk: the core never imports this file.

import type { DialogueBlock } from '../course-data.ts';
import type { Labels } from '../labels.ts';
import type { CharacterView } from '../character/index.ts';
import type { Beat, DialoguePresentation } from './walk.ts';
import type { DialogueRun } from './run.ts';
import type { DialogueAction, DialogueData, DialogueLineData, LineVoiceData } from './types.ts';
import type { DialogueClock, LinePlayback } from './playback.ts';
import type { BubbleRow, ThreadContext } from './thread.ts';

// What the screen gives the dialogues of its blocks (screen-view.ts).
export interface DialogueHost {
  // Tests: the dialogues' clocks move only when told (__elabora.dialogues.advance).
  virtual: boolean;
  // The learner's speed, volume and « couper les voix », shared with the narration's bar.
  prefs(): { rate: number; volume: number; muted: boolean };
  // Two voices never overlap: while a dialogue speaks, the screen's narration is held.
  hold(reason: string): void;
  release(reason: string): void;
  // Presentation actions of options and cues (show and hide blocks and layers, media, object props,
  // a step), and what a replayed path leaves on the screen (no layer opens, no media plays).
  act(actions: readonly DialogueAction[]): void;
  present(presentation: DialoguePresentation): void;
  slides(): boolean;
  // « Texte : tout de suite » (« Affichage », D58).
  instantText(): boolean;
}

export type Phase = 'idle' | 'playing' | 'choosing' | 'ended';

// What the learner perceives of a dialogue, for what reacts to it (the interface's sounds): an
// `elabora:dialogue` CustomEvent on the dialogue (data-t-group), bubbling, its detail
// { block, moment, … }. Only when the dialogue plays (never back on a screen, nor in the canvas).
//   choose          the learner chose an option ({ node, option, quality })
//   feedback        a trainer's note shows while it plays ({ quality }: good, ok, bad, or null)
//   back            the learner went back ({ kind }: retry « Choisir autrement », revisit
//                   « Changer ce choix » or « Reprendre d'ici », restart « Recommencer »)
//   end             the dialogue reached an end ({ ending, well }: well, a score of half or more,
//                   or nothing to score)
//   history-open, history-close, debrief-open, debrief-close
//                   a panel over the dialogue opened, or the learner closed it (a move back closes
//                   the debrief without its own moment: back says it)
export type DialogueMoment = 'choose' | 'feedback' | 'back' | 'end' | 'history-open' | 'history-close' | 'debrief-open' | 'debrief-close';

// The line being said: its row, its voice, the cues still to come.
export interface LineState {
  index: number;
  chars: number;
  line: DialogueLineData | null;
  speaker: string | undefined;
  row: BubbleRow;
  voice: LineVoiceData;
  // Said by a voice (its audio): its words come in ink; else the line is whole at once.
  voiced: boolean;
  playback: LinePlayback;
  paint: { said: number };
  cues: { time: number; gesture?: string; expression?: string; do?: DialogueAction[]; fired: boolean }[];
  avatar: CharacterView | null;
}

// The bubble to come, waiting in the thread with « … », and the beat it announces.
export type Typing = { index: number; node: HTMLElement } | null;

// What the dialogue waits for before its next beat.
export type Step =
  | { kind: 'line'; state: LineState }
  | { kind: 'wait'; until: number; typing: Typing }
  | { kind: 'click'; typing: Typing }
  | { kind: 'turn'; until: number; then: () => Step | null };

// The block, its parts in the page and the screen around it: set once.
export interface ViewParts {
  block: DialogueBlock;
  data: DialogueData;
  wrap: HTMLElement;
  // The dialogue (data-t-group), its thread (data-t-log), the room under it (data-t-options), the
  // scene's stage and the debrief's place when the template gives them.
  root: HTMLElement;
  log: HTMLElement;
  room: HTMLElement;
  stage: HTMLElement | null;
  debriefHost: HTMLElement | null;
  // Hidden copies of the thread and of the room, at their width: what fits, how tall the room must be.
  measureLog: HTMLElement;
  measureRoom: HTMLElement;
  thread: ThreadContext;
  labels: Labels;
  language: string;
  learnerSpeaker: string | undefined;
  // A line of the dialogue has a voice (its audio).
  voiced: boolean;
  // The editor's canvas: the path shown at once, playable, without voices.
  still: boolean;
  clock: DialogueClock;
  host(): DialogueHost;
  reduced(): boolean;
  // Lines shown whole at once (the canvas, reduced motion, « Texte : tout de suite », reveal instant).
  instant(): boolean;
  revealMode(): 'ink' | 'appear' | 'instant';
  rate(): number;
  signal(moment: DialogueMoment, detail?: Record<string, unknown>): void;
}

// Where the dialogue is: the run shown, its beats, how many are in the thread, what it waits for.
export interface ViewState {
  run: DialogueRun;
  beats: Beat[];
  presented: number;
  phase: Phase;
  step: Step | null;
  // The learner paused the dialogue.
  paused: boolean;
  disposed: boolean;
  // The choice the learner took back, marked among the options while its decision waits again.
  previous: { node: string; option: string } | null;
}

export const clamp = (low: number, value: number, high: number) => Math.min(high, Math.max(low, value));
export const PHONE = '(max-width: 760px)';
export const prefersLessMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const phone = () => typeof matchMedia === 'function' && matchMedia(PHONE).matches;
// Boxes in the CSS px of the page under the learner's text size (a CSS zoom on #t-main).
export const cssPx = (node: Element, px: number) => px / ((node as HTMLElement & { currentCSSZoom?: number }).currentCSSZoom || 1);
