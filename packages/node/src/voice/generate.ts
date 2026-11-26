import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateNarration as generate, estimateNarration as estimate, setSpeakerVoice as setVoice, voiceSample as sample, takesOf } from '@elabora/core/voice/generate';
import type { GenerateOptions, StoredTake, TakeStore, VoiceHost, VoiceWriter as CoreWriter } from '@elabora/core/voice/generate';
import { wavBytes } from '@elabora/core/voice/wav';
import { narrationLines } from '@elabora/core/narration/narration';
import type { NarrationLineInfo } from '@elabora/core/narration/narration';
import { loadProjectFromDir } from '../project-reader.ts';
import { projectDataDir } from '../data-dir.ts';
import { setNarrationAudio } from '../narration/audio.ts';
import type { NarrationAudioArgs } from '../narration/audio.ts';
import type { Project } from '@elabora/core/project/model';
import type { EditOptions } from '../edit/index.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { runFfmpeg } from '../media/encode.ts';
import { alignsAtOnce, alignAudio } from '../align/index.ts';
import { voiceRegistry } from './provider.ts';
import type { GenerateResult, TakeInfo, VoiceEstimate } from './types.ts';
import { run } from '../edit/index.ts';
export type { VoiceProgress, LineResult, GenerateResult, TakeInfo, VoiceEstimate } from './types.ts';
export type { GenerateOptions } from '@elabora/core/voice/generate';

// Generated narration on this computer (docs/decisions.md D24, D25): what to say, with which voice,
// and what a take is, are the core's (@elabora/core/voice/generate); here a project is a folder, its
// takes are kept in the project's machine-local data (<data>/voice-takes/<language>/<screen>/<line>/
// take-<n>.wav and .json), never in the course, a take at another speed is made by ffmpeg's atempo,
// and a word aligner of the language on this computer times a line at once.

// Who writes the results: by default the edits of @elabora/node on the folder (the CLI, the MCP
// server); the desktop app's engine passes its session, whose write queue and snapshot they go through.
export interface VoiceWriter extends Omit<CoreWriter, 'setNarrationAudio'> {
  setNarrationAudio(args: NarrationAudioArgs): ReturnType<CoreWriter['setNarrationAudio']>;
}

export function folderWriter(dir: string, editOptions?: EditOptions): VoiceWriter {
  return {
    project: () => loadProjectFromDir(dir),
    async setNarrationAudio(args) {
      const written = await setNarrationAudio(dir, args, editOptions);
      return { audio: written.audio, seq: written.change?.seq ?? null, ...(written.alignmentError ? { alignmentError: written.alignmentError } : {}) };
    },
    async setSpeakerVoice(speaker, language, voice) {
      const written = await run(dir, 'update_course', { patch: { speakers: { [speaker]: { voices: { [language]: voice } } } } }, editOptions);
      return written.change?.seq ?? null;
    },
    async updateLinePause(screen, line, pause) {
      const written = await run(dir, 'update_narration_line', { screen, line, pauseBefore: pause }, editOptions);
      return written.change?.seq ?? null;
    }
  };
}

const takesDir = (dir: string, language: string, screen: string, line: string) => path.join(projectDataDir(dir), 'voice-takes', language, screen, line);

function readTakes(dir: string, language: string, screen: string, line: string): StoredTake[] {
  const folder = takesDir(dir, language, screen, line);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter((name) => /^take-\d+\.json$/.test(name)).flatMap((name) => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')) as Omit<StoredTake, 'file'>;
      const file = path.join(folder, name.replace(/\.json$/, '.wav'));
      return fs.existsSync(file) ? [{ ...meta, file }] : [];
    } catch { return []; }
  }).sort((a, b) => a.take - b.take);
}

function folderTakes(dir: string, tools: () => MediaTools): TakeStore {
  return {
    list: (language, screen, line) => readTakes(dir, language, screen, line),
    async keep({ language, screen, line, take, samples, sampleRate, speed, meta, signal }) {
      const folder = takesDir(dir, language, screen, line);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `take-${take}.wav`);
      if (speed !== 1) {
        const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-voice-'));
        try {
          fs.writeFileSync(path.join(temp, 'line.wav'), wavBytes(samples, sampleRate));
          await runFfmpeg(tools(), ['-nostdin', '-v', 'error', '-y', '-i', path.join(temp, 'line.wav'), '-af', `atempo=${speed}`, '-c:a', 'pcm_s16le', file], { signal });
        } finally { fs.rmSync(temp, { recursive: true, force: true }); }
      } else {
        fs.writeFileSync(file, wavBytes(samples, sampleRate));
      }
      fs.writeFileSync(path.join(folder, `take-${take}.json`), `${JSON.stringify(meta, null, 2)}\n`);
      return file;
    }
  };
}

// The folder as the core's voices see it: its takes, ffmpeg found before anything is said, the word
// aligner of this computer.
function folderHost(dir: string, writer: VoiceWriter): VoiceHost {
  let tools: MediaTools | null = null;
  const found = () => { if (!tools) throw new Error('The media tools were not looked for.'); return tools; };
  return {
    name: path.resolve(dir), providers: voiceRegistry, writer: writer as CoreWriter, takes: folderTakes(dir, found),
    alignsAtOnce: (language) => !!alignsAtOnce(language),
    prepare: async () => { tools = await findMediaTools(); },
    async alignAudio(audio, text, language, signal) {
      const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-voice-'));
      try {
        const file = path.join(temp, 'exchange.wav');
        fs.writeFileSync(file, wavBytes(audio.samples, audio.sampleRate));
        return await alignAudio(file, text, language, { tools: found(), signal });
      } finally {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
  };
}

// The takes of a line: which one is its audio, and which can be put back (same text, voice, settings).
export function voiceTakes(dir: string, { screen, line, language }: { screen: string; line: string; language?: string }, project: Project = loadProjectFromDir(dir)): { language: string; takes: TakeInfo[] } {
  const lang = language || project.course?.language || '';
  const info = narrationLines(project, screen, lang)?.find((candidate) => candidate.id === line);
  return takesOf(project, { screen, line, language: lang }, info ? readTakes(dir, lang, screen, line) : []);
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

// What generating would make and cost, without spending anything (« Générer » shows it first; an
// agent asks the author before spending).
export const estimateNarration = (dir: string, options: GenerateOptions, writer: VoiceWriter = folderWriter(dir)): Promise<VoiceEstimate> => estimate(folderHost(dir, writer), options);

export const generateNarration = (dir: string, options: GenerateOptions, editOptions?: EditOptions, writer: VoiceWriter = folderWriter(dir, editOptions)): Promise<GenerateResult> => generate(folderHost(dir, writer), options);

// A voice heard before it is chosen (« Écouter »): the core's voiceSample, with this computer's voices.
export const voiceSample = (params: Parameters<typeof sample>[1]): Promise<{ audio: Uint8Array; duration: number }> => sample({ providers: voiceRegistry }, params);

// A speaker's voice in a language (course.json speakers[].voices[<language>]); its other settings kept.
// Returns the change's sequence number, or null when nothing changed.
export const setSpeakerVoice = (dir: string, args: Parameters<typeof setVoice>[1], editOptions?: EditOptions, writer: VoiceWriter = folderWriter(dir, editOptions)): Promise<number | null> => setVoice({ name: path.resolve(dir), providers: voiceRegistry, writer: writer as CoreWriter }, args);

export type { NarrationLineInfo };
