import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLessonMd, lessonToScreen } from '@elabora/core/interop/lesson-md';
import { exportLessonMd } from '@elabora/node/lesson-md';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { validateSchema } from '@elabora/format/schemas';
import { EXAMPLE, copyExample, readJSON, writeJSON } from '../helpers.ts';

const SAMPLE = `---
title: Fire Safety Basics
---

::: text
## What to do in a fire emergency

Every second counts.
:::

::: knowledge-check
type: multiple-choice
question: What should you do first in a fire?
maxAttempts: 3
correct-feedback: Staying calm helps you make better decisions.

- [ ] Run to the nearest exit
- [x] Stay calm and assess the situation
:::
`;

test('LESSON.md blocks are parsed with their properties', () => {
  const { title, blocks } = parseLessonMd(SAMPLE);
  assert.equal(title, 'Fire Safety Basics');
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'knowledge-check']);
  assert.equal(blocks[1].props.maxattempts, '3');
});

test('a LESSON.md lesson becomes a schema-valid Elabora screen', () => {
  const r = lessonToScreen(SAMPLE, { id: 'fire', covers: ['ITEM-1'], title: undefined });
  assert.deepEqual(validateSchema('screen', r.screen), []);
  const quiz = r.screen.blocks.find((b) => b.type === 'quiz');
  // Props are what the format says of any block: the options of a quiz, as the importer writes them.
  const options = quiz?.props.options as { correct?: boolean; feedback?: string }[] | undefined;
  assert.equal(options?.[1].correct, true);
  assert.equal(options?.[1].feedback, 'Staying calm helps you make better decisions.');
  assert.match(String(r.screen.blocks[0].props.markdown), /^### What to do/);
});

test('export writes one lesson per screen and a loss report', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-lmd-'));
  const r = exportLessonMd(loadProjectFromDir(EXAMPLE), out);
  assert.equal(r.files.length, 7);
  const evaluation = fs.readFileSync(path.join(out, '05-evaluation.md'), 'utf8');
  assert.match(evaluation, /::: knowledge-check\ntype: multiple-choice/);
  assert.ok(r.losses.some((l) => /free object/.test(l.loss)));
  const back = lessonToScreen(evaluation, { id: 'evaluation-bis', covers: ['ITEM-5'], title: undefined });
  assert.equal(back.screen.blocks.filter((b) => b.type === 'quiz').length, 2);
});

test('LESSON.md multiple-select export and import preserve multiple correct answers', (t) => {
  const dir = copyExample();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = [
    { id: 'a', text: 'Safety goggles', correct: true },
    { id: 'b', text: 'Laptop', correct: false },
    { id: 'c', text: 'Hard hat', correct: true }
  ];
  const screen = readJSON(dir, 'screens/evaluation.json');
  screen.blocks = [{
    id: 'ppe', type: 'quiz', props: {
      stem: 'Which items are protective equipment?', mode: 'multiple', options, attempts: 2
    }
  }];
  writeJSON(dir, 'screens/evaluation.json', screen);

  const out = path.join(dir, 'dist', 'lesson-md');
  exportLessonMd(loadProjectFromDir(dir), out);
  const lesson = fs.readFileSync(path.join(out, '05-evaluation.md'), 'utf8');
  assert.match(lesson, /::: knowledge-check\ntype: multiple-select\n/);
  assert.match(lesson, /- \[x\] Safety goggles\n- \[ \] Laptop\n- \[x\] Hard hat\n/);

  const back = lessonToScreen(lesson, { id: 'ppe-imported', covers: ['ITEM-5'] });
  assert.deepEqual(validateSchema('screen', back.screen), []);
  assert.equal(back.screen.blocks.length, 1);
  const quiz = back.screen.blocks[0];
  assert.equal(quiz.type, 'quiz');
  assert.equal(quiz.props.mode, 'multiple');
  const importedOptions = quiz.props.options as typeof options;
  assert.deepEqual(importedOptions.map(({ id, text, correct }) => ({ id, text, correct })), options);
});
