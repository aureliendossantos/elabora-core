import { rewriteAssetReferences } from '../media/references.ts';
import type { Block, Project, Screen } from '../project/model.ts';
import type { SourceFile } from '../project/files.ts';
import { slugify } from '../util/slug.ts';
import { CommandError, Draft, findBlock, listAt, type CommandContext, type CommandOutput } from './context.ts';
import { moveUnits } from './convert.ts';

// What follows the optimisation of media files whose extension changed (intro.mov → intro.mp4):
// every reference to an old file names the new one (block props, course.json paths, stylesheet
// url()s: rewriteAssetReferences, as the editing engine does), and the old files go. One change,
// so one undo. The plan and its versions are never rewritten: no media is named there.

export interface MediaMove {
  from: string; // project-relative paths: assets/video/intro.mov
  to: string;
}

export interface ReplaceMediaArgs {
  moves: MediaMove[];
}

export interface ReplaceMediaResult {
  files: string[];   // files whose references changed
  removed: string[]; // old media files removed
}

const CONTRACTS = /^(plan\.json|changes\/)/;

export function replaceMediaReferences(context: CommandContext, { moves }: ReplaceMediaArgs): CommandOutput<ReplaceMediaResult> {
  const draft = new Draft(context.files);
  const rewritten = new Set<string>();
  for (const { from, to } of moves) {
    if (!from.startsWith('assets/') || !to.startsWith('assets/')) throw new CommandError(`${from} → ${to}: media moves stay under assets/`);
    if (from === to) continue;
    for (const [rel, file] of rewriteAssetReferences(draft.files(), from, to)) {
      if (CONTRACTS.test(rel)) continue;
      draft.writeFile(rel, file);
      rewritten.add(rel);
    }
  }
  const removed: string[] = [];
  for (const { from, to } of moves) {
    if (from === to || !draft.exists(from)) continue;
    draft.remove(from);
    removed.push(from);
  }
  return { files: draft.files(), result: { files: [...rewritten].sort(), removed } };
}

export interface SetCaptionsArgs {
  block: string; // a video block
  text: string; // a WebVTT file, or a SubRip one (.srt), converted
  name?: string; // the file's name without extension (default: the block's id)
}

// Captions for a video: the text of the file written under assets/captions/ (the same text already
// there is reused), and the block names it. One change, one undo.
export function setCaptions(context: CommandContext, { block, text, name }: SetCaptionsArgs): CommandOutput<{ captions: string }> {
  const place = findBlock(context.project(), block);
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(place.file);
  const target = listAt(screen, place.list)[place.index];
  if (target.type !== 'video') throw new CommandError(`Block "${block}" is a ${target.type} block: captions go on a video.`);
  const vtt = toWebVtt(text);
  const base = portableName(name ?? block) || 'captions';
  let rel = '';
  for (let n = 1; ; n++) {
    rel = `captions/${base}${n === 1 ? '' : `-${n}`}.vtt`;
    const existing = draft.text(`assets/${rel}`);
    if (existing === null || existing === vtt) break;
  }
  if (draft.text(`assets/${rel}`) !== vtt) draft.writeText(`assets/${rel}`, vtt);
  target.props = { ...(target.props ?? {}), captions: rel };
  draft.writeJson(place.file, screen);
  return { files: draft.files(), result: { captions: rel } };
}

// WebVTT as it is; SubRip with its timings written the WebVTT way (00:00:01,500 → 00:00:01.500)
// under a WEBVTT header. Anything else is refused.
export function toWebVtt(text: string): string {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (!/-->/.test(clean)) throw new CommandError('These captions have no cue (a line with "-->"): a WebVTT (.vtt) or SubRip (.srt) file is expected.');
  if (/^WEBVTT\b/.test(clean)) return `${clean}\n`;
  if (/^\d+\n\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(clean)) {
    return `WEBVTT\n\n${clean.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')}\n`;
  }
  throw new CommandError('These captions are neither WebVTT (a file that starts with WEBVTT) nor SubRip (.srt).');
}

const portableName = (name: string): string => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\.(vtt|srt)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// ── An animated image made a video (`elabora media to-video`) ──────────────

// An image block that can become a looping video: its file, and the name its video takes. A video
// takes the place of a centered or a wide image; an image in a band, beside a text or under one
// stays an image (a video is not cropped, nor written over).
export interface AnimatedImageSource {
  screen: string;
  asset: string; // project path: assets/images/spinner.gif
  base: string;  // portable name of the files to write: spinner
}

const VIDEO_PLACES: ReadonlySet<string> = new Set(['centered', 'wide']);

export function animatedImageSource(project: Project, blockId: string): AnimatedImageSource {
  const place = findBlock(project, blockId);
  const block = place.block;
  if (block.type !== 'image') throw new CommandError(`Block "${blockId}" is a ${block.type} block: only an image block becomes a video.`);
  const props = (block.props ?? {}) as Record<string, unknown>;
  const presentation = typeof props.presentation === 'string' ? props.presentation : 'centered';
  if (!VIDEO_PLACES.has(presentation)) throw new CommandError(`Image "${blockId}" is shown ${presentation === 'band' ? 'as a band' : presentation === 'beside' ? 'beside a text' : 'under a text'}: a video takes the place of a centered or a wide image only. Show it centered or wide, then make it a video.`);
  if (typeof props.asset !== 'string' || !props.asset) throw new CommandError(`Image "${blockId}" has no file.`);
  const name = props.asset.slice(props.asset.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return { screen: place.screenId, asset: `assets/${props.asset}`, base: slugify(name, 'animation', 60) };
}

export interface ImageToVideoArgs {
  block: string;
  blocks?: readonly string[];   // other image blocks showing the same file, made videos with it
  reserved?: readonly string[]; // paths media jobs will write: never taken
  video: SourceFile;   // the MP4 made from the image's file
  poster?: SourceFile; // its first frame
  posterExtension?: '.webp' | '.jpg';
}

export interface ImageToVideoResult {
  block: string;
  blocks: string[];       // every block made a video (block first)
  screen: string;
  video: string;          // project paths of the files written
  poster: string | null;
  removed: string | null; // the image's file, gone when nothing else names it
  title: string;
  lost: string[];         // what the image had that a loop does not show, in a few words
  translations: number;   // translation units moved (the caption's, which became the title)
}

// The image block becomes a video block that loops like it, in its place: its id, width, timing,
// step and events stay; alt, decorative and generated carry over; a wide image is a wide block. Its
// caption becomes the video's title (a loop shows none: the editor names it), else alt, else the
// file's name. The image's file goes once nothing else names it. One change, one undo.
export function imageToVideo(context: CommandContext, args: ImageToVideoArgs): CommandOutput<ImageToVideoResult> {
  const project = context.project();
  const source = animatedImageSource(project, args.block);
  const draft = new Draft(context.files);
  const taken = new Set([...context.files.keys(), ...(args.reserved ?? [])].map((path) => path.toLowerCase()));
  const free = (stem: string, extension: string) => {
    for (let n = 1; ; n++) {
      const candidate = `${stem}${n === 1 ? '' : `-${n}`}${extension}`;
      if (!taken.has(candidate.toLowerCase())) { taken.add(candidate.toLowerCase()); return candidate; }
    }
  };
  const video = free(`assets/video/${source.base}`, '.mp4');
  const poster = args.poster ? free(`assets/images/${source.base}-poster`, args.posterExtension ?? '.webp') : null;
  draft.writeFile(video, args.video);
  if (poster && args.poster) draft.writeFile(poster, args.poster);

  // The other image blocks asked that show the same file become videos too, in the same change.
  const ids = [...new Set([args.block, ...(args.blocks ?? [])])];
  for (const id of ids.slice(1)) {
    if (animatedImageSource(project, id).asset !== source.asset) throw new CommandError(`Block "${id}" does not show ${source.asset}: make it a video on its own.`);
  }
  const lost: string[] = [];
  let title = '';
  let translations = 0;
  for (const id of ids) {
    const place = findBlock(project, id);
    const screen = draft.json<Screen>(place.file);
    const list = listAt(screen, place.list);
    const image = list[place.index] as Block;
    const props = (image.props ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const caption = text(props.caption);
    const alt = text(props.alt);
    const named = (caption || alt || source.base.replace(/[-_]+/g, ' ')).slice(0, 200);
    if (id === args.block) title = named;
    const of = ids.length > 1 ? `${id}: ` : '';
    if (caption) lost.push(`${of}its caption, shown under it: now the title of the video, which a loop does not show`);
    if (props.zoom) lost.push(`${of}its zoom: a video does not open in the lightbox`);
    const wide = props.presentation === 'wide' && (image.width === undefined || image.width === 'full');
    list[place.index] = {
      ...image,
      type: 'video',
      ...(wide ? { width: 'wide' } : {}),
      props: {
        asset: video.slice('assets/'.length),
        title: named,
        loop: true,
        ...(alt ? { alt } : {}),
        ...(props.decorative ? { decorative: true } : {}),
        ...(poster ? { poster: poster.slice('assets/'.length) } : {}),
        ...(props.generated ? { generated: true } : {})
      }
    } as Block;
    draft.writeJson(place.file, screen);
    translations += moveUnits(context, draft, id, caption ? [['caption', 'title']] : []);
  }

  // The image's file goes when no other block, page or stylesheet names it any more.
  const named = [...rewriteAssetReferences(draft.files(), source.asset, `${source.asset}\u0000`).keys()].some((rel) => !CONTRACTS.test(rel) && !rel.startsWith('plan-versions/'));
  const removed = !named && draft.exists(source.asset) ? source.asset : null;
  if (removed) draft.remove(removed);
  return { files: draft.files(), result: { block: args.block, blocks: ids, screen: source.screen, video, poster, removed, title, lost, translations } };
}
