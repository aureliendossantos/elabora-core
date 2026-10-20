// Narrated screens for tests (docs/decisions.md D24). The voices are synthetic: ffmpeg sine tones of
// known lengths, one frequency per line, never a recorded or system voice (their licences forbid
// shipping them). Needs ffmpeg on the PATH (or ELABORA_FFMPEG).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { narrationTextHash, narrationAudioPath, narrationSidecarPath } from '@elabora/core';
import { readJSON, writeJSON } from './helpers.ts';

export const FFMPEG = process.env.ELABORA_FFMPEG || 'ffmpeg';

export function hasFfmpeg(): boolean {
  try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// A tone of `seconds` in an M4A (AAC, mono), as a voice tool would write a line.
export function toneM4a(file: string, seconds: number, frequency = 440): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${seconds}:sample_rate=48000`, '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1', '-movflags', '+faststart', file]);
}

export interface FixtureLine {
  id: string;
  text: string;
  step?: number;
  speaker?: string;
  pauseBefore?: number;
  // Seconds of the line's tone; left out: the line has no audio.
  seconds?: number;
}

export interface NarrateOptions {
  advance?: 'learner' | 'auto' | 'next-screen';
  seek?: 'seen' | 'free' | 'none';
  // Speakers to declare in course.json (replacing those there).
  speakers?: { id: string; name: string; voices?: Record<string, { provider: string; voice: string }> }[];
  language?: string;
  // What each voiced line's sidecar says the credits are.
  credit?: string;
}

// Gives a screen its narration, and each line with seconds its tone and sidecar.
export function narrate(dir: string, screenId: string, lines: FixtureLine[], { advance, seek, speakers, language, credit }: NarrateOptions = {}): void {
  const course = readJSON(dir, 'course.json');
  if (speakers) { course.speakers = speakers; writeJSON(dir, 'course.json', course); }
  const lang = language || course.language;
  const screen = readJSON(dir, `screens/${screenId}.json`);
  screen.narration = {
    ...(advance ? { advance } : {}), ...(seek ? { seek } : {}),
    lines: lines.map(({ seconds: _seconds, ...line }) => line)
  };
  writeJSON(dir, `screens/${screenId}.json`, screen);
  lines.forEach((line, index) => { if (line.seconds !== undefined) voice(dir, screenId, line, { language: lang, frequency: 330 + 110 * index, credit }); });
}

// The audio and sidecar of one line, as the voice tools write them.
export function voice(dir: string, screenId: string, line: FixtureLine, { language, frequency = 440, provider = 'test-tone', name = `sine-${frequency}`, generated = true, credit }: { language: string; frequency?: number; provider?: string; name?: string; generated?: boolean; credit?: string }): void {
  const audio = path.join(dir, narrationAudioPath(language, screenId, line.id));
  toneM4a(audio, line.seconds ?? 1, frequency);
  const bytes = fs.readFileSync(audio);
  writeJSON(dir, narrationSidecarPath(language, screenId, line.id), {
    screen: screenId, line: line.id, language, textHash: narrationTextHash(line.text), duration: line.seconds ?? 1,
    provider, voice: name, generated, audioHash: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, ...(credit ? { credit } : {})
  });
}
