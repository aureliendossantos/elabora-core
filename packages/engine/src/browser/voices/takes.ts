// A browser's takes of a line (D24, D25): kept in the origin's private file system, a folder a copy,
// never in the course nor sent to the room, as the desktop keeps them in the project's machine-local
// data: elabora-takes/<copy>/<language>/<screen>/<line>/take-<n>.wav and .json. A take is named by its
// path there (« opfs:elabora-takes/… »). A take at another speed keeps its pitch (WSOLA, as ffmpeg's
// atempo does at the desktop).

import type { StoredTake, TakeStore } from '@elabora/core/voice/generate';
import { wavBytes } from '@elabora/core/voice/wav';

const ROOT = 'elabora-takes';
const PREFIX = 'opfs:';

async function folder(parts: readonly string[], create: boolean): Promise<FileSystemDirectoryHandle | null> {
  try {
    let at = await navigator.storage.getDirectory();
    for (const part of parts) at = await at.getDirectoryHandle(part, { create });
    return at;
  } catch {
    return null;
  }
}

const names = async (dir: FileSystemDirectoryHandle): Promise<string[]> => {
  const out: string[] = [];
  for await (const name of (dir as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }).keys()) out.push(name);
  return out;
};

async function write(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array | string): Promise<void> {
  const stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await stream.write(bytes as FileSystemWriteChunkType);
  await stream.close();
}

// The audio of a take by its name, or null (the browser erased it).
export async function takeAudio(file: string): Promise<Blob | null> {
  if (!file.startsWith(PREFIX)) return null;
  const parts = file.slice(PREFIX.length).split('/');
  const dir = await folder(parts.slice(0, -1), false);
  try { return dir ? await (await dir.getFileHandle(parts.at(-1)!)).getFile() : null; } catch { return null; }
}

export function browserTakes(copy: string): TakeStore {
  const path = (language: string, screen: string, line: string) => [ROOT, copy, language, screen, line];
  return {
    async list(language, screen, line) {
      const dir = await folder(path(language, screen, line), false);
      if (!dir) return [];
      const present = new Set(await names(dir));
      const takes: StoredTake[] = [];
      for (const name of present) {
        if (!/^take-\d+\.json$/.test(name)) continue;
        const wav = name.replace(/\.json$/, '.wav');
        if (!present.has(wav)) continue;
        try {
          const meta = JSON.parse(await (await (await dir.getFileHandle(name)).getFile()).text()) as Omit<StoredTake, 'file'>;
          takes.push({ ...meta, file: `${PREFIX}${[...path(language, screen, line), wav].join('/')}` });
        } catch { /* a take half written: left out */ }
      }
      return takes.sort((a, b) => a.take - b.take);
    },
    async keep({ language, screen, line, take, samples, sampleRate, speed, meta }) {
      const dir = await folder(path(language, screen, line), true);
      if (!dir) throw new Error('This browser keeps no files for this site (a private window?): the take cannot be kept.');
      const name = `take-${take}.wav`;
      await write(dir, name, wavBytes(speed === 1 ? samples : tempo(samples, sampleRate, speed), sampleRate));
      await write(dir, `take-${take}.json`, `${JSON.stringify(meta, null, 2)}\n`);
      return `${PREFIX}${[...path(language, screen, line), name].join('/')}`;
    }
  };
}

// The samples said faster (speed > 1) or slower, their pitch kept: WSOLA, windows of 40 ms laid at
// half a window apart in the output, each taken from where the input is at that time, moved by up to
// 10 ms to where it follows the window before best (cross-correlation).
export function tempo(samples: Float32Array, rate: number, speed: number): Float32Array {
  const size = Math.max(64, Math.round(0.04 * rate));
  const hop = Math.floor(size / 2);
  const search = Math.round(0.01 * rate);
  const out = new Float32Array(Math.ceil(samples.length / speed) + size);
  const weight = new Float32Array(out.length);
  const window = Float32Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  let previous = 0;
  for (let at = 0; at + size <= out.length; at += hop) {
    const ideal = Math.round(at * speed);
    if (ideal + size > samples.length) break;
    let best = ideal;
    if (at > 0) {
      // What naturally follows the last window taken, half a window on.
      const follow = previous + hop;
      let score = -Infinity;
      for (let shift = -search; shift <= search; shift++) {
        const from = ideal + shift;
        if (from < 0 || from + size > samples.length) continue;
        let sum = 0;
        for (let i = 0; i < hop; i++) sum += samples[from + i]! * (samples[follow + i] ?? 0);
        if (sum > score) { score = sum; best = from; }
      }
    }
    for (let i = 0; i < size; i++) { out[at + i]! += samples[best + i]! * window[i]!; weight[at + i]! += window[i]!; }
    previous = best;
  }
  let length = 0;
  for (let i = 0; i < out.length; i++) if (weight[i]! > 1e-3) { out[i]! /= weight[i]!; length = i + 1; }
  return out.slice(0, length);
}
