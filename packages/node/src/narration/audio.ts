import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { NarrationAudioFileArgs } from '@elabora/core/commands/narration';
import type { FileHash } from '@elabora/core/project/files';
import { setNarrationAudioChange } from '../edit/index.ts';
import type { EditOptions } from '../edit/executor.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { probeMedia } from '../media/probe.ts';
import { runFfmpeg } from '../media/encode.ts';
import { ALIGNER_MODELS, alignAudio, alignsAtOnce } from '../align/index.ts';
import { loadProjectFromDir } from '../project-reader.ts';
import { narrationLines } from '@elabora/core/narration/narration';
import type { ImportedFile } from './types.ts';

// The audio of a narration line (docs/decisions.md D24): an M4A (AAC, mono) at
// assets/narration/<language>/<screen>/<line>.m4a and its sidecar, written as one change. A voice
// tool gives the file it made (setNarrationAudio); a recorded human voice is imported
// (importNarration): converted, its silences at both ends trimmed. When the word aligner of its
// language is on this computer, its words are timed in the same change (docs/decisions.md D27).

export const LINE_BITRATE = '96k';

// align: false leaves the words untimed (elabora narration align times them later).
export type NarrationAudioArgs = NarrationAudioFileArgs & { tools?: MediaTools; align?: boolean; onAlign?: () => void };

export async function setNarrationAudio(dir: string, args: NarrationAudioArgs, options?: EditOptions) {
  const tools = args.tools ?? await findMediaTools();
  return withLineAudio(args.file, { trim: !!args.trim, tools }, async (audio) => {
    const timed = args.words?.length ? { words: args.words, ...(args.aligner ? { aligner: args.aligner } : {}) } : args.align === false ? null : await wordsOf(dir, args, audio.file, tools);
    const written = await setNarrationAudioChange(dir, {
      screen: args.screen, line: args.line, ...(args.language ? { language: args.language } : {}),
      audio: { size: audio.bytes.length, hash: audio.hash }, duration: audio.duration, provider: args.provider, voice: args.voice, generated: args.generated,
      ...(timed && 'words' in timed ? timed : {}), ...(args.take ? { take: args.take } : {}), ...(args.credit ? { credit: args.credit } : {}), ...(args.model ? { model: args.model } : {}),
      createdAt: createdAt()
    }, new Map([[audio.hash, audio.bytes]]), options);
    return { ...written, ...(timed && 'alignmentError' in timed ? { alignmentError: timed.alignmentError } : {}) };
  });
}

export const createdAt = (): string => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

// A line's audio as the course keeps it (D24): an M4A in AAC, mono, its index first, no metadata;
// a file already so is kept as it is, unless its silence is to be trimmed. use gets it while it is
// on disk (file: the M4A, named after the source, in a folder removed afterwards when it had to be made).
export interface LineAudio {
  file: string;
  bytes: Buffer;
  hash: FileHash;
  duration: number;
}

export async function withLineAudio<T>(source: string, { trim, tools }: { trim: boolean; tools: MediaTools }, use: (audio: LineAudio) => Promise<T>): Promise<T> {
  const input = path.resolve(source);
  if (!fs.existsSync(input)) throw new Error(`No file ${source}.`);
  const info = await probeMedia(input, { tools });
  if (info.audioCodec === null) throw new Error(`${source} has no sound.`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-narration-'));
  try {
    let file = input;
    const conformant = info.container === 'mp4' && info.audioCodec === 'aac' && info.channels === 1 && info.kind === 'audio' && info.faststart !== false && !trim;
    if (!conformant) {
      // Named after its source (what a transcriber or a log says of it).
      file = path.join(temp, `${path.basename(input).replace(/\.[^.]+$/, '') || 'line'}.m4a`);
      // Silence at both ends down to 0.1 s: pauses between lines come from the script.
      const silence = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1,areverse';
      await runFfmpeg(tools, [
        '-nostdin', '-v', 'error', '-y', '-i', input, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', ...(trim ? ['-af', silence] : []),
        '-c:a', 'aac', '-b:a', LINE_BITRATE, '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-movflags', '+faststart', '-f', 'mp4', file
      ]);
    }
    const bytes = fs.readFileSync(file);
    const hash: FileHash = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const duration = (await probeMedia(file, { tools })).duration;
    if (!duration) throw new Error(`${source}: its length could not be read.`);
    return await use({ file, bytes, hash, duration });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// The words of a line's new audio, when its language's aligner is here; an alignment that fails
// leaves them untimed and reports why (placed in proportion to the text until elabora narration align).
async function wordsOf(dir: string, args: NarrationAudioArgs, file: string, tools: MediaTools): Promise<{ words: NonNullable<NarrationAudioArgs['words']>; aligner: string } | { alignmentError: string } | null> {
  if (args.language ? !alignsAtOnce(args.language) : !ALIGNER_MODELS.some((model) => alignsAtOnce(model.language))) return null;
  const project = loadProjectFromDir(dir);
  const language = args.language || project.course?.language || '';
  if (!alignsAtOnce(language)) return null;
  const text = narrationLines(project, args.screen, language)?.find((line) => line.id === args.line)?.text;
  if (!text) return null;
  try {
    args.onAlign?.();
    const aligned = await alignAudio(file, text, language, { tools });
    return aligned?.words.length ? { words: aligned.words, aligner: aligned.aligner } : null;
  } catch (error) {
    return { alignmentError: error instanceof Error ? error.message : String(error) };
  }
}

// A recorded human voice for a line: provider "recording", not generated.
export function importNarration(dir: string, { screen, line, language, file, voice = '', trim = true }: { screen: string; line: string; language?: string; file: string; voice?: string; trim?: boolean }, options?: EditOptions) {
  return setNarrationAudio(dir, { screen, line, language, file, provider: 'recording', voice, generated: false, trim }, options);
}

// ── Recordings imported together ─────────────────────────────────────

export type { ImportedFile } from './types.ts';

const slugOf = (name: string): string => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s_.]+/g, '-').replace(/[^a-z0-9-]/g, '');

// Recordings of several lines at once (« Importer des enregistrements »): each file goes to the line
// its name gives (a line id, <screen>-<line>, or the line's number in the screen), the others to
// the line whose text the voice says, when the aligner of the language is on this computer; one
// change a line. write: how a line's audio is written (the engine passes its session).
export async function importNarrationFiles(dir: string, { screen, files, language, trim = true }: { screen?: string; files: string[]; language?: string; trim?: boolean }, options?: EditOptions,
  write: (args: NarrationAudioArgs) => Promise<{ change?: { seq: number } | null }> = (args) => setNarrationAudio(dir, args, options)): Promise<{ language: string; files: ImportedFile[] }> {
  const project = loadProjectFromDir(dir);
  const lang = language || project.course?.language || '';
  if (screen && !project.screens.has(screen)) throw new Error(`Unknown screen "${screen}".`);
  const screens = screen ? [screen] : [...project.screens.keys()];
  const lines = screens.flatMap((id) => (narrationLines(project, id, lang) ?? []).map((info, index) => ({ screen: id, line: info.id, index, text: info.text })));
  if (!lines.length) throw new Error(screen ? `Screen "${screen}" has no narration.` : 'The course has no narrated screen.');
  const results: ImportedFile[] = [];
  const taken = new Set<string>();
  const key = (line: { screen: string; line: string }) => `${line.screen}/${line.line}`;
  const pending: string[] = [];
  for (const file of files) {
    const name = slugOf(path.basename(file).replace(/\.[^.]+$/, ''));
    const number = /^(\d{1,3})(?:-|$)/.exec(name);
    const found = lines.find((line) => !taken.has(key(line)) && [slugOf(line.line), `${line.screen}-${slugOf(line.line)}`].includes(name))
      ?? (screen && number ? lines.find((line) => line.index === Number(number[1]) - 1 && !taken.has(key(line))) : undefined);
    if (found) { taken.add(key(found)); results.push({ file, status: 'imported', screen: found.screen, line: found.line, by: 'name' }); }
    else pending.push(file);
  }
  // The others by what they say: each to the free line of the screen the aligner finds best in it.
  if (pending.length && screen && alignsAtOnce(lang)) {
    const scored: { file: string; line: (typeof lines)[number]; score: number }[] = [];
    for (const file of pending) {
      for (const line of lines.filter((candidate) => !taken.has(key(candidate)) && candidate.text)) {
        try {
          const aligned = await alignAudio(path.resolve(file), line.text!, lang);
          const scores = (aligned?.words ?? []).map((word) => word.score).filter((score): score is number => typeof score === 'number');
          if (scores.length) scored.push({ file, line, score: scores.reduce((sum, score) => sum + score, 0) / scores.length });
        } catch { /* too short for that text: not that line */ }
      }
    }
    for (const best of scored.sort((a, b) => b.score - a.score)) {
      if (best.score < 0.5 || taken.has(key(best.line)) || results.some((result) => result.file === best.file)) continue;
      taken.add(key(best.line));
      results.push({ file: best.file, status: 'imported', screen: best.line.screen, line: best.line.line, by: 'voice' });
    }
  }
  for (const file of pending) if (!results.some((result) => result.file === file)) results.push({ file, status: 'unmatched', reason: screen && !alignsAtOnce(lang) ? `no line is named so: name it after its line (${lines.slice(0, 3).map((line) => line.line).join(', ')}…), or install the word aligner (elabora narration align) to find it by what it says` : 'no line is named so, or says it' });
  for (const result of results) {
    if (result.status !== 'imported') continue;
    try {
      const written = await write({ screen: result.screen!, line: result.line!, ...(language ? { language } : {}), file: path.resolve(result.file), provider: 'recording', voice: '', generated: false, trim });
      result.change = written.change?.seq ?? null;
    } catch (error) {
      result.status = 'failed';
      result.reason = error instanceof Error ? error.message : String(error);
    }
  }
  return { language: lang, files: files.map((file) => results.find((result) => result.file === file)!) };
}
