// « Jouer un chemin » and every path, without a preview (D61): `elabora dialogue play` follows the
// choices given, `elabora dialogue paths` lists every path. Both replay the player's own walk
// (@elabora/player dialogue/), so what they say is what learners get.

import { walkScore, firstChoice, optionOf } from '@elabora/player/dialogue/walk';
import type { DialogueWalk } from '@elabora/player/dialogue/walk';
import { openDialogue, choose, scoredResult } from '@elabora/player/dialogue/run';
import type { DialogueRun } from '@elabora/player/dialogue/run';
import { explorePaths } from '@elabora/player/dialogue/paths';
import type { DialogueData } from '@elabora/player/dialogue/types';
import { withoutDirections } from '../narration/directions.ts';
import { courseEnv, pathTime, formatSeconds, projectDialogue } from './project.ts';
import type { DialogueBlockRef } from './project.ts';
import { letterOf } from './script.ts';
import type { Project } from '../project/model.ts';

export interface PlayedStep {
  kind: 'line' | 'choice' | 'feedback' | 'retry' | 'jump' | 'end' | 'decision';
  node: string;
  text: string;
  // What the step is, for a reader that words it itself (the app's « Jouer un chemin »): the line
  // said (line, with role, and option for a reaction), the option chosen (choice, feedback, retry;
  // auto: taken by itself, a fallback), the ending reached (end).
  line?: string;
  role?: 'character' | 'learner' | 'narration';
  option?: string;
  auto?: true;
  ending?: string | null;
}

export interface PlayedDecision {
  node: string;
  option: string;
  letter: string;
  text: string;
  quality: string | null;
  points: number;
  // The option kept when the first choice was retried.
  kept: string | null;
}

export interface PlayReport {
  dialogue: string;
  screen: string;
  choices: string[];
  ok: boolean;
  // Why the path stopped: a choice not offered (the options that were), or choices left over.
  error: string | null;
  offered: string[];
  // The node whose options are offered (null once ended, or when a choice was refused).
  waiting: string | null;
  ended: boolean;
  ending: { id: string; title: string | null } | null;
  scoring: string;
  // 0..100 by the dialogue's scoring (the quality score when not scored); null: nothing to count.
  score: number | null;
  points: number;
  maxPoints: number | null;
  decisions: PlayedDecision[];
  steps: PlayedStep[];
  seconds: number;
  estimated: boolean;
}

const percent = (value: number | null): number | null => (value === null ? null : Math.round(value * 1000) / 10);

function describeSteps(data: DialogueData, walk: DialogueWalk): PlayedStep[] {
  const learner = data.learner ? data.speakers[data.learner]?.name ?? data.learner : 'You';
  const steps: PlayedStep[] = [];
  for (const beat of walk.beats) {
    if (beat.type === 'line') {
      const who = beat.line.speaker ? data.speakers[beat.line.speaker]?.name ?? beat.line.speaker : null;
      steps.push({ kind: 'line', node: beat.node, text: beat.role === 'narration' ? `(${withoutDirections(beat.line.text)})` : `${who}: ${withoutDirections(beat.line.text)}`, line: beat.line.id, role: beat.role, ...(beat.option ? { option: beat.option } : {}) });
    } else if (beat.type === 'choice') {
      const node = data.nodes.find((candidate) => candidate.id === beat.node);
      const index = node?.options.findIndex((candidate) => candidate.id === beat.option) ?? -1;
      const option = node?.options[index];
      steps.push({ kind: 'choice', node: beat.node, option: beat.option, ...(beat.auto ? { auto: true as const } : {}), text: beat.auto ? `${learner} (by itself): ${option?.text ?? beat.option}` : `▸ ${learner} chooses ${letterOf(index)} [${beat.option}]: « ${option?.text ?? ''} »${option?.quality ? ` (${option.quality}${option.points ? `, ${option.points > 0 ? '+' : ''}${option.points}` : ''})` : option?.points ? ` (${option.points > 0 ? '+' : ''}${option.points})` : ''}` });
    } else if (beat.type === 'feedback') {
      steps.push({ kind: 'feedback', node: beat.node, option: beat.option, text: `Feedback: ${(optionOf(data, beat.node, beat.option)?.feedback ?? '').replace(/\s*\n\s*/g, ' ')}` });
    } else if (beat.type === 'retry') steps.push({ kind: 'retry', node: beat.node, option: beat.option, text: '↺ the same options again' });
    else if (beat.type === 'jump') steps.push({ kind: 'jump', node: beat.node, text: `→ moved to ${beat.node}` });
    else if (beat.type === 'end') {
      const ending = data.endings.find((candidate) => candidate.id === beat.ending);
      steps.push({ kind: 'end', node: walk.node, ending: beat.ending, text: `■ End${ending ? ` « ${ending.title ?? ending.id} »` : ''}${beat.capped ? ' (stopped: the decisions cap or a loop without decision)' : ''}` });
    }
  }
  return steps;
}

function decisionsOf(data: DialogueData, walk: DialogueWalk): PlayedDecision[] {
  return walk.decisions.filter((decision) => decision.closed && !decision.auto).map((decision) => {
    const first = firstChoice(decision)!;
    const node = data.nodes.find((candidate) => candidate.id === decision.node);
    const index = node?.options.findIndex((candidate) => candidate.id === first) ?? -1;
    const option = node?.options[index];
    return { node: decision.node, option: first, letter: letterOf(index), text: option?.label ?? option?.text ?? '', quality: option?.quality ?? null, points: option?.points ?? 0, kept: decision.choice !== first ? decision.choice : null };
  });
}

// The path of the choices given (option ids, one for each decision met, retries included).
export function playDialogue(project: Project, ref: DialogueBlockRef, choices: readonly string[], { language }: { language?: string } = {}): PlayReport {
  const data = projectDialogue(project, ref);
  let run: DialogueRun = openDialogue(data, undefined, courseEnv(project));
  let error: string | null = null;
  let offered: string[] = [];
  for (const [index, choice] of choices.entries()) {
    if (run.walk.status === 'ended') { error = `The dialogue ended after ${index} choice${index === 1 ? '' : 's'}: ${choices.slice(index).join(',')} left over.`; break; }
    try { run = choose(run, choice); } catch (thrown) {
      offered = run.walk.offer.filter((option) => option.enabled).map((option) => option.option.id);
      error = `Choice ${index + 1} « ${choice} » is not offered at ${run.walk.node}: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
      break;
    }
  }
  if (!error && run.walk.status === 'choosing') offered = run.walk.offer.filter((option) => option.enabled).map((option) => option.option.id);
  const walk = run.walk;
  const result = scoredResult(run);
  const time = pathTime(project, ref, data, walk.beats, language);
  return {
    dialogue: ref.id, screen: ref.screen, choices: [...choices], ok: error === null, error, offered,
    waiting: !error && walk.status === 'choosing' ? walk.node : null,
    ended: walk.status === 'ended', ending: walk.status === 'ended' && walk.ending ? { id: walk.ending.id, title: walk.ending.title ?? null } : null,
    scoring: data.scoring, score: percent(data.scoring === 'none' ? result.quality : result.score), points: result.points, maxPoints: data.maxPoints,
    decisions: decisionsOf(data, walk), steps: describeSteps(data, walk), seconds: time.seconds, estimated: time.estimated
  };
}

export function formatPlay(report: PlayReport): string {
  const out: string[] = [];
  out.push(`${report.dialogue} (screen ${report.screen}) — ${report.choices.length ? `choices ${report.choices.join(',')}` : 'no choice given'}`);
  for (const step of report.steps) out.push(`  ${step.kind === 'feedback' ? '    ' : ''}${step.text}`);
  if (report.error) out.push(`✘ ${report.error}`);
  if (!report.ended) out.push(report.error ? '' : `… waiting at ${report.steps.length ? report.steps[report.steps.length - 1].node : 'the start'}: offered ${report.offered.join(', ') || 'none'}`);
  out.push(`Ending: ${report.ended ? (report.ending ? `${report.ending.id} « ${report.ending.title ?? report.ending.id} »` : 'the end (no titled ending)') : 'not reached'}`);
  const score = report.score === null ? '—' : `${report.score} %`;
  out.push(`Score: ${score} (${report.scoring === 'none' ? 'quality, not scored' : report.scoring})${report.points || report.maxPoints ? ` · points ${report.points}${report.maxPoints !== null ? ` / ${report.maxPoints}` : ''}` : ''}`);
  if (report.decisions.length) out.push(`Decisions: ${report.decisions.map((decision) => `${decision.node} ${decision.letter}${decision.quality ? ` (${decision.quality})` : ''}${decision.kept ? ` then ${decision.kept}` : ''}`).join(' · ')}`);
  out.push(`Duration: about ${formatSeconds(report.seconds)}${report.estimated ? ' (estimated from the text where a line has no audio)' : ''}`);
  return out.filter((line, index) => line !== '' || index === out.length - 1).join('\n').trimEnd();
}

export interface PathEntry {
  choices: string[];
  letters: string;
  ending: string | null;
  score: number | null;
  points: number;
  decisions: number;
  seconds: number;
  capped: boolean;
}

export interface PathsReport {
  dialogue: string;
  screen: string;
  count: number;
  // Every path was listed (false: past the limit, the first ones only).
  complete: boolean;
  scoring: string;
  maxScore: number | null;
  minScore: number | null;
  maxPoints: number | null;
  minPoints: number | null;
  endings: { id: string; title: string | null; paths: number }[];
  unreachedEndings: string[];
  unreachedNodes: string[];
  implicitEnding: boolean;
  capped: boolean;
  maxDecisions: number;
  paths: PathEntry[];
  estimated: boolean;
}

export function dialoguePaths(project: Project, ref: DialogueBlockRef, { limit, language }: { limit?: number; language?: string } = {}): PathsReport {
  const data = projectDialogue(project, ref);
  const env = courseEnv(project);
  const exploration = explorePaths(data, { env, ...(limit ? { limit } : {}) });
  let estimated = false;
  const paths = exploration.paths.map((path): PathEntry => {
    const kind = data.scoring === 'none' ? 'quality' : data.scoring;
    const { score } = walkScore(data, path.walk, kind);
    const time = pathTime(project, ref, data, path.walk.beats, language);
    estimated ||= time.estimated;
    const choices = path.entries.map((entry) => entry.split('.')[1]);
    const letters = path.entries.map((entry) => {
      const [node, option] = entry.split('.');
      const index = data.nodes.find((candidate) => candidate.id === node)?.options.findIndex((candidate) => candidate.id === option) ?? -1;
      return letterOf(index);
    }).join('');
    return { choices, letters, ending: path.ending, score: percent(score), points: path.points, decisions: path.decisions, seconds: time.seconds, capped: path.walk.capped };
  });
  const scores = paths.map((path) => path.score).filter((score): score is number => score !== null);
  const counts = new Map<string, number>();
  for (const path of paths) if (path.ending) counts.set(path.ending, (counts.get(path.ending) ?? 0) + 1);
  return {
    dialogue: ref.id, screen: ref.screen, count: paths.length, complete: exploration.complete, scoring: data.scoring,
    maxScore: scores.length ? Math.max(...scores) : null, minScore: scores.length ? Math.min(...scores) : null,
    maxPoints: exploration.maxPoints, minPoints: exploration.minPoints,
    endings: data.endings.filter((ending) => counts.has(ending.id)).map((ending) => ({ id: ending.id, title: ending.title ?? null, paths: counts.get(ending.id)! })),
    unreachedEndings: data.endings.filter((ending) => !counts.has(ending.id)).map((ending) => ending.id),
    unreachedNodes: data.nodes.filter((node) => !exploration.nodes.has(node.id)).map((node) => node.id),
    implicitEnding: exploration.implicitEnding, capped: exploration.capped,
    maxDecisions: Math.max(0, ...paths.map((path) => path.decisions)), paths, estimated
  };
}

export function formatPaths(report: PathsReport): string {
  const out: string[] = [];
  out.push(`${report.dialogue} (screen ${report.screen}) — ${report.count} path${report.count === 1 ? '' : 's'}${report.complete ? '' : ' listed (more exist: the first ones only)'}, ${report.maxDecisions} decision${report.maxDecisions === 1 ? '' : 's'} at most`);
  const score = (value: number | null) => (value === null ? '—' : `${value} %`);
  out.push(`Score (${report.scoring === 'none' ? 'quality, not scored' : report.scoring}): best ${score(report.maxScore)}, worst ${score(report.minScore)}${report.maxPoints !== null && (report.maxPoints || report.minPoints) ? ` · points best ${report.maxPoints}, worst ${report.minPoints}` : ''}`);
  out.push(`Endings reached: ${report.endings.map((ending) => `${ending.id} (${ending.paths})`).join(', ') || (report.implicitEnding ? 'the end without title' : 'none')}${report.implicitEnding && report.endings.length ? ', and the end without title' : ''}`);
  if (report.unreachedEndings.length) out.push(`Endings never reached: ${report.unreachedEndings.join(', ')}`);
  if (report.unreachedNodes.length) out.push(`Nodes never reached: ${report.unreachedNodes.join(', ')}`);
  if (report.capped) out.push('Some paths stop at the decisions cap (60) or in a loop without decision.');
  for (const [index, path] of report.paths.entries()) {
    out.push(`  ${String(index + 1).padStart(String(report.paths.length).length)}. ${(path.choices.join(',') || '(no choice)').padEnd(16)} ${path.letters.padEnd(6)} → ${(path.ending ?? 'end').padEnd(12)} ${score(path.score).padStart(7)}${path.points ? `  ${path.points > 0 ? '+' : ''}${path.points}` : ''}  ${formatSeconds(path.seconds)}${path.capped ? '  (capped)' : ''}`);
  }
  if (report.estimated) out.push('Durations are estimated from the text where a line has no audio.');
  return out.join('\n');
}

// The walk of a path given as choices (for the app and the export's highlighted path).
export function walkOf(data: DialogueData, choices: readonly string[], project: Project): DialogueWalk {
  let run = openDialogue(data, undefined, courseEnv(project));
  for (const choice of choices) { if (run.walk.status !== 'choosing') break; run = choose(run, choice); }
  return run.walk;
}

