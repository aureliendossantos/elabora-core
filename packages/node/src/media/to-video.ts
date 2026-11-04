import fs from 'node:fs';
import path from 'node:path';
import { animatedImageSource, commandContext, CommandError, imageToVideo as imageToVideoCommand } from '@elabora/core/commands/index';
import type { ImageToVideoResult } from '@elabora/core/commands/index';
import { fileMedia } from '@elabora/core/media/conformance';
import { binaryFile } from '@elabora/core/project/files';
import { hashFile } from '../blobs.ts';
import { projectDataDir } from '../data-dir.ts';
import { runCommand, snapshotFor, type EditOptions, type EditResult } from '../edit/executor.ts';
import { loopVideoAttempts, posterArgs, runAttempts, runFfmpeg } from './encode.ts';
import type { RunOptions } from './encode.ts';
import { probeMedia, probeProjectFile } from './probe.ts';
import { findMediaTools } from './tools.ts';
import type { MediaTools } from './tools.ts';

// « Transformer en vidéo » (`elabora media to-video`, MCP elabora_image_to_video, the engine's
// image_to_video): an image block whose file is animated (GIF, animated WebP or PNG) becomes a video
// block that loops like it (loop: true), several times lighter. The MP4 and its poster (the first
// frame) are made in the project's data folder, then one journaled change brings them in, turns the
// block into the video and removes the image's file when nothing else names it: an undo puts the
// image back. The lighter qualities make their renditions of the MP4, as of any video.

export interface ImageToVideoRequest {
  block: string;
}

export interface ImageToVideoOptions extends EditOptions {
  tools?: MediaTools;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export async function imageToVideo(dir: string, args: ImageToVideoRequest, options: ImageToVideoOptions = {}): Promise<EditResult & ImageToVideoResult & { bytes: { image: number; video: number; poster: number } }> {
  const root = path.resolve(dir);
  if (typeof args?.block !== 'string' || !args.block) throw new CommandError('block: the image block to make a video.');
  const { tools: given, signal, onProgress, ...edit } = options;
  const source = animatedImageSource(commandContext(snapshotFor(root, edit, []), { root }).project(), args.block);
  const tools = given ?? await findMediaTools();
  const info = await probeProjectFile(root, source.asset, { tools });
  if (info.kind !== 'image' || !info.animated) throw new CommandError(`${source.asset} is not animated: a still image stays an image.`);
  const work = path.join(projectDataDir(root), 'tmp');
  await fs.promises.mkdir(work, { recursive: true });
  const folder = await fs.promises.mkdtemp(path.join(work, 'to-video-'));
  try {
    const input = path.join(root, source.asset);
    const video = path.join(folder, 'video.mp4');
    const poster = path.join(folder, tools.webp ? 'poster.webp' : 'poster.jpg');
    const run: RunOptions = { ...(signal ? { signal } : {}), ...(onProgress ? { onProgress: (fraction) => onProgress(fraction * 0.95) } : {}) };
    await runAttempts(loopVideoAttempts(input, video, info, tools), { output: video, info }, tools, run);
    await runFfmpeg(tools, posterArgs(input, poster, tools), signal ? { signal } : {});
    const [videoInfo, posterInfo] = await Promise.all([probeMedia(video, { tools }), probeMedia(poster, { tools })]);
    const [videoHash, posterHash] = await Promise.all([hashFile(video), hashFile(poster)]);
    const sources = new Map<string, string>([[videoHash, video], [posterHash, poster]]);
    const result = runCommand(root, {
      name: 'image_to_video',
      args: { block: args.block },
      sources,
      run: (context) => imageToVideoCommand(context, {
        block: args.block,
        video: binaryFile(videoInfo.size, { hash: videoHash, media: fileMedia(videoInfo) }),
        poster: binaryFile(posterInfo.size, { hash: posterHash, media: fileMedia(posterInfo) }),
        posterExtension: tools.webp ? '.webp' : '.jpg'
      })
    }, edit);
    onProgress?.(1);
    return { ...result, bytes: { image: info.size, video: videoInfo.size, poster: posterInfo.size } };
  } finally {
    await fs.promises.rm(folder, { recursive: true, force: true });
  }
}
