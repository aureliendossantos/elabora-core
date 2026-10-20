import type { Anchor, Moment } from '@elabora/format';
import type { Block, Screen } from '../project/model.ts';
import { narrationWords, findPhrase, matchWords, normalizeWord } from '../narration/words.ts';
import type { TextWord } from '../narration/words.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import { CommandError, Draft, findBlock, listAt, type CommandContext, type CommandOutput } from './context.ts';

// When a block comes and goes on its screen's timeline (docs/decisions.md D28): block.timing.in and
// .out, each an anchor (at) and an effect. A patch: the fields given replace those of the moment,
// null removes one (the effect or its duration go back to their default; a moment set to null is
// removed: without in the block shows from the start of its step, without out until the end).

export type MomentPatch = { [K in keyof Moment]?: Moment[K] | null };

export interface SetBlockTimingArgs {
  block: string;
  in?: MomentPatch | null;
  out?: MomentPatch | null;
}

export function setBlockTiming(context: CommandContext, args: SetBlockTimingArgs): CommandOutput<{ screen: string; timing: Block['timing'] | null }> {
  const place = findBlock(context.project(), args.block);
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(place.file);
  const block = listAt(screen, place.list)[place.index] as Block;
  const timing: NonNullable<Block['timing']> = isRecord(block.timing) ? { ...block.timing } : {};
  for (const kind of ['in', 'out'] as const) {
    const patch = args[kind];
    if (patch === undefined) continue;
    if (patch === null) { delete timing[kind]; continue; }
    const moment: Record<string, unknown> = isRecord(timing[kind]) ? { ...timing[kind] } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete moment[key];
      else if (value !== undefined) moment[key] = value;
    }
    if (!isRecord(moment.at)) throw new CommandError(`timing.${kind} of "${args.block}" needs a moment: at, an anchor ({ "line": "l2", "word": "imprimante" }, or { "seconds": 1.5 } without narration).`);
    // The order of the format: at, effect, duration, direction.
    const { at, effect, duration, direction, ...rest } = moment;
    timing[kind] = { at, ...(effect !== undefined ? { effect } : {}), ...(duration !== undefined ? { duration } : {}), ...(direction !== undefined ? { direction } : {}), ...rest } as Moment;
  }
  const ordered: NonNullable<Block['timing']> = { ...(timing.in ? { in: timing.in } : {}), ...(timing.out ? { out: timing.out } : {}) };
  if (Object.keys(ordered).length) block.timing = ordered;
  else delete block.timing;
  draft.writeJson(place.file, screen);
  return { files: draft.files(), result: { screen: place.screenId, timing: block.timing ?? null } };
}

// ── Anchors that follow a line's text ─────────────────────────────

export interface Reanchored {
  // Where the anchor is written (block id and in/out, or event id), as people read it.
  where: string;
  word: string;
}

// After a line's text changed, its word anchors follow their words: the words of the old text are
// matched with the new (longest common subsequence), and an anchor whose words are still said, all
// of them and in a row, names the occurrence they are now. An anchor whose words were changed or
// removed stays as written: the validator reports it (E_TIMELINE_ANCHOR_MISSING) when the line no
// longer says them. screen: the screen's document, changed in place.
export function reanchorLine(screen: Screen, lineId: string, before: string, after: string, language: string): { moved: Reanchored[]; lost: Reanchored[] } {
  const oldWords = narrationWords(before, language);
  const newWords = narrationWords(after, language);
  const pairs = new Map(matchWords(oldWords.map((word) => normalizeWord(word.text)), newWords.map((word) => normalizeWord(word.text))));
  const moved: Reanchored[] = [];
  const lost: Reanchored[] = [];
  const follow = (anchor: unknown, where: string) => {
    if (!isRecord(anchor) || anchor.line !== lineId || typeof anchor.word !== 'string') return;
    const result = reanchor(anchor as Anchor, oldWords, newWords, pairs, language);
    if (result === 'lost') lost.push({ where, word: anchor.word });
    else if (result === 'moved') moved.push({ where, word: anchor.word });
  };
  const walk = (blocks: readonly Block[] | undefined) => {
    for (const block of objectsIn(blocks)) {
      if (isRecord(block.timing)) for (const kind of ['in', 'out'] as const) if (isRecord(block.timing[kind])) follow(block.timing[kind]!.at, `${block.id} ${kind}`);
      walk(block.blocks);
    }
  };
  walk(screen.blocks);
  for (const layer of objectsIn(screen.layers)) walk(layer.blocks);
  for (const event of objectsIn(screen.events)) {
    if (event.on?.type === 'timeline.reached') follow(event.on.at, event.id);
    for (const action of [...objectsIn(event.do), ...objectsIn(event.else)]) if (action.type === 'seek-timeline') follow(action.to, event.id);
  }
  return { moved, lost };
}

function reanchor(anchor: Anchor, oldWords: readonly TextWord[], newWords: readonly TextWord[], pairs: ReadonlyMap<number, number>, language: string): 'same' | 'moved' | 'lost' {
  const word = anchor.word!;
  const found = findPhrase(oldWords, word, { occurrence: anchor.occurrence, language });
  // Not said before the change either: nothing to follow (the validator already reports it).
  if (!found) return 'same';
  const mapped = Array.from({ length: found.count }, (_, offset) => pairs.get(found.index + offset));
  if (mapped.some((index, offset) => index === undefined || index !== mapped[0]! + offset)) return 'lost';
  for (let occurrence = 1; ; occurrence++) {
    const now = findPhrase(newWords, word, { occurrence, language });
    if (!now) return 'lost';
    if (now.index !== mapped[0]) continue;
    if (occurrence === (anchor.occurrence ?? 1)) return 'same';
    if (occurrence > 1) anchor.occurrence = occurrence; else delete anchor.occurrence;
    return 'moved';
  }
}
