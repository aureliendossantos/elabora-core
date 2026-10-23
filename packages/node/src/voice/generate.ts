import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { narrationLines, lineSpeaker } from '@elabora/core/narration/narration';
import { trackKey } from '@elabora/core/narration/voice-lines';
import type { NarrationLineInfo } from '@elabora/core/narration/narration';
import type { Speaker } from '@elabora/format';
import { loadProjectFromDir } from '../project-reader.ts';
import { projectDataDir } from '../data-dir.ts';
import { setNarrationAudio } from '../narration/audio.ts';
import type { NarrationAudioArgs } from '../narration/audio.ts';
import type { Project } from '@elabora/core/project/model';
import { updateCourseSettings, updateNarrationLine } from '../edit/index.ts';
import type { EditOptions } from '../edit/index.ts';
import { findMediaTools } from '../media/tools.ts';
import { runFfmpeg } from '../media/encode.ts';
import { alignsAtOnce, alignAudio } from '../align/index.ts';
import { spokenWords } from '../align/spoken.ts';
import { APPROVAL_SHARE, covers, needsApproval, quotaPercent, shareOf } from '@elabora/core/ai/quota';
import { VoiceError, resolveVoice, speaks, voiceProvider } from './provider.ts';
import type { VoiceProvider } from './provider.ts';
import type { InstallProgress, VoiceProgress, LineResult, GenerateResult, TakeInfo, VoiceEstimate } from './types.ts';
export type { VoiceProgress, LineResult, GenerateResult, TakeInfo, VoiceEstimate } from './types.ts';

// Generated narration (docs/decisions.md D24, D25): a voice says the lines of a narrated screen,
// each result written as the line's audio with its sidecar (setNarrationAudio: one journaled,
// undoable change per line). Every generation is a take: a voice that says a line differently each
// time keeps its takes in the project's machine-local data (<data>/voice-takes/<language>/<screen>/
// <line>/take-<n>.wav and .json), never in the course, and one of them is the line's audio. The
// speaker's voice is course.json speakers[].voices[<language>] = { provider, voice, settings }.
// A paid voice (ElevenLabs, D29) spends the author's quota, told as a share of the month's (D30): under
// 1 % of it a generation simply runs; from 1 % it needs the author's approval (approvedPercent, the
// share estimated first: estimateNarration), and a generation stops once the service charged half as
// much again as it was allowed. A line out of date gets back an earlier take of the same text, voice
// and delivery rather than a new one, and lines of several speakers that follow each other in a step
// can be said as one exchange (dialogue), then cut into lines.

export interface GenerateOptions {
  screen: string;
  lines?: string[];        // default: the lines missing or out of date
  all?: boolean;           // every line of the screen, a new take each
  language?: string;       // default: the course's
  voice?: string;          // set this voice for the speaker of the lines first
  take?: number;           // put back this take of the line (one line) instead of making one
  provider?: string;       // of voice, when its id alone is not enough (a voice service's)
  // The share of the month's quota the author approved for paid voices, in percent (the figure they
  // were told: estimateNarration's percent). Not needed under 1 % of the quota; from it, the lines
  // are refused without it (E_VOICE_SPEND, with the estimate). dialogue: say the lines of several
  // speakers that follow each other in a step as one exchange (ElevenLabs), the whole run again.
  approvedPercent?: number;
  dialogue?: boolean;
  onProgress?: (progress: VoiceProgress) => void;
  signal?: AbortSignal;
}

// Who writes the results: by default the edits of @elabora/node on the folder (the CLI, the MCP
// server); the desktop app's engine passes its session, whose write queue and snapshot they go through.
export interface VoiceWriter {
  project(): Project;
  setNarrationAudio(args: NarrationAudioArgs): Promise<{ audio?: string; seq: number | null; alignmentError?: string }>;
  updateSpeakers(speakers: Speaker[]): Promise<number | null>;
  // A line's pause before it (a dialogue's rhythm); a writer without it leaves the pauses.
  updateLinePause?(screen: string, line: string, pause: number): Promise<number | null>;
}

export function folderWriter(dir: string, editOptions?: EditOptions): VoiceWriter {
  return {
    project: () => loadProjectFromDir(dir),
    async setNarrationAudio(args) {
      const written = await setNarrationAudio(dir, args, editOptions);
      return { audio: written.audio, seq: written.change?.seq ?? null, ...(written.alignmentError ? { alignmentError: written.alignmentError } : {}) };
    },
    async updateSpeakers(speakers) {
      const written = await updateCourseSettings(dir, { speakers } as Parameters<typeof updateCourseSettings>[1], editOptions);
      return written.change?.seq ?? null;
    },
    async updateLinePause(screen, line, pause) {
      const written = await updateNarrationLine(dir, { screen, line, pauseBefore: pause }, editOptions);
      return written.change?.seq ?? null;
    }
  };
}

const takesDir = (dir: string, language: string, screen: string, line: string) => path.join(projectDataDir(dir), 'voice-takes', language, screen, line);

function readTakes(dir: string, language: string, screen: string, line: string): Omit<TakeInfo, 'current' | 'usable'>[] {
  const folder = takesDir(dir, language, screen, line);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => /^take-\d+\.json$/.test(name)).flatMap((name) => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as Omit<TakeInfo, 'current' | 'usable' | 'file'>;
      const file = path.join(folder, name.replace(/\.json$/, '.wav'));
      return fs.existsSync(file) ? [{ ...meta, file }] : [];
    } catch { return []; }
  }).sort((a, b) => a.take - b.take);
}

function speakerVoice(speaker: Speaker | null, language: string): { provider: string; voice: string; name?: string } | null {
  const voice = speaker?.voices?.[language];
  return voice && typeof voice.provider === 'string' && typeof voice.voice === 'string' ? { provider: voice.provider, voice: voice.voice, ...(typeof voice.name === 'string' ? { name: voice.name } : {}) } : null;
}

// The takes of a line: which one is its audio, and which can be put back (same text, voice, settings).
export function voiceTakes(dir: string, { screen, line, language }: { screen: string; line: string; language?: string }, project: Project = loadProjectFromDir(dir)): { language: string; takes: TakeInfo[] } {
  const lang = language || project.course?.language || '';
  const info = narrationLines(project, screen, lang)?.find((candidate) => candidate.id === line);
  if (!info) throw new VoiceError('E_VOICE_LINE', `Screen "${screen}" has no narration line "${line}".`);
  const voice = speakerVoice(lineSpeaker(project.course, { speaker: info.speaker ?? undefined }), lang);
  const takes = readTakes(dir, lang, screen, line).map((take) => ({
    ...take,
    current: info.take === take.take && info.status !== 'missing',
    usable: take.spokenHash === info.spokenHash && take.settingsHash === info.settingsHash && !!voice && take.provider === voice.provider && take.voice === voice.voice
  }));
  return { language: lang, takes };
}

// The exchange a take was cut from (dialogue, D29), or null: read from its metadata on this computer.
export function takeDialogue(dir: string, { screen, line, language, take }: { screen: string; line: string; language: string; take: number }): string | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(takesDir(dir, language, screen, line), `take-${take}.json`), 'utf8')) as { dialogue?: unknown };
    return typeof meta.dialogue === 'string' ? meta.dialogue : null;
  } catch {
    return null;
  }
}

const seedOf = (...parts: (string | number)[]): number => crypto.createHash('sha256').update(parts.join('\0')).digest().readUInt32LE(0);

function wavBytes(samples: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + samples.length * 2, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return out;
}

const speedOf = (settings: Record<string, unknown>): number => {
  const speed = settings.speed;
  // ffmpeg's atempo keeps the pitch; past 0.8 and 1.25 a voice sounds stretched.
  return typeof speed === 'number' && Number.isFinite(speed) ? Math.min(1.25, Math.max(0.8, speed)) : 1;
};

// What would be made, line by line: the lines selected, those that get back a usable take at no
// cost, the runs said as one exchange, and what paid voices would cost at most.
interface Plan {
  language: string;
  todo: NarrationLineInfo[];
  skipped: NarrationLineInfo[];
  reuse: Map<string, TakeInfo>;
  dialogues: NarrationLineInfo[][];
  estimate: VoiceEstimate;
}

const DIALOGUE_CHARACTERS = 2000;

async function planNarration(dir: string, project: Project, infos: NarrationLineInfo[], options: GenerateOptions, language: string): Promise<Plan> {
  const voiceOf = (info: NarrationLineInfo) => speakerVoice(lineSpeaker(project.course, { speaker: info.speaker ?? undefined }), language);
  const selected = infos.filter((info) => options.lines ? options.lines.includes(info.id) : options.all || info.status === 'missing' || info.status === 'stale');
  // Every voice is checked before anything is made: no half-made screen for a missing voice.
  for (const info of selected) {
    if (info.status === 'untranslated') continue;
    const voice = voiceOf(info);
    if (!voice) throw new VoiceError('E_VOICE_NOT_SET', `Speaker "${info.speaker ?? '(none)'}" of line ${info.id} has no voice in ${language}: elabora voice set ${info.speaker ?? '<speaker>'} <voice> --language ${language} (elabora voice list --language ${language}).`);
    voiceProvider(voice.provider);
  }
  const skipped = selected.filter((info) => info.status === 'untranslated');
  let todo = selected.filter((info) => info.status !== 'untranslated');
  const paid = (info: NarrationLineInfo) => !!voiceProvider(voiceOf(info)!.provider).paid;

  // A paid line missing or out of date whose earlier take was made from the same text, voice and
  // delivery (an undo, a voice set back) gets that take back: nothing is spent twice.
  const reuse = new Map<string, TakeInfo>();
  if (!options.all && !options.dialogue) {
    for (const info of todo) {
      if (!paid(info) || (info.status !== 'missing' && info.status !== 'stale')) continue;
      const usable = voiceTakes(dir, { screen: options.screen, line: info.id, language }, project).takes.filter((take) => take.usable).at(-1);
      if (usable) reuse.set(info.id, usable);
    }
  }

  // Runs of a step's lines said by ElevenLabs voices of the same model, two speakers or more: said
  // together, the whole run (an exchange needs every turn), in requests of at most 2,000 characters.
  const dialogues: NarrationLineInfo[][] = [];
  if (options.dialogue) {
    const dialogueModel = (info: NarrationLineInfo): string | null => {
      const voice = voiceOf(info);
      if (!voice || !voiceProvider(voice.provider).synthesizeDialogue || info.status === 'untranslated') return null;
      return typeof info.settings.model === 'string' ? info.settings.model : 'default';
    };
    let run: NarrationLineInfo[] = [];
    const close = () => {
      if (run.length > 1 && new Set(run.map((info) => info.speaker)).size > 1 && run.some((info) => todo.includes(info))) {
        let part: NarrationLineInfo[] = [];
        let size = 0;
        for (const info of run) {
          const length = (info.spoken ?? '').length;
          if (part.length && size + length > DIALOGUE_CHARACTERS) { dialogues.push(part); part = []; size = 0; }
          part.push(info);
          size += length;
        }
        if (part.length) dialogues.push(part);
      }
      run = [];
    };
    for (const info of infos) {
      const model = dialogueModel(info);
      const previous = run.at(-1);
      // An exchange stays in one step of one track: a layer's lines, or a dialogue's, are said apart.
      if (!model || (previous && (previous.step !== info.step || trackKey(previous.track) !== trackKey(info.track) || dialogueModel(previous) !== model))) close();
      if (model) run.push(info);
    }
    close();
    const inDialogue = new Set(dialogues.flat().map((info) => info.id));
    todo = infos.filter((info) => todo.includes(info) || inDialogue.has(info.id));
    for (const id of inDialogue) reuse.delete(id);
  }

  const estimate: VoiceEstimate = { screen: options.screen, language, lines: [], characters: 0, credits: 0, ceiling: 0, free: 0, reused: 0, quota: null, percent: null, needsApproval: false };
  let paidProvider: VoiceProvider | null = null;
  const dialogueOf = new Map(dialogues.flatMap((run, index) => run.map((info) => [info.id, `${options.screen}-${index + 1}`] as const)));
  for (const info of todo) {
    const voice = voiceOf(info)!;
    const provider = voiceProvider(voice.provider);
    const dialogue = dialogueOf.get(info.id);
    if (reuse.has(info.id)) {
      estimate.reused++;
      estimate.lines.push({ line: info.id, provider: voice.provider, voice: voice.voice, characters: 0, credits: 0, ceiling: 0, reuse: reuse.get(info.id)!.take });
    } else if (provider.paid && provider.estimate) {
      const cost = await provider.estimate(info.spoken ?? '', voice.voice, info.settings);
      estimate.characters += cost.characters;
      estimate.credits += cost.credits;
      estimate.ceiling += cost.ceiling;
      paidProvider ??= provider;
      estimate.lines.push({ line: info.id, provider: voice.provider, voice: voice.voice, characters: cost.characters, credits: cost.credits, ceiling: cost.ceiling, ...(dialogue ? { dialogue } : {}) });
    } else {
      estimate.free++;
      estimate.lines.push({ line: info.id, provider: voice.provider, voice: voice.voice, characters: 0, credits: 0, ceiling: 0 });
    }
  }
  // What it is of the month's quota (D30): the key must be able to read it (User: read).
  if (estimate.credits > 0 && paidProvider?.quota) {
    try {
      const quota = await paidProvider.quota(options.signal);
      estimate.quota = { plan: quota.plan, limit: quota.limit, used: quota.used, resetsAt: quota.resetsAt };
      estimate.percent = quotaPercent(shareOf(estimate.credits, quota.limit));
    } catch (error) {
      if (error instanceof VoiceError && error.code === 'E_VOICE_KEY_PERMISSION') throw new VoiceError('E_VOICE_KEY_PERMISSION', `The ${paidProvider.name} key may not read your quota (User: read): Elabora needs it to tell what generating costs. Give the key this permission on https://elevenlabs.io/app/settings/api-keys.`);
      throw error;
    }
  }
  estimate.needsApproval = needsApproval(estimate.credits, estimate.quota);
  return { language, todo, skipped, reuse, dialogues, estimate };
}

function linesOf(project: Project, screen: string, language: string, lines?: string[]): NarrationLineInfo[] {
  const infos = narrationLines(project, screen, language);
  if (!project.screens.has(screen)) throw new VoiceError('E_VOICE_SCREEN', `Unknown screen "${screen}".`);
  if (!infos) throw new VoiceError('E_VOICE_SCREEN', `Screen "${screen}" has no narration (screens/${screen}.json narration.lines, or a layer's layers[].narration.lines).`);
  for (const id of lines ?? []) if (!infos.some((info) => info.id === id)) throw new VoiceError('E_VOICE_LINE', `Screen "${screen}" has no narration line "${id}" (its lines: ${infos.map((info) => info.id).join(', ')}).`);
  return infos;
}

// What generating would make and cost, without spending anything (« Générer » shows it first; an
// agent asks the author before spending).
export async function estimateNarration(dir: string, options: GenerateOptions, writer: VoiceWriter = folderWriter(dir)): Promise<VoiceEstimate> {
  const project = writer.project();
  const course = project.course;
  if (!course) throw new VoiceError('E_VOICE_COURSE', `${path.resolve(dir)} is not an Elabora course (no course.json).`);
  const language = options.language || course.language;
  return (await planNarration(dir, project, linesOf(project, options.screen, language, options.lines), options, language)).estimate;
}

export async function generateNarration(dir: string, options: GenerateOptions, editOptions?: EditOptions, writer: VoiceWriter = folderWriter(dir, editOptions)): Promise<GenerateResult> {
  const { screen, onProgress, signal } = options;
  const writeAudio = (args: NarrationAudioArgs) => writer.setNarrationAudio({ ...args,
    onAlign: () => onProgress?.({ phase: 'align', line: args.line, fraction: 0 })
  });
  let project = writer.project();
  const course = project.course;
  if (!course) throw new VoiceError('E_VOICE_COURSE', `${path.resolve(dir)} is not an Elabora course (no course.json).`);
  const language = options.language || course.language;
  let infos = linesOf(project, screen, language, options.lines);
  if (options.take !== undefined && options.lines?.length !== 1) throw new VoiceError('E_VOICE_TAKE', 'Putting back a take is for one line: give the line too.');
  const changes: number[] = [];
  const result: GenerateResult = { screen, language, lines: [], changes, credits: [] };

  // --voice: the voice of the speaker of these lines (one speaker), recorded in course.json first.
  if (options.voice) {
    const voice = await resolveVoice(options.voice, options.provider, signal);
    if (!voice) throw new VoiceError('E_VOICE_UNKNOWN', `Unknown voice "${options.voice}" (elabora voice list --language ${language}, elabora voice search).`);
    if (!speaks(voice, language)) throw new VoiceError('E_VOICE_LANGUAGE', `The voice "${voice.id}" speaks ${voice.language}, not ${language}.`);
    const targeted = infos.filter((info) => !options.lines || options.lines.includes(info.id));
    const speakers = [...new Set(targeted.map((info) => info.speaker))];
    if (speakers.length !== 1 || !speakers[0]) throw new VoiceError('E_VOICE_SPEAKERS', speakers.some((s) => !s)
      ? 'A line has no speaker in course.json speakers: add the speakers first.'
      : `These lines have several speakers (${speakers.join(', ')}): give --line, or set each speaker's voice (elabora voice set <speaker> <voice>).`);
    const speakerId = speakers[0];
    const current = speakerVoice(lineSpeaker(course, { speaker: speakerId }), language);
    if (current?.provider !== voice.provider || current?.voice !== voice.id) {
      const change = await setSpeakerVoice(dir, { speaker: speakerId, voice: voice.id, provider: voice.provider, language }, editOptions, writer);
      if (change !== null) changes.push(change);
      project = writer.project();
      infos = narrationLines(project, screen, language) ?? infos;
    }
    result.voiceSet = { speaker: speakerId, provider: voice.provider, voice: voice.id };
  }

  if (options.take !== undefined) {
    const info = infos.find((candidate) => candidate.id === options.lines![0])!;
    const take = voiceTakes(dir, { screen, line: info.id, language }, project).takes.find((candidate) => candidate.take === options.take);
    if (!take) throw new VoiceError('E_VOICE_TAKE', `Line ${info.id} has no take ${options.take} in ${language} (elabora voice takes ${screen} ${info.id}).`);
    if (!take.usable) throw new VoiceError('E_VOICE_TAKE', `Take ${options.take} of line ${info.id} was made from another text, voice or delivery: it would be out of date at once.`);
    const written = await writeAudio({ screen, line: info.id, language, file: take.file, provider: take.provider, voice: take.voice, generated: true, take: take.take, credit: take.credit, model: take.model, trim: true });
    if (written.seq !== null) changes.push(written.seq);
    result.lines.push({ line: info.id, status: 'selected', take: take.take, audio: written.audio, provider: take.provider, voice: take.voice, ...(written.alignmentError ? { alignmentError: written.alignmentError } : {}) });
    result.credits = [take.credit];
    return result;
  }

  const plan = await planNarration(dir, project, infos, options, language);
  // Paid voices: from 1 % of the month's quota, nothing without the author's approval (D30).
  const { estimate } = plan;
  const limit = estimate.quota?.limit ?? 0;
  const approved = options.approvedPercent;
  if (estimate.needsApproval && !(approved !== undefined && covers(approved, shareOf(estimate.credits, limit)))) {
    const share = estimate.percent === null ? 'an unknown share of the author\'s monthly quota' : `~${estimate.percent} % of the author's monthly quota`;
    const error = new VoiceError('E_VOICE_SPEND', `Generating ${estimate.lines.filter((line) => line.credits).length} line(s) of ${screen} with a paid voice uses ${share}${approved !== undefined ? ` (more than the ${approved} % approved)` : ''}: ask the author, then approve it (--spend ${estimate.percent ?? '<percent>'}, MCP approvedPercent).`);
    Object.assign(error, { estimate });
    throw error;
  }
  // What it may be charged before it stops: half as much again as allowed (the threshold, the
  // approval or the estimate, the largest), so that only a service charging far more is stopped.
  const allowedShare = 1.5 * Math.max(APPROVAL_SHARE, approved !== undefined ? approved / 100 : 0, shareOf(estimate.credits, limit));
  const allowedCredits = limit > 0 ? allowedShare * limit : Number.POSITIVE_INFINITY;
  const tools = await findMediaTools();
  for (const info of plan.skipped) result.lines.push({ line: info.id, status: 'skipped', reason: `not translated into ${language} yet` });
  const voiceOf = (info: NarrationLineInfo) => speakerVoice(lineSpeaker(project.course, { speaker: info.speaker ?? undefined }), language)!;
  const spent = new Map<string, { provider: string; characters: number; estimate: number; credits: number | null; percent: number | null }>();
  let charged = 0; // credits charged so far (or expected, where the service did not say)
  const spend = (provider: string, characters: number, expected: number, cost: number | null | undefined) => {
    const entry = spent.get(provider) ?? { provider, characters: 0, estimate: 0, credits: null, percent: null };
    entry.characters += characters;
    entry.estimate += expected;
    if (typeof cost === 'number') entry.credits = (entry.credits ?? 0) + cost;
    charged += typeof cost === 'number' ? cost : expected;
    entry.percent = limit > 0 ? quotaPercent(shareOf(entry.credits ?? entry.estimate, limit)) : null;
    spent.set(provider, entry);
  };
  // Before a paid request: would it pass what this generation may be charged?
  const overBudget = (expected: number): boolean => {
    if (charged + expected <= allowedCredits) return false;
    result.overBudget = { allowedPercent: quotaPercent(allowedShare), spentPercent: quotaPercent(shareOf(charged, limit)) };
    return true;
  };
  const estimated = new Map(estimate.lines.map((line) => [line.line, line]));

  // A take's audio written as the line's, with its words when the provider timed them and no word
  // aligner of the language is on this computer (the aligner is more precise: D27, D29).
  const keep = async (info: NarrationLineInfo, voice: { provider: string; voice: string }, take: number, seed: number, spoken: { samples: Float32Array; sampleRate: number; model: string; credit: string; retries: number; words?: { text: string; start: number; end: number }[] }, extra: { dialogue?: string; seconds: number; cached?: boolean }, speed = 1) => {
    const folder = takesDir(dir, language, screen, info.id);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `take-${take}.wav`);
    if (speed !== 1) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-voice-'));
      try {
        fs.writeFileSync(path.join(temp, 'line.wav'), wavBytes(spoken.samples, spoken.sampleRate));
        await runFfmpeg(tools, ['-nostdin', '-v', 'error', '-y', '-i', path.join(temp, 'line.wav'), '-af', `atempo=${speed}`, '-c:a', 'pcm_s16le', file], { signal });
      } finally { fs.rmSync(temp, { recursive: true, force: true }); }
    } else {
      fs.writeFileSync(file, wavBytes(spoken.samples, spoken.sampleRate));
    }
    const meta: Omit<TakeInfo, 'file' | 'current' | 'usable'> = {
      take, provider: voice.provider, voice: voice.voice, spokenHash: info.spokenHash ?? '', settingsHash: info.settingsHash, seed,
      model: spoken.model, credit: spoken.credit, createdAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), retries: spoken.retries, ...(extra.dialogue ? { dialogue: extra.dialogue } : {})
    };
    fs.writeFileSync(path.join(folder, `take-${take}.json`), `${JSON.stringify(meta, null, 2)}\n`);
    const words = spoken.words?.length && speed === 1 && !alignsAtOnce(language) ? { words: spoken.words, aligner: voice.provider } : {};
    const written = await writeAudio({ screen, line: info.id, language, file, provider: voice.provider, voice: voice.voice, generated: true, take, credit: spoken.credit, model: spoken.model, trim: true, ...words });
    if (written.seq !== null) changes.push(written.seq);
    credits.add(spoken.credit);
    result.lines.push({ line: info.id, status: 'generated', take, audio: written.audio, provider: voice.provider, voice: voice.voice, retries: spoken.retries, seconds: Math.round(extra.seconds * 10) / 10, ...(extra.dialogue ? { dialogue: extra.dialogue } : {}), ...(extra.cached ? { cached: true } : {}), ...(written.alignmentError ? { alignmentError: written.alignmentError } : {}) });
  };
  const nextTake = (info: NarrationLineInfo) => readTakes(dir, language, screen, info.id).reduce((n, t) => Math.max(n, t.take), 0) + 1;

  // Stopped (signal): the lines said so far stay, each its own change; the result says it stopped.
  const credits = new Set<string>();
  // The local models the lines are said with, held from the first line to the last: removing one
  // (Elabora settings, elabora voice uninstall) is refused meanwhile, in any process.
  const releases: (() => void)[] = [];
  try {
    // Install what the voices need first (a model downloaded once per computer; a service's key).
    for (const providerId of new Set(plan.todo.map((info) => voiceOf(info).provider))) {
      const provider = voiceProvider(providerId);
      const status = provider.status(language);
      if (!status) throw new VoiceError('E_VOICE_LANGUAGE', `${provider.name} has no voice in ${language}.`);
      if (provider.hold) releases.push(await provider.hold(language, signal));
      // Read again once held: a removal that came first has taken it away.
      if (!(provider.hold ? provider.status(language)?.installed : status.installed)) await provider.install(language, { signal, onProgress: (p: InstallProgress) => onProgress?.({ phase: 'install', fraction: p.total ? p.received / p.total : 0, received: p.received, total: p.total }) });
    }

    // An exchange's name, in its takes' metadata: unique to this generation, as another one of the
    // same screen (another step, the exchange said again) is another exchange.
    const stamp = Date.now().toString(36);
    const dialogueOf = new Map(plan.dialogues.flatMap((run, index) => run.map((info) => [info.id, { run, id: `${screen}-${stamp}-${index + 1}` }] as const)));
    const done = new Set<string>();
    for (const [index, info] of plan.todo.entries()) {
      signal?.throwIfAborted();
      if (done.has(info.id)) continue;
      const voice = voiceOf(info);
      const provider = voiceProvider(voice.provider);
      const reused = plan.reuse.get(info.id);
      if (reused) {
        const written = await writeAudio({ screen, line: info.id, language, file: reused.file, provider: reused.provider, voice: reused.voice, generated: true, take: reused.take, credit: reused.credit, model: reused.model, trim: true });
        if (written.seq !== null) changes.push(written.seq);
        credits.add(reused.credit);
        result.lines.push({ line: info.id, status: 'selected', take: reused.take, audio: written.audio, provider: reused.provider, voice: reused.voice, reason: 'an earlier take of the same text, voice and delivery: nothing spent', ...(written.alignmentError ? { alignmentError: written.alignmentError } : {}) });
        done.add(info.id);
        continue;
      }
      const dialogue = dialogueOf.get(info.id);
      if (provider.paid && charged > 0 && overBudget((dialogue?.run ?? [info]).reduce((sum, line) => sum + (estimated.get(line.id)?.credits ?? 0), 0))) break;
      if (dialogue) {
        await sayDialogue(dialogue.run, dialogue.id, provider, index);
        for (const line of dialogue.run) done.add(line.id);
        continue;
      }
      const take = nextTake(info);
      const seed = seedOf(info.spokenHash ?? '', voice.provider, voice.voice, info.settingsHash, take);
      const position = infos.findIndex((candidate) => candidate.id === info.id);
      const neighbour = (at: number) => { const other = infos[at]; return other && other.step === info.step && other.spoken ? other.spoken : undefined; };
      const started = performance.now();
      const spoken = await provider.synthesize({
        text: info.spoken ?? '', voice: voice.voice, language, settings: info.settings, seed, signal,
        ...(provider.paid ? { context: { before: neighbour(position - 1), after: neighbour(position + 1) }, ...(voice.name ? { voiceName: voice.name } : {}) } : {}),
        onProgress: (fraction) => onProgress?.({ phase: 'line', line: info.id, index, count: plan.todo.length, fraction })
      });
      if (provider.paid && !spoken.cached) spend(voice.provider, estimated.get(info.id)?.characters ?? 0, estimated.get(info.id)?.credits ?? 0, spoken.cost);
      await keep(info, voice, take, seed, spoken, { seconds: (performance.now() - started) / 1000, cached: spoken.cached }, spoken.settings.speed === undefined ? speedOf(info.settings) : 1);
      done.add(info.id);
      onProgress?.({ phase: 'line', line: info.id, index, count: plan.todo.length, fraction: 1 });
    }
  } catch (error) {
    if (!signal?.aborted) throw error;
    result.cancelled = true;
  } finally {
    for (const release of releases) release();
  }

  // Lines said as one exchange: each cut out, its take written, and the silence the exchange left
  // before it made the line's pause (none after an interruption).
  async function sayDialogue(run: NarrationLineInfo[], id: string, provider: VoiceProvider, index: number) {
    const voices = run.map(voiceOf);
    const takes = run.map(nextTake);
    const seed = seedOf(...run.map((info) => info.spokenHash ?? ''), ...voices.map((voice) => voice.voice), run[0].settingsHash, Math.max(...takes));
    const started = performance.now();
    const said = await provider.synthesizeDialogue!({
      turns: run.map((info, at) => ({ text: info.spoken ?? '', voice: voices[at].voice, ...(voices[at].name ? { voiceName: voices[at].name } : {}) })), language, settings: run[0].settings, seed, signal,
      onProgress: (fraction) => onProgress?.({ phase: 'line', line: run[0].id, index, count: plan.todo.length, fraction }),
      hear: (exchange) => hearTurns(exchange, run.map((info) => info.text ?? ''))
    });
    if (!said.cached) {
      const expected = run.reduce((sum, info) => sum + (estimated.get(info.id)?.credits ?? 0), 0);
      spend(voices[0].provider, run.reduce((sum, info) => sum + (estimated.get(info.id)?.characters ?? 0), 0), expected, said.cost);
    }
    const seconds = (performance.now() - started) / 1000;
    for (const [at, info] of run.entries()) {
      const line = said.lines[at];
      await keep(info, voices[at], takes[at], seed, { samples: line.samples, sampleRate: said.sampleRate, model: said.model, credit: said.credits[at], retries: 0, words: line.words }, { dialogue: id, seconds: seconds / run.length, cached: said.cached });
      if (at > 0 && info.track.kind !== 'dialogue' && writer.updateLinePause && Math.abs((info.pauseBefore ?? -1) - line.gap) > 0.04) {
        const change = await writer.updateLinePause(screen, info.id, line.gap);
        if (change !== null) changes.push(change);
      }
    }
  }

  // Where each turn of an exchange is in its audio, by the word aligner of the language when it is here:
  // the service's own times can run ahead of its audio (splitDialogue), the aligner's words cannot.
  async function hearTurns(exchange: { samples: Float32Array; sampleRate: number }, texts: string[]): Promise<{ start: number; end: number }[] | null> {
    if (!alignsAtOnce(language)) return null;
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-voice-'));
    try {
      const file = path.join(temp, 'exchange.wav');
      fs.writeFileSync(file, wavBytes(exchange.samples, exchange.sampleRate));
      const aligned = await alignAudio(file, texts.join(' '), language, { tools, signal });
      if (!aligned) return null;
      const counts = texts.map((text) => spokenWords(text, language).length);
      if (counts.some((count) => !count) || counts.reduce((sum, count) => sum + count, 0) !== aligned.words.length) return null;
      let at = 0;
      return counts.map((count) => { const words = aligned.words.slice(at, at + count); at += count; return { start: words[0].start, end: words[count - 1].end }; });
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  result.credits = [...credits];
  if (spent.size) result.spent = [...spent.values()];
  for (const line of result.lines) {
    if (line.status !== 'generated') continue;
    const info = narrationLines(writer.project(), screen, language)?.find((candidate) => candidate.id === line.line);
    if (info?.duration) line.duration = Math.round(info.duration * 100) / 100;
  }
  return result;
}

// A voice heard before it is chosen: a few words said by it, written nowhere (« Écouter » beside a
// voice in the app's menus and its cast). Its model must be on this computer. WAV bytes, mono.
// A paid voice is heard from its service's recording (VoiceInfo.preview), free; it says the author's
// own words only when asked to spend (spend: the app's « Écouter sur une réplique de Marc », a few
// hundred characters at most, far under 1 % of a quota: D30), and the same words again come from
// the cache. name: a voice service's voice as the caller found it (a library voice not used yet).
export async function voiceSample({ voice, provider, language, text, signal, spend = false, name }: { voice: string; provider?: string; language?: string; text: string; signal?: AbortSignal; spend?: boolean; name?: string }): Promise<{ audio: Uint8Array; duration: number }> {
  let info = await resolveVoice(voice, provider, signal);
  if (!info && provider && voiceProvider(provider).paid && spend) info = { provider, id: voice, name: name || voice, language: language || 'en', gender: null, description: {}, licence: '', source: provider, credit: {}, multilingual: true };
  if (!info) throw new VoiceError('E_VOICE_UNKNOWN', `Unknown voice "${voice}" (elabora voice list).`);
  if (voiceProvider(info.provider).paid) {
    if (!spend) throw new VoiceError('E_VOICE_PAID', `${info.name} is a paid voice: hear its preview (${info.preview ?? 'elabora voice search'}) rather than spending credits on a sample.`);
    const said = text.trim().slice(0, 300);
    if (!said) throw new VoiceError('E_VOICE_TEXT', 'A sample needs a few words to say.');
    const lang = language || info.language;
    // Under 1 % of the month's quota, as anything paid (D30): a sample is a line or two, far under it.
    const paid = voiceProvider(info.provider);
    if (paid.estimate && paid.quota) {
      const [estimate, quota] = await Promise.all([paid.estimate(said, info.id, {}), paid.quota(signal)]);
      if (needsApproval(estimate.credits, quota)) throw new VoiceError('E_VOICE_SPEND', `A sample would spend ~${quotaPercent(shareOf(estimate.credits, quota.limit))} % of the month's quota: generate the line itself with the share approved.`);
    }
    const spoken = await paid.synthesize({ text: said, voice: info.id, language: lang, settings: {}, seed: seedOf(said, info.provider, info.id), signal, voiceName: info.name });
    return { audio: new Uint8Array(wavBytes(spoken.samples, spoken.sampleRate)), duration: Math.round((spoken.samples.length / spoken.sampleRate) * 100) / 100 };
  }
  const lang = language || info.language;
  if (!speaks(info, lang)) throw new VoiceError('E_VOICE_LANGUAGE', `The voice "${info.id}" speaks ${info.language}, not ${lang}.`);
  const said = text.trim().slice(0, 300);
  if (!said) throw new VoiceError('E_VOICE_TEXT', 'A sample needs a few words to say.');
  const voices = voiceProvider(info.provider);
  if (!voices.status(lang)?.installed) throw new VoiceError('E_VOICE_NOT_INSTALLED', `The voices in ${lang} are not on this computer yet: elabora voice install ${lang}.`);
  const spoken = await voices.synthesize({ text: said, voice: info.id, language: lang, settings: {}, seed: seedOf(said, info.provider, info.id), signal });
  return { audio: new Uint8Array(wavBytes(spoken.samples, spoken.sampleRate)), duration: Math.round((spoken.samples.length / spoken.sampleRate) * 100) / 100 };
}

// A speaker's voice in a language (course.json speakers[].voices[<language>]); its other settings kept.
// Returns the change's sequence number, or null when nothing changed.
// A voice service's voice (ElevenLabs) is looked up there; one it does not give by id (a library voice
// not used yet) is set as named (name), and its first generation says whether it exists.
export async function setSpeakerVoice(dir: string, { speaker, voice, provider, language, settings, name }: { speaker: string; voice: string; provider?: string; language?: string; settings?: Record<string, unknown>; name?: string }, editOptions?: EditOptions, writer: VoiceWriter = folderWriter(dir, editOptions)): Promise<number | null> {
  const project = writer.project();
  const course = project.course;
  if (!course) throw new VoiceError('E_VOICE_COURSE', `${path.resolve(dir)} is not an Elabora course (no course.json).`);
  const lang = language || course.language;
  let info = await resolveVoice(voice, provider);
  if (!info && provider && voiceProvider(provider).paid) info = { provider, id: voice, name: name || voice, language: lang, gender: null, description: {}, licence: '', source: provider, credit: {}, multilingual: true };
  if (!info) throw new VoiceError('E_VOICE_UNKNOWN', `Unknown voice "${voice}" (elabora voice list --language ${lang}${provider ? '' : ', or give --provider elevenlabs for a voice of the ElevenLabs library'}).`);
  if (!speaks(info, lang)) throw new VoiceError('E_VOICE_LANGUAGE', `The voice "${info.id}" speaks ${info.language}, not ${lang}.`);
  const speakers = (Array.isArray(course.speakers) ? course.speakers : []) as Speaker[];
  if (!speakers.some((s) => s.id === speaker)) throw new VoiceError('E_VOICE_SPEAKERS', `No speaker "${speaker}" in course.json speakers (${speakers.map((s) => s.id).join(', ') || 'none'}).`);
  let changed = false;
  const next = speakers.map((s) => {
    if (s.id !== speaker) return s;
    const before = s.voices?.[lang];
    const keep = settings ?? (before?.provider === info.provider && before?.settings ? before.settings : undefined);
    const label = voiceProvider(info.provider).paid ? { name: (name || info.name).slice(0, 120) } : {};
    const entry = { provider: info.provider, voice: info.id, ...label, ...(keep && Object.keys(keep).length ? { settings: keep } : {}) };
    changed = JSON.stringify(before ?? null) !== JSON.stringify(entry);
    return { ...s, voices: { ...(s.voices ?? {}), [lang]: entry } };
  });
  if (!changed) return null;
  return writer.updateSpeakers(next);
}

export type { NarrationLineInfo };
