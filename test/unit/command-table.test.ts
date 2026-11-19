import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { MULTIPLE_OF_PRECISION } from '@elabora/format';
import { COMMAND_NAMES, NAMED_COMMANDS, namedCommand } from '@elabora/core/commands/table';
import { commandContext, executeCommand, OBJECT_FILES } from '@elabora/core/commands/index';
import { textFile } from '@elabora/core/project/files';
import { newCourseFiles } from '@elabora/core/commands/new-course';
import { loadProject } from '@elabora/core/project/load';
import { validateProject } from '@elabora/core/validate/index';
import { applyOps } from '@elabora/core/ops/apply';
import { translationTable } from '@elabora/core/i18n/translate';
import type { ProjectFiles } from '@elabora/core/project/files';
import type { Files } from '@elabora/core/ops/types';
import { readProjectFiles } from '@elabora/node/project-reader';
import { PROVIDERS } from '@elabora/node/edit/host';
import { NEED_SERVICES } from '@elabora/engine/base/services';
import { ROOT } from '../helpers.ts';

// The commands by name (D84, D110): the core's table, which the engines, a project's room and the
// tools of the cloud derive from. Each schema says what a tool may send; run on a course, the
// command takes it. A command that needs its host says so, and runs on what its host gives.

const ajv = new Ajv2020({ allErrors: true, strict: false, multipleOfPrecision: MULTIPLE_OF_PRECISION });
const PERSON = { kind: 'human' as const, name: 'Ada' };

test('each command of the table has a schema that compiles, and says what it needs', () => {
  for (const name of COMMAND_NAMES) {
    const entry = namedCommand(name);
    assert.ok(entry && entry.description.length > 20, name);
    assert.equal(entry.args.type, 'object', name);
    assert.equal(entry.args.additionalProperties, false, name);
    for (const required of entry.args.required) assert.ok(Object.hasOwn(entry.args.properties, required), `${name}: ${required}`);
    assert.doesNotThrow(() => ajv.compile(entry.args), name);
  }
  // Only the table's own names: nothing inherited, nothing that is not a command.
  for (const name of ['toString', 'constructor', '__proto__', 'migrate_format', '']) assert.equal(namedCommand(name), null, name);
  assert.deepEqual(COMMAND_NAMES.filter((name) => namedCommand(name)?.personOnly), ['create_plan_version', 'approve_plan']);
  assert.ok(namedCommand('remove_narration_line')?.destructive && !namedCommand('add_narration_line')?.destructive);
  // What reads more than the files says what its host gives it; the rest needs nothing.
  assert.equal(namedCommand('add_font')?.needs, 'font');
  assert.equal(namedCommand('set_narration_audio')?.needs, 'lineAudio');
  assert.equal(namedCommand('write_object_file')?.needs, null);
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
  run('set_plan_voiceover', { item, lines: [{ text: 'Fill the chamber, then open the gate.' }] });
  run('narration_from_plan', { screen: 'lock-lab', replace: true });
  run('record_plan_send', { version: 'V2', format: 'pdf', date: '2026-11-13' });
  refused('record_plan_send', { version: 'V2', format: 'odt' });

  // Design: a stylesheet, a component made, forked and written, the theme put under the components.
  run('write_design_file', { file: 'theme/extra.css', content: '.t-extra { color: red; }\n' });
  run('create_component', { id: 'note-card', title: 'Note card', props: { type: 'object', properties: { text: { type: 'string' } } } });
  run('write_component_file', { component: 'note-card', file: 'component.css', content: '.c-note-card { padding: 1rem; }\n' });
  run('fork_component', { component: 'note-card', id: 'tip-card', title: 'Tip card' });
  run('upgrade_theme', {});
  refused('write_component_file', { component: 'note-card', file: 'notes.txt', content: '' });

  // A dialogue's node written whole, then another removed; the speaker leaves.
  const talk = (json<{ blocks: unknown }>('screens/downhill.json').blocks as { id: string; props: { nodes: { id: string }[] } }[]).find((block) => block.id === 'downhill-talk')!;
  run('set_dialogue_node', { block: 'downhill-talk', node: { ...talk.props.nodes[1]!, title: 'Level water' }, first: true });
  run('remove_dialogue_node', { block: 'downhill-talk', node: 'farewell' });
  run('remove_speaker', { speaker: 'nell' });
  refused('remove_speaker', { speaker: 'nell', lines: 'none' });
});

test('a command that needs its host runs on what the host gives, and the journal records what it wrote', () => {
  const files = readProjectFiles(path.join(ROOT, 'examples/canal-locks')).files as ProjectFiles;
  const ran = (name: string, args: Record<string, unknown>, given: unknown) => {
    const entry = namedCommand(name)!;
    assert.ok(ajv.validate(entry.args, args), `${name} ${JSON.stringify(args)}: ${ajv.errorsText(ajv.errors)}`);
    return { executed: executeCommand(files, name, (context) => entry.run(context, args, given), { author: PERSON }), journaled: entry.journal(args, given) };
  };

  // A free object from the templates its host read.
  const templates = Object.fromEntries(OBJECT_FILES.map((file) => [file, fs.readFileSync(path.join(ROOT, 'packages/node/templates/object', file), 'utf8')]));
  const object = ran('create_object', { id: 'sluice-sim', title: 'Sluice', objectives: ['OBJ-1'] }, { templates });
  assert.deepEqual(object.executed.result, { object: 'sluice-sim', files: OBJECT_FILES.map((file) => `objects/sluice-sim/${file}`) });
  assert.deepEqual(object.journaled, { name: 'create_object', args: { id: 'sluice-sim', title: 'Sluice', objectives: ['OBJ-1'] } });

  // A resource from the file its host read: titled from its name, the journal without its content.
  const resource = ran('add_resource', { path: '/somewhere/lock_keepers v2.csv' }, { name: 'lock_keepers v2.csv', file: textFile('name;lock\nNell;3\n'), pdfTitle: null });
  assert.equal((resource.executed.result as { titleFrom: string }).titleFrom, 'name');
  assert.ok(resource.executed.after.has((resource.executed.result as { path: string }).path));
  assert.deepEqual(resource.journaled, { name: 'add_resource', args: { name: 'lock_keepers v2.csv', title: 'lock keepers v2' } });

  // A library's component is journaled by the library's id, an upgrade as such; a file's content is in the operations.
  assert.deepEqual(namedCommand('add_component')!.journal({ library: '/Volumes/Clients/acme', component: 'card', upgrade: true }, { component: { library: 'acme', component: 'card', files: new Map() }, bytes: new Map() }),
    { name: 'upgrade_component', args: { library: 'acme', component: 'card', as: 'card' } });
  assert.deepEqual(namedCommand('write_object_file')!.journal({ object: 'sluice-sim', file: 'object.js', content: 'export {};' }), { name: 'write_object_file', args: { object: 'sluice-sim', file: 'object.js', bytes: 10 } });
});

test('a change a host journals is a command of the table, and each host gives what the table\'s commands need', () => {
  // A change written by a hand-made run, not by the table: only those the host keeps (D110).
  const HOST_ONLY = ['migrate_format', 'update_agent_rules'];
  const sources = fs.globSync('packages/*/src/**/*.ts', { cwd: ROOT }).map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const journaled = sources.flatMap((source) => [...source.matchAll(/runCommand\([^{]*\{\s*name: '([a-z_]+)'/g)].map((match) => match[1]!));
  assert.deepEqual([...new Set(journaled)].sort(), HOST_ONLY);
  for (const name of COMMAND_NAMES) {
    const needs = namedCommand(name)!.needs;
    if (!needs) continue;
    assert.equal(typeof PROVIDERS[needs], 'function', `${name}: this computer gives ${needs}`);
    assert.ok(NEED_SERVICES[needs], `${name}: the engines know the service of ${needs}`);
  }
});

test('a new module\'s files are the first change of an empty project, and a project with a course is left as it is', () => {
  const args = { id: 'canal-tour', title: 'Le canal « pas à pas »', language: 'fr', brief: { audience: 'Éclusiers', duration: { max: 15 }, notes: 'Ton : direct.' } };
  const entry = namedCommand('create_course')!;
  assert.equal(entry.needs, null);
  assert.ok(ajv.validate(entry.args, args), ajv.errorsText(ajv.errors));
  const made = executeCommand(new Map() as ProjectFiles, 'create_course', (context) => entry.run(context, args), { author: PERSON });
  assert.deepEqual(made.result, { created: true, files: ['course.json', 'plan.json', 'screens/intro.json', 'AGENTS.md', 'CLAUDE.md', '.gitignore'] });
  // The bytes a computer writes for the same course (initProject), and a course with nothing to fix.
  for (const [rel, text] of newCourseFiles(args)) assert.equal((made.after.get(rel) as { text: string }).text, text, rel);
  assert.deepEqual(validateProject(loadProject(made.after as ProjectFiles)).diagnostics.filter((d) => d.severity === 'error'), []);
  // Undone, the project is empty again.
  assert.deepEqual([...applyOps(made.after, made.inverse).keys()], []);
  // Two copies that both make it: the second writes nothing.
  assert.deepEqual(executeCommand(made.after as ProjectFiles, 'create_course', (context) => entry.run(context, args), { author: PERSON }).ops, []);
});
