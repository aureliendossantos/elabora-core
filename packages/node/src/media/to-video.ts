import fs from 'node:fs';
import path from 'node:path';
import { animatedImageSource, commandContext, CommandError } from '@elabora/core/commands/index';
import type { ImageToVideoRequest } from '@elabora/core/commands/index';
import type { HostNeeds } from '@elabora/core/commands/host';
import { fileMedia } from '@elabora/core/media/conformance';
import { binaryFile } from '@elabora/core/project/files';
import { hashFile } from '../blobs.ts';
import { projectDataDir } from '../data-dir.ts';
import { snapshotFor } from '../edit/executor.ts';
import type { HostOptions } from '../edit/host.ts';
import { loopVideoAttempts, posterArgs, runAttempts, runFfmpeg } from './encode.ts';
import type { RunOptions } from './encode.ts';
import { probeMedia, probeProjectFile } from './probe.ts';
import { findMediaTools } from './tools.ts';
import { isFinished, readJobs } from './jobs.ts';

// « Transformer en vidéo » (`elabora media to-video`, MCP elabora_image_to_video, the engine's
// image_to_video): an image block whose file is animated (GIF, animated WebP or PNG) becomes a video
// block that loops like it (loop: true), several times lighter. The MP4 and its poster (the first
// frame) are made in the project's data folder, then one journaled change brings them in, turns the
// block into the video and removes the image's file when nothing else names it: an undo puts the
// image back. The lighter qualities make their renditions of the MP4, as of any video.

// What image_to_video needs of this computer (videoOfImage): the MP4 and its poster made from the
// image's file with ffmpeg, in the project's data folder until the change brought them in.
export async function videoOfImage<R>(dir: string, args: ImageToVideoRequest, options: HostOptions, use: (made: HostNeeds['videoOfImage']) => R): Promise<R> {
  const root = path.resolve(dir);
  if (typeof args?.block !== 'string' || !args.block) throw new CommandError('block: the image block to make a video.');
  const { tools: given, signal, onProgress } = options;
  const source = animatedImageSource(commandContext(snapshotFor(root, options, []), { root }).project(), args.block);
  // A file a media job is still turning into its web format (a GIF dropped into assets/) moves under
  // the conversion: once it is done.
  if (readJobs(root).some((job) => job.type !== 'rendition' && !isFinished(job.status) && (job.input === source.asset || job.replaces === source.asset))) {
    throw new CommandError(`${source.asset} is still being converted to its web format: make it a video once that is done.`);
  }
  const tools = given ?? await findMediaTools();
  if (!tools.h264.length) throw new CommandError('This ffmpeg has no H.264 encoder (libx264, h264_videotoolbox, h264_mf or libopenh264): it cannot make a video.');
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
    const result = await use({
      video: binaryFile(videoInfo.size, { hash: videoHash, media: fileMedia(videoInfo) }),
      poster: binaryFile(posterInfo.size, { hash: posterHash, media: fileMedia(posterInfo) }),
      posterExtension: tools.webp ? '.webp' : '.jpg',
      // Names a media job will write (an import still running) are not free.
      reserved: readJobs(root).filter((job) => job.type !== 'rendition' && !isFinished(job.status)).map((job) => job.output),
      sizes: { image: info.size, video: videoInfo.size, poster: posterInfo.size },
      bytes: new Map<string, string>([[videoHash, video], [posterHash, poster]])
    });
    onProgress?.(1);
    return result;
  } finally {
    await fs.promises.rm(folder, { recursive: true, force: true });
  }
}
