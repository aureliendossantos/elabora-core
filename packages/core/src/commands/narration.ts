import type { Course, Project, Screen } from '../project/model.ts';
import { binaryFile, filesIn, pathsUnder } from '../project/files.ts';
import { parseJSON } from '../util/json.ts';
import type { FileHash, ProjectFiles } from '../project/files.ts';
import { narrationLines, narrationAudioPath, narrationSidecarPath, readNarrationSidecar, NARRATION_DIR } from '../narration/narration.ts';
import type { Narration, NarrationLine, NarrationAudio } from '../narration/narration.ts';
import { CommandError, Draft, assignFields, commandContext, insertAt, listIn, screenFile, type CommandContext, type CommandOutput } from './context.ts';
import { reanchorLine, type Reanchored } from './timing.ts';
import { lineWordTimes } from '../narration/words.ts';
import { isMouth } from '../narration/mouth.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import { screenAnchors } from '../i18n/anchors.ts';
import { voiceLinesOf } from '../narration/voice-lines.ts';

// A screen's narration (docs/decisions.md D24): its settings, its lines (the script), and the audio
// of a line in a language with its sidecar; and a layer's narration (D62), its lines said on the
// layer's own timeline. Line ids are unique in their screen, every track counted; a line without an
// id gets the next free one (l1, l2…). Commands that name a line find it in whichever narration holds it.

type NoResult = CommandOutput<Record<string, never>>;

// The narration edited: the screen's (layer undefined or null), a layer's, or the one that holds a
// line (line, layer undefined). create: a narration is made for the first line.
function editNarration<R>(context: CommandContext, screenId: string, change: (narration: Narration, screen: Screen, draft: Draft, layer: string | null) => R, { create = false, layer, line }: { create?: boolean; layer?: string | null; line?: string } = {}): CommandOutput<R> {
  const draft = new Draft(context.files);
  const file = screenFile(screenId);
  const screen = draft.json<Screen>(file);
  const holds = (holder: unknown) => isRecord(holder) && isRecord(holder.narration) && Array.isArray(holder.narration.lines) && holder.narration.lines.some((candidate) => isRecord(candidate) && candidate.id === line);
  const layers = objectsIn(screen.layers);
  let owner: { narration?: unknown } = screen;
  let ownLayer: string | null = null;
  if (layer === undefined && line !== undefined && !holds(screen)) {
    const found = layers.find(holds);
    if (found) { owner = found; ownLayer = found.id; }
  } else if (typeof layer === 'string') {
    const found = layers.find((candidate) => candidate.id === layer);
    if (!found) throw new CommandError(`Screen "${screenId}" has no layer "${layer}" (layers: ${layers.map((candidate) => candidate.id).join(', ') || 'none'}).`);
    owner = found;
    ownLayer = layer;
  }
  const where = ownLayer === null ? `Screen "${screenId}"` : `Layer "${ownLayer}" of screen "${screenId}"`;
  if (!isRecord(owner.narration)) {
    if (!create) throw new CommandError(`${where} has no narration: add a line first.`);
    owner.narration = { lines: [] };
  }
  const narration = owner.narration as Narration;
  listIn<NarrationLine>(narration, 'lines', file, { create: true });
  const result = change(narration, screen, draft, ownLayer);
  if (!narration.lines.length) delete owner.narration;
  draft.writeJson(file, screen);
  return { files: draft.files(), result };
}

// Every line id of a screen, every track counted.
const screenLineIds = (screen: Screen): Set<string> => new Set(voiceLinesOf(screen, typeof screen.id === 'string' ? screen.id : '').map((entry) => entry.line.id));

const lineIn = (narration: Narration, screenId: string, id: string): NarrationLine => {
  const line = narration.lines.find((candidate) => isRecord(candidate) && candidate.id === id);
  if (!line) throw new CommandError(`No line "${id}" in the narration of "${screenId}" (lines: ${narration.lines.map((candidate) => candidate.id).join(', ') || 'none'}).`);
  return line;
};

export interface UpdateNarrationArgs {
  screen: string;
  // A layer's narration (D62): it plays through, so only seek applies.
  layer?: string;
  advance?: Narration['advance'] | null;
  seek?: Narration['seek'] | null;
}

// How the narration advances and how far learners may seek (null: the default).
export function updateNarration(context: CommandContext, args: UpdateNarrationArgs): NoResult {
  if (args.layer !== undefined && args.advance !== undefined) throw new CommandError(`A layer's narration plays through when the layer opens: it has no advance (only seek).`);
  return editNarration(context, args.screen, (narration) => { assignFields(narration, args, ['advance', 'seek']); return {}; }, { layer: args.layer });
}

export interface AddNarrationLineArgs {
  screen: string;
  // A line of that layer's narration (D62); default: the screen's.
  layer?: string;
  line: Omit<NarrationLine, 'id'> & { id?: string };
  // After this line (null: first); default: last.
  after?: string | null;
}

export function addNarrationLine(context: CommandContext, { screen, layer, line, after }: AddNarrationLineArgs): CommandOutput<{ line: string }> {
  if (layer !== undefined && line.step !== undefined) throw new CommandError(`A layer's lines have no step: the layer's timeline is one stretch from its opening.`);
  return editNarration(context, screen, (narration, data) => {
    const ids = screenLineIds(data);
    if (line.id && ids.has(line.id)) throw new CommandError(`Screen "${screen}" already has a line "${line.id}" (ids are unique in the screen, every track counted).`);
    let id = line.id;
    for (let n = ids.size + 1; !id; n++) if (!ids.has(`l${n}`)) id = `l${n}`;
    const added = { ...line, id } as NarrationLine;
    if (after === null) narration.lines.unshift(added);
    else insertAt(narration.lines, added, { after });
    return { line: id };
  }, { create: true, layer });
}

export const LINE_FIELDS = ['text', 'speaker', 'step', 'pauseBefore', 'delivery', 'pronunciations'] as const;
export type UpdateNarrationLineArgs = { screen: string; line: string } & { [K in (typeof LINE_FIELDS)[number]]?: NarrationLine[K] | null };

// A line's text, speaker, step or pause (null: the default). A new text takes the line's word
// anchors with their words (reanchorLine): anchors whose words are gone are listed as lost.
export function updateNarrationLine(context: CommandContext, args: UpdateNarrationLineArgs): CommandOutput<{ anchors?: { moved: Reanchored[]; lost: Reanchored[] } }> {
  if (args.text === null) throw new CommandError('A line has a text: remove the line instead.');
  return editNarration(context, args.screen, (narration, screen, _draft, layer) => {
    const line = lineIn(narration, args.screen, args.line);
    if (layer !== null && typeof args.step === 'number') throw new CommandError(`Line "${args.line}" is said on layer "${layer}", whose timeline has no steps.`);
    const before = line.text;
    assignFields(line, args, LINE_FIELDS);
    if (typeof args.text !== 'string' || args.text === before) return {};
    const anchors = reanchorLine(screen, args.line, before, args.text, context.project().course?.language ?? '');
    return anchors.moved.length || anchors.lost.length ? { anchors } : {};
  }, { line: args.line });
}

export interface MoveNarrationLineArgs {
  screen: string;
  line: string;
  // After this line (null: first).
  after: string | null;
}

// Within the narration that holds it (a line moves to another narration by being removed and added).
export function moveNarrationLine(context: CommandContext, { screen, line, after }: MoveNarrationLineArgs): NoResult {
  return editNarration(context, screen, (narration) => {
    const moved = lineIn(narration, screen, line);
    narration.lines = narration.lines.filter((candidate) => candidate !== moved);
    if (after === null) narration.lines.unshift(moved);
    else insertAt(narration.lines, moved, { after });
    return {};
  }, { line });
}

// The voice-over the validated plan gives a screen: the lines of the items it covers, in the order
// of its covers (the app's « Reprendre la voix off du plan »). Empty: none.
export function planVoiceover(project: Pick<Project, 'plan' | 'screens'>, screenId: string): { item: string; speaker?: string; text: string }[] {
  const screen = project.screens.get(screenId)?.data;
  const items = new Map(objectsIn(project.plan?.items).map((item) => [item.id, item]));
  const covers = Array.isArray(screen?.covers) ? screen.covers : [];
  return covers.flatMap((id) => objectsIn(items.get(id)?.voiceover).map((line) => ({ item: id, ...(line.speaker ? { speaker: line.speaker } : {}), text: line.text })));
}

// The screen's script from the plan's voice-over: a line each, with its speaker when the course has
// it. A screen that has a narration keeps it unless replace (its lines' audio then goes with them).
export interface NarrationFromPlanArgs {
  screen: string;
  replace?: boolean;
}

export function narrationFromPlan(context: CommandContext, { screen: screenId, replace = false }: NarrationFromPlanArgs): CommandOutput<{ lines: string[] }> {
  const project = context.project();
  const voiceover = planVoiceover(project, screenId);
  if (!voiceover.length) throw new CommandError(`The plan gives no voice-over to screen "${screenId}" (plan items' voiceover, for the items it covers).`);
  const speakers = new Set(objectsIn(project.course?.speakers).map((speaker) => speaker.id));
  return editNarration(context, screenId, (narration, _screen, draft) => {
    if (narration.lines.length && !replace) throw new CommandError(`Screen "${screenId}" already has a narration: replace it to take the plan's voice-over.`);
    for (const path of pathsUnder(context.files, NARRATION_DIR)) {
      const match = /^assets\/narration\/[^/]+\/([^/]+)\/[^/]+\.(m4a|json)$/.exec(path);
      if (match && match[1] === screenId) draft.remove(path);
    }
    narration.lines = voiceover.map((line, index) => ({ id: `l${index + 1}`, ...(line.speaker && speakers.has(line.speaker) ? { speaker: line.speaker } : {}), text: line.text }));
    return { lines: narration.lines.map((line) => line.id) };
  }, { create: true });
}

// « Couper à une réplique » (W_SEGMENT_TOO_LONG): the line and those after it in its step start the
// next step, so Continue paces them. Every later step moves one on: its lines, its blocks, its
// settings (steps.<n>), the anchors that name it and reveal-step actions. Blocks of the cut step that
// come on a moved line (timing.in) move with it.
export interface SplitStepArgs {
  screen: string;
  line: string;
}

export function splitStep(context: CommandContext, { screen: screenId, line }: SplitStepArgs): CommandOutput<{ step: number; lines: string[]; blocks: string[] }> {
  return editNarration(context, screenId, (narration, screen, _draft, layer) => {
    if (layer !== null) throw new CommandError(`Line "${line}" is said on layer "${layer}", whose timeline has no steps to cut.`);
    const cut = lineIn(narration, screenId, line);
    const stepOf = (value: { step?: number }) => (typeof value.step === 'number' ? value.step : 1);
    const step = stepOf(cut);
    const index = narration.lines.indexOf(cut);
    const before = narration.lines.slice(0, index).filter((candidate) => stepOf(candidate) === step);
    if (!before.length) throw new CommandError(`Line "${line}" already starts step ${step} of "${screenId}": cut at a later line.`);
    const next = (n: number) => (n > step ? n + 1 : n);
    const moved = narration.lines.slice(index).filter((candidate) => stepOf(candidate) === step);
    for (const candidate of narration.lines) {
      if (moved.includes(candidate)) candidate.step = step + 1;
      else if (stepOf(candidate) > step) candidate.step = next(stepOf(candidate));
    }
    const movedIds = new Set(moved.map((candidate) => candidate.id));
    const blocks: string[] = [];
    for (const block of objectsIn(screen.blocks)) {
      const own = stepOf(block);
      const comes = isRecord(block.timing) && isRecord(block.timing.in) && isRecord(block.timing.in.at) ? block.timing.in.at : null;
      if (own === step && comes && typeof comes.line === 'string' && movedIds.has(comes.line)) { block.step = step + 1; blocks.push(block.id); }
      else if (own > step) block.step = next(own);
    }
    if (isRecord(screen.steps)) {
      const steps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(screen.steps)) steps[String(next(Number(key)))] = value;
      screen.steps = steps as Screen['steps'];
    }
    for (const { anchor, set } of screenAnchors(screen)) if (typeof anchor.step === 'number' && anchor.step > step) set({ ...anchor, step: next(anchor.step) });
    for (const event of objectsIn(screen.events)) {
      for (const action of [...objectsIn(event.do), ...objectsIn(event.else)]) if (action.type === 'reveal-step' && typeof action.step === 'number') action.step = next(action.step);
    }
    return { step: step + 1, lines: [...movedIds], blocks };
  }, { line });
}

// A line goes with its audio, in every language (the last line takes the narration with it).
export function removeNarrationLine(context: CommandContext, { screen, line }: { screen: string; line: string }): NoResult {
  return editNarration(context, screen, (narration, _screen, draft) => {
    const removed = lineIn(narration, screen, line);
    narration.lines = narration.lines.filter((candidate) => candidate !== removed);
    for (const path of pathsUnder(context.files, NARRATION_DIR)) {
      const match = /^assets\/narration\/[^/]+\/([^/]+)\/([^/]+)\.(m4a|json)$/.exec(path);
      if (match && match[1] === screen && match[2] === line) draft.remove(path);
    }
    return {};
  }, { line });
}

export interface RemoveSpeakerArgs {
  speaker: string;
  to?: string; // the speaker who says its lines from now on; none: they are left without a speaker
}

// A speaker leaves the course (course.json speakers, its voice in every language) in one change; the
// lines it says, on every screen, are said by another speaker (to), or by none. Their audio, made
// with its voice, is then out of date (W_NARRATION_AUDIO_STALE) until generated again.
export function removeSpeaker(context: CommandContext, { speaker, to }: RemoveSpeakerArgs): CommandOutput<{ lines: number; screens: string[] }> {
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const speakers = objectsIn(course.speakers);
  const ids = speakers.map((candidate) => candidate.id).filter((id): id is string => typeof id === 'string');
  if (!ids.includes(speaker)) throw new CommandError(`No speaker "${speaker}" in course.json (speakers: ${ids.join(', ') || 'none'}).`);
  if (to !== undefined && (to === speaker || !ids.includes(to))) throw new CommandError(`The lines of "${speaker}" go to another speaker of course.json (${ids.filter((id) => id !== speaker).join(', ') || 'none'}), not "${to}".`);
  const left = speakers.filter((candidate) => candidate.id !== speaker);
  if (left.length) course.speakers = left as Course['speakers'];
  else delete course.speakers;
  draft.writeJson('course.json', course);
  let lines = 0;
  const screens: string[] = [];
  for (const name of filesIn(context.files, 'screens').filter((candidate) => candidate.endsWith('.json'))) {
    const file = `screens/${name}`;
    const parsed = parseJSON(draft.text(file) ?? '');
    if (parsed.error !== undefined || !isRecord(parsed.value)) continue;
    const screen = parsed.value as Screen;
    let said = 0;
    for (const { line } of voiceLinesOf(screen, name.slice(0, -'.json'.length))) {
      if (line.speaker !== speaker) continue;
      if (to) line.speaker = to;
      else delete line.speaker;
      said++;
    }
    if (!said) continue;
    draft.writeJson(file, screen);
    lines += said;
    screens.push(name.slice(0, -'.json'.length));
  }
  return { files: draft.files(), result: { lines, screens } };
}

// The audio of a line from a file (a voice tool's M4A, or a recording: provider "recording", not
// generated), as @elabora/node (narration/audio.ts) takes it: it encodes and measures the file, then
// runs setNarrationAudio.
export interface NarrationAudioFileArgs {
  screen: string;
  line: string;
  language?: string;
  // The audio file (any format ffmpeg reads: an M4A in AAC mono is kept as it is).
  file: string;
  provider: string;
  voice: string;
  generated: boolean;
  words?: NarrationAudio['words'];
  // What timed the words (the forced-alignment model, or the voice itself).
  aligner?: string;
  // Which take of a voice that says a line differently each time; the credits it needs; its model.
  take?: number;
  credit?: string;
  model?: string;
  // Trim the silence at both ends (to 0.1 s): recordings.
  trim?: boolean;
}

export interface SetNarrationAudioArgs {
  screen: string;
  line: string;
  // Default: the course's language.
  language?: string;
  // The audio (AAC in M4A, mono), as the caller stored it: its size and hash (its bytes come with
  // the change).
  audio: { size: number; hash: FileHash };
  duration: number;
  provider: string;
  voice: string;
  generated: boolean;
  words?: NarrationAudio['words'];
  aligner?: string;
  take?: number;
  credit?: string;
  model?: string;
  createdAt?: string;
  // The mouth's envelope of the audio (narration/mouth.ts): what @elabora/node measured on it.
  mouth?: string;
}

// The audio of a line in a language and its sidecar, which records the text it says (its hash in
// that language), its length and its voice; for a generated voice, what it was told to say (after
// the pronunciations) and with which settings, as hashes the validator compares.
export function setNarrationAudio(context: CommandContext, args: SetNarrationAudioArgs): CommandOutput<{ audio: string; sidecar: string }> {
  const project = context.project();
  const language = args.language || project.course?.language;
  if (!language) throw new CommandError('The course has no language.');
  const lines = narrationLines(project, args.screen, language);
  if (!lines) throw new CommandError(`Screen "${args.screen}" has no narration.`);
  const line = lines.find((candidate) => candidate.id === args.line);
  if (!line) throw new CommandError(`No line "${args.line}" in the narration of "${args.screen}" (lines: ${lines.map((candidate) => candidate.id).join(', ')}).`);
  if (!line.textHash) throw new CommandError(`Line "${args.line}" of "${args.screen}" is not translated into ${language} yet: translate it first (its audio says its text).`);
  if (!(args.duration > 0)) throw new CommandError('The audio has no length.');
  const draft = new Draft(context.files);
  const audio = narrationAudioPath(language, args.screen, args.line);
  const sidecar = narrationSidecarPath(language, args.screen, args.line);
  draft.writeFile(audio, binaryFile(args.audio.size, { hash: args.audio.hash }));
  const record: NarrationAudio = {
    screen: args.screen, line: args.line, language, textHash: line.textHash, duration: Math.round(args.duration * 1000) / 1000,
    provider: args.provider, voice: args.voice, generated: args.generated, audioHash: args.audio.hash,
    ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    ...(args.take ? { take: args.take } : {}),
    ...(args.generated && line.spokenHash ? { spokenHash: line.spokenHash, settingsHash: line.settingsHash } : {}),
    ...(args.credit ? { credit: args.credit } : {}), ...(args.model ? { model: args.model } : {}),
    ...(line.text ? { text: line.text } : {}),
    ...(args.mouth !== undefined && isMouth(args.mouth) ? { mouth: args.mouth } : {}),
    ...(args.words?.length ? { ...(args.aligner ? { aligner: args.aligner } : {}), words: args.words } : {})
  };
  draft.writeJson(sidecar, record);
  return { files: draft.files(), result: { audio, sidecar } };
}

// « La voix dit bien ce texte »: the line's text was corrected (a transcription checked, a typo, its
// punctuation) and its audio still says it: the sidecar takes the current text, and its words follow
// by a word diff. Only for a line out of date because of its text alone.
export interface KeepNarrationAudioArgs {
  screen: string;
  line: string;
  language?: string;
}

export function keepNarrationAudio(context: CommandContext, args: KeepNarrationAudioArgs): CommandOutput<{ sidecar: string }> {
  const project = context.project();
  const language = args.language || project.course?.language;
  if (!language) throw new CommandError('The course has no language.');
  const line = narrationLines(project, args.screen, language)?.find((candidate) => candidate.id === args.line);
  if (!line) throw new CommandError(`No line "${args.line}" in the narration of "${args.screen}".`);
  if (line.status !== 'stale' || line.causes.some((cause) => cause !== 'text') || !line.text || !line.textHash) {
    throw new CommandError(line.status === 'stale' ? `The audio of line "${args.line}" is out of date for another reason too (${line.reasons.join('; ')}): make or import it again.` : `The audio of line "${args.line}" is ${line.status === 'ok' ? 'up to date' : line.status}: nothing to keep.`);
  }
  const path = narrationSidecarPath(language, args.screen, args.line);
  const { sidecar } = readNarrationSidecar(project.files, path);
  if (!sidecar) throw new CommandError(`Line "${args.line}" has no sidecar ${path}.`);
  // Its words, followed through the corrected text, as the timeline already places them.
  // (only those it found: a new word stays placed in proportion until the line is aligned again).
  const followed = sidecar.words?.length ? lineWordTimes(line.text, sidecar.duration, sidecar.words, language).filter((word) => !word.estimated) : [];
  const words = followed.length ? followed.map(({ text, start, end, score }) => ({ text, start, end, ...(score === undefined ? {} : { score }) })) : undefined;
  const { words: _words, ...rest } = sidecar;
  const draft = new Draft(context.files);
  draft.writeJson(path, { ...rest, textHash: line.textHash, ...(sidecar.spokenHash && line.spokenHash ? { spokenHash: line.spokenHash } : {}), text: line.text, ...(words ? { words } : {}) });
  return { files: draft.files(), result: { sidecar: path } };
}

// The word times of a line's audio (forced alignment, elabora narration align): written into its
// sidecar with the text they time and what timed them. audioHash: the audio they were measured on
// (refused when the line's audio has changed since).
export interface SetNarrationWordsArgs {
  screen: string;
  line: string;
  language?: string;
  audioHash?: FileHash;
  words: NonNullable<NarrationAudio['words']>;
  aligner: string;
  // The mouth's envelope measured again with these words (the one the sidecar has stays without it).
  mouth?: string;
}

export function setNarrationWords(context: CommandContext, args: SetNarrationWordsArgs): CommandOutput<{ sidecar: string; words: number }> {
  const project = context.project();
  const language = args.language || project.course?.language;
  if (!language) throw new CommandError('The course has no language.');
  const line = narrationLines(project, args.screen, language)?.find((candidate) => candidate.id === args.line);
  if (!line) throw new CommandError(`No line "${args.line}" in the narration of "${args.screen}".`);
  const path = narrationSidecarPath(language, args.screen, args.line);
  const { sidecar, error } = readNarrationSidecar(project.files, path);
  if (!sidecar) throw new CommandError(`Line "${args.line}" of "${args.screen}" has no audio in ${language} to time${error ? ` (${path}: ${error})` : ''}.`);
  if (args.audioHash && sidecar.audioHash !== args.audioHash) throw new CommandError(`The audio of line "${args.line}" changed while its words were timed: time them again.`);
  if (line.textHash !== sidecar.textHash || !line.text) throw new CommandError(`The audio of line "${args.line}" says an older text: make or import it again before timing its words.`);
  const { words: _words, aligner: _aligner, text: _text, ...rest } = sidecar;
  const draft = new Draft(context.files);
  draft.writeJson(path, { ...rest, ...(args.mouth !== undefined && isMouth(args.mouth) ? { mouth: args.mouth } : {}), text: line.text, aligner: args.aligner, words: args.words });
  return { files: draft.files(), result: { sidecar: path, words: args.words.length } };
}

// ── Lines from their audio (docs/decisions.md D46) ───────────────────

// A command's files read as the project the next one starts from: two commands written as one
// undoable change.
const after = (context: CommandContext, files: ProjectFiles): CommandContext => commandContext(files, { now: context.now });

// « Nouvelle réplique depuis un fichier audio… »: a line and its audio in one change. The text is
// what the recording says (a transcription the author checked, or typed), the audio a recording
// (provider "recording", not generated), its words timed on that text when they were. The line goes
// after `after` (null: first; default: last), in its step unless step says another; its speaker is
// given, or the one of the line before it.
export interface AddNarrationLineWithAudioArgs extends Omit<SetNarrationAudioArgs, 'line'> {
  line: Omit<NarrationLine, 'id'> & { id?: string };
  after?: string | null;
  // A line of that layer's narration (D62); default: the screen's.
  layer?: string;
}

export function addNarrationLineWithAudio(context: CommandContext, args: AddNarrationLineWithAudioArgs): CommandOutput<{ line: string; audio: string; sidecar: string }> {
  const project = context.project();
  const language = args.language || project.course?.language;
  if (!language) throw new CommandError('The course has no language.');
  if (language !== project.course?.language) throw new CommandError(`A line is written in the course's language (${project.course?.language}): its translations come from it.`);
  if (!args.line.text?.trim()) throw new CommandError('A line made from a recording needs its text: what the recording says.');
  const { line: _line, after: _after, layer, ...audio } = args;
  const added = addNarrationLine(context, { screen: args.screen, ...(layer !== undefined ? { layer } : {}), line: { ...placed(project, args.screen, args.after, layer), ...args.line }, ...(args.after !== undefined ? { after: args.after } : {}) });
  if (!added.files) throw new CommandError('The line could not be added.');
  const voiced = setNarrationAudio(after(context, added.files), { ...audio, screen: args.screen, line: added.result.line, language });
  if (!voiced.files) throw new CommandError('The audio could not be written.');
  return { files: voiced.files, result: { line: added.result.line, ...voiced.result } };
}

// The step and speaker of a line added after another (or last): those of the line before it, in the
// screen's narration or in the layer's (whose lines have no step).
function placed(project: Project, screenId: string, after: string | null | undefined, layer?: string): { step?: number; speaker?: string } {
  const screen = project.screens.get(screenId)?.data;
  const lines: NarrationLine[] = layer === undefined ? screen?.narration?.lines ?? [] : objectsIn(screen?.layers).find((candidate) => candidate.id === layer)?.narration?.lines ?? [];
  const before = after === null ? undefined : after === undefined ? lines.at(-1) : lines.find((line) => line.id === after);
  if (!before) return {};
  return { ...(typeof before.step === 'number' && layer === undefined ? { step: before.step } : {}), ...(typeof before.speaker === 'string' ? { speaker: before.speaker } : {}) };
}

// « Régénérer le texte d'après l'audio »: the line's text becomes what its recording says, and the
// recording stays its audio, up to date for that text; its word anchors follow the new words (as
// any text edit), its translations are « changed since » (their source changed), and its words take
// the times given (timed on the new text) or else follow by a word diff. Only for a recording in the
// course's language: a generated voice says its text by construction. audioHash: the audio the text
// was heard in (refused when the line's audio changed since).
export interface SetNarrationTextFromAudioArgs {
  screen: string;
  line: string;
  language?: string;
  text: string;
  audioHash?: FileHash;
  words?: NarrationAudio['words'];
  aligner?: string;
}

export function setNarrationTextFromAudio(context: CommandContext, args: SetNarrationTextFromAudioArgs): CommandOutput<{ sidecar: string; before: string; text: string; anchors?: { moved: Reanchored[]; lost: Reanchored[] } }> {
  const project = context.project();
  const language = args.language || project.course?.language;
  if (!language) throw new CommandError('The course has no language.');
  if (language !== project.course?.language) throw new CommandError(`Only the course's language (${project.course?.language}) is written from its audio: a translation's text is written in the translation.`);
  const text = args.text.replace(/\s+/g, ' ').trim();
  if (!text) throw new CommandError('The recording says nothing that could be written: the line keeps its text.');
  const line = narrationLines(project, args.screen, language)?.find((candidate) => candidate.id === args.line);
  if (!line) throw new CommandError(`No line "${args.line}" in the narration of "${args.screen}".`);
  const path = narrationSidecarPath(language, args.screen, args.line);
  const { sidecar } = readNarrationSidecar(project.files, path);
  if (!sidecar || line.status === 'missing') throw new CommandError(`Line "${args.line}" has no audio to read its text from: import a recording first.`);
  if (sidecar.generated) throw new CommandError(`Line "${args.line}" is said by a generated voice, which says its text: change the text, then generate it again.`);
  if (args.audioHash && sidecar.audioHash !== args.audioHash) throw new CommandError(`The audio of line "${args.line}" changed while it was transcribed: transcribe it again.`);
  const before = line.text ?? '';
  let files = context.files;
  let anchors: { moved: Reanchored[]; lost: Reanchored[] } | undefined;
  if (text !== before && line.track.kind === 'dialogue') {
    // A dialogue's line (D61): its text where the block holds it (a node's line, a reply, the
    // learner's answer); its cues are checked against the new words (E_DIALOGUE_CUE).
    const draft = new Draft(context.files);
    const file = screenFile(args.screen);
    const screen = draft.json<Screen>(file);
    const holder = line.path.split('/').slice(1).reduce<unknown>((node, key) => (isRecord(node) || Array.isArray(node) ? (node as Record<string, unknown>)[key] : undefined), screen);
    if (!isRecord(holder)) throw new CommandError(`Line "${args.line}" is no longer where the dialogue held it (${line.path}).`);
    holder.text = text;
    draft.writeJson(file, screen);
    files = draft.files();
  } else if (text !== before) {
    const edited = updateNarrationLine(context, { screen: args.screen, line: args.line, text });
    files = edited.files!;
    anchors = edited.result.anchors;
  }
  // The audio says the new text: its sidecar takes it (keepNarrationAudio, only when the text was
  // what made it out of date), then the words timed on it.
  const current = narrationLines(after(context, files).project(), args.screen, language)!.find((candidate) => candidate.id === args.line)!;
  if (current.status === 'stale' && current.causes.every((cause) => cause === 'text')) files = keepNarrationAudio(after(context, files), { screen: args.screen, line: args.line, language }).files!;
  if (args.words?.length && args.aligner) files = setNarrationWords(after(context, files), { screen: args.screen, line: args.line, language, words: args.words, aligner: args.aligner }).files!;
  return { files, result: { sidecar: path, before, text, ...(anchors ? { anchors } : {}) } };
}
