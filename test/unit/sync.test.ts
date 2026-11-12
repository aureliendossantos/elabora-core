import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps, invertOps, makeFiles, diffFiles, type Author, type Files, type Op } from '@elabora/core/ops/index';
import { rebase, mergeJson, acceptChange, SyncClient, type Committed, type Submission } from '@elabora/core/sync/index';
import { externalEdit } from '@elabora/core/sync/external';

// The rules of rebase (D74), the server's placing (D73) and a copy's model, case by case. The
// convergence bench (sync-convergence.test.ts) draws them together.

const human: Author = { kind: 'human', name: 'Ada' };
const agent: Author = { kind: 'agent', name: 'claude-code' };
const doc = (value: unknown) => makeFiles({ 'screens/one.json': JSON.stringify(value, null, 2) + '\n' });
const read = (files: Files) => JSON.parse((files.get('screens/one.json') as { text: string }).text);
const screen = (blocks: unknown[], extra: Record<string, unknown> = {}) => doc({ id: 'one', blocks, ...extra });
const block = (id: string, markdown: string) => ({ id, type: 'text', props: { markdown } });

// A change made on base: the operations between base and the files an edit leaves.
function change(base: Files, edit: (value: any) => void, author: Author = human, id = 'c') {
  const value = read(base);
  edit(value);
  const ops = diffFiles(base, doc(value));
  return { id, author, ops, inverse: invertOps(base, ops) };
}

test('rebase: an operation whose value is as it was applies; a person\'s over a value changed since wins and says what it replaced', () => {
  const base = screen([block('a', 'one'), block('b', 'two')]);
  const head = applyOps(base, change(base, (v) => { v.blocks[0].props.markdown = 'theirs'; }).ops);
  const mine = change(base, (v) => { v.blocks[0].props.markdown = 'mine'; v.blocks[1].props.markdown = 'also mine'; });
  const result = rebase(head, mine);
  assert.deepEqual(read(result.files).blocks.map((b: any) => b.props.markdown), ['mine', 'also mine']);
  assert.deepEqual(result.overwrote.map((o) => [o.path, o.was]), [['blocks[a].props.markdown', 'theirs']]);
  assert.deepEqual(result.skipped, []);
});

test('rebase: an agent\'s operation over a value changed since is left out and reported; the rest of its change applies', () => {
  const base = screen([block('a', 'one'), block('b', 'two')]);
  const head = applyOps(base, change(base, (v) => { v.blocks[0].props.markdown = 'person'; }).ops);
  const result = rebase(head, change(base, (v) => { v.blocks[0].props.markdown = 'agent'; v.blocks[1].props.markdown = 'agent too'; }, agent));
  assert.deepEqual(read(result.files).blocks.map((b: any) => b.props.markdown), ['person', 'agent too']);
  assert.deepEqual(result.skipped.map((s) => s.reason), ['changed']);
  assert.deepEqual(result.overwrote, []);
});

test('rebase: structure — an anchor gone puts the insertion last, an element gone is not removed nor moved, an id taken refuses the change', () => {
  const base = screen([block('a', 'one'), block('b', 'two'), block('c', 'three')]);
  const head = applyOps(base, change(base, (v) => { v.blocks.splice(1, 1); }).ops); // b removed
  const inserted = rebase(head, change(base, (v) => { v.blocks.splice(2, 0, block('n', 'new')); })); // after b
  assert.deepEqual(read(inserted.files).blocks.map((b: any) => b.id), ['a', 'c', 'n']);
  const removed = rebase(head, change(base, (v) => { v.blocks.splice(1, 1); }));
  assert.deepEqual(removed.ops, []);
  assert.deepEqual(removed.skipped.map((s) => s.reason), ['missing']);
  const move: Op[] = [{ op: 'move', file: 'screens/one.json', path: ['blocks', { id: 'b' }], to: { file: 'screens/one.json', path: ['blocks'] }, after: null }];
  const moved = rebase(head, { id: 'm', author: human, ops: move, inverse: invertOps(base, move) });
  assert.deepEqual([read(moved.files).blocks.map((b: any) => b.id), moved.skipped.map((s) => s.reason)], [['a', 'c'], ['missing']]);
  const taken = applyOps(base, change(base, (v) => { v.blocks.push(block('n', 'theirs')); }).ops);
  const refused = rebase(taken, change(base, (v) => { v.blocks.push(block('n', 'mine')); }));
  assert.equal(refused.refusal?.code, 'E_SYNC_ID_TAKEN');
  assert.equal(refused.files, taken);
});

test('rebase: a value written whole (an array without ids, a document) merges three ways; only what both changed is decided', () => {
  const words = (list: string[]) => list.map((text) => ({ text, say: text }));
  const base = screen([], { words: words(['SQL', 'GUI']) });
  const head = applyOps(base, change(base, (v) => { v.words.push({ text: 'API', say: 'API' }); }).ops);
  const both = rebase(head, change(base, (v) => { v.words.push({ text: 'URL', say: 'URL' }); }, agent));
  assert.deepEqual(read(both.files).words.map((w: any) => w.text), ['SQL', 'GUI', 'API', 'URL']);
  assert.deepEqual(both.skipped, []);
  // The whole document set by a diff that could not split it keeps another's edit elsewhere in it.
  const whole = screen([block('a', 'one')], { title: 'Old' });
  const theirs = applyOps(whole, [{ op: 'set', file: 'screens/one.json', path: ['blocks', { id: 'a' }, 'props', 'markdown'], value: 'theirs' }]);
  const next = { ...read(whole), title: 'New' };
  const ops: Op[] = [{ op: 'set', file: 'screens/one.json', path: [], value: next }];
  const merged = rebase(theirs, { id: 'w', author: agent, ops, inverse: invertOps(whole, ops) });
  assert.deepEqual([read(merged.files).title, read(merged.files).blocks[0].props.markdown], ['New', 'theirs']);
});

test('merge: removed on one side and changed on the other is a conflict, won by the side named', () => {
  const base = { list: [{ id: 'x', v: 1 }, { id: 'y', v: 1 }] };
  const head = { list: [{ id: 'y', v: 1 }] };
  const mine = { list: [{ id: 'x', v: 2 }, { id: 'y', v: 1 }] };
  assert.deepEqual(mergeJson(base, head, mine, 'mine').value, mine);
  const kept = mergeJson(base, head, mine, 'head');
  assert.deepEqual([kept.value, kept.conflicts.length], [head, 1]);
});

test('server: a change is placed once, numbered, its inverse on head; a stale base is refused', () => {
  const base = screen([block('a', 'one')]);
  const made = change(base, (v) => { v.blocks[0].props.markdown = 'two'; }, human, 'c1');
  const submission: Submission = { ...made, base: 0, at: '2026-11-12T20:00:00.000Z' };
  const state = { head: 0, files: base, log: [] as Committed[] };
  const first = acceptChange(state, submission);
  assert.ok('committed' in first);
  assert.deepEqual([first.committed.seq, first.committed.batch, first.duplicate], [1, 'c1', false]);
  assert.deepEqual(applyOps(first.files, first.committed.inverse), base);
  const after = { head: 1, files: first.files, log: [first.committed] };
  const again = acceptChange(after, submission);
  assert.ok('committed' in again && again.duplicate && again.committed === first.committed);
  const stale = acceptChange({ ...after, log: [] }, { ...submission, id: 'c2' });
  assert.ok('refusal' in stale && stale.refusal.code === 'E_SYNC_BASE');
  const malformed = acceptChange(after, { ...submission, id: 'c3', inverse: [] });
  assert.ok('refusal' in malformed && malformed.refusal.code === 'E_SYNC_MALFORMED');
});

test('client: what it shows is confirmed with its waiting changes rebased on top; one in flight; a change of others in between', () => {
  const base = screen([block('a', 'one'), block('b', 'two')]);
  const client = new SyncClient(base, 0);
  const local = (id: string, edit: (v: any) => void) => {
    const view = client.view;
    const value = read(view);
    edit(value);
    client.record({ id, at: '2026-11-12T20:00:00.000Z', author: human, ops: diffFiles(view, doc(value)) });
  };
  local('m1', (v) => { v.blocks[0].props.markdown = 'mine'; });
  local('m2', (v) => { v.blocks[1].props.markdown = 'mine too'; });
  const sent = client.next();
  assert.equal(sent?.id, 'm1');
  assert.equal(client.next(), null);
  // Another copy's change, placed first: block b edited.
  let state = { head: 0, files: base, log: [] as Committed[] };
  const other = acceptChange(state, { ...change(base, (v) => { v.blocks[1].props.markdown = 'theirs'; v.blocks.push(block('c', 'three')); }, human, 'o1'), base: 0, at: '2026-11-12T20:00:00.000Z' });
  assert.ok('committed' in other);
  state = { head: 1, files: other.files, log: [other.committed] };
  client.receive({ type: 'change', change: other.committed });
  assert.deepEqual(read(client.view).blocks.map((b: any) => b.props.markdown), ['mine', 'mine too', 'three']);
  const placed = acceptChange(state, sent as Submission);
  assert.ok('committed' in placed);
  client.receive({ type: 'ack', change: placed.committed });
  state = { head: 2, files: placed.files, log: [...state.log, placed.committed] };
  const second = client.next() as Submission;
  assert.deepEqual([second.id, second.base], ['m2', 2]);
  const last = acceptChange(state, second);
  assert.ok('committed' in last);
  client.receive({ type: 'ack', change: last.committed });
  assert.equal(client.pending, 0);
  assert.deepEqual(client.view, last.files);
  // m2 was made before the other copy's edit of b: it wins, and says what it replaced.
  const outcomes = client.takeOutcomes();
  assert.deepEqual(outcomes.map((o) => [o.id, o.overwrote.map((w) => w.was)]), [['m1', []], ['m2', ['theirs']]]);
});

test('external edit: a file written from an older version keeps what was written since; the edit of the same value is left out', () => {
  const v0 = screen([block('a', 'one'), block('b', 'two')]);
  const v1 = applyOps(v0, change(v0, (v) => { v.blocks[0].props.markdown = 'person'; }).ops);
  // An agent read v0, then wrote block b; another wrote a from v0.
  const value = read(v0);
  value.blocks[1].props.markdown = 'agent';
  const kept = externalEdit(v1, doc(value), [v0]);
  assert.deepEqual(read(applyOps(v1, kept.ops)).blocks.map((b: any) => b.props.markdown), ['person', 'agent']);
  assert.deepEqual(kept.merged, ['screens/one.json']);
  value.blocks[0].props.markdown = 'agent over a';
  const clash = externalEdit(v1, doc(value), [v0]);
  assert.deepEqual(read(applyOps(v1, clash.ops)).blocks.map((b: any) => b.props.markdown), ['person', 'agent']);
  assert.equal(clash.skipped.length, 1);
});
