import path from 'node:path';
import { narrationLines, readNarrationSidecar } from '@elabora/core/narration/narration';
import type { FileHash } from '@elabora/core/project/files';
import type { HostNeeds } from '@elabora/core/commands/host';
import type { HostOptions } from '../edit/host.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { alignAudio, alignsAtOnce } from '../align/index.ts';
import { loadProjectFromDir } from '../project-reader.ts';
import { transcribeAudio, TranscriptionError } from '../transcribe/index.ts';
import type { TranscribeOptions, Transcript } from '../transcribe/index.ts';
import { withApostrophesOf } from '../transcribe/text.ts';
import { createdAt, withLineAudio } from './audio.ts';
import type { LineFromAudioFileArgs, TextFromAudioFileArgs } from '@elabora/core/commands/narration';

// Lines and their recordings (docs/decisions.md D46): a new line made from an audio file (« Nouvelle
// réplique depuis un fichier audio… », elabora narration add-from-audio), and the text of a line
// written again from its recording (« Régénérer le texte d'après l'audio », elabora narration
// retranscribe). The recording is transcribed (transcribe/: on this computer by default), unless
// its text is given; its words are timed on that text by the word aligner when it is on this
// computer (D27), and the line, its text and its audio are written in one undoable change.

// What a recording made a line needs of this computer (recording): its audio as the course keeps
// it, its text (given, or heard by the transcriber in the audio the line keeps, its silence trimmed,
// so that word times match), its words timed.
export async function recording<R>(dir: string, args: LineFromAudioFileArgs, options: HostOptions, use: (heard: HostNeeds['recording']) => R): Promise<R> {
  const project = loadProjectFromDir(dir);
  const language = args.language || project.course?.language || '';
  if (!project.screens.has(args.screen)) throw new TranscriptionError('E_NARRATION_SCREEN', `Unknown screen "${args.screen}".`);
  const tools = options.tools ?? await findMediaTools();
  return withLineAudio(args.file, { trim: args.trim !== false, tools }, async (audio) => {
    const transcript = args.text?.trim() ? null : await transcribeAudio(audio.file, language, { ...transcribing(args, options), tools });
    const text = (args.text ?? transcript?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) throw new TranscriptionError('E_TRANSCRIBE_EMPTY', `${path.basename(args.file)}: the transcriber heard no words in it. Give its text (--text).`);
    const timed = await timedWords(audio.file, text, language, tools, options.signal);
    return use({
      language, text, ...(transcript ? { transcript } : {}), audio: { size: audio.bytes.length, hash: audio.hash }, duration: audio.duration, voice: path.basename(args.file),
      ...(timed ?? {}), createdAt: createdAt(), bytes: new Map([[audio.hash, audio.bytes]])
    });
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

// What the line's recording says, beside its text now: what « Régénérer le texte d'après l'audio »
// shows before anything is written (the old text and the new).
export async function transcribeNarrationLine(dir: string, args: Omit<TextFromAudioFileArgs, 'text' | 'audioHash'>, options: HostOptions = {}): Promise<{ before: string; transcript: Transcript; audioHash: FileHash | null }> {
  const recording = recordingOf(dir, args.screen, args.line, args.language);
  const heard = await transcribeAudio(recording.file, recording.language, { ...transcribing(args, options), ...(options.tools ? { tools: options.tools } : {}) });
  const transcript = { ...heard, text: withApostrophesOf(heard.text, recording.text) };
  return { before: recording.text, transcript, audioHash: recording.audioHash ?? null };
}

// What set_narration_text_from_audio needs of this computer (heardText): what the line's recording
// says (given, or heard now), its words timed on that text.
export async function heardText<R>(dir: string, args: TextFromAudioFileArgs, options: HostOptions, use: (heard: HostNeeds['heardText']) => R): Promise<R> {
  const recording = recordingOf(dir, args.screen, args.line, args.language);
  const tools = options.tools ?? await findMediaTools();
  const transcript = args.text?.trim() ? null : await transcribeAudio(recording.file, recording.language, { ...transcribing(args, options), tools });
  const text = (args.text ?? withApostrophesOf(transcript?.text ?? '', recording.text)).replace(/\s+/g, ' ').trim();
  if (!text) throw new TranscriptionError('E_TRANSCRIBE_EMPTY', `The transcriber heard no words in the recording of line "${args.line}": its text stays.`);
  const audioHash = args.audioHash ?? recording.audioHash;
  const timed = await timedWords(recording.file, text, recording.language, tools, options.signal);
  return use({ language: recording.language, text, ...(audioHash ? { audioHash } : {}), ...(timed ?? {}), ...(transcript ? { transcript } : {}) });
}

const transcribing = (args: Pick<TextFromAudioFileArgs, 'service' | 'install' | 'approvedPercent'>, options: HostOptions): TranscribeOptions => ({
  ...(args.service ? { service: args.service } : {}), ...(args.install ? { install: true } : {}),
  ...(typeof args.approvedPercent === 'number' ? { approvedPercent: args.approvedPercent } : {}),
  ...(options.signal ? { signal: options.signal } : {}), ...(options.onTranscribe ? { onProgress: options.onTranscribe } : {})
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
