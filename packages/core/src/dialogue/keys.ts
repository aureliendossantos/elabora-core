// A dialogue's entries in elabora.lock.json (D61): the dialogue itself (dialogue:<block>, the key of
// its progress in the suspend data), each option (choice:<block>#<node>.<option>, its key in the
// saved path) and each ending (ending:<block>#<ending>). Keys never change for an id, and the lock
// keeps those of removed options: the bit fields of what was explored and found give each option
// and ending its place by the order of their keys, so a place is never reused.

import type { DialogueKeys } from '@elabora/player/dialogue/types';
import { recordsOf, textOf } from '../compile/values.ts';
import type { StateKeys, StateLock } from '../compile/state-model.ts';

export const dialogueEntity = (block: string): string => `dialogue:${block}`;
export const choiceEntity = (block: string, node: string, option: string): string => `choice:${block}#${node}.${option}`;
export const endingEntity = (block: string, ending: string): string => `ending:${block}#${ending}`;

// The lock entities of a dialogue, in a stable order (its options in node order, then its endings).
export function dialogueEntities(block: string, props: Record<string, unknown>): string[] {
  const entities = [dialogueEntity(block)];
  const seen = new Set<string>();
  for (const node of recordsOf(props.nodes)) {
    for (const option of recordsOf(node.options)) {
      const entity = choiceEntity(block, textOf(node.id), textOf(option.id));
      if (!textOf(node.id) || !textOf(option.id) || seen.has(entity)) continue;
      seen.add(entity);
      entities.push(entity);
    }
  }
  for (const ending of recordsOf(props.endings)) {
    const entity = endingEntity(block, textOf(ending.id));
    if (!textOf(ending.id) || seen.has(entity)) continue;
    seen.add(entity);
    entities.push(entity);
  }
  return entities;
}

// The keys of a dialogue's options and the places of its options and endings in the bit fields,
// from the keys assigned (keys) and those the lock keeps for options and endings since removed.
export function dialogueKeys(block: string, keys: StateKeys, lock: Pick<StateLock, 'keys'> | null): DialogueKeys {
  const out: DialogueKeys = { choices: {}, bits: {}, endings: {} };
  const choicePrefix = `choice:${block}#`;
  const endingPrefix = `ending:${block}#`;
  const all = new Map<string, string>([...Object.entries(lock?.keys ?? {}), ...Object.entries(keys)]);
  const ranked = (prefix: string) => [...all].filter(([entity]) => entity.startsWith(prefix)).sort(([, a], [, b]) => parseInt(a, 36) - parseInt(b, 36) || a.localeCompare(b));
  ranked(choicePrefix).forEach(([entity, key], place) => {
    const ref = entity.slice(choicePrefix.length);
    if (keys[entity] === undefined) return;
    out.choices[ref] = key;
    out.bits[ref] = place;
  });
  ranked(endingPrefix).forEach(([entity], place) => {
    if (keys[entity] === undefined) return;
    out.endings[entity.slice(endingPrefix.length)] = place;
  });
  return out;
}
