import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as edit from '@elabora/node/edit/index';
import type { Author } from '@elabora/core/ops/types';
import { copyExample, readJSON } from '../helpers.ts';

// Undo by person (D79): ⌘Z takes the asker's last step (their change, or the whole batch of an agent
// they launched), never someone else's; ⇧⌘Z steps back through their undos; an inverse left out
// stays in force.

const text = (dir: string, block: string): string => readJSON(dir, 'screens/chemin.json').blocks.find((b: { id: string }) => b.id === block).props.markdown;
const write = (dir: string, block: string, markdown: string, author: Author) => edit.updateBlock(dir, { block, props: { markdown } }, { author, autoVersion: false, validate: false });

test('⌘Z undoes my last step: my change, or the whole batch of an agent I launched; ⇧⌘Z redoes them one undo at a time', () => {
  const dir = copyExample();
  const me: Author = { kind: 'human', id: 'ada', name: 'Ada' };
  const other: Author = { kind: 'human', id: 'bob', name: 'Bob' };
  const mine: Author = { kind: 'agent', name: 'claude-code', by: 'ada' };
  const before = { intro: text(dir, 'chemin-intro'), regle: text(dir, 'chemin-regle') };
  write(dir, 'chemin-intro', 'Ada', me);
  write(dir, 'chemin-regle', 'agent one', mine);
  write(dir, 'chemin-regle', 'agent two', mine);
  write(dir, 'chemin-intro', 'Bob', other);
  const options = { author: me, autoVersion: false, validate: false };
  // Bob's change is the newest, but not mine: the agent's batch goes, whole.
  const first = edit.undo(dir, undefined, options);
  assert.equal(first.op, 'update_block');
  assert.deepEqual([text(dir, 'chemin-regle'), text(dir, 'chemin-intro')], [before.regle, 'Bob']);
  // Then my own edit: it was replaced by Bob's since, so it is kept and said.
  const second = edit.undo(dir, undefined, options);
  assert.deepEqual([text(dir, 'chemin-intro'), second.skipped.map((s) => s.reason)], ['Bob', ['changed']]);
  assert.throws(() => edit.undo(dir, undefined, options), /Nothing to undo/);
  // ⇧⌘Z: the undo that kept everything has nothing to redo; the batch's undo comes back.
  edit.redo(dir, options);
  assert.equal(text(dir, 'chemin-regle'), 'agent two');
  assert.throws(() => edit.redo(dir, options), /Nothing to redo/);
  // A change of mine after an undo: nothing left to redo.
  edit.undo(dir, undefined, options);
  write(dir, 'chemin-intro', 'Ada again', me);
  assert.throws(() => edit.redo(dir, options), /Nothing to redo/);
});

test('an inverse left out stays in force: undoing the batch again undoes it once its target is back', () => {
  const dir = copyExample();
  const me: Author = { kind: 'human' };
  const agent: Author = { kind: 'agent', name: 'claude-code' };
  const before = { intro: text(dir, 'chemin-intro'), regle: text(dir, 'chemin-regle') };
  const options = { author: me, autoVersion: false, validate: false };
  write(dir, 'chemin-intro', 'agent', agent);
  const { change } = write(dir, 'chemin-regle', 'agent', agent);
  write(dir, 'chemin-intro', 'person', me);
  const undone = edit.undoBatch(dir, undefined, options);
  assert.deepEqual([text(dir, 'chemin-intro'), text(dir, 'chemin-regle'), undone.skipped.length], ['person', before.regle, 1]);
  const [batch] = edit.historyBatches(dir).filter((b) => b.id === change?.batch);
  assert.deepEqual([batch.undone, batch.partly], [false, true]);
  assert.throws(() => edit.undoBatch(dir, undefined, options), /No AI work to undo/);
  // The person takes their edit back: the agent's value is there again, and its inverse applies.
  edit.undo(dir, undefined, options);
  assert.equal(text(dir, 'chemin-intro'), 'agent');
  const again = edit.undoBatch(dir, batch.id, options);
  assert.deepEqual([text(dir, 'chemin-intro'), again.skipped], [before.intro, []]);
  const [settled] = edit.historyBatches(dir).filter((b) => b.id === batch.id);
  assert.deepEqual([settled.undone, settled.partly], [true, false]);
});
