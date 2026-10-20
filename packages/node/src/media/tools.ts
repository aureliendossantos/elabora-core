import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

// ffmpeg and ffprobe are external programs: ELABORA_FFMPEG / ELABORA_FFPROBE, then PATH. What a
// build can do (encoders, filters) is read once per executable and cached for the process.

export type H264Encoder = 'libx264' | 'h264_videotoolbox' | 'h264_mf' | 'libopenh264';

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  version: string;               // "9.0.2", or the build string of git builds
  major: number | null;
  encoders: ReadonlySet<string>;
  filters: ReadonlySet<string>;
  h264: H264Encoder[];           // usable H.264 encoders, preferred first
  webp: boolean;                 // libwebp (still images) and libwebp_anim
  toneMapping: 'zscale' | 'libplacebo' | null;
}

export class MediaToolsError extends Error {
  readonly code = 'E_MEDIA_TOOLS_MISSING';
  readonly missing: string[];
  constructor(message: string, missing: string[]) {
    super(message);
    this.name = 'MediaToolsError';
    this.missing = missing;
  }
}

// Software first (same output everywhere, best quality per bit), then the hardware encoders of
// macOS and Windows, then Cisco's OpenH264 (the encoder of LGPL ffmpeg builds).
const H264_PREFERENCE: readonly H264Encoder[] = ['libx264', 'h264_videotoolbox', 'h264_mf', 'libopenh264'];

const cache = new Map<string, Promise<MediaTools>>();

export interface FindToolsOptions {
  env?: NodeJS.ProcessEnv;
  refresh?: boolean;
}

export function findMediaTools({ env = process.env, refresh = false }: FindToolsOptions = {}): Promise<MediaTools> {
  const ffmpeg = locate('ffmpeg', env.ELABORA_FFMPEG, env);
  const ffprobe = locate('ffprobe', env.ELABORA_FFPROBE, env);
  const missing = [ffmpeg ? null : 'ffmpeg', ffprobe ? null : 'ffprobe'].filter((x): x is string => !!x);
  if (!ffmpeg || !ffprobe) {
    return Promise.reject(new MediaToolsError(
      `${missing.join(' and ')} not found. Install ffmpeg (it includes ffprobe) or set ${missing.map((m) => `ELABORA_${m.toUpperCase()}`).join(' and ')} to the executable.`,
      missing
    ));
  }
  const key = `${ffmpeg}\0${ffprobe}\0${mtime(ffmpeg)}`;
  if (refresh) cache.delete(key);
  let found = cache.get(key);
  if (!found) {
    found = inspect(ffmpeg, ffprobe);
    found.catch(() => cache.delete(key));
    cache.set(key, found);
  }
  return found;
}

async function inspect(ffmpeg: string, ffprobe: string): Promise<MediaTools> {
  const [versionText, encoderText, filterText] = await Promise.all([
    run(ffmpeg, ['-hide_banner', '-version']),
    run(ffmpeg, ['-hide_banner', '-encoders']),
    run(ffmpeg, ['-hide_banner', '-filters'])
  ]);
  await run(ffprobe, ['-hide_banner', '-version']);
  const version = /ffmpeg version (\S+)/.exec(versionText)?.[1] ?? 'unknown';
  const major = /^n?(\d+)\./.exec(version);
  // Lists look like " V....D libx264   libx264 H.264 …" and " .. scale   V->V   Scale …".
  const names = (text: string, line: RegExp) => new Set(text.split('\n').map((l) => line.exec(l)?.[1]).filter((x): x is string => !!x));
  const encoders = names(encoderText, /^\s*[VAS][A-Z.]{5}\s+(\S+)/);
  const filters = names(filterText, /^\s*[A-Z.]{2,3}\s+(\S+)\s+\S+->\S+/);
  return {
    ffmpeg, ffprobe, version,
    major: major ? Number(major[1]) : null,
    encoders, filters,
    h264: H264_PREFERENCE.filter((e) => encoders.has(e)),
    webp: encoders.has('libwebp'),
    toneMapping: filters.has('zscale') && filters.has('tonemap') ? 'zscale' : filters.has('libplacebo') ? 'libplacebo' : null
  };
}

// ffprobe alone, found synchronously: the snapshot of a folder is read synchronously and probes
// new media files with it. null when there is no ffprobe.
export interface Prober {
  ffprobe: string;
  major: number | null; // ffmpeg major version: stream groups (HEIF grids) need 7 or later
}

const probers = new Map<string, Prober | null>();

export function findProberSync(env: NodeJS.ProcessEnv = process.env): Prober | null {
  const ffprobe = locate('ffprobe', env.ELABORA_FFPROBE, env);
  if (!ffprobe) return null;
  const key = `${ffprobe}\0${mtime(ffprobe)}`;
  if (!probers.has(key)) {
    let prober: Prober | null = null;
    try {
      const text = execFileSync(ffprobe, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const version = /ffprobe version n?(\d+)\./.exec(text);
      prober = { ffprobe, major: version ? Number(version[1]) : null };
    } catch { /* does not run: no prober */ }
    probers.set(key, prober);
  }
  return probers.get(key) ?? null;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(new MediaToolsError(`${path.basename(file)} does not run: ${error.message}`, [path.basename(file)]));
      else resolve(stdout);
    });
  });
}

// A program by its name on the PATH (with Windows' extensions), or the path given for it.
export function locate(name: string, explicit: string | undefined, env: NodeJS.ProcessEnv): string | null {
  if (explicit) return isExecutable(explicit) ? path.resolve(explicit) : null;
  const extensions = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension.toLowerCase());
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function mtime(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
