// The convergence bench of projects in the cloud (D73–D75): copies of one module, a server that
// orders their changes in memory, actors drawn at random with a seed (people, agents through
// Elabora's tools, agents writing files with their own tools), one copy that goes offline and
// comes back. What it affirms, at the end of each draw (check()):
//   - every copy and the server hold the same files, nothing waits;
//   - the project validates with no error;
//   - no edit of a person is lost without being told: each text a person wrote (a unique token) is
//     still there, or was replaced by someone who saw it, or the one who replaced it was told
//     (overwrote), or its author was (skipped, refused);
//   - an agent never replaces a person's text it had not seen (a file written by its own tools,
//     when what it read is unsure, tells the person: D75).
// The oracle reads only what actors saw and the server's log: never rebase's own bookkeeping.
import type { Author, Files, Op } from '@elabora/core/ops/types';
import { diffFiles } from '@elabora/core/ops/diff';
import { formatJson, sameContent, textFile } from '@elabora/core/ops/json';
import { undoChanges } from '@elabora/core/ops/undo';
import { executeCommand } from '@elabora/core/commands/execute';
import {
  CommandError, addBlock, updateBlock, removeBlock, moveBlock, duplicateBlock, updateScreen, duplicateScreen, deleteScreen,
  addNarrationLine, updateNarrationLine, updateCourseSettings, type CommandContext, type CommandOutput
} from '@elabora/core/commands/index';
import { loadProject } from '@elabora/core/project/load';
import { validateProject } from '@elabora/core/validate/index';
import { errorCounts, revalidate, validationState, type ValidationState } from '@elabora/core/validate/incremental';
import type { ProjectFiles } from '@elabora/core/project/files';
import type { Diagnostic } from '@elabora/core/diagnostics/index';
import { SyncClient, type Outcome } from '@elabora/core/sync/client';
import { acceptChange } from '@elabora/core/sync/server';
import { externalEdit, type Version } from '@elabora/core/sync/external';
import type { ClientMessage, Committed, Overwrite, ServerMessage } from '@elabora/core/sync/protocol';
import { benchCourse } from './fixture.ts';

export interface BenchOptions {
  seed: number;
  steps?: number;
  // How a copy turns a file written by an agent's own tools into a change: from the version it
  // most likely read (D75), or from the files as they are (before D75: a stale write undid what was written meanwhile).
  external?: 'closest-version' | 'current';
  // Only copy A acts and no copy goes offline: the generator alone, without concurrency.
  solo?: boolean;
  // Each change placed, the server's validation kept change by change (D86) is compared with a
  // whole validation of the same files: a difference is a problem of the draw.
  differential?: boolean;
}

export interface BenchReport {
  seed: number;
  problems: string[];
  stats: Record<string, number>;
}

// ── random ───────────────────────────────────────────────────────────

export type Rng = ReturnType<typeof random>;
export function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, chance: (p: number) => next() < p, pick: <T>(list: readonly T[]): T => list[int(list.length)] };
}

// ── the world ────────────────────────────────────────────────────────

interface Actor { id: string; author: Author; human: boolean }

interface Copy {
  name: string;
  client: SyncClient;
  up: ClientMessage[];
  down: ServerMessage[];
  online: boolean;
  actors: Actor[];
  versions: Version[];        // the copy's earlier views and who changed each, newest first (D75)
  reads: Map<string, Files>;  // what an agent writing with its own tools read, by actor
  ids: () => number;          // the copy's own draw of ids' suffixes (D77), seeded
}

interface Made {
  id: string;
  actor: Actor;
  seen: Files;                // what its author saw when deciding
  tokens: string[];           // the tokens it wrote (people's only are checked)
  ops: Op[];
  head: number;               // the copy's confirmed head when it was made
}

interface Server { head: number; files: Files; log: Committed[] }

const BASELINE_ERRORS = 0;

export function runBench(options: BenchOptions): BenchReport {
  const rng = random(options.seed);
  const steps = options.steps ?? 60;
  const stats: Record<string, number> = {};
  const count = (key: string, n = 1) => { stats[key] = (stats[key] ?? 0) + n; };
  const start = benchCourse();
  const server: Server = { head: 0, files: start, log: [] };
  const made = new Map<string, Made>();
  const outcomes = new Map<string, Outcome>();
  let tokens = 0;
  let changes = 0;
  const now = () => new Date(Date.UTC(2026, 10, 12, 20, 0, changes)).toISOString();

  const copy = (name: string): Copy => ({
    name, client: new SyncClient(start, 0), up: [], down: [], online: true, versions: [], reads: new Map(), ids: random(options.seed * 31 + name.charCodeAt(0)).next,
    actors: [
      { id: `${name}-human`, author: { kind: 'human', name: `person ${name}` }, human: true },
      { id: `${name}-agent`, author: { kind: 'agent', name: `agent of ${name}` }, human: false },
      { id: `${name}-files`, author: { kind: 'external' }, human: false }
    ]
  });
  const copies = [copy('A'), copy('B')];
  const differences: string[] = [];
  let kept: ValidationState | null = options.differential ? validationState(start as ProjectFiles) : null;

  const validate = (after: Files): string | null => {
    const errors = validateProject(loadProject(after as ProjectFiles)).diagnostics.filter((d) => d.severity === 'error');
    return errors.length > BASELINE_ERRORS ? errors.map((d) => `${d.code} ${d.file ?? ''} ${d.message}`).join('; ') : null;
  };

  // The server gets one message of a copy.
  const serve = (from: Copy, message: ClientMessage) => {
    if (message.type !== 'submit') return;
    // The room validates every change; the bench only those others wrote before (since its base,
    // or since the copy made it), the one case a copy's own validation does not cover. The end of
    // each draw validates everything.
    const madeOn = made.get(message.change.id)?.head;
    const accepted = acceptChange(server, message.change, { validate: (after, context) => (context.concurrent || madeOn !== message.change.base ? validate(after) : null) });
    if ('refusal' in accepted) {
      count(`refused ${accepted.refusal.code}`);
      from.down.push({ type: 'refused', refusal: accepted.refusal, head: server.head });
      return;
    }
    if (accepted.duplicate) {
      from.down.push({ type: 'ack', change: accepted.committed });
      return;
    }
    server.head = accepted.committed.seq;
    server.files = accepted.files;
    server.log.push(accepted.committed);
    count('placed');
    if (kept) {
      kept = revalidate(kept, accepted.files as ProjectFiles);
      const difference = sameFindings(kept, validateProject(loadProject(accepted.files as ProjectFiles)).diagnostics);
      if (difference) differences.push(`after ${accepted.committed.id} (${accepted.committed.command?.name ?? 'a file'}): ${difference}`);
      count(kept.ran.full ? 'validated whole' : 'validated in part');
    }
    if (accepted.committed.skipped.length) count('placed with skipped operations');
    if (accepted.committed.overwrote.length) count('placed over a value not seen');
    if (accepted.committed.command?.name === 'changes') count('placed as a run of an agent\'s changes');
    for (const other of copies) {
      if (other === from) other.down.push({ type: 'ack', change: accepted.committed });
      else if (other.online) other.down.push({ type: 'change', change: accepted.committed });
    }
  };

  const pump = (c: Copy) => {
    for (const outcome of c.client.takeOutcomes()) outcomes.set(outcome.id, outcome);
    const next = c.client.next();
    if (next) c.up.push({ type: 'submit', change: next });
    for (const outcome of c.client.takeOutcomes()) outcomes.set(outcome.id, outcome);
  };

  const receive = (c: Copy, message: ServerMessage) => {
    const before = c.client.view;
    if (c.client.receive(message) === 'gap') throw new Error(`${c.name}: a gap in the changes it got`);
    // Who changed what the copy shows: the change placed, or the change of its own refused.
    const authors = message.type === 'catchup' ? message.changes.map((change) => change.author) : message.type === 'ack' || message.type === 'change' ? [message.change.author] : message.type === 'refused' ? [made.get(message.refusal.id)?.actor.author ?? { kind: 'human' }] : [];
    remember(c, before, authors.find((author) => author.kind === 'human') ?? authors[0] ?? { kind: 'system' });
    pump(c);
  };

  const remember = (c: Copy, before: Files, then: Author) => {
    if (before === c.client.view) return;
    c.versions.unshift({ files: before, then });
    c.versions.length = Math.min(c.versions.length, 64);
  };

  const record = (c: Copy, actor: Actor, ops: Op[], seen: Files, written: string[], name: string, extra: { undoes?: { changes: string[] }; batch?: string; overwrote?: Overwrite[] } = {}) => {
    if (!ops.length) return;
    const id = `${c.name}-${++changes}`;
    made.set(id, { id, actor, seen, tokens: written, ops, head: c.client.pending ? -1 : c.client.head });
    const before = c.client.view;
    c.client.record({ id, at: now(), author: actor.author, command: { name, args: null }, ops, ...extra });
    remember(c, before, actor.author);
    count(`change ${name}`);
    pump(c);
  };

  const token = (actor: Actor) => `${actor.human ? 'H' : 'X'}${actor.id[0]}${++tokens}tok`;

  // ── actions ──
  const commandsFor = (rng: Rng, files: Files, word: string): { name: string; run: (context: CommandContext) => CommandOutput<unknown> } | null => {
    const project = loadProject(files as ProjectFiles);
    const screens = [...project.screens.values()].map((s) => s.data);
    if (!screens.length) return null;
    const screen = rng.pick(screens);
    const blocks = (screen.blocks ?? []) as { id: string; type: string }[];
    const texts = screens.flatMap((s) => ((s.blocks ?? []) as { id: string; type: string }[]).filter((b) => b.type === 'text'));
    const lines = ((screen as { narration?: { lines?: { id: string }[] } }).narration?.lines ?? []);
    const course = project.course as { pronunciations?: { en?: { text: string; say: string }[] } } | null;
    const choices: (() => { name: string; run: (context: CommandContext) => CommandOutput<unknown> } | null)[] = [
      () => texts.length ? { name: 'update_block', run: (ctx) => updateBlock(ctx, { block: rng.pick(texts).id, props: { markdown: word } }) } : null,
      () => texts.length ? { name: 'update_block', run: (ctx) => updateBlock(ctx, { block: rng.pick(texts).id, props: { markdown: word } }) } : null,
      () => ({ name: 'add_block', run: (ctx) => addBlock(ctx, { screen: screen.id, block: { type: 'text', props: { markdown: word } }, ...(blocks.length && rng.chance(0.6) ? { after: rng.pick(blocks).id } : {}) }) }),
      () => texts.length > 2 ? { name: 'remove_block', run: (ctx) => removeBlock(ctx, { block: rng.pick(texts).id }) } : null,
      () => {
        if (!texts.length) return null;
        const to = rng.pick(screens);
        const there = (to.blocks ?? []) as { id: string }[];
        return { name: 'move_block', run: (ctx) => moveBlock(ctx, { block: rng.pick(texts).id, screen: to.id, ...(there.length && rng.chance(0.5) ? { after: rng.pick(there).id } : { position: 0 }) }) };
      },
      () => texts.length ? { name: 'duplicate_block', run: (ctx) => duplicateBlock(ctx, { block: rng.pick(texts).id }) } : null,
      () => ({ name: 'update_screen', run: (ctx) => updateScreen(ctx, { id: screen.id, title: word }) }),
      () => screens.length < 5 && rng.chance(0.3) ? { name: 'duplicate_screen', run: (ctx) => duplicateScreen(ctx, { id: screen.id }) } : null,
      () => screens.length > 2 && rng.chance(0.3) ? { name: 'delete_screen', run: (ctx) => deleteScreen(ctx, { id: screen.id }) } : null,
      () => ({ name: 'add_narration_line', run: (ctx) => addNarrationLine(ctx, { screen: screen.id, line: { text: word } }) }),
      () => lines.length ? { name: 'update_narration_line', run: (ctx) => updateNarrationLine(ctx, { screen: screen.id, line: rng.pick(lines).id, text: word }) } : null,
      () => ({ name: 'update_course', run: (ctx) => updateCourseSettings(ctx, { pronunciations: { en: [...(course?.pronunciations?.en ?? []), { text: word, say: 'said' }] } }) })
    ];
    return rng.pick(choices)();
  };

  const act = (c: Copy) => {
    const actor = rng.pick(c.actors);
    const view = c.client.view;
    if (actor.author.kind === 'external') return writeFiles(c, actor);
    if (actor.human && rng.chance(0.12)) return undoOwn(c, actor);
    const word = token(actor);
    const command = commandsFor(rng, view, word);
    if (!command) return;
    try {
      const { ops } = executeCommand(view as ProjectFiles, command.name, command.run, { author: actor.author, now: new Date(0), random: c.ids });
      record(c, actor, ops, view, JSON.stringify(ops).includes(word) ? [word] : [], command.name, actor.human ? {} : { batch: `${actor.id}-batch` });
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      count('command refused by its own checks');
    }
  };

  // A person undoes their own last change that the server placed, on what the copy shows.
  const undoOwn = (c: Copy, actor: Actor) => {
    const own = server.log.filter((change) => change.seq <= c.client.head && made.get(change.id)?.actor === actor && !undone.has(change.id) && change.ops.length);
    const last = own[own.length - 1];
    if (!last) return;
    const view = c.client.view;
    const result = undoChanges(view, [last]);
    undone.add(last.id);
    record(c, actor, result.ops, view, [], 'undo', { undoes: { changes: [last.id] } });
  };
  const undone = new Set<string>();

  // An agent writing with its own tools: it reads a file, and later writes it with its edit.
  const writeFiles = (c: Copy, actor: Actor) => {
    const read = c.reads.get(actor.id);
    if (!read || rng.chance(0.3)) {
      c.reads.set(actor.id, c.client.view);
      count('files read by an agent');
      return;
    }
    c.reads.delete(actor.id);
    const word = token(actor);
    const written = new Map(c.client.view);
    const project = loadProject(read as ProjectFiles);
    const screens = [...project.screens.values()];
    const roll = rng.next();
    if (roll < 0.15) {
      // course.json rewritten with its keys in another order and a new title.
      const course = read.get('course.json');
      if (course?.kind !== 'text') return;
      const doc = JSON.parse(course.text) as Record<string, unknown>;
      const reordered = Object.fromEntries(Object.entries({ ...doc, title: word }).reverse());
      written.set('course.json', textFile('course.json', JSON.stringify(reordered, null, 2)));
    } else if (roll < 0.4 || !screens.length) {
      const css = read.get('theme/theme.css');
      written.set('theme/theme.css', textFile('theme/theme.css', `${css?.kind === 'text' ? css.text : ''}.${word} { color: red; }\n`));
    } else {
      const screen = rng.pick(screens);
      const file = `screens/${screen.data.id}.json`;
      const doc = structuredClone(screen.data) as { blocks?: { type: string; props?: { markdown?: string } }[] };
      const texts = (doc.blocks ?? []).filter((b) => b.type === 'text');
      if (!texts.length) return;
      rng.pick(texts).props = { markdown: word };
      // Agents' own tools write JSON their way: formatting means nothing.
      written.set(file, textFile(file, rng.chance(0.5) ? formatJson(doc as never) : JSON.stringify(doc, null, 4)));
    }
    const view = c.client.view;
    let ops: Op[];
    let overwrote: Overwrite[] = [];
    if (options.external === 'current') ops = diffFiles(view, written);
    else {
      const edit = externalEdit(view, written, c.versions, actor.author);
      ops = edit.ops;
      overwrote = edit.overwrote;
      if (overwrote.some((o) => o.unsure)) count('file edit over a person\'s edit it may not have seen (told)');
      if (edit.skipped.length) count('file edit merged with what was written meanwhile');
      // Written from what the copy shows: what it leaves out is an agent's edit lost (and told).
      if (edit.skipped.length && read === view) count('file edit from a fresh read left out');
    }
    record(c, actor, ops, read, [word], 'external', overwrote.length ? { overwrote } : {});
  };

  const deliver = (c: Copy, direction: 'up' | 'down') => {
    if (!c.online) return;
    if (direction === 'up') {
      const message = c.up.shift();
      if (message) serve(c, message);
    } else {
      const message = c.down.shift();
      if (message) receive(c, message);
    }
  };

  const goOffline = (c: Copy) => {
    c.online = false;
    c.up.length = 0;   // what was on the wire is lost
    c.down.length = 0;
    c.client.disconnected();
    count('went offline');
  };

  const comeBack = (c: Copy) => {
    c.online = true;
    // hello { since: head } → catchup
    c.down.push({ type: 'catchup', changes: server.log.filter((change) => change.seq > c.client.head), head: server.head });
    pump(c);
  };

  // ── the draw ──
  for (let step = 0; step < steps; step++) {
    const roll = rng.next();
    const c = options.solo ? copies[0] : rng.pick(copies);
    if (roll < 0.45) act(c);
    else if (options.solo) { for (const each of copies) while (each.up.length || each.down.length) { deliver(each, 'up'); deliver(each, 'down'); } }
    else if (roll < 0.93) deliver(c, rng.chance(0.5) ? 'up' : 'down');
    else if (c.name === 'B') (c.online ? goOffline(c) : comeBack(c));
  }
  // Everyone back, every message delivered.
  for (const c of copies) if (!c.online) comeBack(c);
  for (let guard = 0; copies.some((c) => c.up.length || c.down.length || c.client.pending); guard++) {
    if (guard > 10000) throw new Error('the copies do not settle');
    for (const c of copies) {
      deliver(c, 'up');
      deliver(c, 'down');
      if (!c.up.length && !c.down.length && c.client.pending) pump(c);
    }
  }

  return { seed: options.seed, problems: [...differences, ...check(server, copies, made, outcomes, validate)], stats };
}

// What a validation kept change by change found, against a whole validation: every finding, its
// severity, place, message and flags, and the errors counted as a room counts them.
export function sameFindings(kept: ValidationState, whole: readonly Diagnostic[]): string | null {
  const key = (d: Diagnostic) => JSON.stringify([d.code, d.severity, d.file ?? '', d.path ?? '', d.target ?? '', d.message, d.key ?? '', !!d.waived, !!d.ignored]);
  const a = kept.diagnostics.map(key).sort();
  const b = whole.map(key).sort();
  const missing = b.filter((k) => !a.includes(k));
  const extra = a.filter((k) => !b.includes(k));
  if (missing.length || extra.length || a.length !== b.length) return `missing ${missing.slice(0, 3).join(' ')}; extra ${extra.slice(0, 3).join(' ')} (${a.length} for ${b.length})`;
  const counts = errorCounts(kept);
  const wholeCounts = errorCounts({ diagnostics: whole });
  if (JSON.stringify([...counts].sort()) !== JSON.stringify([...wholeCounts].sort())) return 'the errors counted differ';
  return null;
}

// ── what the bench affirms ───────────────────────────────────────────

function check(server: Server, copies: Copy[], made: Map<string, Made>, outcomes: Map<string, Outcome>, validate: (files: Files) => string | null): string[] {
  const problems: string[] = [];
  for (const c of copies) {
    if (c.client.pending) problems.push(`${c.name}: ${c.client.pending} changes still waiting`);
    for (const files of [c.client.view, c.client.confirmed]) {
      for (const path of new Set([...files.keys(), ...server.files.keys()])) {
        if (!sameContent(files.get(path), server.files.get(path))) problems.push(`${c.name}: ${path} differs from the server's`);
      }
    }
  }
  const invalid = validate(server.files);
  if (invalid) problems.push(`the project does not validate: ${invalid}`);

  const placed = new Map(server.log.map((change) => [change.id, change]));
  const contains = (value: unknown, word: string) => JSON.stringify(value).includes(word);
  const saw = (files: Files, word: string) => [...files.values()].some((file) => file.kind === 'text' && file.text.includes(word));
  for (const change of made.values()) {
    if (!change.actor.human) continue;
    const outcome = outcomes.get(change.id);
    if (!outcome) { problems.push(`${change.id}: no outcome`); continue; }
    const told = 'refused' in outcome || outcome.skipped.length > 0;
    for (const word of change.tokens) {
      // Written by the person: placed by the server, or they were told it was not.
      const committed = placed.get(change.id);
      if (!told && (!committed || !contains(committed.ops, word))) problems.push(`${change.id}: ${word} never placed, and its author was not told`);
      if (!committed || !contains(committed.ops, word)) continue;
      // Replaced later: by someone who saw it, or who was told.
      for (const later of server.log) {
        if (later.seq <= committed.seq || !contains(later.inverse, word) || contains(later.ops, word)) continue;
        // A run of an agent's changes sent as one names them (D83): what any of them saw counts.
        const ids = later.command?.name === 'changes' ? (later.command.args as { ids: string[] }).ids : [later.id];
        const run = ids.map((id) => made.get(id)).filter((one): one is Made => one !== undefined);
        const by = run[0];
        const seen = run.some((one) => saw(one.seen, word));
        if (seen) continue;
        // An agent's own file edit may not tell what it read (D75): when unsure, the person is told.
        if (by && !by.actor.human && !later.overwrote.some((o) => o.unsure && contains(o.was, word))) problems.push(`${later.id} (${by.actor.id}) replaced ${word} of ${change.id} without having seen it`);
        else if (by && !by.actor.human) continue;
        else if (!later.overwrote.some((o) => contains(o.was, word))) problems.push(`${later.id} replaced ${word} of ${change.id} without having seen it, and no one was told`);
      }
    }
  }
  return problems;
}
