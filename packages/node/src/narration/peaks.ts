import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { narrationLines } from '@elabora/core/narration/narration';
import type { Project } from '@elabora/core/project/model';
import { projectDataDir } from '../data-dir.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import { decodeSamples } from './tracks.ts';
import { writeFileAtomic } from '../util/fs.ts';
import type { LinePeaks, NarrationPeaks } from './types.ts';

// The waveform of a narrated screen's lines, for the editor's Chronologie view (the words of the
// narration laid on it): the loudest sample of each slice of a line's audio, 0 to 255, perSecond
// slices a second. Decoded by ffmpeg once per audio file and slice length, kept in the project's
// data (<data>/cache/peaks/), never in the course.

export type { LinePeaks, NarrationPeaks } from './types.ts';

const RATE = 8000;

async function peaksOf(file: string, perSecond: number, tools: MediaTools): Promise<Uint8Array> {
  const samples = await decodeSamples(tools, file, RATE);
  const slice = RATE / perSecond;
  const peaks = new Uint8Array(Math.ceil(samples.length / slice));
  for (let i = 0; i < peaks.length; i++) {
    let peak = 0;
    const end = Math.min(samples.length, Math.round((i + 1) * slice));
    for (let s = Math.round(i * slice); s < end; s++) { const value = Math.abs(samples[s]); if (value > peak) peak = value; }
    peaks[i] = Math.min(255, Math.round(peak * 255));
  }
  return peaks;
}

export async function narrationPeaks(root: string, project: Project, screen: string, { language, perSecond = 50, tools }: { language?: string; perSecond?: number; tools?: MediaTools } = {}): Promise<NarrationPeaks | null> {
  const lang = language || project.course?.language || '';
  const infos = narrationLines(project, screen, lang);
  if (!infos) return null;
  const rate = Math.max(1, Math.min(200, Math.round(perSecond)));
  const cache = path.join(projectDataDir(root), 'cache', 'peaks');
  const lines: LinePeaks[] = [];
  for (const info of infos) {
    const file = path.join(root, info.audio);
    if (!info.duration || !fs.existsSync(file)) continue;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const cached = path.join(cache, `${hash}-${rate}.bin`);
    let peaks: Uint8Array;
    if (fs.existsSync(cached)) peaks = new Uint8Array(fs.readFileSync(cached));
    else {
      peaks = await peaksOf(file, rate, tools ??= await findMediaTools());
      fs.mkdirSync(cache, { recursive: true });
      writeFileAtomic(cached, Buffer.from(peaks));
    }
    lines.push({ line: info.id, duration: info.duration, peaks });
  }
  return { screen, language: lang, perSecond: rate, lines };
}
