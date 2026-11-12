import type { Action, Screen } from '../project/model.ts';
import { screenBlocks } from '../project/load.ts';
import { isRecord, objectsIn } from '../util/values.ts';

// Every place a screen's file names a block, a layer or a screen by its id: its events' triggers,
// conditions and actions, and the actions of its dialogues' cues and options (D61). Renaming an id
// and duplicating a screen follow them all through this one walk. local maps a block's or a layer's
// id (ids are unique in the course, so one map serves both), screen a screen's; each returns the id
// it is given when it does not rename it.
// (An id the walk does not know stays: a test duplicates every screen of the examples and finds none.)
export interface Renames {
  local?: (id: string) => string;
  screen?: (id: string) => string;
  // Whether a block's type is a dialogue (the native one, or a component forked from it).
  dialogue: (type: string) => boolean;
}

export function renameReferences(screen: Screen, { local, screen: screenOf, dialogue }: Renames): void {
  const named = (value: unknown, rename: ((id: string) => string) | undefined): unknown => (rename && typeof value === 'string' ? rename(value) : value);
  const action = (a: Action) => {
    if (a.type === 'go-to') a.screen = named(a.screen, screenOf) as string;
    if ('layer' in a) a.layer = named(a.layer, local) as string;
    if ('block' in a) a.block = named(a.block, local) as string;
  };
  for (const { block } of screenBlocks(screen)) {
    if (!dialogue(block.type) || !isRecord(block.props)) continue;
    const records = (value: unknown) => objectsIn(value as Record<string, unknown>[] | undefined);
    const cuesOf = (lines: unknown) => records(lines).flatMap((line) => records(line.cues));
    for (const node of records(block.props.nodes)) {
      const options = records(node.options);
      for (const holder of [...cuesOf(node.lines), ...options, ...options.flatMap((option) => cuesOf(option.reply))]) for (const a of records(holder.do)) action(a as Action);
    }
  }
  for (const event of objectsIn(screen.events)) {
    if (isRecord(event.on)) {
      event.on.target = named(event.on.target, local) as string;
      // A timeline trigger on a layer's timeline (D62).
      if ('layer' in event.on) event.on.layer = named(event.on.layer, local) as string;
    }
    for (const condition of objectsIn(event.if)) {
      if ('visited' in condition) condition.visited = named(condition.visited, local) as string;
      if ('dialogue' in condition) condition.dialogue = named(condition.dialogue, local) as string;
    }
    for (const a of [...objectsIn(event.do), ...objectsIn(event.else)]) action(a);
  }
}
