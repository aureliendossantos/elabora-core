import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Project } from '@elabora/core/project/model';
import { iterateBlocks, screenOrder } from '@elabora/core/project/load';
import { narrationLines, screenTiming, timelineLines } from '@elabora/core/narration/narration';
import { narratedLayers } from '@elabora/core/narration/voice-lines';
import { estimateBytes } from '@elabora/core/media/conformance';
import type { MediaInfo } from '@elabora/core/media/conformance';
import { PRESET_NAMES } from '@elabora/core/media/presets';
import type { PresetName } from '@elabora/core/media/presets';
import type { QualitySize } from '@elabora/core/lms/package-limits';
import { isFontPath } from '@elabora/core/project/fonts';
import { compileSounds, shippedPlayerSounds } from '@elabora/core/sounds/sounds';
import { renditionPath } from '../media/renditions.ts';
import { cachedTrack } from '../narration/tracks.ts';
import { playerSoundFile, runtimeFiles, vendorThree } from '../bundles.ts';
import { isMediaAsset, shippedAssets } from './assets.ts';

// What a package of the course would weigh at each media quality, without building it: nothing is
// encoded, compiled or written, so that the app can say it as the author edits (« Publier »). It
// is what one learner loads to go through the whole module, in its own language: the course's
// language only, as a package of every language (D59) ships the others for learners who switch.
//
// The media shipped (docs/architecture/media.md): the masters at high; below it each cached
// rendition, else its size estimated from bitrates (estimateBytes, never above the master). The
// narration tracks (D24, D62) and the dialogue lines (D61) likewise: made, or estimated. The rest
// is the player's runtime as deflated in the ZIP and the interface sounds it plays, three.js for 3D objects, the fonts of theme/ and
// the free objects' files, and the course's texts deflated; the course data the build compiles from
// them stays within a few kilobytes of that. The ZIP's own headers (under 100 bytes a file) are left
// out. estimated: some part comes from bitrates rather than from a file.

const TRACK_BYTES_PER_SECOND = 64_000 / 8; // TRACK_BITRATE, 64 kb/s

export async function packageWeights(project: Project): Promise<QualitySize[]> {
  const bytes: Record<PresetName, number> = { high: 0, medium: 0, low: 0 };
  let estimated = false;
  const everywhere = (size: number) => {
    for (const preset of PRESET_NAMES) bytes[preset] += size;
  };
  const sizeOf = (file: string) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return null;
    }
  };

  // A media file at each preset: as shipped at high, as cached, else estimated.
  const media = async (rel: string, info: MediaInfo | undefined) => {
    const master = sizeOf(path.join(project.root, rel)) ?? 0;
    for (const preset of PRESET_NAMES) {
      const rendition = info ? await renditionPath(project.root, rel, preset).catch(() => null) : null;
      const made = rendition ? sizeOf(rendition) : null;
      if (made !== null) bytes[preset] += made;
      else if (info) {
        bytes[preset] += estimateBytes(info, preset);
        estimated = true;
      } else bytes[preset] += master;
    }
  };

  for (const name of shippedAssets(project)) {
    const rel = `assets/${name}`;
    const file = project.files.get(rel);
    if (!file) {
      // A media job writes it: its size is not known yet.
      if (isMediaAsset(project, name)) estimated = true;
      continue;
    }
    if (file.kind === 'binary' && isMediaAsset(project, name)) await media(rel, file.media);
    else everywhere(file.kind === 'binary' ? file.size : Buffer.byteLength(file.text));
  }

  // The narration tracks of the course's language, at 64 kb/s whatever the quality.
  const language = project.course?.language ?? '';
  for (const { id: screen } of screenOrder(project)) {
    const data = project.screens.get(screen)?.data;
    const layers = [...(data?.narration ? [null] : []), ...narratedLayers(data)];
    for (const layer of layers) {
      const lines = timelineLines(project, screen, language, layer);
      if (!lines.length || lines.some((line) => line.status === 'missing' || line.status === 'untranslated')) continue;
      const laid = screenTiming(project, screen, { language, layer });
      if (!laid) continue;
      const made = sizeOf((await cachedTrack(project, lines, laid.gaps).catch(() => null))?.file ?? '');
      if (made === null) estimated = true;
      everywhere(made ?? Math.round(laid.duration * TRACK_BYTES_PER_SECOND));
    }
    // The dialogues' lines, one file each at the package's quality.
    for (const info of narrationLines(project, screen, language) ?? []) {
      if (info.track.kind !== 'dialogue' || info.status === 'missing' || info.status === 'untranslated' || !info.duration || !info.text) continue;
      const file = project.files.get(info.audio);
      await media(info.audio, file?.kind === 'binary' ? file.media : undefined);
    }
  }

  // The rest: the runtime and the interface sounds it plays (D67), the fonts and the free objects,
  // and the course's texts.
  everywhere(await runtimeBytes());
  for (const name of shippedPlayerSounds(compileSounds(project, { assetPath: (name) => `assets/${name}` }))) everywhere(playerSoundFile(name).length);
  const objects = new Set<string>();
  for (const { block } of iterateBlocks(project)) if (block.type === 'free-object' && typeof block.props?.object === 'string') objects.add(block.props.object);
  const backdrop = project.course?.theme?.backdrop?.object?.id;
  if (backdrop) objects.add(backdrop);
  let three = false;
  for (const id of objects) {
    const object = project.objects.get(id);
    if (!object?.manifest) continue;
    if (object.manifest.requires?.three) three = true;
    for (const asset of object.manifest.assets ?? []) {
      const file = project.files.get(`${object.folder}/${asset.file}`);
      if (file) everywhere(file.kind === 'binary' ? file.size : Buffer.byteLength(file.text));
    }
  }
  if (three) everywhere(await threeBytes());
  const texts: string[] = [];
  for (const [rel, file] of project.files) {
    if (rel.startsWith('theme/') && isFontPath(rel) && file.kind === 'binary') everywhere(file.size);
    else if (file.kind === 'text' && (rel === 'course.json' || rel.startsWith('screens/') || (rel.startsWith('theme/') && rel.endsWith('.css')))) texts.push(file.text);
  }
  everywhere(zlib.deflateRawSync(Buffer.from(texts.join('\n'))).length);

  return PRESET_NAMES.map((quality) => ({ quality, bytes: bytes[quality], estimated }));
}

// The runtime and three.js are the same in every package of this version: deflated once.
let runtime: Promise<number> | null = null;
let threeJs: Promise<number> | null = null;
const deflated = (contents: Iterable<string | Buffer>) => [...contents].reduce((sum, content) => sum + zlib.deflateRawSync(typeof content === 'string' ? Buffer.from(content) : content, { level: 9 }).length, 0);
// A failure is not kept: the next weighing tries again.
const runtimeBytes = () => (runtime ??= runtimeFiles().then((files) => deflated(Object.values(files))).catch((error: unknown) => { runtime = null; throw error; }));
const threeBytes = () => (threeJs ??= Promise.resolve().then(() => deflated(Object.values(vendorThree()))).catch((error: unknown) => { threeJs = null; throw error; }));
