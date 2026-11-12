import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT, copyExample } from '../helpers.ts';
import { readProjectFiles } from '@elabora/node/project-reader';
import { executeCommand } from '@elabora/core/commands/execute';
import { namedCommand } from '@elabora/core/commands/table';
import { CommandError } from '@elabora/core/commands/context';
import type { ProjectFiles } from '@elabora/core/project/files';

// A field or an entry of a list changed by its path (D89): set, on update_block, update_screen and
// update_course, writes that one place and nothing else; a value given whole says what it took away.

const phishing = readProjectFiles(copyExample(path.join(ROOT, 'examples/phishing-by-numbers'))).files;
const coffee = readProjectFiles(copyExample(path.join(ROOT, 'examples/coffee-in-brief'))).files;
const run = (files: ProjectFiles, name: string, args: unknown) => executeCommand(files, name, (context) => namedCommand(name)!.run(context, args));
const json = (files: ProjectFiles, file: string) => JSON.parse((files.get(file) as { text: string }).text);
const blockOf = (files: ProjectFiles, file: string, id: string) => json(files, file).blocks.find((block: { id: string }) => block.id === id);
const removedBy = (result: unknown) => (result as { removed?: string[] }).removed;

test('one answer of a quiz changed by its path: one operation there, the other answers kept', () => {
  const { ops, result } = run(phishing, 'update_block', { block: 'clicked-quiz', set: [{ path: 'props.options[change].text', value: 'Change your password, then wait' }] });
  assert.deepEqual(ops, [{ op: 'set', file: 'screens/clicked.json', path: ['blocks', { id: 'clicked-quiz' }, 'props', 'options', { id: 'change' }, 'text'], value: 'Change your password, then wait' }]);
  assert.equal(removedBy(result), undefined);
});

// Each list the agents named, changed by its path and given whole with the same entry changed: the
// same files.
const same = (files: ProjectFiles, name: string, byPath: unknown, whole: unknown) => {
  const a = run(files, name, byPath).after;
  const b = run(files, name, whole).after;
  for (const file of new Set([...a.keys(), ...b.keys()])) assert.deepEqual(a.get(file), b.get(file), file);
};
const edited = <T>(value: T, change: (copy: T) => void): T => { const copy = structuredClone(value); change(copy); return copy; };

test('by path or given whole, the same files: answers, a sort\'s items, a chart\'s anchors, a dialogue\'s nodes, a screen\'s narration, the course\'s navigation', () => {
  const quiz = blockOf(phishing, 'screens/clicked.json', 'clicked-quiz').props;
  same(phishing, 'update_block', { block: 'clicked-quiz', set: [{ path: 'props.options[change].correct', value: true }] }, { block: 'clicked-quiz', props: { options: edited(quiz.options, (options) => { options[1].correct = true; }) } });
  // A new answer joins at the end; null removes one.
  const added = { text: 'Close the browser', correct: false, feedback: 'Not enough.' };
  same(phishing, 'update_block', { block: 'clicked-quiz', set: [{ path: 'props.options[close]', value: added }] }, { block: 'clicked-quiz', props: { options: [...quiz.options, { id: 'close', ...added }] } });
  same(phishing, 'update_block', { block: 'clicked-quiz', set: [{ path: 'props.options[report]', value: null }] }, { block: 'clicked-quiz', props: { options: quiz.options.filter((option: { id: string }) => option.id !== 'report') } });
  const sort = blockOf(coffee, 'screens/picking-and-processing.json', 'picking-sort').props;
  same(coffee, 'update_block', { block: 'picking-sort', set: [{ path: 'props.items[tanks].target', value: 'natural' }] }, { block: 'picking-sort', props: { items: edited(sort.items, (items) => { items[1].target = 'natural'; }) } });
  const bars = blockOf(phishing, 'screens/origins.json', 'origins-bars').props;
  same(phishing, 'update_block', { block: 'origins-bars', set: [{ path: 'props.rows[usb].at.word', value: 'sticks' }] }, { block: 'origins-bars', props: { rows: edited(bars.rows, (rows) => { rows[3].at.word = 'sticks'; }) } });
  const dialogue = blockOf(phishing, 'screens/practice.json', 'bank-call').props;
  same(phishing, 'update_block', { block: 'bank-call', set: [{ path: 'props.nodes[pressure].options[b].text', value: 'I will call back.' }] }, { block: 'bank-call', props: { nodes: edited(dialogue.nodes, (nodes) => { nodes[1].options[1].text = 'I will call back.'; }) } });
  const narration = json(phishing, 'screens/origins.json').narration;
  same(phishing, 'update_screen', { id: 'origins', set: [{ path: 'narration.lines[l2].text', value: 'Far behind: fake websites, phone calls and USB sticks.' }] }, { id: 'origins', narration: edited(narration, (value) => { value.lines[1].text = 'Far behind: fake websites, phone calls and USB sticks.'; }) });
  same(phishing, 'update_course', { set: [{ path: 'navigation.lockUntilComplete', value: false }] }, { navigation: { mode: 'linear', lockUntilComplete: false } });
});

test('a value given whole says what it took away; one given by path, or a command made to remove, does not', () => {
  const quiz = blockOf(phishing, 'screens/clicked.json', 'clicked-quiz').props;
  const two = run(phishing, 'update_block', { block: 'clicked-quiz', props: { options: quiz.options.slice(0, 2) } });
  assert.deepEqual(removedBy(two.result), ['screens/clicked.json blocks[clicked-quiz].props.options[report]']);
  const free = run(phishing, 'update_course', { navigation: { mode: 'free' } });
  assert.deepEqual(removedBy(free.result), ['course.json navigation.lockUntilComplete']);
  // Keys given in another order are not taken away.
  const reordered = Object.fromEntries(Object.entries(quiz).reverse());
  assert.equal(removedBy(run(phishing, 'update_block', { block: 'clicked-quiz', props: reordered }).result), undefined);
  assert.equal(removedBy(run(coffee, 'remove_block', { block: 'picking-gallery' }).result), undefined);
});

test('set refuses an id, a field its command does not change, an entry the list does not have and a list without ids, and says why', () => {
  const refused = (name: string, args: unknown, message: RegExp) => assert.throws(() => run(phishing, name, args), (error: unknown) => error instanceof CommandError && message.test(error.message));
  refused('update_block', { block: 'clicked-quiz', set: [{ path: 'props.options[change].id', value: 'other' }] }, /ids are permanent.*rename/);
  refused('update_block', { block: 'clicked-quiz', set: [{ path: 'type', value: 'text' }] }, /"type".*props/);
  refused('update_block', { block: 'clicked-quiz', set: [{ path: 'props.options[nope].text', value: 'x' }] }, /no entry "nope".*call, change, report/);
  refused('update_block', { block: 'clicked-quiz', set: [{ path: 'props.tags', value: [1, 2] }, { path: 'props.tags[x]', value: null }] }, /props\.tags.*without ids/);
  refused('update_block', { block: 'clicked-quiz', set: [{ path: 'props..stem', value: 'x' }] }, /not a path/);
  refused('update_screen', { id: 'origins', set: [{ path: 'blocks[origins-bars].props.max', value: 50 }] }, /"blocks"/);
  refused('update_course', { set: [{ path: 'sections[threat]', value: null }] }, /sections/);
  refused('update_course', { set: [{ path: 'sections[threat].screens', value: [] }] }, /sections/);
});
