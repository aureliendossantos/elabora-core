import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findMediaTools } from '../media/tools.ts';
import { probeMedia } from '../media/probe.ts';
import { runFfmpeg } from '../media/encode.ts';
import { transcribeAudio } from '../transcribe/index.ts';
import type { Transcript } from '../transcribe/index.ts';
import { duration as spoken, image, seconds } from './markdown.ts';
import { SourceParts } from './reader.ts';
import type { ReaderContext, ReaderResult } from './reader.ts';

// A video or a recording as Markdown (docs/decisions.md D49): what it is, what it says, heard on this
// computer by the transcriber of D46 (Parakeet, downloaded once; its audio taken out by the ffmpeg
// Elabora already uses for media), in paragraphs that each start with their time, and for a video a
// few frames placed where they are in the transcript. Nothing leaves the computer: an interview may
// hold personal data. Without the transcriber yet (an author who did not download it), the readable
// version says so and is made again once it is there.

export const RECORDING_READER = 'recording/1';

// Frames of a video: one every two minutes or so, three at least, twelve at most.
export function frameTimes(total: number): number[] {
  if (!(total > 0)) return [];
  const count = total < 20 ? 1 : Math.max(3, Math.min(12, Math.round(total / 120)));
  return Array.from({ length: count }, (_, i) => Math.round(((i + 0.5) * total) / count * 10) / 10);
}

// A transcript cut into paragraphs: at the end of a sentence once 30 s are said, or at 90 s.
export function transcriptParagraphs(transcript: Pick<Transcript, 'text' | 'words'>): { start: number; text: string }[] {
  const tokens = transcript.text.split(/\s+/).filter(Boolean);
  const words = transcript.words;
  const paragraphs: { start: number; text: string }[] = [];
  let current: { start: number; tokens: string[] } | null = null;
  let next = 0;
  let last = 0;
  for (const token of tokens) {
    // A word of the text is a word of the transcriber's list (text.ts): punctuation alone is not.
    const time = /[\p{L}\p{N}]/u.test(token) && next < words.length ? words[next++].start : null;
    if (time !== null) last = time;
    current ??= { start: time ?? last, tokens: [] };
    current.tokens.push(token);
    const elapsed = last - current.start;
    if ((elapsed >= 30 && /[.!?…][»”")]?$/.test(token)) || elapsed >= 90) {
      paragraphs.push({ start: current.start, text: current.tokens.join(' ') });
      current = null;
    }
  }
  if (current) paragraphs.push({ start: current.start, text: current.tokens.join(' ') });
  return paragraphs;
}

export async function readRecording(file: string, context: ReaderContext): Promise<ReaderResult> {
  const tools = context.tools ?? await findMediaTools();
  const info = await probeMedia(file, { tools });
  const parts = new SourceParts(context);
  const video = info.kind === 'video' && !!info.width;
  const out: string[] = [];
  const notes: string[] = [];
  let complete = true;
  out.push(`${video ? 'Video' : 'Audio'}${info.duration ? `, ${spoken(info.duration)}` : ''}${video ? `, ${info.width}×${info.height}` : ''}${info.audioCodec ? '' : ', without sound'}.`);

  const frames: { time: number; markdown: string }[] = [];
  if (video && info.duration) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-frames-'));
    try {
      for (const time of frameTimes(info.duration)) {
        const name = `frame-${seconds(time).replace(/:/g, '-')}.jpg`;
        const target = path.join(temp, name);
        await runFfmpeg(tools, ['-nostdin', '-v', 'error', '-y', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', '-q:v', '5', '-map_metadata', '-1', target], { signal: context.signal });
        if (fs.existsSync(target)) frames.push({ time, markdown: image(`Frame at ${seconds(time)}`, await parts.add(name, target)) });
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  let transcript: Transcript | null = null;
  if (info.audioCodec) {
    try {
      transcript = await transcribeAudio(file, context.language, {
        install: context.install, signal: context.signal, tools,
        onProgress: (progress) => context.onProgress?.(progress.phase === 'install'
          ? { source: context.source, phase: 'install', received: progress.received, total: progress.total }
          : { source: context.source, phase: 'transcribe', fraction: progress.fraction })
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'E_TRANSCRIBE_NOT_INSTALLED') {
        complete = false;
        notes.push(`No transcript yet: the transcription model (downloaded once, then nothing leaves this computer) is not here. \`elabora sources read . "${context.source}"\` downloads it and writes the transcript, as Elabora settings › Téléchargements does.`);
      } else if (code === 'E_TRANSCRIBE_LANGUAGE') {
        notes.push(`No transcript: no transcriber on this computer hears ${context.language}.`);
      } else throw error;
    }
  }

  const items: string[] = [];
  const pending = [...frames];
  if (transcript) {
    notes.push(`Transcribed on this computer by ${transcript.transcriber} (numbers mostly in words, names as heard): check a quotation against the recording before using it.`);
    out.push('## Transcript');
    for (const paragraph of transcriptParagraphs(transcript)) {
      while (pending.length && pending[0].time <= paragraph.start) items.push(pending.shift()!.markdown);
      items.push(`**[${seconds(paragraph.start)}]** ${paragraph.text}`);
    }
    if (!transcript.text.trim()) items.push('*(nothing heard)*');
  }
  if (pending.length) {
    if (!transcript) out.push('## Frames');
    items.push(...pending.map((frame) => frame.markdown));
  }
  out.push(...items);
  return { markdown: out.join('\n\n'), complete, notes, parts: parts.written };
}
