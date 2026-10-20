import type { MediaStatus } from '@elabora/core/project/files';
import { MEDIA_EXTENSIONS, extensionOf, fileMedia } from '@elabora/core/media/conformance';
import type { FileMedia } from '@elabora/core/media/conformance';
import { probeProjectMedia } from '../media/probe.ts';
import { MediaToolsError } from '../media/tools.ts';
import { pendingOutputs } from '../media/jobs.ts';
import type { MediaTools } from '../media/tools.ts';

// Media information of a folder's snapshot, asynchronously, as the synchronous reader gives it
// (project-reader.ts): the probe and verdict of media files in assets/ (BinaryFile.media), from the
// probe cache in the project's data, probing only new or changed files.

export interface ProbedMedia {
  media: Map<string, FileMedia>;
  unreadable: { path: string; message: string }[];
  toolsMissing: boolean;
}

// The files a snapshot carries media information for.
export const isMediaAsset = (rel: string): boolean => rel.startsWith('assets/') && MEDIA_EXTENSIONS.has(extensionOf(rel));

export async function probeAssets(root: string, paths: readonly string[], options: { tools?: MediaTools } = {}): Promise<ProbedMedia> {
  const out: ProbedMedia = { media: new Map(), unreadable: [], toolsMissing: false };
  const wanted = paths.filter(isMediaAsset);
  if (!wanted.length) return out;
  for (const [rel, result] of await probeProjectMedia(root, wanted, { tools: options.tools })) {
    if (result instanceof MediaToolsError) out.toolsMissing = true;
    else if (result instanceof Error) out.unreadable.push({ path: rel, message: result.message });
    else out.media.set(rel, fileMedia(result));
  }
  return out;
}

// What loadProject takes as LoadOptions.media: unreadable media, ffprobe missing, and the outputs of
// media jobs not done yet (of any process: their job files).
export function mediaStatus(root: string, probed: Pick<ProbedMedia, 'unreadable' | 'toolsMissing'>): MediaStatus {
  return { processing: pendingOutputs(root), unreadable: probed.unreadable, toolsMissing: probed.toolsMissing };
}
