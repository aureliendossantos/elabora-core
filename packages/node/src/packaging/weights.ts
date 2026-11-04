import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Project } from '@elabora/core/project/model';
import { iterateBlocks, screenOrder } from '@elabora/core/project/load';
import { narrationLines, screenTiming, timelineLines } from '@elabora/core/narration/narration';
import { narratedLayers } from '@elabora/core/narration/voice-lines';
import { audioNeedsRendition, estimateBytes, mediaKindOfPath, presetDimensions, renditionPlan } from '@elabora/core/media/conformance';
import type { MediaInfo } from '@elabora/core/media/conformance';
import { PRESET_NAMES } from '@elabora/core/media/presets';
import type { PresetName } from '@elabora/core/media/presets';
import { bytesAt, heavyBytes, heavyWhy } from '@elabora/core/media/weights';
import type { MediaAtQuality, MediaUse, MediaWeight, MediaWeightKind, PackageWeights } from '@elabora/core/media/weights';
import { isFontPath } from '@elabora/core/project/fonts';
import { compileSounds, shippedPlayerSounds } from '@elabora/core/sounds/sounds';
import { renditionPath } from '../media/renditions.ts';
import { cachedTrack } from '../narration/tracks.ts';
import { playerSoundFile, runtimeFiles, vendorThree } from '../bundles.ts';
import { assetUses, isMediaAsset } from './assets.ts';
import { mediaQualityOf } from './media.ts';

// What a package of the course would weigh at each media quality, without building it: nothing is
// encoded, compiled or written, so that the app can say it as the author edits (« Publier »), and
// media by media, so that an author or an agent sees which weigh and why. It is what one learner
// loads to go through the whole module, in its own language: the course's language only, as a
// package of every language (D59) ships the others for learners who switch.
//
// The media shipped (docs/architecture/media.md): the masters at high; below it each cached
// rendition, else its size estimated from bitrates (estimateBytes, never above the master). The
// narration tracks (D24, D62) and the dialogue lines (D61) likewise: made, or estimated. Assets the
// qualities leave as they are (a PDF, captions) are in the list too, as files. The rest is the
// player's runtime as deflated in the ZIP and the interface sounds it plays, three.js for 3D objects,
// the fonts of theme/ and the free objects' files, and the course's texts deflated; the course data
// the build compiles from them stays within a few kilobytes of that. The ZIP's own headers (under
// 100 bytes a file) are left out. estimated: some part comes from bitrates rather than from a file.

const TRACK_BYTES_PER_SECOND = 64_000 / 8; // TRACK_BITRATE, 64 kb/s

// quality: the one media are ordered by and stand out at (default: the course's).
export async function packageWeights(project: Project, options: { quality?: PresetName } = {}): Promise<PackageWeights> {
  const quality = options.quality ?? (project.course ? mediaQualityOf(project.course) : 'high');
  const list: MediaWeight[] = [];
  let estimated = false;
  let rest = 0;
  const sizeOf = (file: string) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return null;
    }
  };
  const same = (bytes: number, made = true): MediaAtQuality[] => PRESET_NAMES.map((q) => ({ quality: q, bytes, estimated: !made, rendition: false }));

  // A media file at each preset: as shipped at high, as cached, else estimated; and its size there.
  const atQualities = async (rel: string, info: MediaInfo | undefined): Promise<MediaAtQuality[]> => {
    const master = path.join(project.root, rel);
    const masterBytes = sizeOf(master) ?? 0;
    const sizes: MediaAtQuality[] = [];
    for (const preset of PRESET_NAMES) {
      const rendition = info ? await renditionPath(project.root, rel, preset).catch(() => null) : null;
      const made = rendition ? sizeOf(rendition) : null;
      // Without its path (a probe or hash that failed), from its plan: a sound kept as FLAC has one at high too.
      const encoded = rendition ? rendition !== master : !!info && (preset === 'high' ? audioNeedsRendition(info) : renditionPlan(info, preset).action !== 'reuse');
      const size: MediaAtQuality = { quality: preset, bytes: masterBytes, estimated: false, rendition: encoded };
      if (made !== null) size.bytes = made;
      else if (info) {
        size.bytes = estimateBytes(info, preset);
        size.estimated = true;
        estimated = true;
      }
      const shown = info && (info.kind === 'video' || info.kind === 'image') ? shippedDimensions(info, preset, encoded) : null;
      if (shown) Object.assign(size, shown);
      sizes.push(size);
    }
    return sizes;
  };
  const probed = (info: MediaInfo | undefined) => ({
    ...(info?.width && info.height ? { width: info.width, height: info.height } : {}),
    ...(info?.duration ? { seconds: info.duration } : {})
  });

  for (const [name, uses] of assetUses(project)) {
    const rel = `assets/${name}`;
    const file = project.files.get(rel);
    if (!file) {
      // A media job writes it: its size is not known yet.
      if (isMediaAsset(project, name)) estimated = true;
      continue;
    }
    if (file.kind === 'binary' && isMediaAsset(project, name)) {
      const kind: MediaWeightKind = file.media?.kind ?? mediaKindOfPath(name) ?? 'file';
      list.push({ kind, path: rel, uses, master: file.size, ...probed(file.media), qualities: await atQualities(rel, file.media), heavy: false });
    } else {
      const bytes = file.kind === 'binary' ? file.size : Buffer.byteLength(file.text);
      list.push({ kind: mediaKindOfPath(name) ?? 'file', path: rel, uses, master: bytes, qualities: same(bytes), heavy: false });
    }
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
      const voiced = lines.filter((line) => !line.sound).length;
      list.push({
        kind: 'narration', path: null, uses: [{ screen, ...(layer ? { layer } : {}) }], seconds: laid.duration, lines: voiced,
        qualities: same(made ?? Math.round(laid.duration * TRACK_BYTES_PER_SECOND), made !== null), heavy: false
      });
    }
    // The dialogues' lines, one file each at the package's quality, counted by dialogue.
    const dialogues = new Map<string, MediaWeight>();
    for (const info of narrationLines(project, screen, language) ?? []) {
      if (info.track.kind !== 'dialogue' || info.status === 'missing' || info.status === 'untranslated' || !info.duration || !info.text) continue;
      const file = project.files.get(info.audio);
      const sizes = await atQualities(info.audio, file?.kind === 'binary' ? file.media : undefined);
      const block = info.track.block;
      const dialogue = dialogues.get(block) ?? { kind: 'dialogue', path: null, uses: [{ screen, block }], master: 0, seconds: 0, lines: 0, qualities: same(0), heavy: false };
      dialogues.set(block, dialogue);
      dialogue.master! += file?.kind === 'binary' ? file.size : 0;
      dialogue.seconds! += info.duration;
      dialogue.lines! += 1;
      dialogue.qualities = dialogue.qualities.map((size, index) => ({ ...size, bytes: size.bytes + sizes[index]!.bytes, estimated: size.estimated || sizes[index]!.estimated, rendition: size.rendition || sizes[index]!.rendition }));
    }
    list.push(...dialogues.values());
  }

  // The rest: the runtime and the interface sounds it plays (D67), the fonts and the free objects,
  // and the course's texts.
  rest += await runtimeBytes();
  for (const name of shippedPlayerSounds(compileSounds(project, { assetPath: (name) => `assets/${name}` }))) rest += playerSoundFile(name).length;
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
      if (file) rest += file.kind === 'binary' ? file.size : Buffer.byteLength(file.text);
    }
  }
  if (three) rest += await threeBytes();
  const texts: string[] = [];
  for (const [rel, file] of project.files) {
    if (rel.startsWith('theme/') && isFontPath(rel) && file.kind === 'binary') rest += file.size;
    else if (file.kind === 'text' && (rel === 'course.json' || rel.startsWith('screens/') || (rel.startsWith('theme/') && rel.endsWith('.css')))) texts.push(file.text);
  }
  rest += zlib.deflateRawSync(Buffer.from(texts.join('\n'))).length;

  const limit = heavyBytes(quality);
  for (const media of list) {
    media.heavy = bytesAt(media, quality) > limit;
    if (media.heavy) media.why = heavyWhy(media, quality);
  }
  list.sort((a, b) => bytesAt(b, quality) - bytesAt(a, quality) || (a.path ?? '').localeCompare(b.path ?? ''));
  const qualities = PRESET_NAMES.map((q) => ({ quality: q, bytes: rest + list.reduce((sum, media) => sum + bytesAt(media, q), 0), estimated }));
  return { quality, qualities, media: list, rest };
}

// The size a video or an image is shipped at: the master's, unless a rendition resizes it.
function shippedDimensions(info: MediaInfo, preset: PresetName, encoded: boolean): { width: number; height: number } | null {
  if (!info.width || !info.height) return null;
  if (!encoded || (info.kind === 'video' && renditionPlan(info, preset).video !== 'encode')) return { width: info.width, height: info.height };
  return presetDimensions(info, preset);
}

// The runtime and three.js are the same in every package of this version: deflated once.
let runtime: Promise<number> | null = null;
let threeJs: Promise<number> | null = null;
const deflated = (contents: Iterable<string | Buffer>) => [...contents].reduce((sum, content) => sum + zlib.deflateRawSync(typeof content === 'string' ? Buffer.from(content) : content, { level: 9 }).length, 0);
// A failure is not kept: the next weighing tries again.
const runtimeBytes = () => (runtime ??= runtimeFiles().then((files) => deflated(Object.values(files))).catch((error: unknown) => { runtime = null; throw error; }));
const threeBytes = () => (threeJs ??= Promise.resolve().then(() => deflated(Object.values(vendorThree()))).catch((error: unknown) => { threeJs = null; throw error; }));
