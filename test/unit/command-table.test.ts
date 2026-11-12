import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { MULTIPLE_OF_PRECISION } from '@elabora/format';
import { COMMAND_NAMES, NAMED_COMMANDS, namedCommand } from '@elabora/core/commands/table';
import { commandContext, executeCommand } from '@elabora/core/commands/index';
import { setPlanVoiceover } from '@elabora/core/commands/plan';
import { translationTable } from '@elabora/core/i18n/translate';
import type { ProjectFiles } from '@elabora/core/project/files';
import type { Files } from '@elabora/core/ops/types';
import { readProjectFiles } from '@elabora/node/project-reader';
import { ROOT } from '../helpers.ts';

// The commands by name (D84): the core's table, which a project's room and the tools of the cloud
// derive from. Each schema says what a tool may send; run on a course, the command takes it.

// The commands that need nothing but the project's files, as the room runs them today.
const ROOM = [
  'create_screen', 'update_screen', 'delete_screen', 'move_screen', 'duplicate_screen',
  'add_block', 'update_block', 'remove_block', 'move_block', 'place_block', 'arrange_screen', 'duplicate_block', 'detach_block', 'convert_block', 'rename',
  'upsert_layer', 'remove_layer', 'upsert_event', 'remove_event', 'upsert_variable', 'rename_variable', 'remove_variable',
  'update_course', 'ignore_findings', 'update_player', 'replace_text', 'export_translation', 'translate_text', 'approve_translation',
  'write_plan', 'set_plan_text', 'revert_plan_change', 'create_plan_version', 'approve_plan', 'set_plan_note',
  'update_narration', 'add_narration_line', 'update_narration_line', 'move_narration_line', 'remove_narration_line', 'remove_speaker',
  'narration_from_plan', 'split_step', 'set_continuity', 'set_block_timing', 'set_dialogue_node', 'remove_dialogue_node'
];

const ajv = new Ajv2020({ allErrors: true, strict: false, multipleOfPrecision: MULTIPLE_OF_PRECISION });
const PERSON = { kind: 'human' as const, name: 'Ada' };

test('the table has the commands a room runs, no more, each with a schema that compiles', () => {
  assert.deepEqual([...COMMAND_NAMES].sort(), [...ROOM].sort());
  for (const name of COMMAND_NAMES) {
    const entry = namedCommand(name);
    assert.ok(entry && entry.description.length > 20, name);
    assert.equal(entry.args.type, 'object', name);
    assert.equal(entry.args.additionalProperties, false, name);
    for (const required of entry.args.required) assert.ok(Object.hasOwn(entry.args.properties, required), `${name}: ${required}`);
    assert.doesNotThrow(() => ajv.compile(entry.args), name);
  }
  // Only the table's own names: nothing inherited, nothing that is not a command.
  for (const name of ['toString', 'constructor', '__proto__', 'add_font', 'write_object_file', '']) assert.equal(namedCommand(name), null, name);
  assert.deepEqual(COMMAND_NAMES.filter((name) => namedCommand(name)?.personOnly), ['create_plan_version', 'approve_plan']);
  assert.ok(namedCommand('remove_narration_line')?.destructive && !namedCommand('add_narration_line')?.destructive);
});

test('each command takes what its schema allows: a course edited through the table, nulls included', () => {
  let files: Files = readProjectFiles(path.join(ROOT, 'examples/canal-locks')).files;
  const run = (name: string, args: Record<string, unknown>) => {
    const entry = namedCommand(name);
    assert.ok(entry, name);
    const validate = ajv.compile(entry.args);
    assert.ok(validate(args), `${name} ${JSON.stringify(args)}: ${ajv.errorsText(validate.errors)}`);
    const executed = executeCommand(files as ProjectFiles, name, (context) => entry.run(context, args), { author: PERSON, now: new Date('2026-11-12T08:00:00Z') });
    files = executed.after;
    return executed;
  };
  const json = <T>(rel: string): T => JSON.parse((files.get(rel) as { text: string }).text) as T;
  const refused = (name: string, args: Record<string, unknown>) => assert.equal(ajv.validate(NAMED_COMMANDS[name as keyof typeof NAMED_COMMANDS].args, args), false, `${name} ${JSON.stringify(args)}`);

  // The narration, line by line.
  run('add_narration_line', { screen: 'intro', line: { id: 'l1', text: 'Welcome to the canal.', speaker: 'nell' } });
  run('add_narration_line', { screen: 'intro', line: { id: 'l2', text: 'The keeper waits at the gates.' }, after: 'l1' });
  run('add_narration_line', { screen: 'intro', line: { id: 'l0', text: 'Listen.' }, after: null });
  run('update_narration_line', { screen: 'intro', line: 'l2', text: 'The lock keeper waits at the gates.', speaker: null, pauseBefore: null, step: null });
  run('move_narration_line', { screen: 'intro', line: 'l0', after: 'l1' });
  run('update_narration', { screen: 'intro', advance: 'auto', seek: null });
  run('split_step', { screen: 'intro', line: 'l2' });
  run('set_block_timing', { block: 'intro-text', in: { at: { line: 'l1', word: 'canal' }, effect: 'fade' }, out: null });
  run('remove_narration_line', { screen: 'intro', line: 'l0' });
  refused('update_narration_line', { screen: 'intro', line: 'l1', step: 0 });
  refused('move_narration_line', { screen: 'intro', line: 'l1' });

  // Placed by hand, then back in the flow.
  run('place_block', { block: 'intro-text', place: { x: 0.1, y: 0.1, width: 0.5 }, slot: null, after: null });
  run('place_block', { block: 'intro-text', place: null });
  refused('place_block', { block: 'intro-text' });

  // The player and the findings.
  run('update_player', { disable: ['credits'], options: { outline: { label: null }, controls: { speeds: null } } });
  run('ignore_findings', { findings: [{ code: 'W_TEXT_DENSE', key: 'intro-text' }] });
  refused('ignore_findings', { findings: [{ code: 'E_SCHEMA', key: 'x' }] });

  // Translations: a language started, a text translated, a translated plan approved by a person.
  run('export_translation', { to: 'de' });
  const unit = translationTable(commandContext(files as ProjectFiles).project(), 'de').rows[0]!.id;
  run('translate_text', { language: 'de', unit, target: 'Schleusen', state: 'translated' });
  run('translate_text', { language: 'de', texts: [{ unit, target: null }] });
  refused('translate_text', { language: 'de', texts: [] });

  // The plan: a validated text reworded, a note on it, the change undone, a version made and validated.
  run('set_plan_text', { text: 'TXT-2', markdown: 'The water finds its level, and the barge goes down with it.' });
  run('set_plan_note', { target: 'text:TXT-2', text: 'Shorter.' });
  run('set_plan_note', { target: 'text:TXT-2', text: null });
  run('revert_plan_change', { key: 'text:TXT-2', version: 1 });
  run('set_plan_text', { text: 'TXT-2', markdown: 'The water finds its level.' });
  run('create_plan_version', { note: 'Shorter texts.', date: '2026-11-12' });
  run('approve_plan', { version: 'V2', by: 'Client, Canal Trust', reference: 'mail of 12 Nov.', date: '2026-11-12' });

  // A screen's script from its plan item's voice-over.
  const item = json<{ covers: string[] }>('screens/lock-lab.json').covers[0]!;
  files = executeCommand(files as ProjectFiles, 'set_plan_voiceover', (context) => setPlanVoiceover(context, { item, lines: [{ text: 'Fill the chamber, then open the gate.' }] }), { author: PERSON }).after;
  run('narration_from_plan', { screen: 'lock-lab', replace: true });

  // A dialogue's node written whole, then another removed; the speaker leaves.
  const talk = (json<{ blocks: unknown }>('screens/downhill.json').blocks as { id: string; props: { nodes: { id: string }[] } }[]).find((block) => block.id === 'downhill-talk')!;
  run('set_dialogue_node', { block: 'downhill-talk', node: { ...talk.props.nodes[1]!, title: 'Level water' }, first: true });
  run('remove_dialogue_node', { block: 'downhill-talk', node: 'farewell' });
  run('remove_speaker', { speaker: 'nell' });
  refused('remove_speaker', { speaker: 'nell', lines: 'none' });
});
