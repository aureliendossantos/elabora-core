import fs from 'node:fs';
import path from 'node:path';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { samplesOf } from '../align/index.ts';
import { resolveKey } from '../voice/elevenlabs/key.ts';
import { TranscribeProcess, TranscriptionError } from './process.ts';
import { acquireTranscriber, holdTranscriber, installTranscriber, transcriberDir, transcriberDownloading, transcriberFor, transcriberInstalled, transcriberSize } from './models.ts';
import { elevenLabsTranscript } from './elevenlabs.ts';
import type { TranscribeProgress, Transcript, TranscriberView, TranscriptionService } from './types.ts';
import { localAiSupported, requireLocalAi } from '../models/platform.ts';

// What a recording says (docs/decisions.md D46): the text of a line made from a recording, or the
// text a recording gives back to its line (« Régénérer le texte d'après l'audio »). By default on
// this computer, free and private: Parakeet TDT 0.6B v3 (models.ts, downloaded once, 25 European
// languages, punctuation and capitals) in a process of its own (process.ts). On the author's
// request, ElevenLabs' speech to text with their key (elevenlabs.ts), its share of the quota told
// before anything is spent (D30). Either way the text is the author's to check, and the word aligner
// (D27) times it when the line is written.
//
// ELABORA_TRANSCRIBER_FAKE=<file.json> ({ "<file name, or its name without extension>": "text", "*":
// "text" }) answers the local
// transcription without the model's inference (the model still has to be installed, made-up files
// will do): for the app's tests and try scripts, never for authors.

export { TRANSCRIBER_MODELS, transcriberFor, transcriberInstalled, transcriberSize, installTranscriber, TranscriberDownloadError } from './models.ts';
export type { TranscriberModel } from './models.ts';
export { TranscriptionError } from './process.ts';
export type { TranscribeProgress, Transcript, TranscriberView, TranscriptionEstimate, TranscriptionService } from './types.ts';
export { estimateTranscription } from './elevenlabs.ts';

const SAMPLE_RATE = 16000;
let transcriber: TranscribeProcess | null = null;

// Stops the transcriber's process and frees its model (tests, a closing engine, a removal).
export async function disposeTranscriber(): Promise<void> {
  const current = transcriber;
  transcriber = null;
  await current?.dispose();
}

// What can transcribe a language on this computer.
export function transcribers(language: string): TranscriberView {
  const model = transcriberFor(language);
  return {
    language,
    local: model && localAiSupported() ? { model: model.model, installed: transcriberInstalled(model), size: transcriberSize(model), installing: transcriberDownloading(model) } : null,
    elevenlabs: resolveKey() !== null
  };
}

export interface TranscribeOptions {
  service?: TranscriptionService;   // default: local
  install?: boolean;                // download the local model when it is not here (else E_TRANSCRIBE_NOT_INSTALLED)
  approvedPercent?: number;         // ElevenLabs: the share of the quota the author approved (D30)
  signal?: AbortSignal;
  onProgress?: (progress: TranscribeProgress) => void;
  tools?: MediaTools;
}

export async function transcribeAudio(file: string, language: string, options: TranscribeOptions = {}): Promise<Transcript> {
  const input = path.resolve(file);
  if (!fs.existsSync(input)) throw new TranscriptionError('E_TRANSCRIBE_FILE', `No file ${file}.`);
  if (options.service === 'elevenlabs') return elevenLabsTranscript(input, language, options);
  requireLocalAi();
  const model = transcriberFor(language);
  if (!model) throw new TranscriptionError('E_TRANSCRIBE_LANGUAGE', `No transcriber on this computer hears ${language} yet (Parakeet: 25 European languages); ElevenLabs can (service elevenlabs).`);
  // Held while it transcribes: it is not removed under it (Elabora settings, D38).
  let release: (() => void) | null = null;
  try {
    if (!transcriberInstalled(model)) {
      if (!options.install) throw new TranscriptionError('E_TRANSCRIBE_NOT_INSTALLED', `The transcription model is not on this computer yet (${Math.round(transcriberSize(model) / 1e6)} MB, downloaded once): install it (elabora downloads install transcriber, or --install).`);
      await installTranscriber(model, { signal: options.signal, onProgress: (progress) => options.onProgress?.({ phase: 'install', received: progress.received, total: progress.total }) });
    }
    const active = await acquireTranscriber(model, options.signal);
    release = active.release;
    const samples = await samplesOf(input, options.tools ?? await findMediaTools(), options.signal);
    options.signal?.throwIfAborted();
    options.onProgress?.({ phase: 'transcribe', fraction: 0 });
    const fake = fakeTranscript(input, samples.length / SAMPLE_RATE);
    if (fake) return fake;
    transcriber ??= new TranscribeProcess();
    const heard = await transcriber.transcribe({ dir: active.dir, samples, language });
    options.signal?.throwIfAborted();
    options.onProgress?.({ phase: 'transcribe', fraction: 1 });
    return { ...heard, transcriber: active.model, service: 'local' };
  } finally {
    release?.();
  }
}

// The tests' transcriber (ELABORA_TRANSCRIBER_FAKE): the text given for the file's name (with its
// extension or without: a recording is heard as it was chosen, or as the line keeps it), its words
// spread over the audio.
function fakeTranscript(file: string, duration: number): Transcript | null {
  const config = process.env.ELABORA_TRANSCRIBER_FAKE;
  if (!config) return null;
  const texts = JSON.parse(fs.readFileSync(config, 'utf8')) as Record<string, string>;
  const name = path.basename(file);
  const text = texts[name] ?? texts[name.replace(/\.[^.]+$/, '')] ?? texts['*'] ?? '';
  const words = text.split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean);
  const step = duration / (words.length || 1);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return { text, transcriber: 'fake', service: 'local', duration: round(duration), words: words.map((word, i) => ({ text: word, start: round(i * step), end: round((i + 1) * step) })) };
}
