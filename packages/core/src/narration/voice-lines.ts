// Every line a voice says on a screen, whatever holds it (docs/decisions.md D24, D62): the screen's
// narration, each layer's narration, and later the lines of its dialogues. Each comes with its track
// (whose timeline or block says it), the translation unit of its text and where it is written. The
// audio of a line keeps its path whatever its track (assets/narration/<language>/<screen>/<line>.m4a):
// line ids are unique in the screen, every track counted (E_NARRATION_LINE_DUPLICATE).
//
// Everything that touches voices reads lines through here: their audio's state (narrationLines), the
// voice tools, alignment, recordings and transcription, translation units and anchors, the timeline
// report and the engine's dock data. A new kind of line is one more source in VOICE_LINE_SOURCES.

import type { Screen, VoiceLine } from '@elabora/format';
import type { Project } from '../project/model.ts';
import { objectsIn, isRecord } from '../util/values.ts';

// Where a line is said: the screen's timeline, a layer's timeline, or a dialogue block (a node's line,
// or an option the learner's voice says).
export type VoiceTrack =
  | { kind: 'screen' }
  | { kind: 'layer'; layer: string }
  | { kind: 'dialogue'; block: string; node: string; option?: string };

// A voice line as written, with the fields of the track that holds it (step, pauseBefore).
export type WrittenVoiceLine = VoiceLine & { step?: number; pauseBefore?: number };

export interface VoiceLineEntry {
  line: WrittenVoiceLine;
  track: VoiceTrack;
  // The step of the screen it is said in: its own on the screen's narration; 1 elsewhere (a layer's
  // timeline has one stretch; a dialogue says its lines when the learner gets there).
  step: number;
  // The translation unit of its text (XLIFF id). blockUnit: the unit is one of its block's props,
  // which the block's translation lists already (a dialogue's lines): not listed again for it.
  unit: string;
  blockUnit?: true;
  // Where it is written in the screen's file (a JSON pointer).
  path: string;
}

// A source of voice lines: the lines one kind of holder gives a screen, in reading order.
export type VoiceLineSource = (screen: Screen, context: { project: Project | null; screenId: string }) => VoiceLineEntry[];

const isLine = (value: unknown): value is WrittenVoiceLine => isRecord(value) && typeof value.id === 'string';

// The screen's narration (narration.lines).
export const screenNarrationSource: VoiceLineSource = (screen, { screenId }) => {
  const lines = isRecord(screen.narration) && Array.isArray(screen.narration.lines) ? screen.narration.lines : [];
  const out: VoiceLineEntry[] = [];
  lines.forEach((line, index) => {
    if (!isLine(line)) return;
    out.push({ line, track: { kind: 'screen' }, step: typeof line.step === 'number' ? line.step : 1, unit: `screen.${screenId}.narration.${line.id}.text`, path: `/narration/lines/${index}` });
  });
  return out;
};

// Each layer's narration (layers[].narration.lines, D62).
export const layerNarrationSource: VoiceLineSource = (screen, { screenId }) => {
  const out: VoiceLineEntry[] = [];
  (Array.isArray(screen.layers) ? screen.layers : []).forEach((layer, layerIndex) => {
    if (!isRecord(layer) || typeof layer.id !== 'string' || !isRecord(layer.narration) || !Array.isArray(layer.narration.lines)) return;
    layer.narration.lines.forEach((line, index) => {
      if (!isLine(line)) return;
      out.push({ line, track: { kind: 'layer', layer: layer.id }, step: 1, unit: `screen.${screenId}.layer.${layer.id}.narration.${line.id}.text`, path: `/layers/${layerIndex}/narration/lines/${index}` });
    });
  });
  return out;
};

// The sources, in the order a screen's lines are listed (the screen's, then each layer's). The one
// place a new source of lines is added: the lines of dialogue blocks come here, with their track
// { kind: 'dialogue', block, node, option? } and their units (block.<id>.nodes.<node>.lines.<line>.text,
// block.<id>.nodes.<node>.options.<option>.text).
export const VOICE_LINE_SOURCES: readonly VoiceLineSource[] = [screenNarrationSource, layerNarrationSource];

// The voice lines of a screen's data (also a screen file that breaks its schema: what is not a line is
// left out). project: for sources that read the course (a dialogue's components); null in pure checks.
export function voiceLinesOf(screen: Screen | null | undefined, screenId: string, project: Project | null = null): VoiceLineEntry[] {
  if (!isRecord(screen)) return [];
  return VOICE_LINE_SOURCES.flatMap((source) => source(screen, { project, screenId }));
}

// The voice lines of a screen of the project, every track counted.
export function screenVoiceLines(project: Project, screenId: string): VoiceLineEntry[] {
  return voiceLinesOf(project.screens.get(screenId)?.data, screenId, project);
}

// A track as a key (maps, comparisons): screen, layer:<id>, dialogue:<block>:<node>[:<option>].
export function trackKey(track: VoiceTrack): string {
  if (track.kind === 'screen') return 'screen';
  if (track.kind === 'layer') return `layer:${track.layer}`;
  return `dialogue:${track.block}:${track.node}${track.option ? `:${track.option}` : ''}`;
}

// The timeline a track's lines are laid on: the screen's, a layer's, or none (a dialogue says its
// lines as the learner moves through it).
export function timelineOf(track: VoiceTrack): { layer: string | null } | null {
  if (track.kind === 'screen') return { layer: null };
  if (track.kind === 'layer') return { layer: track.layer };
  return null;
}

// Whether a line is laid on the timeline of the screen (layer null) or of a layer.
export const onTimeline = (track: VoiceTrack, layer: string | null): boolean => {
  const timeline = timelineOf(track);
  return !!timeline && timeline.layer === layer;
};

// A track in words, for messages: the screen's narration, layer "x"'s narration, dialogue "b".
export function trackLabel(track: VoiceTrack): string {
  if (track.kind === 'screen') return 'the screen\'s narration';
  if (track.kind === 'layer') return `the narration of layer "${track.layer}"`;
  return `dialogue "${track.block}" (node "${track.node}"${track.option ? `, option "${track.option}"` : ''})`;
}

// The lines laid on one timeline of a screen: its own (layer null) or a layer's, in order.
export function timelineVoiceLines(project: Project, screenId: string, layer: string | null): VoiceLineEntry[] {
  return screenVoiceLines(project, screenId).filter((entry) => onTimeline(entry.track, layer));
}

// The layers of a screen whose narration has lines.
export function narratedLayers(screen: Screen | null | undefined): string[] {
  return objectsIn(screen?.layers).filter((layer) => objectsIn(layer.narration?.lines).length > 0).map((layer) => layer.id);
}
