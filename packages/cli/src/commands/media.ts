import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { importMedia } from '@elabora/node/media/import';
import { optimizeMedia, mediaToOptimize } from '@elabora/node/media/optimize';
import { MediaQueue, readJobs, isFinished } from '@elabora/node/media/jobs';
import type { MediaJob } from '@elabora/node/media/jobs';
import * as edit from '@elabora/node/edit';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { packageWeights } from '@elabora/node/packaging/weights';
import { imageToVideo } from '@elabora/node/media/to-video';
import { isPresetName } from '@elabora/core/media/presets';
import { sizeText } from '@elabora/core/lms/package-limits';
import { bytesAt, durationText, noticedFirst } from '@elabora/core/media/weights';
import type { MediaUse, MediaWeight } from '@elabora/core/media/weights';
import { defineCommand, errorMessage, printDiagnostics, printFormatMigration, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';
import { mediaProgress } from '../media-progress.ts';

const HELP = `  media import [dir] <file…> [--to <folder>] [--name <name>] [--no-wait] [--json]
                                                      Bring media into assets/ (video, audio, images): converted in the
                                                      background to web masters (MP4 H.264/AAC, M4A, WebP; SVG as is),
                                                      metadata such as GPS positions removed, the original never copied.
                                                      Prints the paths at once, then waits (--no-wait: a worker goes on)
  media optimize [dir] [<path>…|--all] [--json]       Convert media of assets/ that are not masters (W_MEDIA_NOT_OPTIMIZED);
                                                      references follow a new extension, in one undoable change
  media captions [dir] <block> <file.vtt|.srt> [--name <name>] [--json]
                                                      Captions of a video block (E_VIDEO_CAPTIONS_MISSING): the file written
                                                      under assets/captions/ (SubRip converted to WebVTT), named by the
                                                      block, in one undoable change
  media to-video [dir] <block> [--json]              An image block whose file is animated (GIF, animated WebP or PNG)
                                                      made a video block that loops like it (loop: true), several
                                                      times lighter: an MP4 (H.264, no sound) and its first frame as
                                                      poster; id, place, width, alt kept; its caption becomes the
                                                      title. Centered or wide images only. One undoable change
  media weights [dir] [--media-quality high|medium|low] [--all] [--json]
                                                      What the package weighs at each media quality, media by media,
                                                      heaviest first: kind, file, duration and size, what high, medium
                                                      and low ship (made or estimated), where the course uses it. A
                                                      media heavier than it needs to be for what its file shows (not
                                                      in its web format, an animated image, a still image or a video
                                                      far denser than its size needs) comes first, with why and what
                                                      lightens it. Nothing is encoded or written. At the course's
                                                      quality unless --media-quality; ten unless --all
  media status [dir] [--wait] [--json]                Media jobs (queued, running, done, failed) and media to optimise
  media cancel [dir] <job>                            Cancel a media job
  media worker [dir]                                  Run the project's media jobs until none is left (import --no-wait)`;

// The course folder is optional before the files: a first argument that is a course is the course.
function courseAndArguments(positionals: readonly string[]): { dir: string; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first !== undefined && fs.existsSync(path.join(first, 'course.json'))) return { dir: first, rest };
  return { dir: '.', rest: [...positionals] };
}

const notACourse = (dir: string) => !fs.existsSync(path.join(dir, 'course.json'));

// Unfinished import and optimisation jobs: a build needs their outputs.
export function pendingMediaJobs(dir: string): MediaJob[] {
  return readJobs(dir).filter((job) => job.type !== 'rendition' && !isFinished(job.status));
}

// Waits for media jobs, running them here when no other process does, with progress on stderr.
export async function waitForMediaJobs(dir: string, ids: readonly string[]): Promise<MediaJob[]> {
  const queue = new MediaQueue(dir);
  const progress = mediaProgress();
  queue.on('progress', progress.progress);
  queue.on('complete', progress.complete);
  return queue.wait([...ids]);
}

// A worker that outlives this command, for import --no-wait.
function startWorker(dir: string): void {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'media', 'worker', path.resolve(dir)], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

const actionText: Readonly<Record<string, string>> = {
  copy: 'copied as is', remux: 'rewrapped without re-encoding, metadata removed', encode: 'converted to its master format', reuse: 'used as is'
};

const importCommand = defineCommand({
  name: 'media import',
  flags: { to: 'string', name: 'string', 'no-wait': 'boolean', json: 'boolean' },
  async run({ positionals, flags }) {
    const { dir, rest: files } = courseAndArguments(positionals);
    if (!files.length) { console.error('Usage: elabora media import [dir] <file…> [--to <folder>] [--name <name>] [--no-wait] [--json]'); return 2; }
    if (flags.name && files.length > 1) { console.error('--name names one file: import the others separately.'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const queue = new MediaQueue(dir, { autoStart: !flags['no-wait'] });
    const imported: { file: string; path?: string; job?: string; action?: string; error?: string }[] = [];
    for (const file of files) {
      try {
        const result = await importMedia(dir, file, { queue, ...(flags.to ? { to: flags.to } : {}), ...(flags.name ? { name: flags.name } : {}) });
        imported.push({ file, path: result.path, job: result.job.id, action: result.plan.action });
        if (!flags.json) console.log(`→ ${result.path} (${actionText[result.plan.action]})`);
      } catch (error) {
        imported.push({ file, error: errorMessage(error) });
        if (!flags.json) console.error(`✘ ${file}: ${errorMessage(error)}`);
      }
    }
    const ids = imported.flatMap((entry) => (entry.job ? [entry.job] : []));
    const failed = imported.some((entry) => entry.error);
    if (flags['no-wait']) {
      if (ids.length) startWorker(dir);
      if (flags.json) printJson({ ok: !failed, files: imported });
      else if (ids.length) console.log(`\n${ids.length} media job(s) queued: elabora media status shows them. Builds wait for them.`);
      return failed ? 1 : 0;
    }
    const progress = mediaProgress();
    if (!flags.json) { queue.on('progress', progress.progress); queue.on('complete', progress.complete); }
    const jobs = new Map((await queue.wait(ids)).map((job) => [job.id, job]));
    const results = imported.map((entry) => {
      const job = entry.job ? jobs.get(entry.job) : undefined;
      return { ...entry, ...(job ? { status: job.status, error: job.error ?? undefined, warnings: job.warnings } : {}) };
    });
    const ok = results.every((entry) => !entry.error && (!('status' in entry) || entry.status === 'done'));
    if (flags.json) printJson({ ok, files: results });
    else console.log(`\n${ok ? '✔' : '✘'} ${results.filter((entry) => 'status' in entry && entry.status === 'done').length}/${files.length} imported. Reference them from blocks by their path under assets/ (${results.find((entry) => entry.path)?.path?.slice('assets/'.length) ?? 'video/intro.mp4'}).`);
    return ok ? 0 : 1;
  }
});

const optimize = defineCommand({
  name: 'media optimize',
  flags: { all: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest } = courseAndArguments(positionals);
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    if (!flags.all && !rest.length) { console.error('Usage: elabora media optimize [dir] [<path>…|--all] [--json]'); return 2; }
    const paths = flags.all ? mediaToOptimize(dir) : rest.map((p) => p.split(path.sep).join('/'));
    if (!paths.length) {
      if (flags.json) printJson({ ok: true, files: [], change: null });
      else console.log('Nothing to optimise: every media file of assets/ is a master.');
      return 0;
    }
    const progress = mediaProgress();
    const result = await optimizeMedia(dir, paths, flags.json ? {} : { onProgress: progress.progress, onComplete: progress.complete });
    const ok = result.files.every((f) => f.status === 'done' || f.status === 'conformant');
    if (flags.json) printJson({ ok, files: result.files, change: result.change ? { change: result.change.change, undo: result.change.undo, files: result.change.files } : null });
    else {
      for (const f of result.files) console.log(`${f.status === 'done' || f.status === 'conformant' ? '✔' : '✘'} ${f.from}${f.to !== f.from ? ` → ${f.to}` : ''}: ${f.status === 'conformant' ? 'already a master' : f.status}${f.error ? ` — ${f.error}` : ''}`);
      if (result.change?.change) console.log(`\nReferences updated and old files removed in change ${result.change.change.seq} (elabora undo --change ${result.change.change.seq}).`);
    }
    return ok ? 0 : 1;
  })
});

// A video's captions from a file a person or a transcription tool made: WebVTT as it is, SubRip
// converted; the block names the file written under assets/captions/.
const captions = defineCommand({
  name: 'media captions',
  flags: { name: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const { dir, rest: [block, file, ...extra] } = courseAndArguments(positionals);
    if (!block || !file || extra.length) { console.error('Usage: elabora media captions [dir] <block> <file.vtt|.srt> [--name <name>] [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    if (!fs.existsSync(file)) { console.error(`✘ No file ${file}.`); return 1; }
    const result = edit.setCaptions(dir, { block, text: fs.readFileSync(file, 'utf8'), ...(flags.name ? { name: flags.name } : {}) });
    const touched = new Set(result.files);
    const own = result.diagnostics.filter((d) => d.severity !== 'info' && d.file !== undefined && touched.has(d.file));
    if (flags.json) { printJson({ ok: true, block, captions: result.captions, change: result.change, undo: result.undo, files: result.files, diagnostics: own }); return 0; }
    printFormatMigration(result.formatMigration);
    console.log(result.change ? `✔ Captions of ${block}: assets/${result.captions}` : `✔ ${block} already has these captions (assets/${result.captions}): nothing changed.`);
    printDiagnostics(own);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

// An animated image made a looping video, which weighs several times less (the « animated » notice of
// media weights).
const toVideo = defineCommand({
  name: 'media to-video',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { dir, rest: [block, ...extra] } = courseAndArguments(positionals);
    if (!block || extra.length) { console.error('Usage: elabora media to-video [dir] <block> [--json]'); return 2; }
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const result = await imageToVideo(dir, { block });
    const touched = new Set(result.files);
    const own = result.diagnostics.filter((d) => d.severity !== 'info' && d.file !== undefined && touched.has(d.file));
    if (flags.json) {
      printJson({ ok: true, block, screen: result.screen, video: result.video, poster: result.poster, removed: result.removed, title: result.title, lost: result.lost, bytes: result.bytes, change: result.change, undo: result.undo, files: result.files, diagnostics: own });
      return 0;
    }
    printFormatMigration(result.formatMigration);
    const { image, video, poster } = result.bytes;
    console.log(`✔ ${block} is a video that loops: ${result.video} (${bytesText(video)}, and its poster ${bytesText(poster)}), for ${bytesText(image)} as an animated image.`);
    if (result.removed) console.log(`  ${result.removed} removed: nothing else named it.`);
    for (const lost of result.lost) console.log(`  Not kept: ${lost}.`);
    printDiagnostics(own);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

const SHOWN = 10;
// A media's size: in KB under a megabyte, as sizeText above.
const bytesText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : sizeText(bytes));

// Where the course uses a media, in a few words.
export function useText(uses: readonly MediaUse[]): string {
  const words = uses.map((use) => {
    if (use.as === 'logo') return "the player's logo";
    if (use.as === 'resource') return 'a resource';
    if (use.as === 'interface-sound') return 'an interface sound';
    if (use.as === 'background') return 'a background track';
    const within = [use.block, use.layer ? `layer ${use.layer}` : ''].filter(Boolean).join(', ');
    return `${use.screen}${within ? ` (${within})` : ''}`;
  });
  const unique = [...new Set(words)];
  return unique.length > 3 ? `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more` : unique.join(', ');
}

// What a media is: its duration, its size and the size it ships at, its lines.
export function mediaFacts(media: MediaWeight, quality: MediaWeight['qualities'][number]['quality']): string {
  const shipped = media.qualities.find((size) => size.quality === quality);
  const size = media.width && media.height ? `${media.width}×${media.height}${shipped?.width && (shipped.width !== media.width || shipped.height !== media.height) ? ` → ${shipped.width}×${shipped.height}` : ''}` : '';
  const lines = media.lines ? `${media.lines} line${media.lines === 1 ? '' : 's'}` : '';
  return [media.seconds ? durationText(media.seconds) : '', size, lines].filter(Boolean).join(' · ');
}

const weights = defineCommand({
  name: 'media weights',
  flags: { 'media-quality': 'string', all: 'boolean', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(async () => {
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const asked = flags['media-quality'];
    if (asked !== undefined && !isPresetName(asked)) { console.error(`--media-quality is high, medium or low (not "${asked}").`); return 2; }
    const project = loadProjectFromDir(dir);
    const result = await packageWeights(project, asked ? { quality: asked } : {});
    if (flags.json) { printJson(result); return 0; }
    const { quality, qualities, media, rest } = result;
    const about = (bytes: number, estimated: boolean) => `${estimated ? 'about ' : ''}${sizeText(bytes)}`;
    const total = qualities.find((size) => size.quality === quality)!;
    const others = qualities.filter((size) => size.quality !== quality).map((size) => `${size.quality} ${about(size.bytes, size.estimated)}`).join(', ');
    console.log(`${project.course?.title ?? path.resolve(dir)}: ${about(total.bytes, total.estimated)} at ${quality}${asked ? '' : ' (the course\'s quality)'}; ${others}.`);
    console.log(`Media ${sizeText(total.bytes - rest)}, the rest ${sizeText(rest)} (the player, fonts and texts, at every quality).${total.estimated ? ' "about": renditions or narration tracks not made yet, estimated from bitrates.' : ''}`);
    if (!media.length) { console.log('\nNo media.'); return 0; }
    const noticed = media.filter((one) => one.notice).length;
    const shown = flags.all ? noticedFirst(media) : noticedFirst(media).slice(0, Math.max(SHOWN, noticed));
    const width = Math.max(...shown.map((one) => bytesText(bytesAt(one, quality)).length));
    console.log('');
    for (const one of shown) {
      const name = one.path ?? (one.kind === 'narration' ? 'narration track' : 'dialogue lines');
      const same = one.qualities.every((size) => size.bytes === one.qualities[0]!.bytes && !size.rendition);
      const ladder = same ? `the same at every quality${one.qualities[0]!.estimated ? ' (estimated)' : ''}` : one.qualities.map((size) => `${size.quality} ${bytesText(size.bytes)}${size.estimated ? '*' : ''}${size.rendition ? '' : ' (as is)'}`).join(', ');
      const facts = mediaFacts(one, quality);
      console.log(`${one.notice ? '!' : ' '} ${bytesText(bytesAt(one, quality)).padStart(width)}  ${one.kind.padEnd(9)} ${name}${facts ? `  ${facts}` : ''}`);
      console.log(`  ${' '.repeat(width)}  ${' '.repeat(9)} ${ladder}${one.uses.length ? ` · ${useText(one.uses)}` : ''}`);
      if (one.notice) console.log(`  ${' '.repeat(width)}  ${' '.repeat(9)} Heavier than it needs to be (${one.notice.reason}): ${one.notice.why}`);
    }
    if (shown.length < media.length) console.log(`\n${media.length - shown.length} more media (--all lists them).`);
    console.log(`\n* estimated from bitrates; (as is): the master ships at that quality.${noticed ? ` ! heavier than it needs to be at ${quality}, for what its file shows.` : ` No media seems heavier than it needs to be at ${quality}.`}`);
    return 0;
  })
});

const status = defineCommand({
  name: 'media status',
  flags: { wait: 'boolean', json: 'boolean' },
  async run({ positionals: [dir = '.'], flags }) {
    if (notACourse(dir)) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
    const unfinished = readJobs(dir).filter((job) => !isFinished(job.status)).map((job) => job.id);
    if (flags.wait && unfinished.length) {
      const queue = new MediaQueue(dir);
      if (!flags.json) { const progress = mediaProgress(); queue.on('progress', progress.progress); queue.on('complete', progress.complete); }
      await queue.wait(unfinished);
    }
    const jobs = readJobs(dir).reverse();
    const toOptimize = mediaToOptimize(dir);
    if (flags.json) {
      printJson({ jobs: jobs.map(({ id, type, status, input, output, preset, action, progress, error, warnings, createdAt, finishedAt }) => ({ id, type, status, input, output, preset, action, progress, error, warnings, createdAt, finishedAt })), toOptimize });
      return 0;
    }
    if (!jobs.length) console.log('No media job.');
    for (const job of jobs.slice(0, 20)) {
      const what = job.type === 'rendition' ? `${job.preset} rendition of ${job.input}` : job.output;
      console.log(`${job.status.padEnd(9)} ${job.type.padEnd(9)} ${what}${job.status === 'running' ? ` ${Math.round(job.progress * 100)}%` : ''}${job.error ? ` — ${job.error}` : ''}  (${job.id})`);
    }
    if (jobs.length > 20) console.log(`… ${jobs.length - 20} older job(s) (--json lists them all).`);
    if (toOptimize.length) console.log(`\nNot masters yet (W_MEDIA_NOT_OPTIMIZED): ${toOptimize.join(', ')}\nRun: elabora media optimize --all`);
    return 0;
  }
});

const cancel = defineCommand({
  name: 'media cancel',
  flags: {},
  run({ positionals }) {
    const [dir, id] = positionals.length > 1 ? positionals : ['.', positionals[0]];
    if (!id) { console.error('Usage: elabora media cancel [dir] <job>'); return 2; }
    const job = new MediaQueue(dir, { autoStart: false }).cancel(id);
    if (!job) { console.error(`✘ No media job ${id} (elabora media status lists them).`); return 1; }
    console.log(isFinished(job.status) && job.status !== 'cancelled' ? `Job ${id} had already finished (${job.status}).` : `✔ Job ${id} (${job.output}) cancelled.`);
    return 0;
  }
});

const worker = defineCommand({
  name: 'media worker',
  flags: {},
  async run({ positionals: [dir = '.'] }) {
    const queue = new MediaQueue(dir);
    // Jobs added while it runs are taken too: it stops once a pass finds nothing left to do.
    for (let ids = queue.list().filter((job) => !isFinished(job.status)).map((job) => job.id); ids.length; ids = queue.list().filter((job) => !isFinished(job.status)).map((job) => job.id)) {
      await queue.wait(ids);
    }
    return 0;
  }
});

export const mediaCommands: CommandGroup = {
  title: 'Media (video, audio and images of assets/)',
  help: HELP,
  commands: [importCommand, optimize, captions, toVideo, weights, status, cancel, worker],
  subcommandUsage: { media: `Usage: elabora media import|optimize|captions|to-video|weights|status|cancel|worker\n\n${HELP}` }
};
