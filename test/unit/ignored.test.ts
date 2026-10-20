import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { copyExample, readJSON, writeJSON } from '../helpers.ts';

// Warnings on the author's own words that a check may misjudge carry a key (D31): the author ignores
// one, and it comes back when what it found changes.
test('content heuristics may be ignored by the author, each until the text it read changes', () => {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push(
    { id: 'accueil-maxime', type: 'quiz', props: { stem: 'Nietzsche écrit : « Ce qui ne me tue pas me rend plus fort. » Que veut-il dire ?', mode: 'single', options: [
      { id: 'a', text: 'La souffrance peut devenir une force', correct: true, feedback: 'Oui.' },
      { id: 'b', text: 'Toutes ces réponses', correct: false, feedback: 'Non.' }
    ] } },
    { id: 'accueil-schema', type: 'image', props: { asset: 'images/chemin-impression.svg', alt: 'image', decorative: false } }
  );
  writeJSON(dir, 'screens/accueil.json', screen);
  const keyed = () => validateDir(dir).diagnostics.filter((d) => (d.target === 'accueil-maxime' || d.target === 'accueil-schema') && d.code !== 'W_ASSET_SVG_TEXT');
  const found = keyed();
  assert.deepEqual(found.map((d) => d.code).sort(), ['W_IMAGE_ALT_SUSPECT', 'W_QUIZ_ALL_NONE', 'W_QUIZ_NEGATION', 'W_QUIZ_OPTION_COUNT']);
  for (const d of found) assert.match(d.key ?? '', /^accueil-(maxime|schema)\/.+@[0-9a-f]+$/, d.code);
  const negation = found.find((d) => d.code === 'W_QUIZ_NEGATION')!;
  assert.match(negation.key!, /^accueil-maxime\/stem@[0-9a-f]{12}$/);
  edit.ignoreFindings(dir, { findings: found.map((d) => ({ code: d.code, key: d.key! })) });
  assert.deepEqual(keyed().map((d) => d.ignored), [true, true, true, true]);
  assert.equal(validateDir(dir).summary.ignored, 4);
  // The stem rewritten: its negation is a new finding; the other choices hold.
  const edited = readJSON(dir, 'screens/accueil.json');
  edited.blocks.at(-2).props.stem = 'Que veut dire Nietzsche quand il écrit : « Ce qui ne me tue pas me rend plus fort » ?';
  edited.blocks.at(-2).props.options.push({ id: 'c', text: 'Que la maladie rend toujours plus fort', correct: false, feedback: 'Non.' });
  writeJSON(dir, 'screens/accueil.json', edited);
  assert.deepEqual(keyed().filter((d) => !d.ignored).map((d) => d.code).sort(), ['W_QUIZ_NEGATION'], 'the option count changed too: 3 options is no finding');
});

test('a neuromyth named to be refuted is ignored in its block only, and moving the block keeps the choice', () => {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/accueil.json');
  screen.blocks.push(
    { id: 'accueil-mythe', type: 'text', props: { markdown: 'Les « styles d’apprentissage » ? Les études ne les confirment pas.' } },
    { id: 'accueil-autre', type: 'text', props: { markdown: 'Adaptez le module au cerveau droit de chacun.' } }
  );
  writeJSON(dir, 'screens/accueil.json', screen);
  const myths = () => validateDir(dir).diagnostics.filter((d) => d.code === 'W_NEUROMYTH' && d.file === 'screens/accueil.json');
  assert.deepEqual(myths().map((d) => [d.target, d.ignored ?? false]), [['accueil-mythe', false], ['accueil-autre', false]]);
  const refuted = myths().find((d) => d.target === 'accueil-mythe')!;
  edit.ignoreFindings(dir, { findings: [{ code: refuted.code, key: refuted.key! }] });
  assert.deepEqual(myths().map((d) => [d.target, d.ignored ?? false]), [['accueil-mythe', true], ['accueil-autre', false]]);
  // Moved before the others: the same key.
  const moved = readJSON(dir, 'screens/accueil.json');
  moved.blocks.unshift(moved.blocks.splice(moved.blocks.findIndex((block: { id: string }) => block.id === 'accueil-mythe'), 1)[0]);
  writeJSON(dir, 'screens/accueil.json', moved);
  assert.equal(myths().find((d) => d.target === 'accueil-mythe')?.ignored, true);
});
