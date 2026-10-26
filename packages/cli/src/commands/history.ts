import fs from 'node:fs';
import path from 'node:path';
import type { Author, ChangeLike, SkippedOp } from '@elabora/core/ops/types';
import { formatPath } from '@elabora/core/ops/path';
import { undoneChanges } from '@elabora/core/ops/batch';
import * as edit from '@elabora/node/edit';
import { readJournal } from '@elabora/node/journal/index';
import { defineCommand, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  history [dir] [--limit 20] [--json]                 Changes grouped by batch of AI work: when, who, the request, what
                                                      changed, what was undone
  undo [dir]                                          Undo the last change made through Elabora tools or by an agent
  undo [dir] --change <id|seq>                        Undo one change (an undo too: that redoes it)
  undo [dir] --batch [<id>]                           Undo a batch of AI work (default: the last one). Whatever changed
                                                      since is kept, and listed
  mark [dir] "<request>"                              Label the next batch of AI work with the request that starts it.
                                                      Claude Code: a UserPromptSubmit hook running elabora mark --stdin
                                                      labels each batch with the prompt (read from the hook's JSON)`;

// ── history ──

// Authors as people read them: agents by name, the rest by what they are.
const KNOWN_AGENTS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
function authorName(author: Author): string {
  if (author.kind === 'agent') return author.name ? KNOWN_AGENTS[author.name] ?? author.name : 'an agent';
  if (author.kind === 'human') return author.name ?? 'a person';
  if (author.kind === 'external') return author.name ?? 'edits outside Elabora';
  return author.name ?? 'Elabora';
}

// A field of journaled command arguments, which are stored as given.
function field(value: unknown, ...keys: string[]): string | undefined {
  let node = value;
  for (const key of keys) node = typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined;
  return typeof node === 'string' || typeof node === 'number' ? String(node) : undefined;
}

// What a change did, in a few words: from its command, or from its files for edits made outside Elabora.
export function describeChange(change: ChangeLike): string {
  const args = change.command?.args;
  const of = (...keys: string[]) => field(args, ...keys) ?? '?';
  const files = change.files.map((file) => file.path).join(', ');
  const kept = change.type === 'undo' && change.skipped.length ? ` (kept ${change.skipped.length} edit(s) made since)` : '';
  if (!change.command) return `edited ${files}`;
  switch (change.command.name) {
    case 'create_screen': return `created screen ${of('id')}`;
    case 'update_screen': return `changed screen ${of('id')}`;
    case 'delete_screen': return `deleted screen ${of('id')}`;
    case 'move_screen': return `moved screen ${of('id')}`;
    case 'duplicate_screen': return `duplicated screen ${of('id')}`;
    case 'add_block': return `added ${field(args, 'block', 'id') ? `block ${of('block', 'id')}` : `a ${of('block', 'type')} block`} to ${field(args, 'parent') ?? field(args, 'layer') ?? of('screen')}`;
    case 'update_block': return `changed block ${of('block')}`;
    case 'set_captions': return `set the captions of video ${of('block')}`;
    case 'update_narration': return `changed the narration of ${of('screen')}`;
    case 'add_narration_line': return `added a narration line to ${of('screen')}`;
    case 'update_narration_line': return `changed narration line ${of('line')} of ${of('screen')}`;
    case 'move_narration_line': return `moved narration line ${of('line')} of ${of('screen')}`;
    case 'remove_narration_line': return `removed narration line ${of('line')} of ${of('screen')}`;
    case 'remove_speaker': return `removed speaker ${of('speaker')}${field(args, 'to') ? `, its lines to ${of('to')}` : ''}`;
    case 'set_narration_audio': return `set the voice of narration line ${of('line')} of ${of('screen')}`;
    case 'remove_block': return `removed block ${of('block')}`;
    case 'move_block': return `moved block ${of('block')}`;
    case 'duplicate_block': return `duplicated block ${of('block')}`;
    case 'detach_block': return `detached block ${of('block')} from its component`;
    case 'convert_block': return `converted block ${of('block')} into ${of('to', 'type')}${field(args, 'to', 'presentation') ? ` (${of('to', 'presentation')})` : ''}`;
    case 'upsert_layer': return field(args, 'layer', 'id') ? `wrote layer ${of('layer', 'id')} of ${of('screen')}` : `added a layer to ${of('screen')}`;
    case 'remove_layer': return `removed layer ${of('id')} from ${of('screen')}`;
    case 'upsert_event': return field(args, 'event', 'id') ? `wrote event ${of('event', 'id')} of ${of('screen')}` : `added an event to ${of('screen')}`;
    case 'remove_event': return `removed event ${of('id')} from ${of('screen')}`;
    case 'upsert_variable': return `wrote variable ${of('variable', 'id')}`;
    case 'remove_variable': return `removed variable ${of('id')}`;
    case 'rename_variable': return `renamed variable ${of('from')} to ${of('to')}`;
    case 'replace_text': return `replaced ${of('find')} with ${of('replace')}`;
    case 'export_translation': return `brought the ${of('to')} translation up to date`;
    case 'translate_text': {
      const texts = args && typeof args === 'object' && 'texts' in args && Array.isArray(args.texts) ? args.texts.length : null;
      return texts === null ? `translated ${of('unit')} into ${of('language')}` : `translated ${texts} text${texts === 1 ? '' : 's'} into ${of('language')}`;
    }
    case 'approve_translation': return `recorded the approval of the ${of('to')} plan by ${of('by')}`;
    case 'update_course': return 'changed the course settings';
    case 'update_agent_rules': return `brought the rules for agents in AGENTS.md up to date (revision ${of('to')})`;
    case 'upgrade_theme': return 'put the theme under the components (cascade D32), its look kept';
    case 'ignore_findings': {
      const findings = args && typeof args === 'object' && 'findings' in args && Array.isArray(args.findings) ? args.findings as { code?: unknown; key?: unknown }[] : [];
      const back = args && typeof args === 'object' && 'ignored' in args && args.ignored === false;
      return `${back ? 'brought back' : 'ignored'} ${findings.map((finding) => `${String(finding.code)} ${String(finding.key)}`).join(', ') || 'findings'}`;
    }
    case 'create_object': return `created free object ${of('id')}`;
    case 'write_object_file': return `wrote ${of('file')} of free object ${of('object')}`;
    case 'write_design_file': return `wrote ${of('file')}`;
    case 'write_plan': return args && typeof args === 'object' && 'patch' in args ? 'wrote the plan (a patch)' : 'wrote the plan';
    case 'set_plan_text': return `reworded ${args && typeof args === 'object' && 'text' in args ? of('text') : `the text of ${of('block')}`} in the plan`;
    case 'set_plan_voiceover': return `wrote the voice-over of ${of('item')}`;
    case 'revert_plan_change': return `brought ${of('key')} back as a version had it`;
    case 'create_plan_version': return 'made a version of the plan';
    case 'approve_plan': return `recorded the validation of ${args && typeof args === 'object' && 'version' in args ? of('version') : 'the latest version'} of the plan (${of('by')})`;
    case 'record_plan_send': return `recorded that ${of('version')} of the plan was sent (${of('format')})`;
    case 'set_plan_note': return `wrote a note for the client on ${of('target')}`;
    case 'create_component': return `created component ${of('id')}`;
    case 'fork_component': return `forked ${of('component')} into ${of('id')}`;
    case 'write_component_file': return `wrote ${of('file')} of component ${of('component')}`;
    case 'migrate_components': return 'migrated component instances';
    case 'add_component': return `added ${of('as')} from library ${of('library')}`;
    case 'upgrade_component': return `upgraded ${of('as')} from library ${of('library')}`;
    case 'publish_component': return `published ${of('component')} to library ${of('library')}`;
    case 'rename': return `renamed ${of('from')} to ${of('to')}`;
    case 'migrate_format': return `migrated the course from ${of('from')} to ${of('to')}`;
    case 'undo': return `undid change ${of('seq')}${kept}`;
    case 'undo_batch': return `undid batch ${of('batch')}${kept}`;
    default: return `${change.command.name}: ${files}`;
  }
}

const day = (at: string) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const time = (at: string) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

const history = defineCommand({
  name: 'history',
  flags: { limit: 'string', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(() => {
    const batches = edit.historyBatches(dir, Number(flags.limit) || 20);
    if (flags.json) { printJson(batches); return 0; }
    if (!batches.length) { console.log('No change yet.'); return 0; }
    const journal = readJournal(dir);
    const changes = new Map(journal.filter((entry): entry is ChangeLike => entry.type !== 'mark').map((entry) => [entry.id, entry]));
    const undone = undoneChanges(journal);
    let currentDay = '';
    for (const batch of batches) {
      if (day(batch.start) !== currentDay) { currentDay = day(batch.start); console.log(currentDay); }
      const header = [time(batch.start), batch.authors.map(authorName).join(', '), ...(batch.label ? [`"${batch.label}"`] : []), `${batch.changes.length} change(s)`, `batch ${batch.id}`];
      console.log(`  ${header.join(' · ')}${batch.undone ? ' · undone' : ''}`);
      for (const id of batch.changes) {
        const change = changes.get(id);
        if (change) console.log(`    ${String(change.seq).padStart(4)}  ${describeChange(change)}${undone.has(id) && !batch.undone ? ' (undone)' : ''}`);
      }
    }
    return 0;
  })
});

// ── undo ──

// What undo kept, because it changed since: where, and why.
export function keptEdits(skipped: readonly SkippedOp[]): { file: string; path: string | null; reason: SkippedOp['reason']; message: string }[] {
  return skipped.map(({ op, reason, message }) => ({ file: op.file, path: 'path' in op && op.path.length ? formatPath(op.path) : null, reason, message }));
}

// The sequence number of a change given by id or by sequence number.
export function changeSeq(dir: string, change: string): number {
  const entry = readJournal(dir).find((candidate) => candidate.type !== 'mark' && candidate.id === change);
  if (entry) return entry.seq;
  if (/^\d+$/.test(change)) return Number(change);
  throw new edit.EditError(`No change ${change} in the journal`);
}

const undo = defineCommand({
  name: 'undo',
  flags: { change: 'string', batch: 'optional', seq: 'string' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(() => {
    const change = flags.change ?? flags.seq; // --seq: the former name of --change
    if (change !== undefined && flags.batch !== undefined) { console.error('Usage: elabora undo [dir] [--change <id|seq> | --batch [<id>]]'); return 2; }
    if (flags.batch !== undefined) {
      const result = edit.undoBatch(dir, flags.batch === true ? undefined : flags.batch);
      const label = edit.historyBatches(dir, Infinity).find((batch) => batch.id === result.batch)?.label;
      const seqs = Array.isArray(result.undone) ? result.undone : [result.undone];
      console.log(`✔ Undid batch ${result.batch}${label ? ` "${label}"` : ''}: ${seqs.length} change(s) (${seqs.join(', ')}), ${result.files.join(', ')}`);
      printKept(result.skipped);
      return 0;
    }
    const result = edit.undo(dir, change === undefined ? undefined : changeSeq(dir, change));
    console.log(`✔ Undid change ${result.undone} (${result.op}): ${result.files.join(', ')}`);
    printKept(result.skipped);
    return 0;
  })
});

function printKept(skipped: readonly SkippedOp[]): void {
  for (const kept of keptEdits(skipped)) console.log(`  kept: ${kept.message}`);
}

// ── mark ──

// The request of a Claude Code UserPromptSubmit hook (JSON with prompt), or plain text.
function requestFromInput(input: string): string {
  try {
    const value: unknown = JSON.parse(input);
    const prompt = field(value, 'prompt');
    if (prompt !== undefined) return prompt.trim();
  } catch { /* plain text */ }
  return input.trim();
}

const mark = defineCommand({
  name: 'mark',
  flags: { stdin: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    // A UserPromptSubmit hook adds what it prints to the prompt: with --stdin, only errors are
    // printed (on stderr), and an empty prompt marks nothing.
    const dir = flags.stdin || positionals.length > 1 ? positionals[0] ?? '.' : '.';
    const request = flags.stdin ? requestFromInput(fs.readFileSync(0, 'utf8')) : positionals[positionals.length > 1 ? 1 : 0];
    if (!request && !flags.stdin) { console.error('Usage: elabora mark [dir] "<request>" | elabora mark [dir] --stdin'); return 2; }
    if (!fs.existsSync(path.join(dir, 'course.json'))) throw new edit.EditError(`${path.resolve(dir)} is not an Elabora course (no course.json)`);
    if (!request) return 0;
    edit.appendMark(dir, request);
    if (!flags.stdin) console.log(`✔ The next batch of AI work is labelled "${request}".`);
    return 0;
  })
});

export const historyCommands: CommandGroup = {
  title: 'History (changes made through Elabora tools and by agents; AI work is grouped in batches)',
  help: HELP,
  commands: [history, undo, mark]
};
