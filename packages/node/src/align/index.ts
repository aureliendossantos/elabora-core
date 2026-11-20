import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { narrationLines } from '@elabora/core/narration/narration';
import type { NarrationAudio } from '@elabora/core/narration/narration';
import type { Project } from '@elabora/core/project/model';
import { loadProjectFromDir } from '../project-reader.ts';
import { lineMouth, mouthWords } from '../narration/mouth.ts';
import type { EditOptions } from '../edit/index.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { runFfmpeg } from '../media/encode.ts';
import { AlignProcess } from './process.ts';
import { AlignmentError } from '@elabora/core/align/ctc';
import { acquireAligner, alignerFor, alignerDir, alignerInstalled, alignerModels, alignerSize, holdAligner, installAligner } from './models.ts';
import type { AlignerModel } from './models.ts';
import type { DownloadProgress } from '../models/download.ts';
import type { AlignerView, AlignProgress, AlignResult } from '@elabora/core/align/types';
import { localAiSupported, requireLocalAi } from '../models/platform.ts';
import { run } from '../edit/index.ts';
import type { CommandArgs } from '@elabora/core/commands/table';
import { alignedLine, planAlignment, sidecarAudioHash } from '@elabora/core/align/plan';

// When each word of a narration line is said (docs/decisions.md D27): forced alignment of the
// line's text with its audio, by a wav2vec2 character model of its language (models.ts, downloaded
// once per computer) and a Viterbi search in TypeScript (ctc.ts), in a process of its own (process.ts).
// The words go into the line's sidecar (words, aligner, text), where word anchors find their times.
// A voice made or a recording imported is aligned at once when the aligner of its language is on
// this computer (ELABORA_ALIGN=0 turns that off); elabora narration align times the others, downloading
// the aligner first.

export { ALIGNER_MODELS, alignerFor, alignerInstalled, alignerModels, alignerSize, installAligner, AlignerDownloadError } from './models.ts';
export type { AlignerModel } from './models.ts';
export { AlignmentError } from '@elabora/core/align/ctc';
export type { AlignedWord, Alignment } from '@elabora/core/align/align';
export type { AlignerView, AlignProgress, AlignedLine, AlignResult } from '@elabora/core/align/types';

const SAMPLE_RATE = 16000;
let aligner: AlignProcess | null = null;

// Stops the aligner's process and frees its model (tests, a closing engine).
export async function disposeAligner(): Promise<void> {
  const current = aligner;
  aligner = null;
  await current?.dispose();
}

// An audio file as 16 kHz mono samples (ffmpeg): what the aligner and the transcriber hear.
export async function samplesOf(file: string, tools: MediaTools, signal?: AbortSignal): Promise<Float32Array> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-align-'));
  try {
    const raw = path.join(temp, 'line.f32');
    await runFfmpeg(tools, ['-nostdin', '-v', 'error', '-y', '-i', file, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', raw], { signal });
    const bytes = fs.readFileSync(raw);
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// Names an audio file for the aligner's process, which keeps the emissions of the last one.
function cacheKeyOf(file: string): string | undefined {
  try {
    const stat = fs.statSync(file);
    return `${path.resolve(file)}:${stat.size}:${stat.mtimeMs}`;
  } catch { return undefined; }
}

export interface AlignedAudio {
  words: NonNullable<NarrationAudio['words']>;
  aligner: string;
  duration: number;
}

// The words of an audio file that says text. install: download the aligner when it is not on this
// computer (else E_ALIGN_NOT_INSTALLED). null: no aligner for that language.
export async function alignAudio(file: string, text: string, language: string, { tools, signal, install = false, onDownload }: { tools?: MediaTools; signal?: AbortSignal; install?: boolean; onDownload?: (progress: DownloadProgress) => void } = {}): Promise<AlignedAudio | null> {
  requireLocalAi();
  const model = alignerFor(language);
  if (!model) return null;
  // Held while it places words: it is not removed under it (Elabora settings, D38).
  let release: (() => void) | null = null;
  try {
    if (!alignerInstalled(model)) {
      if (!install) throw new AlignmentError('E_ALIGN_NOT_INSTALLED', `The word aligner for ${language} is not on this computer yet (${Math.round(alignerSize(model) / 1e6)} MB): elabora narration align downloads it.`);
      await installAligner(model, { signal, onProgress: onDownload });
    }
    const active = await acquireAligner(model, signal);
    release = active.release;
    const samples = await samplesOf(file, tools ?? await findMediaTools(), signal);
    signal?.throwIfAborted();
    aligner ??= new AlignProcess();
    const alignment = await aligner.align({ dir: active.dir, samples, text, language, startShift: model.startShift, endShift: model.endShift, cacheKey: cacheKeyOf(file) });
    return {
      aligner: active.model, duration: alignment.duration,
      words: alignment.words.map(({ text: word, start, end, score }) => ({ text: word, start, end, ...(score === undefined ? {} : { score }) }))
    };
  } finally {
    release?.();
  }
}

// The aligners and whether they are on this computer.
export function aligners(language?: string): AlignerView[] {
  if (!localAiSupported()) return [];
  return alignerModels().filter((model) => !language || alignerFor(language)?.id === model.id).map((model) => ({ language: model.language, model: model.model, installed: alignerInstalled(model), size: alignerSize(model) }));
}

// Whether a line made or imported now is aligned at once: its language's aligner is here.
export function alignsAtOnce(language: string, env: NodeJS.ProcessEnv = process.env): AlignerModel | null {
  if (!localAiSupported() || env.ELABORA_ALIGN === '0') return null;
  const model = alignerFor(language);
  return model && alignerInstalled(model, env) ? model : null;
}

// ── elabora narration align ────────────────────────────────────────────

export interface AlignOptions {
  screen?: string;           // default: every narrated screen
  lines?: string[];          // with screen
  language?: string;         // default: the course's
  force?: boolean;           // lines already timed by this aligner too
  signal?: AbortSignal;
  onProgress?: (progress: AlignProgress) => void;
}

// Who writes the words: by default the edits of @elabora/node on the folder; the engine passes its
// session, whose write queue and snapshot they go through.
export interface AlignWriter {
  project(): Project;
  setNarrationWords(args: CommandArgs['set_narration_words']): Promise<number | null>;
}

export function folderAlignWriter(dir: string, editOptions?: EditOptions): AlignWriter {
  return {
    project: () => loadProjectFromDir(dir),
    async setNarrationWords(args) {
      const written = await run(dir, 'set_narration_words', args, editOptions);
      return written.change?.seq ?? null;
    }
  };
}

export async function alignNarration(dir: string, options: AlignOptions = {}, editOptions?: EditOptions, writer: AlignWriter = folderAlignWriter(dir, editOptions)): Promise<AlignResult> {
  requireLocalAi();
  const { result, todo, model, language } = planAlignment(writer.project(), options, (lang) => alignerFor(lang));
  if (!model || !todo.length) return result;
  const tools = await findMediaTools();
  // Held from the first line to the last (D38), then each line's alignment holds it too.
  let release: (() => void) | null = null;
  try {
    release = await holdAligner(model, { signal: options.signal });
    if (!alignerInstalled(model)) await installAligner(model, { signal: options.signal, onProgress: (progress) => options.onProgress?.({ phase: 'install', received: progress.received, total: progress.total }) });
    for (const [index, line] of todo.entries()) {
      options.signal?.throwIfAborted();
      options.onProgress?.({ phase: 'line', screen: line.screen, line: line.line, index, count: todo.length });
      const sidecar = narrationLines(writer.project(), line.screen, language)?.find((info) => info.id === line.line);
      const audioHash = sidecarAudioHash(writer.project(), sidecar?.sidecar);
      try {
        const aligned = await alignAudio(path.join(writer.project().root ?? dir, line.audio), line.text, language, { tools, signal: options.signal });
        if (!aligned) continue;
        result.aligner = aligned.aligner;
        // The mouth's envelope follows the words newly timed (D61).
        const mouth = await lineMouth(tools, path.join(writer.project().root ?? dir, line.audio), mouthWords(line.text, sidecar?.duration ?? 0, aligned.words, language)).catch(() => null);
        const seq = await writer.setNarrationWords({ screen: line.screen, line: line.line, language, words: aligned.words, aligner: aligned.aligner, ...(audioHash ? { audioHash } : {}), ...(mouth !== null ? { mouth } : {}) });
        if (seq !== null) result.changes.push(seq);
        result.lines.push(alignedLine(writer.project(), line, language, aligned.words));
      } catch (error) {
        if (options.signal?.aborted) throw error;
        result.lines.push({ screen: line.screen, line: line.line, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
      }
    }
  } catch (error) {
    if (!options.signal?.aborted) throw error;
    result.cancelled = true;
  } finally {
    release?.();
  }
  return result;
}

