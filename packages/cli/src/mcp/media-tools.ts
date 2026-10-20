import fs from 'node:fs';
import path from 'node:path';
import * as edit from '@elabora/node/edit';
import { importMedia } from '@elabora/node/media/import';
import { mediaToOptimize } from '@elabora/node/media/optimize';
import { MediaQueue, readJobs } from '@elabora/node/media/jobs';
import { errorMessage } from '../commands/command.ts';
import { defineTool, editResult, errorResult, objectSchema, SLUG, textResult } from './tool.ts';

// Media: agents that generate or download images, record audio or receive videos import them; they
// never write raw files into assets/ (no conversion, metadata kept, W_MEDIA_NOT_OPTIMIZED).

export const importMediaTool = defineTool({
  name: 'elabora_media_import',
  description: 'Import media files (absolute paths: a generated or downloaded image, a recording, a video) into assets/. Each becomes a web master: MP4 H.264/AAC, M4A or WebP (SVG as is), downscaled to the high preset, metadata such as GPS positions removed; the original is not copied. Returns the path under assets/ to put in asset props (without "assets/"). Waits for the conversion unless wait is false; elabora_media_status follows jobs.',
  inputSchema: objectSchema({
    files: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Absolute paths of the files to import.' },
    to: { type: 'string', description: 'Folder under assets/ (default by kind: assets/video, assets/audio, assets/images).' },
    name: { type: 'string', description: 'File name without extension (one file only; default: the original name, made portable).' },
    wait: { type: 'boolean', description: 'Wait for the conversions (default true).' }
  }, ['files']),
  async handler(args, { root }) {
    if (args.name && args.files.length > 1) return textResult({ ok: false, error: 'name names one file: import the others separately.' });
    const wait = args.wait !== false;
    const queue = new MediaQueue(root);
    const results: { file: string; path?: string; asset?: string; status?: string; error?: string; warnings?: string[] }[] = [];
    const ids = new Map<string, number>();
    for (const file of args.files) {
      try {
        const imported = await importMedia(root, path.resolve(root, file), { queue, ...(args.to ? { to: args.to } : {}), ...(args.name ? { name: args.name } : {}) });
        ids.set(imported.job.id, results.length);
        results.push({ file, path: imported.path, asset: imported.path.slice('assets/'.length), status: imported.job.status });
      } catch (error) {
        results.push({ file, error: errorMessage(error) });
      }
    }
    if (wait) {
      for (const job of await queue.wait([...ids.keys()])) {
        const entry = results[ids.get(job.id)!];
        Object.assign(entry, { status: job.status, ...(job.error ? { error: job.error } : {}), ...(job.warnings.length ? { warnings: job.warnings } : {}) });
      }
    }
    return textResult({ ok: results.every((r) => !r.error), files: results });
  }
});

export const mediaStatus = defineTool({
  name: 'elabora_media_status',
  readOnly: true,
  description: 'Media jobs of the course (imports, optimisations, renditions: queued, running with progress, done, failed) and the media files of assets/ that are not masters yet (W_MEDIA_NOT_OPTIMIZED).',
  inputSchema: objectSchema({}),
  handler(_args, { root }) {
    const jobs = readJobs(root).reverse().slice(0, 50).map(({ id, type, status, input, output, preset, action, progress, error, warnings, finishedAt }) => ({ id, type, status, input, output, preset, action, progress, error, warnings, finishedAt }));
    return textResult({ jobs, toOptimize: mediaToOptimize(root) });
  }
});

export const setCaptions = defineTool({
  name: 'elabora_set_captions',
  description: 'Captions for a video block (E_VIDEO_CAPTIONS_MISSING): a WebVTT file, or a SubRip one (.srt) converted to WebVTT, written under assets/captions/ (named after the block unless name is given; the same text already there is reused) and named by the block\'s captions prop, in one change. Give the file (an absolute path: a transcription tool\'s output) or its text. Captions say what is heard, in the language of the course; the transcript (a prop of the block) says what is said and shown.',
  inputSchema: objectSchema({
    block: { ...SLUG, description: 'The video block.' },
    file: { type: 'string', description: 'Absolute path of a .vtt or .srt file (or give text).' },
    text: { type: 'string', description: 'The captions themselves, WebVTT or SubRip (or give file).' },
    name: { type: 'string', description: 'File name under assets/captions/, without extension (default: the block id).' }
  }, ['block']),
  handler(args, { root, author }) {
    if (args.file !== undefined && args.text !== undefined) return errorResult({ error: 'Give the captions as file or as text, not both.' });
    const text = args.file !== undefined ? fs.readFileSync(path.resolve(root, args.file), 'utf8') : args.text;
    if (text === undefined) return errorResult({ error: 'Give the captions: file (a .vtt or .srt) or text.' });
    return editResult(edit.setCaptions(root, { block: args.block, text, ...(args.name ? { name: args.name } : {}) }, { author }));
  }
});
