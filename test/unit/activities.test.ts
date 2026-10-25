import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlanks, normalizeAnswer, blankIsRight, gradeFillIn, blankMaxLength, stableShuffle, MAX_BLANKS } from '@elabora/player/fill-in';
import { gradeSort, sortComplete } from '@elabora/player/sort';
import { fillInInteractions, sortInteraction, reflectionInteraction } from '@elabora/player/activity-interactions';
import { emptyState, encodeState, decodeState, worstCaseLength, worstCaseState } from '@elabora/player/state-codec';
import type { StateModel } from '@elabora/player/state-codec';
import { createCourseState, flatBlocks } from '@elabora/player/course-state';
import type { FillInBlock, ReflectionBlock, SortBlock } from '@elabora/player/course-data';
import { loadProjectFromDir, validateDir } from '@elabora/node/project-reader';
import { readLock, assignKeys, buildStateModel } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { placeBlanks, markBlanks } from '@elabora/core/compile/blanks';
import { getRegistry } from '@elabora/core/components/registry';
import { checkTemplate } from '@elabora/core/validate/components';
import { createReporter } from '@elabora/core/diagnostics/index';
import { projectMarkdown } from '@elabora/core/project/markdown';
import { lessonMdExport } from '@elabora/core/interop/lesson-md';
import { extractUnits, invariants } from '@elabora/core/i18n/units';
import { labelsFor, labelLanguages } from '@elabora/player/labels';
import { copyExample, readJSON, writeJSON, writeFixture, codes } from '../helpers.ts';
import { addActivities } from '../activities-fixture.ts';

// The activities of D63 (fill-in, sort, reflection) and the quiz on pictures: grading, saved state,
// SCORM records, course data, checks, exports and translation.

// ── fill-in ──
test('fill-in blanks: [[answer|other]] read in order, empty answers left out', () => {
  assert.deepEqual(parseBlanks('Le [[routeur|routeur d’accès]] puis le [[ DNS ]], [[a||b]] et [[ ]].'), [{ answers: ['routeur', 'routeur d’accès'] }, { answers: ['DNS'] }, { answers: ['a', 'b'] }, { answers: [] }]);
  assert.deepEqual(parseBlanks('Pas de trou, un [lien](https://example.org) et [[x\ny]].'), []);
  assert.equal(MAX_BLANKS, 12);
  assert.equal(blankMaxLength({ answers: ['DNS'] }), 16);
  assert.equal(blankMaxLength({ answers: ['passerelle par défaut du réseau local'] }), 60);
  // The build: markers, then hooks; punctuation kept with its blank; answers never in the text.
  const html = placeBlanks(`<p>${markBlanks('Le [[routeur]], puis « [[DNS]] ».')}</p><span title="${markBlanks('[[x]]')}"></span>`);
  assert.equal(html, '<p>Le <span class="t-nobr"><span class="t-blank" data-t-blank="1"></span>,</span> puis « <span class="t-blank" data-t-blank="2"></span> ».</p><span title="…"></span>');
});

test('fill-in grading: case, spaces, quotes and apostrophes never count; accents only when asked; partial score per blank', () => {
  assert.equal(normalizeAnswer('  L’Adresse   IP '), "l'adresse ip");
  assert.equal(normalizeAnswer('« Ping »'), normalizeAnswer('"ping"'));
  assert.equal(normalizeAnswer('Quoi ?'), normalizeAnswer('quoi?'));
  assert.ok(blankIsRight({ answers: ["l'adresse IP"] }, 'L’ADRESSE ip'));
  assert.ok(!blankIsRight({ answers: ['élève'] }, 'eleve'), 'accents count by default');
  assert.ok(blankIsRight({ answers: ['élève'] }, 'eleve', { ignoreAccents: true }));
  assert.ok(!blankIsRight({ answers: ['élève'] }, ''), 'an empty answer is never right');
  assert.ok(blankIsRight({ answers: ['routeur', 'routeur d’accès'] }, "Routeur d'accès"));
  const blanks = [{ answers: ['routeur'] }, { answers: ['DNS'] }, { answers: ['câble'] }, { answers: ['ping'] }];
  assert.deepEqual(gradeFillIn(blanks, ['routeur', 'dns', 'cable', '']), { marks: [true, true, false, false], score: 0.5, correct: false });
  assert.deepEqual(gradeFillIn(blanks, ['routeur', 'dns', 'cable', 'Ping'], { ignoreAccents: true }), { marks: [true, true, true, true], score: 1, correct: true });
  assert.deepEqual(gradeFillIn([], []), { marks: [], score: 0, correct: false });
});

test('a stable shuffle: the same order at every build, never the written one', () => {
  const words = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(stableShuffle(words, 'trous-1'), stableShuffle(words, 'trous-1'));
  assert.notDeepEqual(stableShuffle(words, 'trous-1'), words);
  assert.deepEqual([...stableShuffle(words, 'trous-1')].sort(), words);
  for (const seed of ['a', 'b', 'c', 'x', 'classer-ordre']) assert.notDeepEqual(stableShuffle([0, 1], seed), [0, 1], seed);
  assert.deepEqual(stableShuffle(['solo'], 'x'), ['solo']);
});

// ── sort ──
test('sort grading: pairs and categories per item, order per position', () => {
  const pairs = { presentation: 'pairs' as const, items: [{ target: 0 }, { target: 1 }, { target: 2 }] };
  assert.deepEqual(gradeSort(pairs, [0, 2, 1]), { marks: [true, false, false], score: 1 / 3, correct: false });
  assert.deepEqual(gradeSort(pairs, [0, 1, 2]).correct, true);
  assert.ok(!sortComplete(pairs, [0, -1, 2]));
  const categories = { presentation: 'categories' as const, items: [{ target: 0 }, { target: 1 }, { target: 0 }, { target: 1 }] };
  assert.deepEqual(gradeSort(categories, [0, 0, 0, 1]), { marks: [true, false, true, true], score: 0.75, correct: false });
  const order = { presentation: 'order' as const, items: [{ target: -1 }, { target: -1 }, { target: -1 }, { target: -1 }] };
  assert.deepEqual(gradeSort(order, [0, 2, 1, 3]), { marks: [true, false, false, true], score: 0.5, correct: false });
  assert.ok(gradeSort(order, [0, 1, 2, 3]).correct);
  assert.ok(sortComplete(order, [3, 2, 1, 0]));
  assert.ok(!sortComplete(order, [0, 0, 1, 2]), 'an item twice');
});

// ── SCORM 1.2 patterns ──
// RTE 3.4.2.7: choice a single character; matching source.target pairs; sequencing characters in order;
// likert one character; fill-in one line (CMIString255).
const SCORM12 = {
  choice: /^[0-9a-z]$/,
  matching: /^[0-9a-z]\.[0-9a-z](,[0-9a-z]\.[0-9a-z])*$/,
  sequencing: /^[0-9a-z](,[0-9a-z])*$/,
  likert: /^[0-9a-z]?$/,
  'fill-in': /^[^\n\r]{0,255}$/
};
test('SCORM interactions: valid SCORM 1.2 patterns for every activity', () => {
  const blanks = [{ answers: ['routeur'], maxLength: 16 }, { answers: ['DNS'], maxLength: 16 }];
  const typed = fillInInteractions('trous', { presentation: 'typed', blanks, words: [], weight: 1, objective: 'OBJ-1' }, ['Routeur', 'un texte\nsur deux lignes'], [true, false]);
  assert.deepEqual(typed.map((interaction) => [interaction.id, interaction.type, interaction.response, interaction.correctPattern, interaction.result, interaction.weight]), [['trous.1', 'fill-in', 'Routeur', 'routeur', 'correct', 0.5], ['trous.2', 'fill-in', 'un texte sur deux lignes', 'DNS', 'wrong', 0.5]]);
  const menus = fillInInteractions('trous', { presentation: 'menus', blanks, words: ['DNS', 'répéteur', 'routeur'], weight: 2 }, ['routeur', 'répéteur'], [true, false]);
  assert.deepEqual(menus.map((interaction) => [interaction.type, interaction.response, interaction.correctPattern]), [['choice', 'c', 'c'], ['choice', 'b', 'a']]);
  const items = [{ id: 'a', label: 'A', target: 1 }, { id: 'b', label: 'B', target: 0 }, ...Array.from({ length: 10 }, (_, index) => ({ id: `i${index}`, label: 'x', target: index % 2 }))];
  const matching = sortInteraction('classer', { presentation: 'pairs', items, weight: 1 }, items.map((item) => item.target), true);
  assert.equal(matching.type, 'matching');
  assert.match(matching.response, SCORM12.matching);
  assert.equal(matching.correctPattern, matching.response);
  assert.ok(matching.correctPattern!.startsWith('1.b,2.a,3.a'), matching.correctPattern);
  assert.ok(matching.correctPattern!.endsWith('c.b'), 'the twelfth item is c');
  const sequencing = sortInteraction('ordre', { presentation: 'order', items: items.slice(0, 4), weight: 1 }, [1, 0, 3, 2], false);
  assert.deepEqual([sequencing.type, sequencing.response, sequencing.correctPattern, sequencing.result], ['sequencing', 'b,a,d,c', 'a,b,c,d', 'wrong']);
  const text = reflectionInteraction('reflexion', { presentation: 'text' }, `${'é'.repeat(300)}\nfin`);
  const likert = reflectionInteraction('echelle', { presentation: 'scale', objective: 'OBJ-2' }, 4);
  assert.deepEqual([text.type, text.response.length, text.result, likert.type, likert.response, likert.result, likert.objective], ['fill-in', 255, 'neutral', 'likert', '4', 'neutral', 'OBJ-2']);
  for (const interaction of [...typed, ...menus, matching, sequencing, text, likert]) {
    const pattern = SCORM12[interaction.type as keyof typeof SCORM12];
    assert.match(interaction.response, pattern, `${interaction.type} response`);
    if (interaction.correctPattern !== undefined) assert.match(interaction.correctPattern, pattern, `${interaction.type} pattern`);
  }
});

// ── saved state ──
// Pinned: what packages write must decode the same forever (state-golden.test.ts for the older fields).
const GOLDEN = '{"v":1,"s":"0","f":{"7":[2,"routeur","l’adresse \\"IP\\"",""]},"r":{"8":"201|1","9":"-0|0"},"e":{"a":"Ma réponse\\nsur deux lignes","b":4}}';
test('saved state: fill-in answers, sort placements and reflections in v1, pinned, and back', () => {
  const state = emptyState();
  state.visited.add('0');
  state.fillIns['7'] = { answers: ['routeur', 'l’adresse "IP"', ''], attempts: 2 };
  state.sorts['8'] = { placement: [2, 0, 1], attempts: 1 };
  state.sorts['9'] = { placement: [-1, 0], attempts: 0 };
  state.reflections.a = 'Ma réponse\nsur deux lignes';
  state.reflections.b = 4;
  assert.equal(encodeState(state), GOLDEN);
  const back = decodeState(GOLDEN);
  assert.equal(encodeState(back), GOLDEN);
  assert.deepEqual(back.fillIns['7'], state.fillIns['7']);
  assert.deepEqual(back.sorts['9'], { placement: [-1, 0], attempts: 0 });
  assert.equal(back.reflections.b, 4);
  // What does not read as this module wrote it is left out, never thrown.
  const odd = decodeState('{"v":1,"f":{"1":"x","2":[1,3,"a"]},"r":{"3":"z!|x"},"e":{"4":{"no":1},"5":null}}');
  assert.deepEqual(odd.fillIns, { 2: { answers: ['', 'a'], attempts: 1 } });
  assert.deepEqual(odd.sorts['3'], { placement: [35, -1], attempts: 0 });
  assert.deepEqual(odd.reflections, {});
  assert.equal(encodeState(emptyState()), '{"v":1}', 'nothing new in an empty state');
});

test('worst case: typed blanks at their longest, every character escaped; a reflection at its maxLength, as a string variable', () => {
  const base: StateModel = { screens: [], quizzes: [], numerics: [], decisions: [], variables: [], objects: [], toggleableBlocks: [], steppedScreens: [], controls: [] };
  const model: StateModel = { ...base, fillIns: [{ key: 'f', maxAttempts: 3, blanks: [{ maxLength: 16 }, { longest: 'répéteur' }] }], sorts: [{ key: 's', maxAttempts: 2, items: 5 }], reflections: [{ key: 'e', maxLength: 500 }, { key: 'g', scaleMax: 7 }] };
  const worst = worstCaseState(model);
  assert.deepEqual(worst.fillIns.f, { attempts: 3, answers: ['\\'.repeat(16), 'répéteur'] });
  assert.deepEqual(worst.sorts.s, { attempts: 2, placement: [35, 35, 35, 35, 35] });
  assert.equal(worst.reflections.e, '\\'.repeat(500));
  assert.equal(worst.reflections.g, 7);
  // The same reflection as a string variable of the same length costs the same characters.
  const asVariable = worstCaseLength({ ...base, variables: [{ key: 'e', type: 'string', maxLength: 500 }] }) - worstCaseLength(base);
  const asReflection = worstCaseLength({ ...base, reflections: [{ key: 'e', maxLength: 500 }] }) - worstCaseLength(base);
  assert.equal(asReflection, asVariable);
});

// ── the course: data, state, scoring ──
function activityCourse() {
  const dir = copyExample();
  addActivities(dir);
  const project = loadProjectFromDir(dir);
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  return { dir, project, keys, data: compileCourseData(project, keys, { buildId: 'test' }) };
}
const blockIn = <T>(data: ReturnType<typeof activityCourse>['data'], id: string) => data.screens.flatMap((screen) => screen.blocks).find((block) => block.id === id) as T;

test('course data: blanks become hooks and their answers leave the text; words and items in a fixed shuffled order', () => {
  const { data, keys } = activityCourse();
  const typed = blockIn<FillInBlock>(data, 'trous-saisie');
  assert.equal(typed.behavior, 'fill-in');
  assert.equal(typed.key, keys['fillin:trous-saisie']);
  assert.match(typed.html!, /<span class="t-blank" data-t-blank="1"><\/span>/);
  assert.match(typed.html!, /<span class="t-nobr"><span class="t-blank" data-t-blank="2"><\/span>\.<\/span>/);
  assert.doesNotMatch(typed.html!, /routeur|DNS|\[\[/, 'no answer in the text');
  assert.deepEqual(typed.props.blanks, [{ answers: ['routeur', 'routeur d’accès'], maxLength: 30 }, { answers: ['DNS'], maxLength: 16 }]);
  assert.deepEqual(typed.props.words, []);
  const menus = blockIn<FillInBlock>(data, 'trous-listes');
  assert.deepEqual([...menus.props.words].sort(), ['commutateur', 'routeur', 'répéteur']);
  const bank = blockIn<FillInBlock>(data, 'trous-mots');
  assert.equal(bank.props.words.length, 4);
  assert.match(bank.html!, /data-t-bank/);
  assert.deepEqual(compileCourseData(activityCourse().project, keys, { buildId: 'test' }).screens.find((screen) => screen.id === 'activites-trous')!.blocks.map((block) => (block as FillInBlock).props.words), data.screens.find((screen) => screen.id === 'activites-trous')!.blocks.map((block) => (block as FillInBlock).props.words), 'the same at every build');
  const pairs = blockIn<SortBlock>(data, 'classer-paires');
  assert.deepEqual(pairs.props.items.map((item) => item.target), [0, 1, 2]);
  assert.notDeepEqual(pairs.props.shuffled, [0, 1, 2]);
  const order = blockIn<SortBlock>(data, 'classer-ordre');
  assert.deepEqual([order.props.targets, order.props.items.map((item) => item.target)], [[], [-1, -1, -1, -1]]);
  assert.match(order.html!, /data-t-sort-item="voyant"/);
  assert.doesNotMatch(order.html!, /data-t-sort-target/, 'no targets in order');
  const reflection = blockIn<ReflectionBlock>(data, 'reflexion-texte');
  assert.equal(reflection.props.maxLength, 400);
  assert.match(reflection.props.modelHtml, /voyant de la carte/);
  const zones = data.screens.find((screen) => screen.id === 'activites-images')!.blocks[1];
  assert.equal((zones.props as { presentation?: string }).presentation, 'image');
  assert.match(zones.html!, /style="--x: 0\.625; --y: 0\.61"/);
});

test('course state: partial credit with weights, attempts, retake, a reflection answered once saved and never scored', () => {
  const { data } = activityCourse();
  const state = createCourseState(data);
  const trous = blockIn<FillInBlock>(data, 'trous-mots');
  const sort = blockIn<SortBlock>(data, 'classer-categories');
  const reflection = blockIn<ReflectionBlock>(data, 'reflexion-texte');
  const scale = blockIn<ReflectionBlock>(data, 'reflexion-echelle');
  // Two tries: the first wrong, then final.
  const first = state.answerFillIn('trous-mots', ['câble', 'imprimante', 'passerelle'])!;
  assert.deepEqual([first.correct, first.final, first.attemptsLeft, first.marks, Math.round(first.score * 100)], [false, false, 1, [true, false, true], 67]);
  assert.ok(state.activityAnswered(trous) && !state.activityDone(trous));
  const last = state.answerFillIn('trous-mots', ['câble', 'imprimante', 'passerelle'])!;
  assert.ok(last.final && state.activityDone(trous));
  assert.equal(state.answerFillIn('trous-mots', ['câble', 'carte réseau', 'passerelle']), null, 'final: no more tries');
  assert.equal(state.answerSort('classer-categories', [0, 1, -1, 1]), null, 'every item placed first');
  assert.deepEqual(state.answerSort('classer-categories', [0, 1, 0, 0])!.marks, [true, true, true, false]);
  // A reflection: saved when not empty, answered, never scored.
  assert.ok(!state.saveReflection('reflexion-texte', '   '));
  assert.ok(!state.activityDone(reflection));
  assert.ok(state.saveReflection('reflexion-texte', 'x'.repeat(450)));
  assert.equal((state.reflectionOf(reflection) as string).length, 400, 'cut at maxLength');
  assert.ok(!state.saveReflection('reflexion-echelle', 9), 'outside the scale');
  assert.ok(state.saveReflection('reflexion-echelle', 5) && state.activityDone(scale));
  assert.ok(!state.score().decided);
  // Everything else right: the score counts the partial credits, weights included.
  for (const screen of state.screens) for (const block of flatBlocks([...screen.blocks, ...screen.layers.flatMap((layer) => layer.blocks)])) {
    if (block.behavior === 'quiz') state.answerQuiz(block.id, block.props.options.filter((option) => option.correct).map((option) => option.id));
    if (block.behavior === 'fill-in') state.answerFillIn(block.id, block.props.blanks.map((blank) => blank.answers[0]));
    if (block.behavior === 'sort') state.answerSort(block.id, block.props.presentation === 'order' ? block.props.items.map((_, index) => index) : block.props.items.map((item) => item.target));
    if (block.behavior === 'decision') state.chooseDecision(block.id, (block.props.options.find((option) => option.correct) || block.props.options[0]).id);
    if (block.behavior === 'numeric') state.answerNumeric(block.id, block.props.answer);
    if (block.behavior === 'object') state.completeObject(block.id, 1);
  }
  const scored = state.score();
  const items = scored.items;
  assert.ok(scored.decided);
  // trous-mots 2/3 and classer-categories 1 (its second try was right): the rest is right.
  assert.equal(scored.raw, Math.round(100 * (items - 1 + 2 / 3) / items));
  // Retake: scored activities start over; reflections stay.
  state.retake();
  assert.equal(state.fillInState(trous), null);
  assert.equal(state.sortState(sort), null);
  assert.equal(state.reflectionOf(scale), 5);
  // Saved and read back, the state is the same.
  const again = createCourseState(data, { suspendData: state.encode() });
  assert.equal(again.reflectionOf(reflection), 'x'.repeat(400));
});

test('the state model and the budget: a course with too much reflection text for its LMS fails the build', () => {
  const { project, keys } = activityCourse();
  const model = buildStateModel(project, keys);
  assert.deepEqual(model.fillIns!.map((fillIn) => fillIn.blanks), [[{ maxLength: 30 }, { maxLength: 16 }], [{ longest: 'commutateur' }, { longest: 'commutateur' }], [{ longest: 'carte réseau' }, { longest: 'carte réseau' }, { longest: 'carte réseau' }]]);
  assert.deepEqual(model.sorts!.map((sort) => sort.items), [3, 4, 4]);
  assert.deepEqual(model.reflections!.map(({ key: _, ...rest }) => rest), [{ maxLength: 400 }, { scaleMax: 5 }]);
  const dir = copyExample();
  addActivities(dir);
  assert.ok(!codes(validateDir(dir, { profiles: ['moodle'] }).diagnostics).includes('E_SUSPEND_DATA_BUDGET'));
  const screen = readJSON(dir, 'screens/activites-reflexion.json');
  for (let i = 0; i < 3; i++) screen.blocks.push({ id: `reflexion-longue-${i}`, type: 'reflection', props: { prompt: 'Racontez.', maxLength: 2000 } });
  writeJSON(dir, 'screens/activites-reflexion.json', screen);
  assert.ok(codes(validateDir(dir, { profiles: ['moodle'] }).diagnostics).includes('E_SUSPEND_DATA_BUDGET'));
});

// ── checks ──
test('checks: E_FILLIN_NO_BLANK, E_SORT_TARGET, W_ACTIVITY_NO_FEEDBACK, E_QUIZ_PICTURE and the pictures\' alt', () => {
  const dir = copyExample();
  addActivities(dir);
  assert.deepEqual(validateDir(dir).diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`), []);
  const edit = (file: string, change: (blocks: Record<string, any>[]) => void) => { const screen = readJSON(dir, `screens/${file}.json`); change(screen.blocks); writeJSON(dir, `screens/${file}.json`, screen); };
  const found = (code: string) => validateDir(dir).diagnostics.filter((d) => d.code === code).map((d) => `${d.target} ${d.path}`).sort();
  edit('activites-trous', (blocks) => {
    blocks[0].props.markdown = 'Pas de trou.';
    blocks[1].props.markdown = 'Un [[ ]] vide et un [[plein]].';
    delete blocks[2].props.feedback;
  });
  assert.deepEqual(found('E_FILLIN_NO_BLANK'), ['trous-listes /blocks/1/props/markdown', 'trous-saisie /blocks/0/props/markdown']);
  assert.deepEqual(found('W_ACTIVITY_NO_FEEDBACK'), ['trous-mots /blocks/2/props']);
  edit('activites-classer', (blocks) => {
    blocks[0].props.items[0].target = 'nulle-part';
    blocks[1].props.targets = [blocks[1].props.targets[0]];
    blocks[1].props.items.forEach((item: Record<string, unknown>) => { item.target = 'materiel'; });
    blocks[1].props.items[0].alt = '';
    blocks[2].props.items = [];
    blocks[2].props.feedback = { correct: 'Oui.' };
  });
  assert.deepEqual(found('E_SORT_TARGET'), [
    'classer-categories /blocks/1/props/targets', 'classer-ordre /blocks/2/props/items',
    'classer-paires /blocks/0/props/items/0/target', 'classer-paires /blocks/0/props/targets'
  ]);
  assert.deepEqual(found('E_IMAGE_ALT_MISSING'), ['classer-categories /blocks/1/props/items/0/alt']);
  assert.deepEqual(found('W_ACTIVITY_NO_FEEDBACK'), ['classer-ordre /blocks/2/props/feedback', 'trous-mots /blocks/2/props']);
  edit('activites-images', (blocks) => {
    delete blocks[0].props.options[1].image;
    delete blocks[1].props.options[2].x;
    blocks[1].props.image = 'images/absente.svg';
  });
  assert.deepEqual(found('E_QUIZ_PICTURE'), ['images-cartes /blocks/0/props/options/1', 'images-zones /blocks/1/props/options/2']);
  assert.deepEqual(found('E_ASSET_MISSING'), ['images-zones /blocks/1/props/image']);
  // A plan question has no pictures: inline, or a fork.
  edit('activites-images', (blocks) => { blocks[0].props = { presentation: 'images', questionRef: 'Q-1' }; });
  assert.ok(found('E_QUIZ_PICTURE').some((where) => where.startsWith('images-cartes')));
});

test('forks keep their behaviour: hooks of fill-in, sort and reflection checked like a quiz\'s', () => {
  const dir = copyExample();
  const fork = (id: string, parent: string, template: string) => {
    writeFixture(dir, `components/${id}/component.json`, { id, title: id, version: '1.0.0', extends: { component: parent, version: '0.1.0' } });
    writeFixture(dir, `components/${id}/template.html`, template);
  };
  fork('trous-carte', 'fill-in', '<div data-t-group><div data-t-text>{{markdown}}</div><button data-t-submit></button></div>');
  fork('tri-carte', 'sort', '<div><p data-t-stem>{{stem}}</p><button data-each="items" data-t-sort-item="{{id}}">{{text}}</button><div data-each="targets" data-t-sort-target="{{id}}"><span>{{text}}</span></div><button data-t-place></button><button data-t-submit></button><div data-t-feedback></div></div>');
  fork('note-carte', 'reflection', '<div><p data-t-prompt>{{prompt}}</p><textarea></textarea><div data-t-response></div><button data-t-submit></button><div data-t-feedback></div></div>');
  fork('bon-tri', 'sort', '<div><p data-t-stem>{{stem}}</p><div data-t-pool><button data-each="items" data-t-sort-item="{{id}}">{{text}}</button></div><div data-each="targets" data-t-sort-target="{{id}}"><button data-t-place>{{text}}</button><div data-t-zone></div></div><button data-t-submit></button><div data-t-feedback></div></div>');
  const project = loadProjectFromDir(dir);
  const registry = getRegistry(project);
  const findings = (id: string) => { const reporter = createReporter(); checkTemplate({ project, reporter }, registry.get(id)!); return reporter.items.filter((d) => d.severity !== 'info').map((d) => `${d.code} ${d.message}`); };
  assert.deepEqual(findings('trous-carte'), ['E_COMPONENT_HOOK trous-carte keeps the fill-in behaviour of fill-in: its template needs data-t-stem.', 'E_COMPONENT_HOOK trous-carte keeps the fill-in behaviour of fill-in: its template needs data-t-feedback.']);
  assert.ok(findings('tri-carte').includes('E_COMPONENT_HOOK data-t-place goes inside the data-t-sort-target element.'), findings('tri-carte').join('\n'));
  assert.ok(findings('note-carte').some((finding) => /^E_COMPONENT_TEMPLATE <textarea> is not allowed/.test(finding)), findings('note-carte').join('\n'));
  assert.deepEqual(findings('bon-tri'), []);
  for (const id of ['fill-in', 'sort', 'reflection']) assert.equal(registry.get(id)!.behavior, id);
});

// ── exports and translation ──
test('exports: the client view, the agent view and LESSON.md give each activity as text', () => {
  const { project } = activityCourse();
  const client = projectMarkdown(project, { audience: 'client', screen: 'activites-trous' }) + projectMarkdown(project, { audience: 'client', screen: 'activites-classer' }) + projectMarkdown(project, { audience: 'client', screen: 'activites-reflexion' });
  assert.match(client, /Le poste envoie sa requête au \*\*routeur\*\* \(routeur d’accès\), qui interroge le serveur \*\*DNS\*\*\./);
  assert.match(client, /Mots en trop : répéteur/);
  assert.match(client, /- Tout est lent → Débit saturé/);
  assert.match(client, /- \*\*Matériel\*\* : Routeur, Câble/);
  assert.match(client, /1\. Regarder le voyant de la carte/);
  assert.match(client, /Réponse d'expert : _J’aurais d’abord regardé/);
  const agent = projectMarkdown(project, { audience: 'agent', screen: 'activites-trous' });
  assert.match(agent, /fill-in `trous-mots`: fill-in \(bank, 3 blanks\): On teste d’abord le \[\[câble\]\]/);
  const lesson = lessonMdExport(project);
  const text = [...lesson.output.values()].join('\n');
  assert.match(text, /On teste d’abord le \*\*câble\*\*, puis la \*\*carte réseau\*\*, enfin la \*\*passerelle\*\*\./);
  assert.match(text, /- Le voisin a internet, pas moi → Câble débranché/);
  assert.ok(lesson.losses.some((loss) => loss.block === 'reflexion-texte'));
});

test('translation: every word of the activities is a unit, blanks kept with their sentence', () => {
  const { project } = activityCourse();
  const units = extractUnits(project).filter((unit) => /^block\.(trous|classer|reflexion|images)-/.test(unit.id));
  const ids = units.map((unit) => unit.id);
  for (const id of ['block.trous-listes.distractors.0', 'block.trous-mots.feedback.incorrect', 'block.classer-paires.items.lent.text', 'block.classer-paires.targets.dns.text', 'block.classer-categories.items.routeur.alt', 'block.reflexion-texte.model', 'block.reflexion-echelle.scale.maxLabel', 'block.images-zones.alt', 'block.images-cartes.options.b.alt']) assert.ok(ids.includes(id), id);
  const blanks = units.find((unit) => unit.id === 'block.trous-saisie.markdown')!;
  assert.match(blanks.note ?? '', /keep the double brackets/);
  assert.equal(invariants(blanks.text, 'markdown').blanks, 2);
  assert.notDeepEqual(invariants('The request goes to the router.', 'markdown'), invariants(blanks.text, 'markdown'), 'a translation without its blanks is refused');
});

test('player labels of the activities: every language', () => {
  for (const language of labelLanguages()) {
    const labels = labelsFor(language);
    for (const key of ['blank', 'blankEmpty', 'blankFilled', 'chooseWord', 'wordBank', 'pickWord', 'wordPlaced', 'wordReturned', 'blanksRight', 'fillAll', 'sortPick', 'sortPlaceIn', 'sortPlaced', 'sortChooseFirst', 'sortAll', 'itemsRight', 'itemsToPlace', 'sortIn', 'moveUp', 'moveDown', 'movedTo', 'rightPlace', 'rightPosition', 'markRight', 'markWrong', 'cancelled', 'save', 'saved', 'reflectionEmpty', 'scaleEmpty', 'characters', 'expertAnswer', 'myAnswers', 'scaleAnswer', 'noAnswer', 'zone']) {
      assert.ok(labels[key]?.trim(), `${language} ${key}`);
    }
  }
});
