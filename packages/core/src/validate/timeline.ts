import type { Anchor, Block } from '@elabora/format';
import { blockControls } from '../components/controls.ts';
import { narrationWords, findPhrase } from '../narration/words.ts';
import { withoutDirections } from '../narration/directions.ts';
import { momentsOf, cuesOf, seekTargetsOf, beatsOf, screenTimeline, blockTimings, isBuiltinEffect, EFFECTS, timedLayers } from '../narration/timeline.ts';
import type { ScreenTimeline, TimelineMoment } from '../narration/timeline.ts';
import { screenSteps } from '../narration/narration.ts';
import { voiceLinesOf, timelineOf, trackLabel } from '../narration/voice-lines.ts';
import { blockText } from './narration.ts';
import type { CourseCheckContext, ScreenFile } from './context.ts';
import { list, fieldsOf, text } from './guards.ts';

// Timed blocks and anchors (docs/decisions.md D28). A screen check reads what is written: anchors to
// lines and words the narration says, seconds only without narration, effects the player or the
// theme knows, the contents of stacks; each layer's blocks on the layer's own timeline (D62), an anchor
// never on a line of another timeline (E_TIMELINE_ANCHOR_TRACK). A project check reads
// the times (they come from the narration's audio and its words, files of assets/): blocks that
// leave before they come or before their step, text shown too briefly, questions that leave before
// learners can answer, movement longer than five seconds, word anchors on estimated times.

// Reading what appears: about 17 characters a second (adult subtitles), never less than 1.5 s.
export const READING_CHARACTERS_PER_SECOND = 17;
export const READING_MINIMUM = 1.5;
// Captions faster than this cannot be read along (natural speech says 13 to 21 a second, verbatim
// captions follow it; beyond 25 the voice runs faster than most people read).
export const CAPTION_CHARACTERS_PER_SECOND = 25;
// WCAG 2.2.2: movement that starts by itself and lasts longer than this must be pausable.
export const MOTION_SECONDS = 5;
// Effects closer than this run into one another.
const MOTION_GAP = 0.25;
const EPSILON = 1e-3;

// What an anchor names that its timeline does not have, as written (no audio needed); null when it
// resolves. The code and the JSON pointer below the anchor's own path. elsewhere: the lines of the
// screen said on another timeline, and where.
export function anchorProblem(anchor: Anchor, { lines, steps, narrated, language, elsewhere }: { lines: ReadonlyMap<string, { text: string; step: number }>; steps: readonly number[]; narrated: boolean; language: string; elsewhere?: ReadonlyMap<string, string> }): { code: 'E_TIMELINE_ANCHOR_MISSING' | 'E_TIMING_SECONDS_NARRATED' | 'E_TIMELINE_ANCHOR_TRACK'; at: string; message: string } | null {
  if (typeof anchor.line === 'string') {
    const line = lines.get(anchor.line);
    const other = elsewhere?.get(anchor.line);
    if (!line && other) return { code: 'E_TIMELINE_ANCHOR_TRACK', at: '/line', message: `line "${anchor.line}" is said on ${other}, another timeline${lines.size ? ` (lines of its own: ${[...lines.keys()].join(', ')})` : ''}` };
    if (!line) return { code: 'E_TIMELINE_ANCHOR_MISSING', at: '/line', message: narrated ? `no line "${anchor.line}" in the narration (lines: ${[...lines.keys()].join(', ')})` : `the screen has no narration, so no line "${anchor.line}"` };
    if (typeof anchor.word === 'string' && !findPhrase(narrationWords(line.text, language), anchor.word, { occurrence: anchor.occurrence, language })) {
      const said = findPhrase(narrationWords(line.text, language), anchor.word, { language });
      return { code: 'E_TIMELINE_ANCHOR_MISSING', at: '/word', message: said ? `line "${anchor.line}" says "${anchor.word}" fewer than ${anchor.occurrence} times` : `line "${anchor.line}" does not say "${anchor.word}": « ${line.text.length > 90 ? `${line.text.slice(0, 89)}…` : line.text} »` };
    }
    return null;
  }
  if (typeof anchor.seconds === 'number' && narrated) return { code: 'E_TIMING_SECONDS_NARRATED', at: '/seconds', message: `${anchor.seconds} s: a narrated screen anchors to its lines and words` };
  if (typeof anchor.step === 'number' && !steps.includes(anchor.step)) return { code: 'E_TIMELINE_ANCHOR_MISSING', at: '/step', message: `the screen has no step ${anchor.step} (steps: ${steps.join(', ')})` };
  return null;
}

// The lines of one timeline of a screen as anchors read them (their text in the course's language):
// the screen's (layer null) or a layer's.
export function anchorLines(data: ScreenFile['data'], layer: string | null = null): Map<string, { text: string; step: number }> {
  return new Map(voiceLinesOf(data, typeof data.id === 'string' ? data.id : '').filter((entry) => timelineOf(entry.track)?.layer === layer && timelineOf(entry.track) !== null).map((entry) => [entry.line.id, { text: text(entry.line.text), step: entry.step }]));
}

// The timelines a screen's file writes: its own, then each layer's (D62), with what anchors on each
// may name and the lines said elsewhere.
function writtenTimelines(data: ScreenFile['data']): { layer: string | null; holder: Pick<ScreenFile['data'], 'blocks'>; path: string; lines: Map<string, { text: string; step: number }>; steps: number[]; elsewhere: Map<string, string>; where: string }[] {
  const id = typeof data.id === 'string' ? data.id : '';
  const all = voiceLinesOf(data, id);
  const out: ReturnType<typeof writtenTimelines> = [];
  const add = (layer: string | null, holder: Pick<ScreenFile['data'], 'blocks'>, path: string) => {
    const lines = anchorLines(data, layer);
    const elsewhere = new Map(all.filter((entry) => !lines.has(entry.line.id)).map((entry) => [entry.line.id, trackLabel(entry.track)]));
    out.push({ layer, holder, path, lines, steps: layer === null ? screenSteps(data) : [1], elsewhere, where: layer === null ? `screen "${id}"` : `layer "${layer}" (screen "${id}")` });
  };
  add(null, data, '/blocks');
  list(data.layers).forEach((layer, index) => { if (layer && typeof layer.id === 'string') add(layer.id, layer, `/layers/${index}/blocks`); });
  return out;
}

export function checkScreenTiming(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { reporter, project } = ctx;
  const { id, file, data } = screen;
  const language = ctx.course.language;
  const themeEffects = new Set(Object.keys(fieldsOf(ctx.course.theme?.effects)));
  for (const timeline of writtenTimelines(data)) {
    const { layer, lines, steps, elsewhere, where } = timeline;
    const narrated = lines.size > 0;
    const holder = { path: timeline.path, step: layer === null ? null : 1 };
    for (const moment of momentsOf(project, timeline.holder, holder)) {
      if (moment.implied) continue;
      const problem = anchorProblem(moment.anchor, { lines, steps, narrated, language, elsewhere });
      if (problem) reporter.emit(problem.code, { file, path: `${moment.path}/at${problem.at}`, target: moment.block, details: { screen: id, ...(layer !== null ? { layer } : {}), block: moment.block, kind: moment.kind, anchor: moment.anchor, lost: problem.at.slice(1) }, message: `Block "${moment.block}" of ${where}: its timing.${moment.kind} ${problem.message}.` });
      if (moment.effect === 'draw') checkDrawnImage(ctx, screen, moment);
      if (!isBuiltinEffect(moment.effect) && !themeEffects.has(moment.effect)) reporter.emit('E_TIMING_EFFECT_UNKNOWN', { file, path: `${moment.path}/effect`, target: moment.block, message: `Block "${moment.block}" of ${where}: no effect "${moment.effect}" (the player's: ${EFFECTS.join(', ')}${themeEffects.size ? `; the theme's: ${[...themeEffects].join(', ')}` : ''}).` });
    }
    // The contents of a stack come one after the other: each after the first needs its moment.
    const walk = (blocks: readonly (Block | null | undefined)[] | undefined, path: string) => list(blocks).forEach((block, index) => {
      if (block === null || block === undefined) return;
      if (ctx.registry.get(block.type)?.root === 'stack') {
        list(block.blocks).forEach((content, contentIndex) => {
          if (contentIndex === 0 || content === null || content === undefined) return;
          if (!fieldsOf(fieldsOf(content.timing).in).at) reporter.emit('W_STACK_UNTIMED', { file, path: `${path}/${index}/blocks/${contentIndex}`, target: content.id, message: `Content ${contentIndex + 1} of stack "${block.id}" (${where}) has no timing.in: it shows with the content before it.` });
        });
      }
      walk(block.blocks, `${path}/${index}/blocks`);
    });
    walk(timeline.holder.blocks, timeline.path);
    // Event cues and seek-timeline targets (a line no timeline has is E_TIMELINE_CUE, from the events
    // check; a cue whose line is on another timeline than the layer it names, from there too).
    for (const cue of [...cuesOf(data, { layer }), ...seekTargetsOf(data, { layer })]) {
      if (typeof cue.anchor.line === 'string' && !lines.has(cue.anchor.line)) continue;
      const problem = anchorProblem(cue.anchor, { lines, steps, narrated, language, elsewhere });
      if (problem) reporter.emit(problem.code, { file, path: `${cue.path}${problem.at}`, target: cue.event, details: { screen: id, ...(layer !== null ? { layer } : {}), event: cue.event, anchor: cue.anchor, lost: problem.at.slice(1) }, message: `Event "${cue.event}" of screen "${id}": its moment ${problem.message}${layer !== null ? ` (on the timeline of layer "${layer}")` : ''}.` });
    }
    // Charts' items brought by the voice, and the end of their spotlight (D60).
    for (const beat of beatsOf(project, timeline.holder, holder)) {
      if (beat.implied) continue;
      const problem = anchorProblem(beat.anchor, { lines, steps, narrated, language, elsewhere });
      const what = beat.item === null ? 'its spotlightEnd' : `item "${beat.item}"'s moment`;
      if (problem) reporter.emit(problem.code, { file, path: `${beat.path}${problem.at}`, target: beat.block, details: { screen: id, ...(layer !== null ? { layer } : {}), block: beat.block, item: beat.item, anchor: beat.anchor, lost: problem.at.slice(1) }, message: `Chart "${beat.block}" of ${where}: ${what} ${problem.message}.` });
    }
  }
}

export function checkTimelineTimes(ctx: CourseCheckContext): void {
  const { project, reporter } = ctx;
  checkThemeEffects(ctx);
  for (const id of ctx.screens.keys()) {
    const entry = project.screens.get(id);
    if (!entry) continue;
    for (const layer of [null, ...timedLayers(project, entry.data)]) checkTimes(ctx, id, layer);
  }
}

// The times of one timeline of a screen: the screen's (layer null) or a layer's (D62).
function checkTimes(ctx: CourseCheckContext, id: string, layer: string | null): void {
  const { project, reporter } = ctx;
  const entry = project.screens.get(id)!;
  const timeline = screenTimeline(project, id, { layer });
  if (!timeline) return;
  const { file, data } = entry;
  {
    const where = layer === null ? `screen "${id}"` : `layer "${layer}" (screen "${id}")`;
    const timings = blockTimings(timeline);
    const blocks = blocksOf(layer === null ? data.blocks : list(data.layers).find((candidate) => candidate?.id === layer)?.blocks);
    const segmentOf = (step: number) => timeline.segments.find((segment) => segment.step === step);
    // Where playback stops for the learner: the end of a step that waits for Continue (learner
    // mode), for answers (opens "answered") or for exploring (opens "explored"), and the end of the screen. A layer plays through.
    const advance = layer !== null ? 'auto' : data.narration?.advance ?? ctx.course.narration?.advance ?? 'learner';
    const stops = timeline.segments.filter((segment, index) => {
      const next = timeline.segments[index + 1];
      if (!next) return advance !== 'next-screen';
      const opens = fieldsOf(fieldsOf(data.steps)[String(next.step)]).opens;
      return advance === 'learner' || opens === 'answered' || opens === 'explored';
    }).map((segment) => segment.end);
    for (const [blockId, timing] of timings) {
      const block = blocks.get(blockId);
      if (!block) continue;
      const step = timing.in?.blockStep ?? timing.out?.blockStep ?? 1;
      const segment = segmentOf(step);
      if (timing.in && timing.out && timing.out.at <= timing.in.at + EPSILON) reporter.emit('E_TIMING_ORDER', { file, path: `${timing.out.path}/at`, target: blockId, details: { screen: id, block: blockId, in: timing.in.at, out: timing.out.at }, message: `Block "${blockId}" of ${where} leaves at ${seconds(timing.out.at)} and comes at ${seconds(timing.in.at)}: learners never see it.` });
      if (timing.in && !timing.in.problem && segment && timing.in.at < segment.start - EPSILON) reporter.emit('W_TIMING_STEP', { file, path: `${timing.in.path}/at`, target: blockId, details: { screen: id, block: blockId, step, opens: segment.start, in: timing.in.at }, message: `Block "${blockId}" of ${where} is in step ${step}, which opens at ${seconds(segment.start)}: its timing.in (${seconds(timing.in.at)}) falls before, so it comes when step ${step} opens.` });
      const shownFrom = timing.in ? timing.in.at + timing.in.duration : segment?.start ?? 0;
      if (timing.out && timing.out.at > shownFrom) {
        const words = blockText(ctx, block).replace(/[*_`#>~[\]()!|]/g, '').replace(/\s+/g, ' ').trim();
        const needed = Math.max(READING_MINIMUM, words.length / READING_CHARACTERS_PER_SECOND);
        const shown = timing.out.at - shownFrom;
        if (words && shown + EPSILON < needed) reporter.emit('W_TEXT_TOO_FAST', { file, path: `${timing.out.path}/at`, target: blockId, measured: round(shown), limit: round(needed), details: { screen: id, block: blockId, characters: words.length, shown: round(shown), needed: round(needed), from: round(shownFrom), until: round(timing.out.at) }, message: `Block "${blockId}" of ${where} shows its ${words.length} characters for ${seconds(shown)}; reading them takes about ${seconds(needed)}.` });
      }
      if (timing.out && learnersUse(ctx, block)) {
        const from = timing.in ? timing.in.at : segment?.start ?? 0;
        const stopped = stops.some((stop) => stop >= from - EPSILON && stop <= timing.out!.at + EPSILON);
        if (!stopped && timing.out.at < timeline.duration - EPSILON) reporter.emit('E_ACTIVITY_LEAVES_UNANSWERED', { file, path: `${timing.out.path}/at`, target: blockId, details: { screen: id, block: blockId, leaves: timing.out.at, stops: stops.find((stop) => stop > timing.out!.at) ?? timeline.duration }, message: `Block "${blockId}" of ${where} leaves at ${seconds(timing.out.at)}, while playback goes on: learners may not have used it (playback next stops at ${seconds(stops.find((stop) => stop > timing.out!.at) ?? timeline.duration)}).` });
      }
    }
    // Word anchors placed by estimate: once per line, on a line that has its audio.
    const estimated = new Map<string, string[]>();
    for (const moment of [...timeline.moments, ...timeline.cues.map((cue) => ({ ...cue, block: cue.event }))]) {
      const line = moment.anchor.line;
      if (typeof line !== 'string' || typeof moment.anchor.word !== 'string' || moment.problem || !moment.estimated) continue;
      const info = timeline.infos.get(line);
      if (!info || (info.status !== 'ok' && info.status !== 'stale')) continue;
      estimated.set(line, [...(estimated.get(line) ?? []), `"${moment.anchor.word}" (${moment.block})`]);
    }
    for (const [line, anchors] of estimated) {
      reporter.emit('I_TIMELINE_WORDS_ESTIMATED', { file, path: timeline.infos.get(line)?.path ?? '/narration/lines', target: id, details: { screen: id, line }, message: `Line "${line}" of screen "${id}" has no word times yet: ${anchors.join(', ')} placed in proportion to its text.` });
    }
    // Captions learners cannot read along: what they read, the line without its stage directions (D29).
    for (const line of timeline.lines) {
      const info = timeline.infos.get(line.id);
      if (line.estimated || !info?.text || line.duration <= 0) continue;
      const rate = withoutDirections(info.text).replace(/\s+/g, ' ').trim().length / line.duration;
      if (rate > CAPTION_CHARACTERS_PER_SECOND) {
        reporter.emit('W_TEXT_TOO_FAST', { file, path: info.path, target: id, measured: Math.round(rate), limit: CAPTION_CHARACTERS_PER_SECOND, details: { screen: id, line: line.id, charactersPerSecond: Math.round(rate) }, message: `Line "${line.id}" of screen "${id}" says ${Math.round(rate)} characters a second: its captions cannot be read along.` });
      }
    }
    checkMotion(ctx, id, file, timeline);
  }
}

// Effects that run into one another for more than five seconds (WCAG 2.2.2).
function checkMotion(ctx: CourseCheckContext, id: string, file: string, timeline: ScreenTimeline): void {
  const runs: { from: number; to: number; moments: TimelineMoment[] }[] = [];
  for (const moment of [...timeline.moments].filter((candidate) => candidate.effect !== 'none' && candidate.duration > 0).sort((a, b) => a.at - b.at)) {
    const last = runs[runs.length - 1];
    if (last && moment.at <= last.to + MOTION_GAP) { last.to = Math.max(last.to, moment.at + moment.duration); last.moments.push(moment); } else runs.push({ from: moment.at, to: moment.at + moment.duration, moments: [moment] });
  }
  for (const run of runs) {
    const length = run.to - run.from;
    if (length <= MOTION_SECONDS + EPSILON) continue;
    // Named after the longest effect of the run (the first of them).
    const first = run.moments.reduce((longest, moment) => (moment.duration > longest.duration ? moment : longest));
    ctx.reporter.emit('W_MOTION_LONG', { file, path: `${first.path}`, target: first.block, measured: round(length), limit: MOTION_SECONDS, details: { screen: id, ...(timeline.layer !== null ? { layer: timeline.layer } : {}), from: round(run.from), to: round(run.to), blocks: [...new Set(run.moments.map((moment) => moment.block))] }, message: `On ${timeline.layer !== null ? `layer "${timeline.layer}" of ` : ''}screen "${id}", effects run one into the other from ${seconds(run.from)} to ${seconds(run.to)} (${run.moments.map((moment) => moment.block).filter((block, index, all) => all.indexOf(block) === index).join(', ')}).` });
  }
}

// draw traces the strokes of the block's own drawing: an image block shows an <img> unless inline.
function checkDrawnImage(ctx: CourseCheckContext, screen: ScreenFile, moment: { block: string; path: string }): void {
  const block = ctx.blocks.get(moment.block)?.block;
  if (!block || ctx.registry.get(block.type)?.root !== 'image') return;
  const props = fieldsOf(block.props);
  if (props.inline === true && typeof props.asset === 'string' && /\.svg$/i.test(props.asset)) return;
  const svg = typeof props.asset === 'string' && /\.svg$/i.test(props.asset);
  ctx.reporter.emit('W_TIMING_DRAW_IMAGE', { file: screen.file, path: `${moment.path}/effect`, target: moment.block, message: `Block "${moment.block}" of screen "${screen.id}" is drawn (effect draw), but ${svg ? `its SVG is shown as an image, whose strokes the page cannot reach: set inline: true on the block` : 'its image has no strokes (not an SVG)'}; until then it is wiped.` });
}

// Effects the theme declares need their keyframes in its stylesheet.
function checkThemeEffects(ctx: CourseCheckContext): void {
  const effects = Object.keys(fieldsOf(ctx.course.theme?.effects));
  if (!effects.length) return;
  const sheet = typeof ctx.course.theme?.stylesheet === 'string' ? ctx.project.files.get(ctx.course.theme.stylesheet) : undefined;
  const css = sheet && sheet.kind === 'text' ? sheet.text : '';
  for (const name of effects) {
    if (new RegExp(`@keyframes\\s+t-fx-${name}\\b(?!-)`).test(css)) continue;
    ctx.reporter.emit('W_THEME_EFFECT_UNDEFINED', { file: 'course.json', path: `/theme/effects/${name}`, target: name, message: `Theme effect "${name}" has no @keyframes t-fx-${name} in ${ctx.course.theme?.stylesheet ?? 'a theme stylesheet (theme.stylesheet)'}.` });
  }
}

// Activities and blocks learners click (buttons, tabs, disclosures).
function learnersUse(ctx: CourseCheckContext, block: Block): boolean {
  const behavior = ctx.registry.get(block.type)?.behavior;
  if (behavior === 'quiz' || behavior === 'numeric' || behavior === 'fill-in' || behavior === 'sort' || behavior === 'reflection' || behavior === 'decision' || behavior === 'object') return true;
  return blockControls(ctx.project, block).size > 0;
}

// Every block of a screen (or of a layer) by id, at any depth.
function blocksOf(blocks: readonly (Block | null | undefined)[] | undefined, out = new Map<string, Block>()): Map<string, Block> {
  for (const block of list(blocks)) {
    if (block === null || block === undefined) continue;
    out.set(block.id, block);
    blocksOf(block.blocks, out);
  }
  return out;
}

const round = (value: number): number => Math.round(value * 10) / 10;
const seconds = (value: number): string => `${round(value)} s`;
