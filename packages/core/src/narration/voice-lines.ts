// Every line a voice says on a screen, whatever holds it (docs/decisions.md D24, D62): the screen's
// narration, each layer's narration, and the lines of its dialogues (D61). Each comes with its track
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
import { screenBlocks } from '../project/load.ts';
import { getRegistry, rootOf } from '../components/registry.ts';

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

// The lines of each dialogue block (D61) a voice says, in the order of its nodes: a node's lines, then
// for each option the learner's own line when learnerVoice says it, then its reply. A line without a
// speaker is a narration without voice (no voice line); a narrator speaker says it. An option's line
// has no id of its own: it is "<node>.<option>" (a dot is never in an id, so it never collides with a
// line's id), and its speaker the dialogue's learner. Its unit is the block's prop (blockUnit), as the
// block's translation lists it: block.<id>.nodes.<node>.lines.<line>.text,
// block.<id>.nodes.<node>.options.<option>.text, block.<id>.nodes.<node>.options.<option>.reply.<line>.text.
export const dialogueLineSource: VoiceLineSource = (screen, { project }) => {
  const registry = project ? getRegistry(project) : null;
  const out: VoiceLineEntry[] = [];
  for (const { block, path } of screenBlocks(screen)) {
    if (typeof block.type !== 'string' || typeof block.id !== 'string' || (registry ? rootOf(registry, block.type) : block.type) !== 'dialogue' || !isRecord(block.props)) continue;
    const props = block.props;
    const learner = typeof props.learner === 'string' ? props.learner : null;
    const base = `block.${unitSegment(block.id)}.nodes`;
    const said = (value: unknown, index: number, at: string, unit: string, track: VoiceTrack) => {
      if (!isLine(value) || typeof value.speaker !== 'string') return;
      out.push({ line: value, track, step: 1, unit: `${unit}.${unitSegment(value.id ?? index)}.text`, blockUnit: true, path: `${at}/${index}` });
    };
    (Array.isArray(props.nodes) ? props.nodes : []).forEach((node, nodeIndex) => {
      if (!isRecord(node) || typeof node.id !== 'string') return;
      const at = `${path}/props/nodes/${nodeIndex}`;
      const unit = `${base}.${unitSegment(node.id)}`;
      (Array.isArray(node.lines) ? node.lines : []).forEach((line, index) => said(line, index, `${at}/lines`, `${unit}.lines`, { kind: 'dialogue', block: block.id, node: node.id as string }));
      (Array.isArray(node.options) ? node.options : []).forEach((option, optionIndex) => {
        if (!isRecord(option) || typeof option.id !== 'string') return;
        const track: VoiceTrack = { kind: 'dialogue', block: block.id, node: node.id as string, option: option.id };
        if (props.learnerVoice === true && learner && typeof option.text === 'string' && option.fallback !== true) {
          const line: WrittenVoiceLine = { id: optionLineId(node.id as string, option.id), speaker: learner, text: option.text, ...(isRecord(option.delivery) ? { delivery: option.delivery } : {}), ...(Array.isArray(option.pronunciations) ? { pronunciations: option.pronunciations } : {}) } as WrittenVoiceLine;
          out.push({ line, track, step: 1, unit: `${unit}.options.${unitSegment(option.id)}.text`, blockUnit: true, path: `${at}/options/${optionIndex}` });
        }
        (Array.isArray(option.reply) ? option.reply : []).forEach((line, index) => said(line, index, `${at}/options/${optionIndex}/reply`, `${unit}.options.${unitSegment(option.id as string)}.reply`, track));
      });
    });
  }
  return out;
};

// The voice line id of an option the learner's voice says (learnerVoice): "<node>.<option>".
export const optionLineId = (node: string, option: string): string => `${node}.${option}`;

// A segment of a translation unit's id, as the block's units name it (i18n/units.ts).
const unitSegment = (key: unknown): string => String(key).replace(/[^A-Za-z0-9_-]/g, '_');

// The sources, in the order a screen's lines are listed (the screen's, then each layer's, then each
// dialogue's). The one place a new source of lines is added.
export const VOICE_LINE_SOURCES: readonly VoiceLineSource[] = [screenNarrationSource, layerNarrationSource, dialogueLineSource];

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

// What lines are said together, for what is told once for all of them (missing audio) and for a
// voice's exchanges (a dialogue model says them in one go): a timeline's lines, or a dialogue's.
export function trackGroup(track: VoiceTrack): string {
  return track.kind === 'dialogue' ? `dialogue:${track.block}` : trackKey(track);
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
