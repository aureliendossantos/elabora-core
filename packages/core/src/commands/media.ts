import { rewriteAssetReferences } from '../media/references.ts';
import type { Screen } from '../project/model.ts';
import { CommandError, Draft, findBlock, listAt, type CommandContext, type CommandOutput } from './context.ts';

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
