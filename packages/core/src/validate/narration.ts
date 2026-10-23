import { findingKey } from '../diagnostics/index.ts';
import { screenBlocks, resolveBlockProps } from '../project/load.ts';
import { valuesOfKind } from '../components/props.ts';
import type { Block } from '../project/model.ts';
import { narrationLines, screenTiming, lineSpeaker } from '../narration/narration.ts';
import type { NarrationLineInfo } from '../narration/narration.ts';
import { voiceLinesOf, trackKey, trackGroup, trackLabel, timelineOf } from '../narration/voice-lines.ts';
import { lineDirections, playsDirections, withoutDirections } from '../narration/directions.ts';
import { doubtfulWords, swallowedKey, SWALLOWED_SCORE } from '../narration/words.ts';
import { fileHash } from '../project/files.ts';
import type { CourseCheckContext, ScreenFile } from './context.ts';
import { list, fieldsOf, text, byId } from './guards.ts';

// Narrated screens (docs/decisions.md D24): the script (ids, speakers, step order), the pace it sets
// (auto advance, long steps), the on-screen text that reads it aloud again (E4), and the audio of its
// lines (missing, out of date). The audio is found by convention, not named in the screen: its check
// is a project check, which the editor runs again when a file of assets/ changes. Every voice line of
// a screen counts (voice-lines.ts: the screen's narration, each layer's, D62): ids are unique in the
// screen, speakers declared, audio there and up to date.

// More voice than this in one step without a pause for the learner (segmenting principle).
export const SEGMENT_SECONDS = 90;
// A line is a few sentences; past this it is suggested to cut it (W_NARRATION_LINE_LONG).
export const LINE_SECONDS = 45;
// A line repeated on screen: this share of its word sequences (three words) shown by one block.
const DUPLICATED_SHARE = 0.6;
const DUPLICATED_MIN_WORDS = 6;

export function checkScreenNarration(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { reporter } = ctx;
  const { id, file, data } = screen;
  const narration = data.narration;
  const speakers = new Set(list(ctx.course.speakers).map((speaker) => speaker?.id));
  // Ids are unique in the screen, every track counted: a line's audio files are named by it alone.
  const seen = new Map<string, string>();
  let previousStep = 0;
  for (const { line, track, path: at } of voiceLinesOf(data, id, ctx.project)) {
    const first = seen.get(line.id);
    if (first !== undefined) reporter.emit('E_NARRATION_LINE_DUPLICATE', { file, path: `${at}/id`, target: id, details: { screen: id, line: line.id, tracks: [first, trackKey(track)] }, message: first === trackKey(track) ? `Screen "${id}" has two lines "${line.id}" in ${trackLabel(track)}.` : `Screen "${id}" has two lines "${line.id}": in ${trackLabel(trackOf(first))} and in ${trackLabel(track)} (ids are unique in the screen, every track counted).` });
    else seen.set(line.id, trackKey(track));
    // A dialogue's speakers are checked with the dialogue (E_DIALOGUE_SPEAKER).
    if (line.speaker !== undefined && !speakers.has(line.speaker) && track.kind !== 'dialogue') reporter.emit('E_NARRATION_SPEAKER', { file, path: `${at}/speaker`, target: id, message: `Line "${line.id}" of screen "${id}": no speaker "${line.speaker}" in course.json speakers${speakers.size ? ` (${[...speakers].join(', ')})` : ''}.` });
    if (track.kind !== 'screen') continue;
    const step = typeof line.step === 'number' ? line.step : 1;
    if (step < previousStep) reporter.emit('E_NARRATION_STEP_ORDER', { file, path: `${at}/step`, target: id, message: `Line "${line.id}" of screen "${id}" is in step ${step}, after a line of step ${previousStep}.` });
    previousStep = Math.max(previousStep, step);
  }
  if (narration && (narration.advance ?? ctx.course.narration?.advance) === 'next-screen') reporter.emit('W_AUTO_ADVANCE', { file, path: narration.advance ? '/narration/advance' : '/narration', target: id, message: `Screen "${id}" plays its steps one after the other and goes on to the next screen by itself${narration.advance ? '' : ' (the course\'s narration.advance)'}.` });
  checkDuplicated(ctx, screen);
}

// A track from its key (messages only).
const trackOf = (key: string) => (key === 'screen' ? { kind: 'screen' as const } : key.startsWith('layer:') ? { kind: 'layer' as const, layer: key.slice(6) } : { kind: 'dialogue' as const, block: key.split(':')[1] ?? '', node: key.split(':')[2] ?? '' });

// On-screen text that repeats a line of the narration (E4): learners read and hear the same words. A
// layer's lines are compared with the layer's blocks.
function checkDuplicated(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { id, file, data } = screen;
  const blocks = [...screenBlocks(data, file)].filter((location) => location.block !== null && location.block !== undefined);
  const shown = blocks.map((location) => ({ block: location.block, layer: location.layer?.id ?? null, step: location.layer ? 1 : stepOf(data.blocks, location.block), grams: trigrams(blockText(ctx, location.block)) }));
  for (const { line, track, path } of voiceLinesOf(data, id, ctx.project)) {
    const timeline = timelineOf(track);
    if (!timeline) continue;
    // What learners hear: its stage directions are not said (D29).
    const words = wordsOf(withoutDirections(text(line.text)));
    if (words.length < DUPLICATED_MIN_WORDS) continue;
    const grams = trigrams(words.join(' '));
    const step = typeof line.step === 'number' && track.kind === 'screen' ? line.step : 1;
    for (const candidate of shown) {
      if (candidate.layer !== timeline.layer || candidate.step > step || !candidate.grams.size) continue;
      let common = 0;
      for (const gram of grams) if (candidate.grams.has(gram)) common++;
      const share = common / grams.size;
      if (share >= DUPLICATED_SHARE) {
        ctx.reporter.emit('W_NARRATION_DUPLICATED', { file, path: `${path}/text`, target: candidate.block.id, measured: Math.round(share * 100), limit: Math.round(DUPLICATED_SHARE * 100), key: findingKey(`${id}/${text(line.id)}/${candidate.block.id}`, `${words.join(' ')}\u0000${blockText(ctx, candidate.block)}`), message: `Line "${line.id}" of screen "${id}" is shown on screen by "${candidate.block.id}" (${Math.round(share * 100)} % of its words, in the same order).` });
        break;
      }
    }
  }
}

// The step of a block of the screen: its own, or that of the block of the screen holding it.
function stepOf(blocks: readonly (Block | null | undefined)[] | undefined, block: Block): number {
  for (const top of list(blocks)) {
    if (top === null || top === undefined) continue;
    const inside = (candidate: Block): boolean => candidate === block || list(candidate.blocks).some((child) => child !== null && child !== undefined && inside(child));
    if (inside(top)) return typeof top.step === 'number' ? top.step : 1;
  }
  return 1;
}

// The words a block shows (its text props; for components, their text and markdown props).
export function blockText(ctx: Pick<CourseCheckContext, 'registry' | 'planIndex'>, block: Block): string {
  const component = ctx.registry.get(block.type);
  if (!component) return '';
  if (!component.builtin && !component.root) return valuesOfKind(component.schema, resolveBlockProps(block, ctx.planIndex, ctx.registry), ['text', 'markdown']).map((found) => text(found.value)).join(' ');
  const props = fieldsOf(block.props);
  const locked = props.textRef ? byId(ctx.planIndex.texts, props.textRef)?.text : null;
  return [locked || props.markdown || props.text, props.title, props.stem, props.prompt, props.caption].map(text).join(' ');
}

const wordsOf = (value: string): string[] => value.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);

function trigrams(value: string): Set<string> {
  const words = wordsOf(value);
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}

// The audio of the lines in the course's language, and how long each step runs.
export function checkNarrationAudio(ctx: CourseCheckContext): void {
  const { project, reporter } = ctx;
  const declared = new Set<string>();
  list(ctx.course.speakers).forEach((speaker, index) => {
    if (speaker === null || speaker === undefined) return;
    if (declared.has(speaker.id)) reporter.emit('E_NARRATION_SPEAKER', { file: 'course.json', path: `/speakers/${index}/id`, target: speaker.id, message: `Speaker "${speaker.id}" is declared twice.` });
    declared.add(speaker.id);
  });
  for (const id of ctx.screens.keys()) {
    const entry = project.screens.get(id);
    if (!entry) continue;
    const file = entry.file;
    const lines = narrationLines(project, id);
    if (!lines) continue;
    const language = ctx.course.language;
    // Missing audio, said once per timeline (it runs silent until every line of it has its audio) or
    // per dialogue.
    const tracks = new Map<string, NarrationLineInfo[]>();
    for (const line of lines) tracks.set(trackGroup(line.track), [...(tracks.get(trackGroup(line.track)) ?? []), line]);
    for (const own of tracks.values()) {
      const missing = own.filter((line) => line.status === 'missing');
      if (!missing.length) continue;
      const which = missing.map((line) => line.id).join(', ');
      const track = own[0].track;
      const where = track.kind === 'screen' ? `screen "${id}"` : track.kind === 'dialogue' ? `dialogue "${track.block}" (screen "${id}")` : `${trackLabel(track)} (screen "${id}")`;
      const runs = timelineOf(track) ? `its timeline runs silent, on estimated times` : 'its lines are silent';
      reporter.emit('W_NARRATION_AUDIO_MISSING', {
        file, path: track.kind === 'dialogue' ? own[0].path.replace(/\/nodes\/.*$/, '') : own[0].path.replace(/\/\d+$/, ''), target: id, measured: missing.length, details: { screen: id, track: trackGroup(track), lines: missing.map((line) => line.id) },
        message: missing.length === own.length
          ? `${where[0].toUpperCase()}${where.slice(1)} has no narration audio in ${language} yet (${which}): ${runs}.`
          : `${missing.length} of ${own.length} lines of ${where} have no audio in ${language} (${which}): ${runs}${timelineOf(track) ? ', until every line has its audio' : ''}.`
      });
    }
    for (const line of lines.filter((candidate) => candidate.status === 'stale')) {
      reporter.emit('W_NARRATION_AUDIO_STALE', { file, path: line.path, target: id, message: `The audio of line "${line.id}" of screen "${id}" (${language}) is out of date: ${line.reasons.join('; ')}.` });
    }
    lines.forEach((line) => {
      if (line.status === 'ok' && line.duration !== null && line.duration > LINE_SECONDS) reporter.emit('W_NARRATION_LINE_LONG', { file, path: line.path, target: id, measured: Math.round(line.duration), limit: LINE_SECONDS, key: findingKey(`${id}/${line.id}/${language}`, line.text ?? ''), details: { screen: id, line: line.id, duration: Math.round(line.duration * 10) / 10 }, message: `Line "${line.id}" of screen "${id}" (${language}) runs ${Math.round(line.duration)} s: cut it into shorter lines.` });
      const directions = line.text ? lineDirections(line.text) : [];
      if (directions.length && !playsDirections(lineSpeaker(ctx.course, { speaker: line.speaker ?? undefined })?.voices?.[language])) {
        reporter.emit('I_NARRATION_DIRECTIONS_IGNORED', { file, path: `${line.path}/text`, target: id, details: { screen: id, line: line.id, directions: directions.map((direction) => direction.text) }, message: `Line "${line.id}" of screen "${id}" has stage directions (${directions.map((direction) => `[${direction.text}]`).join(' ')}) that the voice of its speaker in ${language} does not play.` });
      }
    });
    // One finding per word, keyed by the take's audio: the author may ignore one (D31) until another take.
    lines.forEach((line) => {
      const doubtful = line.status === 'ok' ? doubtfulWords(line.words ?? []) : [];
      if (!doubtful.length) return;
      const take = fileHash(project.files, line.audio);
      for (const word of doubtful) {
        reporter.emit('W_NARRATION_WORD_SWALLOWED', {
          file, path: line.path, target: id, measured: word.score, limit: SWALLOWED_SCORE, details: { screen: id, line: line.id, words: [word] }, ...(take ? { key: swallowedKey(id, line.id, language, word, take) } : {}),
          message: `The voice of line "${line.id}" of screen "${id}" (${language}) may have swallowed « ${word.word} » (word ${word.index + 1}, score ${word.score}).`
        });
      }
    });
    const timing = entry.data.narration ? screenTiming(project, id) : null;
    for (const segment of timing?.segments ?? []) {
      const seconds = Math.round(segment.end - segment.start);
      if (seconds > SEGMENT_SECONDS) reporter.emit('W_SEGMENT_TOO_LONG', { file, path: '/narration/lines', target: id, measured: seconds, limit: SEGMENT_SECONDS, details: { screen: id, step: segment.step, start: segment.start, end: segment.end, lines: (timing?.lines ?? []).filter((line) => line.step === segment.step).map((line) => line.id) }, message: `Step ${segment.step} of screen "${id}" runs ${seconds} s of narration${timing?.estimated ? ' (estimated from its text)' : ''}.` });
    }
    // A layer speaks in one go: past the same length, the learner has nothing to do but listen.
    list(entry.data.layers).forEach((layer, layerIndex) => {
      if (!layer?.narration) return;
      const own = screenTiming(project, id, { layer: layer.id });
      const seconds = own ? Math.round(own.duration) : 0;
      if (own && seconds > SEGMENT_SECONDS) reporter.emit('W_SEGMENT_TOO_LONG', { file, path: `/layers/${layerIndex}/narration/lines`, target: id, measured: seconds, limit: SEGMENT_SECONDS, details: { screen: id, layer: layer.id, start: 0, end: own.duration, lines: own.lines.map((line) => line.id) }, message: `Layer "${layer.id}" of screen "${id}" runs ${seconds} s of narration${own.estimated ? ' (estimated from its text)' : ''}.` });
    });
  }
}
