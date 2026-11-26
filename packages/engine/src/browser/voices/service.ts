// The voices service of a browser's session (D25, D102): the local voices (Pocket TTS, pocket.ts) on a
// computer, a speaker's voice, a screen's lines said and their takes, a voice heard before it is chosen.
// What to say and with which voice, what a take is and what it costs are the core's
// (@elabora/core/voice/generate), as at the desktop; here the takes are kept in the origin's private
// file system (takes.ts), a take's audio is written by set_narration_audio as a file that comes beside
// the command (D108), and a line is timed at once when the align service keeps its language's aligner.
// ElevenLabs is the core's provider, through the page that holds the author's key (elevenlabs.ts).

import type { Author } from '@elabora/core/ops/types';
import type { Project } from '@elabora/core/project/model';
import { estimateNarration, generateNarration, setSpeakerVoice, voiceSample, voiceTakes } from '@elabora/core/voice/generate';
import type { VoiceHost, VoiceWriter } from '@elabora/core/voice/generate';
import { VoiceRegistry } from '@elabora/core/voice/provider';
import type { VoiceProvider } from '@elabora/core/voice/provider';
import { standIn } from '@elabora/core/voice/stand-in';
import type { GenerateResult, TakeInfo, VoiceAccount, VoiceEstimate, VoiceQuery, VoiceSearchResult } from '@elabora/core/voice/types';
import { EngineError, toolError } from '../../base/errors.ts';
import type { EngineEvent, GenerateVoiceParams, RunResult, VoiceView } from '../../protocol.ts';
import type { ModelsWorker } from '../models/align.ts';
import type { Attachments } from '../media/service.ts';
import { BrowserPocket } from './pocket.ts';
import { browserTakes, takeAudio } from './takes.ts';
import { BrowserElevenLabs } from './elevenlabs.ts';

export interface VoicesHost {
  copy: string;                  // the copy's id: its takes' folder
  project(): Project;
  run(name: string, args: unknown, author: Author, attachments: Attachments): Promise<RunResult>;
  emit(event: EngineEvent): void;
  // Whether a line of this language is timed at once when it is written (the align service).
  alignsAtOnce(language: string): Promise<boolean>;
  catalogue: string;             // where the host serves the local voices' catalogue
  models: string;                // the models' origin
  standIn?: boolean;             // tones in Pocket TTS's place, for routine checks (never a course's voice)
}

const tokenOf = (take: number) => `elabora-file:${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('')}/take-${take}.wav`;

export class BrowserVoices {
  readonly #host: VoicesHost;
  readonly #pocket: BrowserPocket;
  readonly #elevenLabs = new BrowserElevenLabs();
  readonly #providers = new VoiceRegistry();
  readonly #jobs = new Set<{ screen: string | null; controller: AbortController }>();

  constructor(models: ModelsWorker, host: VoicesHost) {
    this.#host = host;
    this.#pocket = new BrowserPocket(models, { catalogue: host.catalogue, models: host.models });
    this.#providers.register(host.standIn ? standIn(this.#pocket) : this.#pocket);
    this.#providers.register(this.#elevenLabs.elevenLabs.provider);
  }

  // A take's audio given to set_narration_audio as the file beside it, as a window's file is.
  #writer(author: Author): VoiceWriter {
    const run = (name: string, args: unknown, attachments: Attachments = new Map()) => this.#host.run(name, args, author, attachments);
    return {
      project: () => this.#host.project(),
      setNarrationAudio: async ({ onAlign, file, ...args }) => {
        const audio = await takeAudio(file);
        if (!audio) throw new EngineError('not-found', `The take ${args.take ?? ''} of ${args.line} is no longer kept in this browser.`, { code: 'E_VOICE_TAKE' });
        if (onAlign && await this.#host.alignsAtOnce(args.language ?? this.#host.project().course?.language ?? '')) onAlign();
        const token = tokenOf(args.take ?? 0);
        const written = await run('set_narration_audio', { ...args, file: token }, new Map([[token, audio]]));
        return { audio: typeof written.result.audio === 'string' ? written.result.audio : undefined, seq: written.change?.seq ?? null,
          ...(typeof written.result.alignmentError === 'string' ? { alignmentError: written.result.alignmentError } : {}) };
      },
      setSpeakerVoice: async (speaker, language, voice) => (await run('update_course', { patch: { speakers: { [speaker]: { voices: { [language]: voice } } } } })).change?.seq ?? null,
      updateLinePause: async (screen, line, pause) => (await run('update_narration_line', { screen, line, pauseBefore: pause })).change?.seq ?? null
    };
  }

  #voiceHost(author: Author): VoiceHost {
    return { name: 'This module', providers: this.#providers, writer: this.#writer(author), takes: browserTakes(this.#host.copy), alignsAtOnce: (language) => this.#host.alignsAtOnce(language) };
  }

  async #job<T>(screen: string | null, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const job = { screen, controller: new AbortController() };
    this.#jobs.add(job);
    try {
      return await work(job.controller.signal);
    } finally {
      this.#jobs.delete(job);
    }
  }

  async #answer<T>(work: () => Promise<T>): Promise<T> {
    try {
      await this.#pocket.ready();
      return await work();
    } catch (error) {
      throw toolError(error);
    }
  }

  voices(language?: string): Promise<VoiceView[]> {
    return this.#answer(async () => this.#providers.voices(language).map((voice) => ({ ...voice, ...(this.#providers.provider(voice.provider).status(voice.language) ?? { installed: false, size: 0 }) })));
  }

  installVoices(language: string): Promise<{ language: string; installed: boolean }> {
    return this.#answer(async () => {
      const providers: VoiceProvider[] = this.#providers.list().filter((provider) => !provider.paid && provider.status(language));
      if (!providers.length) throw new EngineError('not-found', `No voice speaks ${language}`);
      return this.#job(null, async (signal) => {
        try {
          for (const provider of providers) await provider.install(language, { signal, onProgress: (p) => this.#host.emit({ type: 'voiceProgress', progress: { phase: 'install', fraction: p.total ? p.received / p.total : 0, received: p.received, total: p.total } }) });
        } catch (error) {
          if (signal.aborted) return { language, installed: false };
          throw error;
        }
        return { language, installed: true };
      });
    });
  }

  setSpeakerVoice(params: { speaker: string; voice: string; language?: string; provider?: string; name?: string; settings?: Record<string, unknown> }, author: Author): Promise<{ change: number | null }> {
    return this.#answer(async () => ({ change: await setSpeakerVoice(this.#voiceHost(author), params) }));
  }

  generateVoice(params: GenerateVoiceParams, author: Author): Promise<GenerateResult> {
    // A job from the start: cancelVoice finds it while the catalogue is read.
    return this.#job(params.screen, (signal) => this.#answer(() => generateNarration(this.#voiceHost(author), { ...params, signal, onProgress: (progress) => this.#host.emit({ type: 'voiceProgress', screen: params.screen, progress }) })));
  }

  voiceEstimate(params: GenerateVoiceParams, author: Author): Promise<VoiceEstimate> {
    return this.#answer(() => estimateNarration(this.#voiceHost(author), params));
  }

  voiceTakes(params: { screen: string; line: string; language?: string }, author: Author): Promise<{ language: string; takes: TakeInfo[] }> {
    return this.#answer(() => voiceTakes(this.#voiceHost(author), params));
  }

  voiceSample(params: { voice: string; provider?: string; language?: string; text: string; spend?: boolean; name?: string }): Promise<{ audio: Uint8Array; duration: number }> {
    return this.#job(null, (signal) => this.#answer(() => voiceSample({ providers: this.#providers }, { ...params, signal })));
  }

  // Stops what the voices make (a screen's lines, a download, a screen's words timed: cancelVoice).
  cancelVoice(screen?: string): { cancelled: number } {
    let cancelled = 0;
    for (const job of this.#jobs) {
      if (screen !== undefined && job.screen !== screen) continue;
      if (!job.controller.signal.aborted) { job.controller.abort(); cancelled++; }
    }
    return { cancelled };
  }

  // The words of a narration timed, as a job cancelVoice stops.
  timing<T>(screen: string | null, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.#job(screen, work);
  }

  close(): void {
    for (const job of this.#jobs) if (!job.controller.signal.aborted) job.controller.abort();
    this.#elevenLabs.close();
  }

  // The port to the page that holds the ElevenLabs key (the window frames it and transfers it).
  voiceKeyPort(port: MessagePort | undefined): Record<string, never> {
    if (!port) throw new EngineError('bad-request', 'voiceKeyPort takes the port transferred with its message');
    this.#elevenLabs.connect(port);
    return {};
  }

  // In a browser the key is typed in its own page, never given here: only forgetting it is asked.
  async setVoiceKey(params: { key?: string | null } | undefined): Promise<{ key: null }> {
    if (params?.key) throw new EngineError('bad-request', 'In a browser, the ElevenLabs key is typed in its own page (« Clé ElevenLabs »), never given to the session.');
    try { await this.#elevenLabs.forget(); } catch (error) { throw toolError(error); }
    return { key: null };
  }

  voiceAccount(params: { check?: boolean } | undefined): Promise<VoiceAccount> {
    return this.#answer(() => this.#elevenLabs.elevenLabs.account({ check: !!params?.check }));
  }

  voiceSearch(query: VoiceQuery): Promise<VoiceSearchResult> {
    return this.#answer(() => this.#elevenLabs.elevenLabs.searchVoices({ ...query, provider: 'elevenlabs' }));
  }
}
