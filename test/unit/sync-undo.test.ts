import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invertOps, makeFiles, diffFiles, type Author, type Files } from '@elabora/core/ops/index';
import { changesToUndo, lastStep } from '@elabora/core/ops/batch';
import { undoChanges } from '@elabora/core/ops/undo';
import { acceptChange, journalOf, SyncClient, type Committed, type RoomState, type Submission } from '@elabora/core/sync/index';
import { runBench } from '../sync/bench.ts';

// An undo across a project's server (D79, D87): what it left out travels with it and stays in the
// server's log, so that an agent of the cloud reading that log, or the copy that made it, can take
// it back later.

const person: Author = { kind: 'human', id: 'acc_ada', name: 'Ada' };
const agent: Author = { kind: 'agent', id: 'acc_ada:agent:claude', name: 'Claude', by: 'acc_ada' };
const doc = (value: unknown) => makeFiles({ 'screens/one.json': `${JSON.stringify(value, null, 2)}\n` });
const read = (files: Files) => JSON.parse((files.get('screens/one.json') as { text: string }).text);
const base = doc({ id: 'one', title: 'One', blocks: [{ id: 'a', type: 'text', props: { markdown: 'a0' } }, { id: 'b', type: 'text', props: { markdown: 'b0' } }] });

class Server {
  state: RoomState = { head: 0, files: base, log: [] };
  n = 0;
  place(author: Author, edit: (value: any) => void, extra: Partial<Submission> = {}): Committed {
    const value = read(this.state.files);
    edit(value);
    const ops = diffFiles(this.state.files, doc(value));
    return this.submit({ id: `c${++this.n}`, base: this.state.head, at: '2026-11-12T09:00:00.000Z', author, ops, inverse: invertOps(this.state.files, ops), ...extra });
  }
  submit(submission: Submission): Committed {
    const accepted = acceptChange(this.state, submission);
    assert.ok('committed' in accepted, JSON.stringify(accepted));
    this.state = { head: accepted.committed.seq, files: accepted.files, log: [...this.state.log, accepted.committed] };
    return accepted.committed;
  }
  // An agent of the cloud undoes its last batch, as the connector does: from the server's log, on its head.
  undoAgentBatch(): { kept: number; undone: number } | null {
    const entries = journalOf(this.state.log);
    const step = lastStep(entries, agent);
    const batch = step?.change.batch ?? ([...entries].reverse().find((entry) => entry.type === 'change' && entry.author.kind === 'agent') as { batch?: string } | undefined)?.batch;
    if (!batch) return null;
    const changes = changesToUndo(entries, { batch });
    if (!changes.length) return null;
    const undone = undoChanges(this.state.files, changes);
    if (!undone.ops.length && !undone.skipped.length) return null;
    this.submit({ id: `u${++this.n}`, base: this.state.head, at: '2026-11-12T09:00:00.000Z', author: agent, ops: undone.ops, inverse: invertOps(this.state.files, undone.ops), undoes: { batch, changes: changes.map((change) => change.id), skipped: undone.skipped } });
    return { kept: undone.skipped.length, undone: undone.ops.length };
  }
}

const markdown = (files: Files) => read(files).blocks.map((block: any) => block.props.markdown);

test('an agent\'s undo through the server keeps what was edited since, and a later undo takes it back once it can', () => {
  const server = new Server();
  server.place(agent, (v) => { v.blocks[0].props.markdown = 'a1'; }, { batch: 'run' });
  server.place(agent, (v) => { v.blocks[1].props.markdown = 'b1'; }, { batch: 'run' });
  const edit = server.place(person, (v) => { v.blocks[0].props.markdown = 'a by Ada'; });

  assert.deepEqual(server.undoAgentBatch(), { kept: 1, undone: 1 });
  assert.deepEqual(markdown(server.state.files), ['a by Ada', 'b0']);
  // The person takes their edit back: the agent's value is there again.
  const back = undoChanges(server.state.files, changesToUndo(journalOf(server.state.log), { change: edit.id }));
  server.submit({ id: 'p-undo', base: server.state.head, at: '2026-11-12T09:00:00.000Z', author: person, ops: back.ops, inverse: invertOps(server.state.files, back.ops), undoes: { changes: [edit.id], skipped: back.skipped } });
  assert.deepEqual(markdown(server.state.files), ['a1', 'b0']);
  // The agent's undo of the same batch now takes back what it had kept; then nothing is left.
  assert.deepEqual(server.undoAgentBatch(), { kept: 0, undone: 1 });
  assert.deepEqual(markdown(server.state.files), ['a0', 'b0']);
  assert.equal(server.undoAgentBatch(), null);
});

test('what the server\'s rebase leaves out of an agent\'s undo is recorded too, and taken back later', () => {
  const server = new Server();
  server.place(agent, (v) => { v.blocks[0].props.markdown = 'a1'; }, { batch: 'run' });
  // The agent computes its undo on the head it read…
  const entries = journalOf(server.state.log);
  const changes = changesToUndo(entries, { batch: 'run' });
  const read = server.state;
  const undone = undoChanges(read.files, changes);
  assert.equal(undone.skipped.length, 0);
  // …a person edits the same text meanwhile…
  const edit = server.place(person, (v) => { v.blocks[0].props.markdown = 'a by Ada'; });
  // …and the server places the undo on the new head: the person's value stays, the undo's op is left out.
  const placed = server.submit({ id: 'u-late', base: read.head, at: '2026-11-12T09:00:00.000Z', author: agent, ops: undone.ops, inverse: invertOps(read.files, undone.ops), undoes: { batch: 'run', changes: changes.map((c) => c.id), skipped: undone.skipped } });
  assert.equal(placed.ops.length, 0);
  assert.equal(placed.undoes?.skipped?.length, 1);
  assert.deepEqual(markdown(server.state.files), ['a by Ada', 'b0']);
  // The batch is still to undo in part; once the person's edit is gone, the agent's undo takes it back.
  assert.equal(changesToUndo(journalOf(server.state.log), { batch: 'run' }).length, 1);
  const back = undoChanges(server.state.files, changesToUndo(journalOf(server.state.log), { change: edit.id }));
  server.submit({ id: 'p-undo', base: server.state.head, at: '2026-11-12T09:00:00.000Z', author: person, ops: back.ops, inverse: invertOps(server.state.files, back.ops), undoes: { changes: [edit.id] } });
  assert.deepEqual(server.undoAgentBatch(), { kept: 0, undone: 1 });
  assert.deepEqual(markdown(server.state.files), ['a0', 'b0']);
});

test('a copy\'s undo carries what it left out, and what its own rebase left out of it', () => {
  const server = new Server();
  const made = server.place(agent, (v) => { v.blocks[0].props.markdown = 'a1'; }, { batch: 'run' });
  const client = new SyncClient(server.state.files, server.state.head);
  // The copy undoes the agent's change on what it shows; meanwhile a person's edit reached the server.
  const undone = undoChanges(client.view, [made]);
  client.record({ id: 'u-copy', at: '2026-11-12T09:00:00.000Z', author: agent, ops: undone.ops, undoes: { batch: 'run', changes: [made.id], skipped: undone.skipped } });
  const edit = server.place(person, (v) => { v.blocks[0].props.markdown = 'a by Ada'; });
  client.receive({ type: 'change', change: edit });
  const sent = client.next() as Submission;
  assert.equal(sent.undoes?.skipped?.length, 1, 'left out by the copy\'s rebase');
  const placed = server.submit(sent);
  assert.equal(placed.undoes?.skipped?.length, 1);
  assert.equal(changesToUndo(journalOf(server.state.log), { batch: 'run' }).length, 1, 'still in force');
});

test('an undo goes alone: the changes after it in the same batch are not sent with it', () => {
  const server = new Server();
  const made = server.place(agent, (v) => { v.blocks[0].props.markdown = 'a1'; }, { batch: 'run' });
  const client = new SyncClient(server.state.files, server.state.head);
  const undone = undoChanges(client.view, [made]);
  client.record({ id: 'u1', at: '2026-11-12T09:00:00.000Z', author: agent, batch: 'run', ops: undone.ops, undoes: { batch: 'run', changes: [made.id] } });
  const value = read(client.view);
  value.blocks[1].props.markdown = 'b1';
  client.record({ id: 'c-after', at: '2026-11-12T09:00:01.000Z', author: agent, batch: 'run', ops: diffFiles(client.view, doc(value)) });
  const sent = client.next() as Submission;
  assert.deepEqual([sent.id, sent.ops.length], ['u1', 1]);
});

// The bench with agents undoing their batch from the server's log: every undo placed keeps what it
// left out, and nothing in force before it vanishes without being applied (test/sync/bench.ts).
const DRAWS = Number(process.env.ELABORA_SYNC_DRAWS ?? 120);
test('the bench: undos of agents and people through the server keep what they leave out (D87)', () => {
  const problems: string[] = [];
  let partly = 0;
  for (let seed = 5000; seed < 5000 + DRAWS; seed++) {
    for (const solo of [true, false]) {
      const report = runBench({ seed, solo, agentUndos: true });
      problems.push(...report.problems.map((problem) => `seed ${seed}${solo ? ' solo' : ''}: ${problem}`));
      partly += report.stats['undo of an agent\'s batch, in part'] ?? 0;
    }
  }
  assert.deepEqual(problems.slice(0, 5), []);
  assert.ok(partly > DRAWS / 4, `${partly} undos of an agent's batch left something out`);
});
