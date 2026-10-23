// Dialogue blocks of a course (D61): finding one, its data for the core's tools, the time its lines
// and decisions take. What `elabora dialogue show | play | paths | export` and the debrief read.

import type { DialogueData, DialogueValue } from '@elabora/player/dialogue/types';
import type { Beat, DialogueEnv } from '@elabora/player/dialogue/walk';
import { iterateBlocks } from '../project/load.ts';
import { getRegistry, rootOf } from '../components/registry.ts';
import { recordOf } from '../compile/values.ts';
import { objectsIn } from '../util/values.ts';
import { narrationSidecarPath, readNarrationSidecar } from '../narration/narration.ts';
import { estimatedDuration } from '../narration/timing.ts';
import { withoutDirections } from '../narration/directions.ts';
import { dialogueData } from './data.ts';
import type { Project, Block } from '../project/model.ts';

export interface DialogueBlockRef {
  id: string;
  screen: string;
  file: string;
  path: string;
  layer: string | null;
  block: Block;
  props: Record<string, unknown>;
}

// Every dialogue block of the course (forks included), in course order.
export function dialogueBlocks(project: Project): DialogueBlockRef[] {
  const registry = getRegistry(project);
  const out: DialogueBlockRef[] = [];
  for (const { block, file, path, layer, screen } of iterateBlocks(project)) {
    if (rootOf(registry, block.type) !== 'dialogue') continue;
    const screenId = typeof screen?.id === 'string' ? screen.id : (file ?? '').replace(/^screens\/|\.json$/g, '');
    out.push({ id: block.id, screen: screenId, file: file ?? `screens/${screenId}.json`, path, layer: layer?.id ?? null, block, props: recordOf(block.props) });
  }
  return out;
}

export function findDialogue(project: Project, id: string): DialogueBlockRef | null {
  return dialogueBlocks(project).find((ref) => ref.id === id) ?? null;
}

// The course's variables at their default: what { variable } conditions read when the core walks.
export function courseEnv(project: Project): DialogueEnv {
  const values = new Map<string, DialogueValue>();
  for (const variable of objectsIn(project.course?.variables)) {
    if (typeof variable.id === 'string' && (typeof variable.default === 'number' || typeof variable.default === 'boolean' || typeof variable.default === 'string')) values.set(variable.id, variable.default);
  }
  return { variable: (id) => values.get(id) };
}

// A dialogue's data for the core's tools: the script's text as written (stage directions kept).
export function projectDialogue(project: Project, ref: DialogueBlockRef): DialogueData {
  return dialogueData(ref.props, { course: project.course, env: courseEnv(project), directions: 'keep' });
}

// Reading a note or the options of a decision: words a second, as for text that appears (D28).
const READING_CHARACTERS_PER_SECOND = 17;
const readingSeconds = (text: string): number => Math.max(1.5, withoutDirections(text).length / READING_CHARACTERS_PER_SECOND);
// Between two lines, and the moment a learner takes to choose once the options are read.
const LINE_GAP = 0.6;
const CHOOSING_SECONDS = 3;

export interface PathTime {
  seconds: number;
  // Some lines had no audio: their time comes from their text.
  estimated: boolean;
}

// How long a path takes: each line's audio when it has one (assets/narration/<language>/<screen>/
// <line>.json, D24), else its time estimated from the text; reading each decision's options and each
// note shown; the learner's own lines when their voice says them.
export function pathTime(project: Project, ref: DialogueBlockRef, data: DialogueData, beats: readonly Beat[], language = project.course?.language ?? ''): PathTime {
  let seconds = 0;
  let estimated = false;
  const lineSeconds = (id: string, text: string): number => {
    const { sidecar } = readNarrationSidecar(project.files, narrationSidecarPath(language, ref.screen, id));
    if (sidecar) return sidecar.duration;
    estimated = true;
    return estimatedDuration(text);
  };
  for (const beat of beats) {
    if (beat.type === 'line') seconds += lineSeconds(beat.line.id, beat.line.text) + LINE_GAP;
    else if (beat.type === 'decision') {
      const node = data.nodes.find((candidate) => candidate.id === beat.node);
      seconds += readingSeconds([node?.prompt ?? '', ...(node?.options ?? []).filter((option) => !option.fallback).map((option) => option.label ?? option.text ?? '')].join(' ')) + CHOOSING_SECONDS;
    } else if (beat.type === 'choice' && data.learnerVoice && !beat.auto) {
      const option = data.nodes.find((candidate) => candidate.id === beat.node)?.options.find((candidate) => candidate.id === beat.option);
      if (option?.text) { seconds += estimatedDuration(option.text) + LINE_GAP; estimated = true; }
    } else if (beat.type === 'feedback') {
      const option = data.nodes.find((candidate) => candidate.id === beat.node)?.options.find((candidate) => candidate.id === beat.option);
      seconds += readingSeconds(option?.feedback ?? '');
    }
  }
  return { seconds: Math.round(seconds * 10) / 10, estimated };
}

// « 1 min 40 s », « 35 s ».
export function formatSeconds(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes} min${total % 60 ? ` ${total % 60} s` : ''}` : `${total} s`;
}
