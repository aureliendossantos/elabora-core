import fs from 'node:fs';
import path from 'node:path';
import type { Course } from '@elabora/format';
import type { Project } from '@elabora/core/project/model';
import { audioNeedsRendition, estimateBytes, extensionOf, replaceExtension } from '@elabora/core/media/conformance';
import type { MediaInfo } from '@elabora/core/media/conformance';
import { PRESET_NAMES } from '@elabora/core/media/presets';
import type { PresetName } from '@elabora/core/media/presets';
import { ensureRendition, renditionPath } from '../media/renditions.ts';
import { findMediaTools } from '../media/tools.ts';
import type { MediaTools } from '../media/tools.ts';
import type { MediaJob } from '../media/jobs.ts';

// The media of a package (docs/architecture/media.md): the masters at the high quality, and
// below it renditions encoded from them once and cached. Media are files on disk that the build
// streams into the ZIP or clones into a folder; they are never read whole.

export interface PackagedMedia {
  name: string;          // the asset name (relative to assets/), as asset props hold it
  path: string;          // in the package: assets/<name>, or another extension for a rendition
  file: string | null;   // on disk (master or rendition); null while a media job writes the master
  info: MediaInfo | null;
  rendition: boolean;
}

export interface MediaProgress {
  asset: string;         // project-relative path of the master
  preset: PresetName;
  job: MediaJob;
}

export interface MediaPackaging {
  media: PackagedMedia[];
  failures: { asset: string; message: string }[];
}

// The quality of a package: the build option, else course.json delivery.mediaQuality, else high.
export function mediaQualityOf(course: Course, option?: PresetName): PresetName {
  return option ?? course.delivery?.mediaQuality ?? 'high';
}

// The media among the asset names a package ships: files of assets/ the snapshot knows as media,
// and outputs of media jobs under way. taken: package paths already used by other files, so that a
// rendition under another extension never replaces one.
export async function packageMedia(project: Project, names: Iterable<string>, quality: PresetName, options: { taken: ReadonlySet<string>; onProgress?: (progress: MediaProgress) => void }): Promise<MediaPackaging> {
  const out: MediaPackaging = { media: [], failures: [] };
  const used = new Set(options.taken);
  let tools: MediaTools | null | undefined;
  for (const name of [...new Set(names)].sort()) {
    const rel = `assets/${name}`;
    const file = project.files.get(rel);
    if (!file) {
      if (project.media?.processing.includes(rel)) out.media.push({ name, path: rel, file: null, info: null, rendition: false });
      continue;
    }
    if (file.kind !== 'binary' || !file.media) continue; // not media: shipped as it is
    const master = path.join(project.root, rel);
    let source = master;
    if (quality !== 'high' || audioNeedsRendition(file.media)) {
      try {
        tools ??= await findMediaTools().catch(() => null);
        const result = await ensureRendition(project.root, rel, quality, { tools, onProgress: (job) => options.onProgress?.({ asset: rel, preset: quality, job }) });
        source = result.file;
      } catch (error) {
        out.failures.push({ asset: rel, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
    }
    const extension = extensionOf(source);
    const packagePath = extension === extensionOf(rel) ? rel : uniqueName(replaceExtension(rel, extension), used);
    used.add(packagePath);
    out.media.push({ name, path: packagePath, file: source, info: file.media, rendition: source !== master });
  }
  return out;
}

function uniqueName(candidate: string, used: ReadonlySet<string>): string {
  if (!used.has(candidate)) return candidate;
  const extension = extensionOf(candidate);
  const stem = candidate.slice(0, candidate.length - extension.length);
  for (let n = 2; ; n++) if (!used.has(`${stem}-${n}${extension}`)) return `${stem}-${n}${extension}`;
}

export interface PresetSize {
  preset: PresetName;
  bytes: number;
  measured: boolean; // false: some media sizes are estimated from bitrates
}

// What the package would weigh at each preset: the rest of the package as planned, plus each
// media file as packaged, as a cached rendition, or estimated.
export async function packageSizes(project: Project, media: readonly PackagedMedia[], packageBytes: number, quality: PresetName): Promise<PresetSize[]> {
  const sizeOf = (file: string | null) => (file && fs.existsSync(file) ? fs.statSync(file).size : 0);
  const current = media.reduce((sum, m) => sum + sizeOf(m.file), 0);
  const rest = packageBytes - current;
  const sizes: PresetSize[] = [];
  for (const preset of PRESET_NAMES) {
    let bytes = rest;
    let measured = true;
    for (const m of media) {
      const master = path.join(project.root, `assets/${m.name}`);
      if (preset === quality) bytes += sizeOf(m.file);
      else if (preset === 'high') bytes += sizeOf(fs.existsSync(master) ? master : null);
      else if (m.info) {
        const cached = await renditionPath(project.root, `assets/${m.name}`, preset).catch(() => null);
        if (cached && fs.existsSync(cached)) bytes += sizeOf(cached);
        else { bytes += estimateBytes(m.info, preset); measured = false; }
      }
    }
    sizes.push({ preset, bytes, measured });
  }
  return sizes;
}
