import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Sound } from '@elabora/format';
import { addSound as addSoundCommand } from '@elabora/core/commands/sounds';
import type { AddSoundResult } from '@elabora/core/commands/sounds';
import { classifyLicence } from '@elabora/core/sounds/licences';
import { binaryFile } from '@elabora/core/project/files';
import { CommandError } from '@elabora/core/commands/context';
import { hashBytes } from '../blobs.ts';
import { findMediaTools } from '../media/tools.ts';
import { probeMedia } from '../media/probe.ts';
import { runCommand, type EditOptions, type EditResult } from '../edit/executor.ts';
import { libraryFile, librarySounds } from './library.ts';
import { openverseSound } from './openverse.ts';
import { ELABORA_VERSION } from '../bundles.ts';

const run = promisify(execFile);

// « Ajouter un son » (docs/decisions.md D67): a sound of the library, one found through Openverse, or
// a file, into assets/sounds/ with its sidecar, in one journaled change (add_sound). A lossy file that
// needs no cut is kept as it came (no second lossy encoding before the build); a cut, a fade or a
// lossless original are written as FLAC, or as AAC at 256 kb/s for an ambience or a long sound.

export interface AddSoundRequest {
  // A library id (telephone-fixe), openverse:<uuid>, or a file.
  from: string;
  id?: string;
  // The part kept (seconds) and a fade out at its end (seconds).
  trim?: { start: number; end: number };
  fade?: number;
  loop?: boolean;
  // For a file: what its source says.
  title?: string;
  author?: string;
  license?: string;
  url?: string;
  caption?: Record<string, string>;
  // Made by an AI service (sound generate).
  generated?: Sound['generated'];
  signal?: AbortSignal;
}

// Kept as they come when nothing is cut: FLAC, and the lossy formats (never encoded twice).
const KEPT = new Map([['flac', '.flac'], ['vorbis', '.ogg'], ['opus', '.opus'], ['aac', '.m4a'], ['mp3', '.mp3']]);
// Above this, a sound kept as audio a person hears is AAC at 256 kb/s rather than FLAC (D67, measured:
// a 45 s ambience is 3.6 MB as FLAC, 1.4 MB as AAC 256, and its package file keeps 22.3 dB of signal
// to distortion where FLAC keeps 24.0).
const LONG = 20;

export async function addSound(dir: string, request: AddSoundRequest, options?: EditOptions): Promise<EditResult & AddSoundResult & { source: string; license: string; duration: number }> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-sound-'));
  try {
    const { file, sidecar, id } = await source(request, work);
    const licence = classifyLicence(sidecar.license);
    if (!licence.ok) throw new CommandError(`${request.from} is under ${licence.name || 'a licence not given'}: a course may ship CC0, public-domain, CC BY or CC BY-SA sounds, the author's own (--license own) or generated ones.`);
    const tools = await findMediaTools();
    const info = await probeMedia(file, { tools });
    if (info.kind !== 'audio' || !info.audioCodec) throw new CommandError(`${request.from} is not a sound ffmpeg can read.`);
    const loops = request.loop ?? sidecar.loop ?? false;
    // A FLAC that loops or lasts is written as AAC 256 like any lossless original (D67).
    const keep = !request.trim && !request.fade && KEPT.has(info.audioCodec) && (info.audioCodec !== 'flac' || (!loops && (info.duration ?? 0) <= LONG)) && (info.audioCodec !== 'aac' || info.container === 'mp4') && (info.audioCodec !== 'opus' || info.container === 'ogg') && (info.audioCodec !== 'vorbis' || info.container === 'ogg');
    let output = file;
    let extension = keep ? KEPT.get(info.audioCodec)! : '.flac';
    const modified: Sound['modified'] = [];
    if (!keep) {
      const length = request.trim ? request.trim.end - request.trim.start : info.duration ?? 0;
      if (loops || length > LONG) extension = '.m4a';
      output = path.join(work, `out${extension}`);
      const filters = [request.trim ? `atrim=start=${request.trim.start}:end=${request.trim.end},asetpts=PTS-STARTPTS` : null, request.fade ? `afade=t=out:st=${Math.max(0, length - request.fade)}:d=${request.fade}` : null].filter(Boolean);
      await run(tools.ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', file, '-vn', '-map_metadata', '-1', ...(filters.length ? ['-af', filters.join(',')] : []), ...(extension === '.flac' ? ['-c:a', 'flac'] : ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart']), '-fflags', '+bitexact', '-flags:a', '+bitexact', output]);
      if (request.trim) modified.push('trimmed');
      if (request.fade) modified.push('faded');
      if (!request.trim && !request.fade) modified.push('converted');
    }
    const duration = Math.round(((await probeMedia(output, { tools })).duration ?? 0) * 1000) / 1000;
    const full: Sound = { ...sidecar, ...(modified.length ? { modified: [...new Set([...(sidecar.modified ?? []), ...modified])] } : {}), ...(request.trim ? { trim: request.trim } : {}), duration, ...(loops ? { loop: true } : {}) };
    const bytes = fs.readFileSync(output);
    const hash = hashBytes(bytes);
    const result = runCommand(dir, {
      name: 'add_sound', args: { id: request.id ?? id, from: request.from },
      run: (context) => addSoundCommand(context, { id: request.id ?? id, extension, file: binaryFile(bytes.length, { hash }), sidecar: full }),
      sources: new Map([[hash, output]])
    }, options);
    return { ...result, source: full.source ?? 'file', license: full.license, duration };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// The course's language (a caption given on the command line is in it), read from course.json alone.
export function courseLanguage(dir: string): string {
  try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'course.json'), 'utf8')).language || 'fr'); } catch { return 'fr'; }
}

const today = () => new Date().toISOString().slice(0, 10);

async function source(request: AddSoundRequest, work: string): Promise<{ file: string; sidecar: Sound; id: string }> {
  const given = (sidecar: Sound): Sound => ({ ...sidecar, ...(request.title ? { title: request.title } : {}), ...(request.caption ? { caption: { ...sidecar.caption, ...request.caption } } : {}) });
  const library = librarySounds().find((sound) => sound.id === request.from);
  if (library) {
    return {
      file: libraryFile(library), id: library.id,
      sidecar: given({ title: library.title.en, source: 'library', sourceId: library.id, url: library.url, author: library.author, license: library.license, licenseUrl: library.licenseUrl, checked: library.checked, ...(library.kind === 'ambience' ? { loop: true } : {}), ...(library.caption ? { caption: library.caption } : {}) })
    };
  }
  if (request.from.startsWith('openverse:')) {
    const found = await openverseSound(request.from, { signal: request.signal });
    const response = await fetch(found.file, { headers: { 'user-agent': `Elabora/${ELABORA_VERSION} (+https://elabora.studio)` }, signal: request.signal ?? AbortSignal.timeout(60000) }).catch((error: unknown) => { throw new CommandError(`The sound could not be downloaded from ${new URL(found.file).host}: ${error instanceof Error ? error.message : String(error)}`); });
    if (!response.ok) throw new CommandError(`The sound could not be downloaded from ${new URL(found.file).host} (${response.status}).`);
    const file = path.join(work, `download${path.extname(new URL(found.file).pathname) || '.audio'}`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    return {
      file, id: slugOf(found.title),
      sidecar: given({ title: found.title, source: 'openverse', sourceId: found.id.slice('openverse:'.length), url: found.url, ...(found.author ? { author: found.author } : {}), license: found.license, ...(found.licenseUrl ? { licenseUrl: found.licenseUrl } : {}), checked: today() })
    };
  }
  const file = path.resolve(request.from);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new CommandError(`No library sound or file "${request.from}" (elabora sound search lists the library).`);
  if (!request.license) throw new CommandError(`Say the licence of ${path.basename(file)} (--license CC0-1.0, CC-BY-4.0…, own for a sound the author made or bought): a course ships no sound of unknown licence.`);
  return {
    file, id: slugOf(path.basename(file).replace(/\.[^.]+$/, '')),
    sidecar: given({ title: request.title ?? path.basename(file).replace(/\.[^.]+$/, ''), source: request.generated ? 'elevenlabs' : request.license === 'own' ? 'recording' : 'file', ...(request.generated ? { generated: request.generated } : {}), ...(request.url ? { url: request.url } : {}), ...(request.author ? { author: request.author } : {}), license: request.license, checked: today() })
  };
}

const slugOf = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 's-$1').slice(0, 40) || 'sound';
