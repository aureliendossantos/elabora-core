// The align service of a browser's session (D27, D114): the word aligners and whether this browser
// keeps them, a narration's lines timed (set_narration_words, one change a line), and the words of a
// line timed at once when it is written and the aligner of its language is kept here. The lines to
// time, the reasons others are left and the words a voice may have swallowed are the core's
// (@elabora/core/align/plan), the alignment the core's code in the models Worker. Not on a phone, nor a
// language's model on a computer with too little memory for it.

import { ALIGNER_MODELS, alignerOf } from '@elabora/core/align/models';
import type { AlignerModel } from '@elabora/core/align/models';
import { alignedLine, planAlignment, sidecarAudioHash } from '@elabora/core/align/plan';
import type { AlignerView, AlignProgress, AlignResult } from '@elabora/core/align/types';
import { SAMPLE_RATE } from '@elabora/core/align/wav2vec2';
import { narrationLines } from '@elabora/core/narration/narration';
import type { NarrationAudio } from '@elabora/core/narration/narration';
import type { Project } from '@elabora/core/project/model';
import type { ProjectFiles } from '@elabora/core/project/files';
import { EngineError, toolError } from '../../base/errors.ts';
import type { AlignNarrationParams } from '../../protocol.ts';
import type { BrowserStore } from '../store.ts';
import type { MediaWorker, WorkerClient } from '../worker-client.ts';
import type { ModelsAnswer, ModelsAsk } from './worker.ts';
import { installModel, modelInstalled, modelSize } from './store.ts';
import { onAPhone, refusal } from './refusal.ts';

const refused = (model: AlignerModel) => refusal(model.language, 'Timing words');

export type ModelsWorker = WorkerClient<ModelsAsk, ModelsAnswer>;

export interface AlignHost {
  files(): ProjectFiles;
  project(): Project;
  store: BrowserStore;
  // The models' origin the host names (C110): where a model not kept yet is downloaded from.
  base: string;
  // set_narration_words, as the session's author, through its queue: the change's number.
  setNarrationWords(args: Record<string, unknown>): Promise<number | null>;
  progress(progress: AlignProgress, screen?: string): void;
}

type Words = NonNullable<NarrationAudio['words']>;

export class BrowserAlign {
  readonly #models: ModelsWorker;
  readonly #media: MediaWorker;
  readonly #host: AlignHost;

  constructor(models: ModelsWorker, media: MediaWorker, host: AlignHost) {
    this.#models = models;
    this.#media = media;
    this.#host = host;
  }

  async aligners(language?: string): Promise<AlignerView[]> {
    if (onAPhone()) return [];
    const models = ALIGNER_MODELS.filter((model) => !language || alignerOf(language)?.id === model.id);
    return Promise.all(models.map(async (model) => ({ language: model.language, model: model.model, installed: await modelInstalled(model), size: modelSize(model) })));
  }

  // Whether a line of this language is timed at once when it is written: its aligner kept here.
  async keeps(language: string): Promise<boolean> {
    const model = alignerOf(language);
    return !!model && !refused(model) && await modelInstalled(model);
  }

  // signal: stops it between two lines (cancelVoice), the lines timed so far kept.
  async alignNarration(params: AlignNarrationParams, signal?: AbortSignal): Promise<AlignResult> {
    try {
      const { result, todo, model, language } = planAlignment(this.#host.project(), params, (lang) => alignerOf(lang));
      if (!model || !todo.length) return result;
      const no = refused(model);
      if (no) throw no;
      await this.#installed(model, params.screen);
      for (const [index, line] of todo.entries()) {
        if (signal?.aborted) break;
        this.#host.progress({ phase: 'line', screen: line.screen, line: line.line, index, count: todo.length }, params.screen);
        try {
          const words = await this.#time(model, line.audio, line.text, language);
          if (!words) { result.lines.push({ screen: line.screen, line: line.line, status: 'failed', reason: 'its audio is not kept in this browser, and the project cannot be reached' }); continue; }
          const project = this.#host.project();
          const sidecar = narrationLines(project, line.screen, language)?.find((info) => info.id === line.line);
          const audioHash = sidecarAudioHash(project, sidecar?.sidecar);
          const seq = await this.#host.setNarrationWords({ screen: line.screen, line: line.line, language, words, aligner: model.model, ...(audioHash ? { audioHash } : {}) });
          if (seq !== null) result.changes.push(seq);
          result.lines.push(alignedLine(this.#host.project(), line, language, words));
        } catch (error) {
          // Too little memory for the model fails every line the same way: the run stops, said why.
          if ((error as { code?: string }).code === 'E_LOCAL_AI_MEMORY') throw new EngineError('not-available', (error as Error).message, { code: 'E_LOCAL_AI_MEMORY' });
          result.lines.push({ screen: line.screen, line: line.line, status: 'failed', reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    } catch (error) {
      throw toolError(error);
    }
  }

  // The words of a line's audio just made (set_narration_audio, a recording), when its language's
  // aligner is kept here: the desktop times a line at once in the same case. null: not here, or not kept.
  async wordsAtOnce(language: string, audio: Blob, duration: number | null, text: string): Promise<{ words: Words; aligner: string } | { alignmentError: string } | null> {
    const model = alignerOf(language);
    if (!model || refused(model) || !(await modelInstalled(model))) return null;
    try {
      const words = await this.#wordsOf(model, audio, duration, text, language);
      return words.length ? { words, aligner: model.model } : null;
    } catch (error) {
      return { alignmentError: error instanceof Error ? error.message : String(error) };
    }
  }

  // Downloaded first when not kept (or erased by the browser since), its bytes told as they come.
  async #installed(model: AlignerModel, screen?: string): Promise<void> {
    if (await modelInstalled(model)) return;
    try {
      await installModel(model, this.#host.base, { onProgress: ({ received, total }) => this.#host.progress({ phase: 'install', received, total }, screen) });
    } catch (error) {
      throw new EngineError('not-available', error instanceof Error ? error.message : String(error), { code: (error as { code?: string }).code === 'E_LOCAL_AI_STORAGE' ? 'E_LOCAL_AI_STORAGE' : 'E_ALIGN_DOWNLOAD' });
    }
  }

  async #time(model: AlignerModel, path: string, text: string, language: string): Promise<Words | null> {
    const file = this.#host.files().get(path);
    if (file?.kind !== 'binary' || !file.hash) return null;
    const audio = await this.#host.store.medium(file.hash);
    if (!audio) return null;
    try {
      return await this.#wordsOf(model, audio, file.media?.duration ?? null, text, language);
    } catch (error) {
      // The browser erased the model meanwhile: downloaded again, then once more.
      if ((error as { code?: string }).code !== 'E_ALIGN_NOT_INSTALLED') throw error;
      await this.#installed(model);
      return this.#wordsOf(model, audio, file.media?.duration ?? null, text, language);
    }
  }

  async #wordsOf(model: AlignerModel, audio: Blob, duration: number | null, text: string, language: string): Promise<Words> {
    const decoded = (await this.#media.ask({ op: 'samples', file: audio, name: 'line.m4a', rate: SAMPLE_RATE, duration })).answer;
    if (!('samples' in decoded)) throw new EngineError('refused', 'error' in decoded ? decoded.error : 'The line could not be read.', { code: 'E_ALIGN_AUDIO' });
    const { answer } = await this.#models.ask({ op: 'align', model, samples: decoded.samples, text, language });
    if ('error' in answer) throw Object.assign(new Error(answer.error), answer.code ? { code: answer.code } : {});
    if (!('alignment' in answer)) throw new Error('The models Worker gave no alignment.');
    return answer.alignment.words.map(({ text: word, start, end, score }) => ({ text: word, start, end, ...(score === undefined ? {} : { score }) }));
  }
}
