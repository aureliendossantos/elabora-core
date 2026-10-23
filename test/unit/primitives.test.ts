import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { readLock, assignKeys, buildStateModel } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { controlsOf, blockControls } from '@elabora/core/components/controls';
import { createCourseState } from '@elabora/player/course-state';
import { decodeState } from '@elabora/player/state-codec';
import { labelKeys, labelLanguages, labelsFor, formatLabel } from '@elabora/player/labels';
import { ROOT, copyExample, readJSON, writeJSON, codes } from '../helpers.ts';

// The primitives of D63 in the core: where their hooks go and what they need, the controls they add
// (names, visits saved with the learner's progress, conditions and events that name them), optional
// blocks, and steps that open once explored.

const FIXTURE = path.join(ROOT, 'test/fixtures/primitives');
const hookErrors = (dir: string) => validateDir(dir).diagnostics.filter((d) => d.code === 'E_COMPONENT_HOOK').map((d) => d.message);
const template = (dir: string, id: string, html: string) => fs.writeFileSync(path.join(dir, `components/${id}/template.html`), html);
function compiled(dir: string) {
  const project = loadProjectFromDir(dir);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  return { project, keys, data: compileCourseData(project, keys, { buildId: 'test' }) };
}

test('primitives: the fixture components validate, one per primitive', () => {
  const diagnostics = validateDir(FIXTURE).diagnostics;
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`), []);
  assert.deepEqual(diagnostics.filter((d) => /^W_COMPONENT/.test(d.code)).map((d) => `${d.code} ${d.message}`), [], 'no words, ids or decoration left in the templates');
});

test('primitives: each hook says where it goes and what it needs', () => {
  const dir = copyExample(FIXTURE);
  const cases: [string, string, RegExp][] = [
    ['step-sequence', '<div data-t-sequence><section data-each="items" data-t-item="{{id}}">{{title}}{{markdown}}</section></div>', /data-t-sequence needs a data-t-prev button, a data-t-next button inside it/],
    ['step-sequence', '<div data-t-sequence><button data-t-prev></button><button data-t-next></button></div><p data-each="items" data-t-item="{{id}}">{{title}}{{markdown}}</p>', /data-t-sequence needs data-t-item elements inside it/],
    ['step-sequence', '<div data-t-sequence><p data-each="items" data-t-item="">{{title}}{{markdown}}</p><button data-t-prev></button><button data-t-next></button></div>', /data-t-item needs a name/],
    ['step-sequence', '<div data-t-sequence><p data-each="items" data-t-item="{{id}}">{{title}}{{markdown}}</p><button data-t-prev></button><div data-t-next></div></div><span data-t-position></span>', /data-t-next goes on <button>, not <div>[\s\S]*|data-t-position goes inside a data-t-sequence/],
    ['step-sequence', '<div data-t-sequence><p data-t-item="one">{{items}}</p><button data-t-prev></button><button data-t-next></button><button data-t-goto="two"></button></div>', /data-t-goto="two" names no data-t-item \(items: one\)/],
    ['flip-cards', '<ul><li data-each="cards"><div data-t-card="{{id}}"><div data-t-face="front">{{title}}</div><div data-t-face="side">{{markdown}}</div></div><button data-t-flip="{{id}}"></button></li></ul>', /data-t-card needs a data-t-face="back" inside it/],
    ['flip-cards', '<ul><li data-each="cards"><div data-t-card="{{id}}"><div data-t-face="front">{{title}}</div><div data-t-face="back">{{markdown}}</div></div><button data-t-flip="other"></button></li></ul>', /data-t-card="\{\{id\}\}" has no data-t-flip="\{\{id\}\}" button/],
    ['zoom-images', '<ul><li data-each="images"><button data-t-zoom>{{alt}}</button><p data-t-caption>{{caption}}</p><img src="{{asset}}" alt="{{alt}}"></li></ul>', /data-t-zoom goes on a button that holds the <img> it enlarges/],
    ['term-popovers', '<div data-t-exclusive="menu"><div data-each="terms"><button data-t-toggle="{{id}}">{{label}}</button><div data-t-part="{{id}}">{{markdown}}</div></div></div>', /data-t-exclusive is empty or "popover", not "menu"/],
    ['detail-list', '<div><div data-each="items" data-t-details="{{id}}">{{title}}{{markdown}}</div></div>', /data-t-details goes on <details>, not <div>/],
    ['timeline-events', '<ol><li data-each="events" data-t-reveal="Matin">{{date}}{{title}}{{markdown}}</li></ol>', /data-t-reveal="Matin": a name is lowercase letters/]
  ];
  for (const [id, html, expected] of cases) {
    const original = fs.readFileSync(path.join(FIXTURE, `components/${id}/template.html`), 'utf8');
    template(dir, id, html);
    const found = hookErrors(dir);
    assert.ok(found.some((message) => expected.test(message)), `${id}: ${expected} in ${JSON.stringify(found)}`);
    template(dir, id, original);
  }
  assert.deepEqual(hookErrors(dir), []);
});

test('primitives: names bound to props are checked on each instance', () => {
  const dir = copyExample(FIXTURE);
  // Without the pattern of the props, the name rendered from an item id is checked as a control name.
  const manifest = readJSON(dir, 'components/flip-cards/component.json');
  delete manifest.props.properties.cards.items.properties.id.pattern;
  writeJSON(dir, 'components/flip-cards/component.json', manifest);
  const screen = readJSON(dir, 'screens/sequence.json');
  screen.blocks[2].props.cards[0].id = 'Cold Front';
  writeJSON(dir, 'screens/sequence.json', screen);
  assert.ok(hookErrors(dir).some((message) => /flip-cards "fronts-cards" renders data-t-flip="Cold Front"/.test(message)), JSON.stringify(hookErrors(dir)));
});

test('primitives: items, cards, details and reveals are controls, with keys and visits', () => {
  // Items count inside a sequence only: charts mark their items with data-t-item too.
  assert.deepEqual([...controlsOf('<div data-t-item="a"></div><div data-t-sequence><p data-t-item="b"></p><button data-t-next></button></div><div data-t-card="c"><button data-t-flip="c"></button></div><details data-t-details="d"></details><li data-t-reveal="e"></li>')],
    [['b', 'item'], ['c', 'flip'], ['d', 'details'], ['e', 'reveal']]);
  const { project, keys, data } = compiled(FIXTURE);
  const block = (id: string) => data.screens.flatMap((screen) => screen.blocks).find((candidate) => candidate.id === id);
  const visits = (id: string) => Object.keys(block(id)?.visits ?? {});
  assert.deepEqual(visits('marks'), ['isobars', 'fronts', 'pressure', 'wind']);
  assert.deepEqual(visits('fronts-cards'), ['cold', 'warm']);
  assert.deepEqual(visits('explore-more'), ['units']);
  assert.deepEqual(visits('day'), ['e0600', 'e0700', 'e0900', 'e1200', 'e1500']);
  assert.deepEqual(visits('drawings'), [], 'a zoom button is not a control');
  assert.deepEqual(visits('terms'), ['low', 'high', 'ridge'], 'exclusive parts stay disclosures');
  assert.ok(keys['visit:marks#fronts'] && keys['visit:fronts-cards#warm'] && keys['visit:day#e1200']);
  // Each counts in the suspend data budget, like any control.
  assert.ok(buildStateModel(project, keys).controls.includes(keys['visit:fronts-cards#warm']));
  // Saved with the learner's progress and read by conditions.
  const state = createCourseState(data);
  state.visitControl('fronts-cards', 'cold');
  assert.equal(state.blockVisited('fronts-cards'), false);
  state.visitControl('fronts-cards', 'warm');
  const again = createCourseState(data, { suspendData: state.encode() });
  assert.ok(again.blockVisited('fronts-cards') && again.controlVisited('fronts-cards', 'warm'));
  assert.equal(decodeState(state.encode()).visits.size, 2);
  // The optional block is marked as such in the course data.
  assert.equal(block('explore-more')?.optional, true);
  assert.equal(block('explore-marks')?.optional, undefined);
});

test('primitives: events and visited conditions name the primitives\' controls', () => {
  const dir = copyExample(FIXTURE);
  const screen = readJSON(dir, 'screens/sequence.json');
  screen.events = [
    { id: 'fronts-seen', on: { type: 'click', target: 'marks', name: 'fronts' }, do: [{ type: 'complete-screen' }] },
    { id: 'cards-turned', on: { type: 'click', target: 'fronts-cards' }, if: [{ visited: 'fronts-cards', name: 'warm' }], do: [{ type: 'complete-screen' }] }
  ];
  writeJSON(dir, 'screens/sequence.json', screen);
  assert.deepEqual(validateDir(dir).diagnostics.filter((d) => d.severity === 'error').map((d) => d.message), []);
  screen.events[0].on.name = 'clouds';
  screen.events[1].if = [{ visited: 'fronts-cards', name: 'hot' }];
  writeJSON(dir, 'screens/sequence.json', screen);
  const diagnostics = validateDir(dir).diagnostics;
  assert.match(diagnostics.find((d) => d.code === 'E_EVENT_TARGET')?.message ?? '', /step-sequence "marks" has no control named "clouds" \(controls: isobars, fronts, pressure, wind\)/);
  assert.match(diagnostics.find((d) => d.code === 'E_VISITED_TARGET')?.message ?? '', /flip-cards "fronts-cards" has no control named "hot" \(controls: cold, warm\)/);
  const project = loadProjectFromDir(dir);
  assert.deepEqual([...blockControls(project, screen.blocks[1]).values()], ['item', 'item', 'item', 'item']);
});

test('primitives: a step that opens once explored needs something to explore above it', () => {
  const dir = copyExample(FIXTURE);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('W_STEP_SETTING_UNUSED'));
  const screen = readJSON(dir, 'screens/explore.json');
  // Only text and an optional block above: nothing locks the Continue.
  screen.blocks = screen.blocks.filter((block: { id: string }) => ['explore-intro', 'explore-more', 'explore-done'].includes(block.id));
  screen.completeWhen = 'viewed';
  writeJSON(dir, 'screens/explore.json', screen);
  const unused = validateDir(dir).diagnostics.filter((d) => d.code === 'W_STEP_SETTING_UNUSED');
  assert.equal(unused.length, 1);
  assert.match(unused[0].message, /Step 2 of "explore" waits until the blocks above it are explored, but they hold no activity and no control/);
  assert.equal(unused[0].path, '/steps/2/opens');
});

test('primitives: interactions-done leaves optional blocks aside', () => {
  const dir = copyExample(FIXTURE);
  const screen = readJSON(dir, 'screens/explore.json');
  // A second question, optional: the screen completes once the first one is answered.
  screen.blocks.splice(5, 0, { id: 'explore-extra', type: 'quiz', optional: true, props: { stem: 'And a ridge?', mode: 'single', objective: 'OBJ-1', options: [
    { id: 'a', text: 'High pressure', correct: true }, { id: 'b', text: 'Low pressure', correct: false }, { id: 'c', text: 'A front', correct: false }] } });
  writeJSON(dir, 'screens/explore.json', screen);
  const { data } = compiled(dir);
  const state = createCourseState(data);
  const explore = data.screens.find((candidate) => candidate.id === 'explore')!;
  state.refreshScreenCompletion(explore);
  assert.equal(state.screenComplete(explore), false);
  state.answerQuiz('explore-check', ['a']);
  state.refreshScreenCompletion(explore);
  assert.equal(state.screenComplete(explore), true, 'the optional question is not waited for');
});

test('primitives: their labels exist in every language the player ships', () => {
  // Every language gives every label (the type of the labels checks it); each formats its values.
  const keys = ['position', 'itemOf', 'carousel', 'slide', 'previousItem', 'nextItem', 'flipCard', 'showFront', 'enlargeImage', 'previousImage', 'nextImage', 'leftToAnswer', 'leftToExplore', 'leftCards'];
  for (const key of keys) assert.ok(labelKeys().includes(key), key);
  for (const language of labelLanguages()) {
    const labels = labelsFor(language);
    assert.equal(formatLabel(labels.position, { n: 2, count: 5 }, language), '2 / 5', language);
    for (const key of ['itemOf', 'leftToAnswer', 'leftToExplore', 'leftCards']) {
      for (const n of [1, 3]) assert.match(formatLabel(labels[key] ?? '', { n, count: 5 }, language), new RegExp(`^[^{}#]*${n}[^{}#]*$`), `${language}.${key}`);
    }
  }
  assert.equal(formatLabel(labelsFor('en').leftCards, { n: 1 }), '1 card left to turn over.');
  assert.equal(formatLabel(labelsFor('fr').leftToExplore, { n: 3 }, 'fr'), 'Il reste 3 éléments à explorer.');
});
