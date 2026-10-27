import path from 'node:path';
import type { Author } from '@elabora/core/ops/types';
import type { Project } from '@elabora/core/project/model';
import { narrationLines } from '@elabora/core/narration/narration';
import { listVoices, voiceProvider, voiceProviders, generateNarration, estimateNarration, setSpeakerVoice, voiceTakes, voiceSample, setSessionKey, maskKey } from '@elabora/node/voice/index';
import type { VoiceQuery, VoiceSearchResult, VoiceAccount, VoiceEstimate, VoiceWriter, GenerateResult, TakeInfo } from '@elabora/node/voice/index';
import { aligners, alignNarration } from '@elabora/node/align/index';
import type { AlignWriter, AlignResult, AlignerView } from '@elabora/node/align/index';
import { estimateTranscription, transcribeAudio, transcribers } from '@elabora/node/transcribe/index';
import type { TranscribeProgress, Transcript, TranscriberView, TranscriptionEstimate, TranscriptionService } from '@elabora/node/transcribe/index';
import { transcribeNarrationLine } from '@elabora/node/narration/from-audio';
import { EngineError } from './errors.ts';
import type { CommandArgs, EngineEvent, VoiceView, GenerateVoiceParams, AlignNarrationParams } from './protocol.ts';
import type { Session } from './session.ts';

// Voices, alignment and transcription (D25, D27, D46): their jobs, which cancelVoice stops, and what
// they write, through the session's queue on its snapshot.
export class SessionVoice {
  readonly #root: string;
  readonly #author: Author;
  readonly #project: () => Project;
  readonly #run: Session['run'];
  readonly #assertOpen: () => void;
  readonly #emit: (event: EngineEvent) => void;

  constructor(init: { root: string; author: Author; project: () => Project; run: Session['run']; assertOpen: () => void; emit: (event: EngineEvent) => void }) {
    this.#root = init.root;
    this.#author = init.author;
    this.#project = init.project;
    this.#run = init.run;
    this.#assertOpen = init.assertOpen;
    this.#emit = init.emit;
  }

  // Transcription (D46): what can transcribe the course's language here.
  transcribers(language?: string): TranscriberView {
    this.#assertOpen();
    return transcribers(language || this.#project().course?.language || '');
  }

  // What a recording says, a text to check with its words; the model downloaded first with install,
  // ElevenLabs with service (its share of the quota approved from 1 %). cancelVoice stops it.
  async transcribeRecording({ file, language, install, service, approvedPercent }: { file: string; language?: string; install?: boolean; service?: TranscriptionService; approvedPercent?: number }): Promise<Transcript> {
    this.#assertOpen();
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new EngineError('bad-request', 'transcribeRecording takes file: the absolute path of a recording');
    const lang = language || this.#project().course?.language || '';
    try {
      return await this.#voiceJob(null, (signal) => transcribeAudio(file, lang, { signal, ...this.#transcribing({ install, service, approvedPercent }) }));
    } catch (error) { throw voiceError(error); }
  }

  // What transcribing a file, or a line's recording, with ElevenLabs takes of the author's quota.
  async transcriptionEstimate({ file, screen, line, language }: { file?: string; screen?: string; line?: string; language?: string }): Promise<TranscriptionEstimate> {
    this.#assertOpen();
    let audio = file;
    if (audio === undefined) {
      if (typeof screen !== 'string' || typeof line !== 'string') throw new EngineError('bad-request', 'transcriptionEstimate takes a file (an absolute path), or a screen and a line');
      const info = narrationLines(this.#project(), screen, language || this.#project().course?.language || '')?.find((candidate) => candidate.id === line);
      if (!info || info.status === 'missing') throw new EngineError('not-found', `Line "${line}" of "${screen}" has no audio`);
      audio = path.join(this.#root, info.audio);
    }
    if (!path.isAbsolute(audio)) throw new EngineError('bad-request', 'transcriptionEstimate takes file: the absolute path of a recording');
    try {
      return await estimateTranscription(audio);
    } catch (error) { throw voiceError(error); }
  }

  // What a line's recording says beside its text now (« Régénérer le texte d'après l'audio » shows
  // both before anything is written).
  async transcribeLine({ screen, line, language, install, service, approvedPercent }: { screen: string; line: string; language?: string; install?: boolean; service?: TranscriptionService; approvedPercent?: number }): Promise<{ before: string; transcript: Transcript; audioHash: `sha256:${string}` | null }> {
    this.#assertOpen();
    if (!this.#project().screens.has(screen)) throw new EngineError('not-found', `No screen "${screen}"`);
    try {
      return await this.#voiceJob(screen, (signal) => transcribeNarrationLine(this.#root, { screen, line, ...(language ? { language } : {}), signal, ...this.#transcribing({ install, service, approvedPercent }) }));
    } catch (error) { throw voiceError(error); }
  }

  #transcribing({ install, service, approvedPercent }: { install?: boolean; service?: TranscriptionService; approvedPercent?: number }) {
    return {
      install: install === true, ...(service === 'elevenlabs' ? { service } : {}), ...(typeof approvedPercent === 'number' ? { approvedPercent } : {}),
      onProgress: (progress: TranscribeProgress) => this.#emit({ type: 'transcribeProgress', progress })
    };
  }

  // ── voices (docs/decisions.md D25) ─────────────────────────────────

  voices(language?: string): VoiceView[] {
    this.#assertOpen();
    return listVoices(language).map((voice) => ({ ...voice, ...(voiceProvider(voice.provider).status(voice.language) ?? { installed: false, size: 0 }) }));
  }

  // What the voices are making (a screen's lines, or a download without a screen): cancelVoice stops them.
  #voiceJobs = new Set<{ screen: string | null; controller: AbortController }>();

  async #voiceJob<T>(screen: string | null, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const job = { screen, controller: new AbortController() };
    this.#voiceJobs.add(job);
    try {
      return await run(job.controller.signal);
    } finally {
      this.#voiceJobs.delete(job);
    }
  }

  async installVoices(language: string): Promise<{ language: string; installed: boolean }> {
    this.#assertOpen();
    const providers = voiceProviders().filter((provider) => !provider.paid && provider.status(language));
    if (!providers.length) throw new EngineError('not-found', `No voice speaks ${language}`);
    return this.#voiceJob(null, async (signal) => {
      try {
        for (const provider of providers) {
          await provider.install(language, { signal, onProgress: (p) => this.#emit({ type: 'voiceProgress', progress: { phase: 'install', fraction: p.total ? p.received / p.total : 0, received: p.received, total: p.total } }) });
        }
      } catch (error) {
        if (signal.aborted) return { language, installed: false };
        throw voiceError(error);
      }
      return { language, installed: true };
    });
  }

  cancelVoice(screen?: string): { cancelled: number } {
    this.#assertOpen();
    let cancelled = 0;
    for (const job of this.#voiceJobs) {
      if (screen !== undefined && job.screen !== screen) continue;
      if (!job.controller.signal.aborted) { job.controller.abort(); cancelled++; }
    }
    return { cancelled };
  }

  async voiceSample(params: { voice: string; provider?: string; language?: string; text: string; spend?: boolean; name?: string }): Promise<{ audio: Uint8Array; duration: number }> {
    this.#assertOpen();
    try {
      return await voiceSample(params);
    } catch (error) { throw voiceError(error); }
  }

  // The session writes what the voices make: through its queue, on its snapshot.
  #voiceWriter(author: Author): VoiceWriter {
    return {
      project: () => this.#project(),
      setNarrationAudio: async (args) => {
        const written = await this.#run('set_narration_audio', args, author);
        return { audio: typeof written.result.audio === 'string' ? written.result.audio : undefined, seq: written.change?.seq ?? null,
          ...(typeof written.result.alignmentError === 'string' ? { alignmentError: written.result.alignmentError } : {}) };
      },
      updateSpeakers: async (speakers) => (await this.#run('update_course', { speakers } as CommandArgs['update_course'], author)).change?.seq ?? null,
      updateLinePause: async (screen, line, pause) => (await this.#run('update_narration_line', { screen, line, pauseBefore: pause } as CommandArgs['update_narration_line'], author)).change?.seq ?? null
    };
  }

  // The ElevenLabs key, in this process's memory only (when the app keeps it in the system's secure storage, D40).
  setVoiceKey(key: string | null): { key: string | null } {
    try { setSessionKey(key); } catch (error) { throw voiceError(error); }
    return { key: key ? maskKey(key.trim()) : null };
  }

  async voiceAccount({ check }: { check?: boolean }): Promise<VoiceAccount> {
    try { return await voiceProvider('elevenlabs').account!({ check }); } catch (error) { throw voiceError(error); }
  }

  async voiceSearch(query: VoiceQuery): Promise<VoiceSearchResult> {
    try { return await voiceProvider('elevenlabs').search!({ ...query, provider: 'elevenlabs' }); } catch (error) { throw voiceError(error); }
  }

  async voiceEstimate(params: GenerateVoiceParams): Promise<VoiceEstimate> {
    this.#assertOpen();
    try { return await estimateNarration(this.#root, params, this.#voiceWriter(this.#author)); } catch (error) { throw voiceError(error); }
  }

  aligners(language?: string): AlignerView[] {
    this.#assertOpen();
    return aligners(language);
  }

  // Times the words of voiced lines, through the write queue (set_narration_words), cancelVoice stops it.
  async alignNarration(params: AlignNarrationParams = {}, author: Author = this.#author): Promise<AlignResult> {
    this.#assertOpen();
    const writer: AlignWriter = {
      project: () => this.#project(),
      setNarrationWords: async (args) => (await this.#run('set_narration_words', args, author)).change?.seq ?? null
    };
    try {
      return await this.#voiceJob(params.screen ?? null, (signal) => alignNarration(this.#root, {
        ...params, signal, onProgress: (progress) => this.#emit({ type: 'alignProgress', ...(params.screen ? { screen: params.screen } : {}), progress })
      }, undefined, writer));
    } catch (error) { throw voiceError(error); }
  }

  async setSpeakerVoice({ speaker, voice, language, provider, name, settings }: { speaker: string; voice: string; language?: string; provider?: string; name?: string; settings?: Record<string, unknown> }, author: Author = this.#author): Promise<{ change: number | null }> {
    this.#assertOpen();
    try {
      return { change: await setSpeakerVoice(this.#root, { speaker, voice, ...(language ? { language } : {}), ...(provider ? { provider } : {}), ...(name ? { name } : {}), ...(settings ? { settings } : {}) }, undefined, this.#voiceWriter(author)) };
    } catch (error) { throw voiceError(error); }
  }

  async generateVoice(params: GenerateVoiceParams, author: Author = this.#author): Promise<GenerateResult> {
    this.#assertOpen();
    try {
      return await this.#voiceJob(params.screen, (signal) => generateNarration(this.#root, { ...params, signal, onProgress: (progress) => this.#emit({ type: 'voiceProgress', screen: params.screen, progress }) }, undefined, this.#voiceWriter(author)));
    } catch (error) { throw voiceError(error); }
  }

  voiceTakes({ screen, line, language }: { screen: string; line: string; language?: string }): { language: string; takes: TakeInfo[] } {
    this.#assertOpen();
    try {
      return voiceTakes(this.#root, { screen, line, ...(language ? { language } : {}) }, this.#project());
    } catch (error) { throw voiceError(error); }
  }
}

// A voice tool's error, for the app: what was not found or not set is refused with its code.
function voiceError(error: unknown): unknown {
  if (error instanceof EngineError || !(error instanceof Error) || !('code' in error) || typeof error.code !== 'string' || !/^E_(VOICE|ALIGN|TRANSCRIBE|NARRATION)_/.test(error.code)) return error;
  const kind = /^E_(VOICE|ALIGN|TRANSCRIBE)_(DOWNLOAD|RUNTIME|NOT_INSTALLED|LANGUAGE)$/.test(error.code) ? 'not-available' : /^E_(VOICE|ALIGN|NARRATION)_(SCREEN|LINE)$/.test(error.code) || error.code === 'E_VOICE_UNKNOWN' ? 'not-found' : 'refused';
  return new EngineError(kind, error.message, { code: error.code });
}
