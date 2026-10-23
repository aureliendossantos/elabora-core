import path from 'node:path';
import { narrationLines, readNarrationSidecar } from '@elabora/core/narration/narration';
import type { FileHash } from '@elabora/core/project/files';
import { addNarrationLineWithAudioChange, setNarrationTextFromAudioChange } from '../edit/index.ts';
import type { EditOptions } from '../edit/executor.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { alignAudio, alignsAtOnce } from '../align/index.ts';
import { loadProjectFromDir } from '../project-reader.ts';
import { transcribeAudio, TranscriptionError } from '../transcribe/index.ts';
import type { TranscribeOptions, Transcript } from '../transcribe/index.ts';
import { withApostrophesOf } from '../transcribe/text.ts';
import { createdAt, withLineAudio } from './audio.ts';
import type { LineFromAudioFileArgs, TextFromAudioFileArgs } from './types.ts';

export type { LineFromAudioFileArgs, TextFromAudioFileArgs } from './types.ts';

// Lines and their recordings (docs/decisions.md D46): a new line made from an audio file (« Nouvelle
// réplique depuis un fichier audio… », elabora narration add-from-audio), and the text of a line
// written again from its recording (« Régénérer le texte d'après l'audio », elabora narration
// retranscribe). The recording is transcribed (transcribe/: on this computer by default), unless
// its text is given; its words are timed on that text by the word aligner when it is on this
// computer (D27), and the line, its text and its audio are written in one undoable change.

type Transcribing = Pick<TranscribeOptions, 'service' | 'install' | 'approvedPercent' | 'signal' | 'onProgress'>;

// What runs a job, beside its arguments (which the engine's protocol carries).
interface Running {
  signal?: AbortSignal;
  onProgress?: TranscribeOptions['onProgress'];
  tools?: MediaTools;
}

export type LineFromAudioArgs = LineFromAudioFileArgs & Running;

export async function addNarrationLineFromAudio(dir: string, args: LineFromAudioArgs, options?: EditOptions) {
  const project = loadProjectFromDir(dir);
  const language = args.language || project.course?.language || '';
  if (!project.screens.has(args.screen)) throw new TranscriptionError('E_NARRATION_SCREEN', `Unknown screen "${args.screen}".`);
  const tools = args.tools ?? await findMediaTools();
  return withLineAudio(args.file, { trim: args.trim !== false, tools }, async (audio) => {
    // What the voice says, heard in the audio the line keeps (its silence trimmed), so that word times match.
    const transcript = args.text?.trim() ? null : await transcribeAudio(audio.file, language, { ...transcribing(args), tools });
    const text = (args.text ?? transcript?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) throw new TranscriptionError('E_TRANSCRIBE_EMPTY', `${path.basename(args.file)}: the transcriber heard no words in it. Give its text (--text).`);
    const timed = await timedWords(audio.file, text, language, tools, args.signal);
    const written = await addNarrationLineWithAudioChange(dir, {
      screen: args.screen, ...(args.after !== undefined ? { after: args.after } : {}), ...(args.layer !== undefined ? { layer: args.layer } : {}), language,
      line: { text, ...(args.speaker ? { speaker: args.speaker } : {}), ...(typeof args.step === 'number' ? { step: args.step } : {}) },
      audio: { size: audio.bytes.length, hash: audio.hash }, duration: audio.duration, provider: 'recording', voice: path.basename(args.file), generated: false,
      ...(timed ?? {}), createdAt: createdAt()
    }, new Map([[audio.hash, audio.bytes]]), options);
    return { ...written, text, ...(transcript ? { transcript } : {}) };
  });
}

// The recording of a line and what the line says now, to transcribe it again.
function recordingOf(dir: string, screen: string, line: string, language?: string): { file: string; text: string; audioHash: FileHash | undefined; language: string } {
  const project = loadProjectFromDir(dir);
  const lang = language || project.course?.language || '';
  if (!project.screens.has(screen)) throw new TranscriptionError('E_NARRATION_SCREEN', `Unknown screen "${screen}".`);
  if (lang !== project.course?.language) throw new TranscriptionError('E_NARRATION_LANGUAGE', `Only the course's language (${project.course?.language}) is written from its audio: a translation's text is written in the translation.`);
  const info = narrationLines(project, screen, lang)?.find((candidate) => candidate.id === line);
  if (!info) throw new TranscriptionError('E_NARRATION_LINE', `No line "${line}" in the narration of "${screen}".`);
  const { sidecar } = readNarrationSidecar(project.files, info.sidecar);
  if (!sidecar || info.status === 'missing') throw new TranscriptionError('E_NARRATION_NO_AUDIO', `Line "${line}" has no audio to read its text from: import a recording first (elabora narration import).`);
  if (sidecar.generated) throw new TranscriptionError('E_NARRATION_GENERATED', `Line "${line}" is said by a generated voice, which says its text: change the text, then generate it again.`);
  return { file: path.join(project.root ?? dir, info.audio), text: info.text ?? '', audioHash: sidecar.audioHash as FileHash | undefined, language: lang };
}

export type TextFromAudioArgs = TextFromAudioFileArgs & Running;

// What the line's recording says, beside its text now: what « Régénérer le texte d'après l'audio »
// shows before anything is written (the old text and the new).
export async function transcribeNarrationLine(dir: string, args: Omit<TextFromAudioArgs, 'text' | 'audioHash'>): Promise<{ before: string; transcript: Transcript; audioHash: FileHash | null }> {
  const recording = recordingOf(dir, args.screen, args.line, args.language);
  const heard = await transcribeAudio(recording.file, recording.language, { ...transcribing(args), ...(args.tools ? { tools: args.tools } : {}) });
  const transcript = { ...heard, text: withApostrophesOf(heard.text, recording.text) };
  return { before: recording.text, transcript, audioHash: recording.audioHash ?? null };
}

export async function setNarrationTextFromAudio(dir: string, args: TextFromAudioArgs, options?: EditOptions) {
  const recording = recordingOf(dir, args.screen, args.line, args.language);
  const tools = args.tools ?? await findMediaTools();
  const transcript = args.text?.trim() ? null : await transcribeAudio(recording.file, recording.language, { ...transcribing(args), tools });
  const text = (args.text ?? withApostrophesOf(transcript?.text ?? '', recording.text)).replace(/\s+/g, ' ').trim();
  if (!text) throw new TranscriptionError('E_TRANSCRIBE_EMPTY', `The transcriber heard no words in the recording of line "${args.line}": its text stays.`);
  const audioHash = args.audioHash ?? recording.audioHash;
  const timed = await timedWords(recording.file, text, recording.language, tools, args.signal);
  const written = setNarrationTextFromAudioChange(dir, {
    screen: args.screen, line: args.line, language: recording.language, text, ...(audioHash ? { audioHash } : {}), ...(timed ?? {})
  }, options);
  return { ...written, ...(transcript ? { transcript } : {}) };
}

const transcribing = (args: Transcribing): TranscribeOptions => ({
  ...(args.service ? { service: args.service } : {}), ...(args.install ? { install: true } : {}),
  ...(typeof args.approvedPercent === 'number' ? { approvedPercent: args.approvedPercent } : {}),
  ...(args.signal ? { signal: args.signal } : {}), ...(args.onProgress ? { onProgress: args.onProgress } : {})
});

// The text's words on the audio, when the language's aligner is here (an alignment that fails
// leaves them placed in proportion to the text until elabora narration align).
async function timedWords(file: string, text: string, language: string, tools: MediaTools, signal?: AbortSignal): Promise<{ words: { text: string; start: number; end: number; score?: number }[]; aligner: string } | null> {
  if (!alignsAtOnce(language)) return null;
  try {
    const aligned = await alignAudio(file, text, language, { tools, ...(signal ? { signal } : {}) });
    return aligned?.words.length ? { words: aligned.words, aligner: aligned.aligner } : null;
  } catch {
    return null;
  }
}
