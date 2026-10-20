import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { planState, planVersionsView, planDiffBetween, planContentHash } from '@elabora/core/project/plan-versions';
import { planDiff, revertPlanChange } from '@elabora/core/project/plan-diff';
import { planCourse } from '@elabora/core/project/plan-order';
import type { Plan } from '@elabora/core/project/model';
import { initProject } from '@elabora/node/scaffold';
import { copyExample, readJSON, writeJSON, codes } from '../helpers.ts';
import * as edit from '@elabora/node/edit';

// The plan's versions (docs/decisions.md D52): plan.json is the working copy, written at any time;
// a person makes its versions (V1, V2…) and records the client's validation of one.

const PERSON = { author: { kind: 'human' as const, name: 'Aurélien' } };
const AGENT = { author: { kind: 'agent' as const, name: 'claude-code' } };

// The example without its versions: a plan nobody validated yet.
function withoutVersions(): string {
  const dir = copyExample();
  fs.rmSync(path.join(dir, 'plan-versions'), { recursive: true, force: true });
  return dir;
}

test('a plan without a validated version is a draft; a person makes V1, the client validates it, and release builds take it', () => {
  const dir = withoutVersions();
  assert.equal(planState(loadProjectFromDir(dir)), 'draft');
  assert.ok(codes(validateDir(dir, { release: true }).diagnostics).includes('E_PLAN_NOT_APPROVED'));
  assert.ok(codes(validateDir(dir).diagnostics).includes('W_PLAN_DRAFT'));
  // Validating needs a version: the working copy is never validated.
  assert.throws(() => edit.approvePlan(dir, { by: 'Claire Martin' }, PERSON), /no version yet: make one first/);
  const v1 = edit.createPlanVersion(dir, { note: 'Premier envoi' }, PERSON);
  assert.deepEqual([v1.version, v1.number, v1.contentHash], ['V1', 1, planContentHash(readJSON(dir, 'plan.json'))]);
  const file = readJSON(dir, 'plan-versions/V1.json');
  assert.equal(file.version, 1);
  assert.equal(file.note, 'Premier envoi');
  assert.match(file.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(file.plan.$schema, undefined, 'the frozen plan is its content');
  assert.equal(planState(loadProjectFromDir(dir)), 'draft', 'made, not validated');
  assert.throws(() => edit.createPlanVersion(dir, {}, PERSON), /The plan is V1 as it is: nothing changed since/);
  edit.approvePlan(dir, { by: 'Claire Martin, Hélios Énergie', reference: 'Courriel du 5 octobre', date: '2026-10-05' }, PERSON);
  assert.deepEqual(readJSON(dir, 'plan-versions/V1.json').validation, { by: 'Claire Martin, Hélios Énergie', date: '2026-10-05', reference: 'Courriel du 5 octobre' });
  assert.equal(planState(loadProjectFromDir(dir)), 'approved');
  assert.equal(validateDir(dir, { release: true }).summary.errors, 0);
  assert.throws(() => edit.approvePlan(dir, { by: 'Claire Martin' }, PERSON), /V1 is already validated, by Claire Martin, Hélios Énergie on 2026-10-05/);
});

test('the plan is written at any time; what changed since the validated version is a warning, never a refusal, and counts twice', () => {
  const dir = copyExample(); // V1, validated, and the working copy as it is
  assert.equal(planState(loadProjectFromDir(dir)), 'approved');
  edit.writePlan(dir, { patch: [{ op: 'replace', path: '/objectives/1/criterion', value: '3 diagnostics réussis sur 3' }] }, AGENT);
  assert.equal(planState(loadProjectFromDir(dir)), 'modified');
  const found = validateDir(dir, { release: true });
  assert.equal(found.summary.errors, 0, 'a release delivers changes the client has not validated, and says so');
  const warning = found.diagnostics.find((d) => d.code === 'W_PLAN_MODIFIED_SINCE_VALIDATION')!;
  assert.match(warning.message, /changed since V1, validated by Claire Martin, Hélios Énergie \(client fictif\) on 2026-10-05: 1 change\(s\)/);
  assert.deepEqual(warning.details, { version: 'V1', changes: 1 });
  let view = planVersionsView(loadProjectFromDir(dir));
  assert.deepEqual([view.latest, view.validated, view.next, view.current.sinceValidated, view.current.unversioned, view.export], [1, 1, 2, 1, 1, { shows: 1, changesSince: 1 }]);
  // V2 made: the pill counts nothing in no version, the marks still count since V1 validated.
  edit.createPlanVersion(dir, {}, PERSON);
  edit.writePlan(dir, { patch: [{ op: 'replace', path: '/title', value: 'Diagnostiquer une panne réseau' }] }, AGENT);
  view = planVersionsView(loadProjectFromDir(dir));
  assert.deepEqual([view.latest, view.validated, view.current.sinceValidated, view.current.unversioned, view.versions.map((version) => version.changes)], [2, 1, 2, 1, [0, 1]]);
  // Validating takes the latest version by default, never the working copy.
  edit.approvePlan(dir, { by: 'Claire Martin' }, PERSON);
  view = planVersionsView(loadProjectFromDir(dir));
  assert.deepEqual([view.validated, view.state, view.current.sinceValidated], [2, 'modified', 1]);
  // An older version can be validated by name.
  edit.createPlanVersion(dir, {}, PERSON);
  edit.writePlan(dir, { patch: [{ op: 'replace', path: '/title', value: 'Encore un titre' }] }, AGENT);
  edit.createPlanVersion(dir, {}, PERSON);
  edit.approvePlan(dir, { version: 'V3', by: 'Claire Martin' }, PERSON);
  assert.equal(planVersionsView(loadProjectFromDir(dir)).validated, 3);
  assert.throws(() => edit.approvePlan(dir, { version: 'V9', by: 'Claire Martin' }, PERSON), /no version V9/);
});

test('versions and their validation are a person\'s: an agent is refused, whatever its tool', () => {
  const dir = copyExample();
  edit.writePlan(dir, { patch: [{ op: 'replace', path: '/title', value: 'Autre' }] }, AGENT);
  for (const run of [() => edit.createPlanVersion(dir, {}, AGENT), () => edit.approvePlan(dir, { by: 'Claire Martin' }, AGENT)]) {
    assert.throws(run, (error: Error & { code?: string }) => error.code === 'E_PLAN_PERSON_ONLY' && /Only a person .* Nothing was written/.test(error.message));
  }
  assert.ok(!fs.existsSync(path.join(dir, 'plan-versions/V2.json')));
});

test('a text kept « à l\'identique »: an agent never changes it, the author does, and the change is flagged', () => {
  const dir = withoutVersions();
  const plan = readJSON(dir, 'plan.json');
  plan.items[0].lockedTexts[0].verbatim = true;
  writeJSON(dir, 'plan.json', plan);
  edit.createPlanVersion(dir, {}, PERSON);
  edit.approvePlan(dir, { by: 'Claire Martin' }, PERSON);
  const before = fs.readFileSync(path.join(dir, 'plan.json'), 'utf8');
  const refused = (error: Error & { code?: string }) => error.code === 'E_PLAN_VERBATIM_LOCKED' && /TXT-1 is kept « à l'identique » .* Ask the author/.test(error.message);
  assert.throws(() => edit.writePlan(dir, { patch: [{ op: 'replace', path: '/items/0/lockedTexts/0/text', value: 'Lundi matin.' }] }, AGENT), refused);
  assert.throws(() => edit.writePlan(dir, { patch: [{ op: 'remove', path: '/items/0/lockedTexts/0/verbatim' }] }, AGENT), refused);
  assert.throws(() => edit.setPlanText(dir, { text: 'TXT-1', markdown: 'Lundi matin.' }, AGENT), refused);
  assert.equal(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'), before);
  // Moving it with its item is no change of its words.
  edit.writePlan(dir, { patch: [{ op: 'replace', path: '/items/0/title', value: 'Le ticket' }] }, AGENT);
  // The author changes it, deliberately: the change is flagged until a version holds it.
  edit.setPlanText(dir, { block: 'accueil-situation', markdown: 'Lundi matin, Marc vous appelle.' }, PERSON);
  assert.deepEqual(planVersionsView(loadProjectFromDir(dir)).verbatimChanged, ['TXT-1']);
  const flag = validateDir(dir).diagnostics.find((d) => d.code === 'W_PLAN_VERBATIM_CHANGED')!;
  assert.equal(flag.target, 'TXT-1');
  // The block follows the plan by textRef.
  assert.equal(readJSON(dir, 'plan.json').items[0].lockedTexts[0].text, 'Lundi matin, Marc vous appelle.');
});

test('a version never changes: one edited by hand does not hold together and is not counted', () => {
  const dir = copyExample();
  const version = readJSON(dir, 'plan-versions/V1.json');
  version.plan.title = 'Retouché à la main';
  writeJSON(dir, 'plan-versions/V1.json', version);
  const found = validateDir(dir).diagnostics.filter((d) => d.code === 'E_PLAN_VERSION_INVALID');
  assert.deepEqual(found.map((d) => [d.file, d.path, d.target]), [['plan-versions/V1.json', '/contentHash', 'V1']]);
  assert.equal(planState(loadProjectFromDir(dir)), 'draft', 'no version holds together');
  writeJSON(dir, 'plan-versions/V2.json', { ...readJSON(dir, 'plan-versions/V1.json'), version: 3 });
  assert.ok(validateDir(dir).diagnostics.some((d) => d.code === 'E_PLAN_VERSION_INVALID' && d.file === 'plan-versions/V2.json' && d.path === '/version'));
  // A plan written as before D52 breaks the plan's schema.
  writeJSON(dir, 'plan.json', { ...readJSON(dir, 'plan.json'), status: 'approved' });
  assert.ok(validateDir(dir).diagnostics.some((d) => d.code === 'E_SCHEMA' && d.file === 'plan.json'));
});

test('the diff of two plans, element by element and matched by ids', () => {
  const dir = copyExample();
  const base = readJSON(dir, 'plan.json');
  const plan = structuredClone(base);
  plan.title = 'Diagnostiquer une panne';
  plan.audience.role = 'Techniciens de niveau 1';
  plan.objectives[1].statement = "Localiser l'équipement défaillant en suivant le chemin des paquets, sans en sauter un.";
  // Item 6 goes before item 5, item 4 is removed, a new item comes after item 1, item 2 changes part.
  const [, , , fourth, fifth, sixth] = plan.items;
  plan.items.splice(3, 3, sixth, fifth);
  plan.items.splice(1, 0, { id: 'ITEM-7', kind: 'exposition', title: 'Les cinq équipements', objectives: ['OBJ-1'] });
  plan.items[2].kind = 'demonstration';
  plan.items.at(-1).part = 'Évaluer';
  // A text goes to another item, a question loses an option and rewords another.
  plan.items[0].lockedTexts.push(plan.items[2].lockedTexts.pop());
  delete plan.items[2].lockedTexts;
  const question = plan.items.find((item: { id: string }) => item.id === 'ITEM-5').questions[0];
  question.options[0].text = 'Le commutateur du bureau';
  question.options.pop();
  const diff = planDiff(base, plan);
  const summary = diff.changes.map((change) => [change.key, change.status, change.moved ?? null, change.part ?? null, change.fromItem ?? null, change.fields.map((field) => field.field)]);
  assert.deepEqual(summary, [
    ['plan:title', 'changed', null, null, null, ['title']],
    ['plan:audience', 'changed', null, null, null, ['audience/role']],
    ['objective:OBJ-2', 'changed', null, null, null, ['statement']],
    ['text:TXT-2', 'changed', { from: 1, to: 2 }, null, 'ITEM-2', []],
    ['item:ITEM-7', 'added', null, null, null, []],
    ['item:ITEM-2', 'changed', null, null, null, ['kind']],
    ['item:ITEM-4', 'removed', null, null, null, []],
    // Of two items swapped, one moved: the other kept its order with the rest. The plan had no parts
    // and no course is given to take them from: there is no part to say ITEM-5 left.
    ['item:ITEM-5', 'changed', { from: 5, to: 6 }, null, null, []],
    ['question:Q-1', 'changed', null, null, null, ['options/a/text', `options/${base.items[4].questions[0].options[2].id}`]]
  ]);
  assert.deepEqual(diff.counts, { added: 1, removed: 1, changed: 7 });
  // A reworded text reads word by word.
  const statement = diff.changes[2]!.fields[0]!.diff![0]!;
  assert.equal(statement.type, 'paragraph');
  assert.ok(statement.type === 'paragraph' && statement.content.some((part) => part.change === 'del') && statement.content.some((part) => part.change === 'ins'));
  // Without a version to start from, everything is added.
  assert.equal(planDiff(null, plan).changes.every((change) => change.status === 'added'), true);
});

// The part an item belongs to, not the field it is written in (D50): an item without one continues
// the part before it, and a plan without parts takes those of the course's sections.
test('the diff compares the parts items belong to: one that says the part it already continued did not change part', () => {
  const plan = (parts: Record<string, string>, order = ['A', 'B', 'C', 'D']) => ({ items: order.map((id) => ({ id, kind: 'exposition', title: id, ...(parts[id] ? { part: parts[id] } : {}) })) }) as unknown as Plan;
  const summary = (before: Plan, after: Plan, course?: ReturnType<typeof planCourse>) => planDiff(before, after, course).changes.map((change) => [change.key, change.moved ?? null, change.part ?? null]);
  const base = plan({ A: 'Un', C: 'Deux' }); // A and B in Un, C and D in Deux
  assert.deepEqual(summary(base, plan({ A: 'Un', B: 'Un', C: 'Deux', D: 'Deux' })), [], 'B and D only say what they continued');
  assert.deepEqual(summary(base, plan({ A: 'Un', C: 'Trois' })), [['item:C', null, { from: 'Deux', to: 'Trois' }], ['item:D', null, { from: 'Deux', to: 'Trois' }]], 'a part renamed: its items, which did not move');
  assert.deepEqual(summary(base, plan({ A: 'Un', B: 'Deux', C: 'Deux' })), [['item:B', null, { from: 'Un', to: 'Deux' }]], 'one item given the next part');
  assert.deepEqual(summary(base, plan({}, ['A', 'B', 'C', 'D'])), [['item:A', null, { from: 'Un', to: null }], ['item:B', null, { from: 'Un', to: null }], ['item:C', null, { from: 'Deux', to: null }], ['item:D', null, { from: 'Deux', to: null }]], 'parts taken away');
  // A plan without parts: its parts are the course's sections, or none without a course.
  const course = planCourse({
    course: { sections: [{ id: 's1', title: 'Un', screens: ['a', 'b'] }, { id: 's2', title: 'Deux', screens: ['c'] }] },
    screens: new Map([['a', 'A'], ['b', 'B'], ['c', 'C']].map(([id, item]) => [id!, { file: `screens/${id}.json`, data: { covers: [item] } }]))
  } as never);
  const bare = plan({});
  assert.deepEqual(summary(bare, plan({ A: 'Un', B: 'Un', C: 'Deux' }), course), [], 'written down as the sections call them');
  assert.deepEqual(summary(bare, plan({ A: 'Un', B: 'Un', C: 'Deux' })), [], 'no course, no part to compare');
  assert.deepEqual(summary(bare, plan({ A: 'Un', B: 'Un', C: 'Trois' }), course), [['item:C', null, { from: 'Deux', to: 'Trois' }], ['item:D', null, { from: 'Deux', to: 'Trois' }]], 'not as they call them');
  assert.deepEqual(summary(bare, plan({ A: 'Un', B: 'Un', C: 'Deux', D: 'Deux' }, ['A', 'C', 'B', 'D']), course), [['item:B', { from: 2, to: 3 }, null]], 'a swap: one moved, and none changed part');
});

test('one change undone (« Revenir à la V1 »): the element as the version has it, in its place there', () => {
  const dir = copyExample();
  const base = readJSON(dir, 'plan.json');
  const plan = structuredClone(base);
  plan.items[1].title = 'Autre titre';
  const removed = plan.items.splice(3, 1)[0];
  plan.items.push({ id: 'ITEM-7', kind: 'summary', title: 'Nouveau', objectives: [] });
  plan.items[0].lockedTexts[0].text = 'Autre texte.';
  const back = (key: string) => revertPlanChange(plan, base, key);
  assert.equal(back('item:ITEM-2').items[1].title, base.items[1].title);
  assert.deepEqual(back('item:ITEM-4').items.map((item: { id: string }) => item.id), ['ITEM-1', 'ITEM-2', 'ITEM-3', 'ITEM-4', 'ITEM-5', 'ITEM-6', 'ITEM-7']);
  assert.deepEqual(back('item:ITEM-4').items[3], removed);
  assert.ok(!back('item:ITEM-7').items.some((item: { id: string }) => item.id === 'ITEM-7'));
  assert.equal(back('text:TXT-1').items[0].lockedTexts![0]!.text, base.items[0].lockedTexts[0].text);
  assert.throws(() => back('plan:nothing'), /No field nothing/);
  // As a command: back to the validated version, one change.
  writeJSON(dir, 'plan.json', plan);
  const result = edit.revertPlanChange(dir, { key: 'item:ITEM-4' }, AGENT);
  assert.equal(result.version, 'V1');
  assert.ok(!planDiffBetween(loadProjectFromDir(dir)).changes.some((change) => change.key === 'item:ITEM-4'));
  assert.throws(() => edit.revertPlanChange(dir, { key: 'item:ITEM-4' }, AGENT), /Nothing changed in item:ITEM-4 since V1/);
});

test('notes for the client: one per change in no version yet, frozen with the next version; those on changes undone go', () => {
  const dir = copyExample();
  assert.throws(() => edit.setPlanNote(dir, { target: 'item:ITEM-2', text: 'Pourquoi' }, AGENT), /No change item:ITEM-2 since V1/);
  edit.writePlan(dir, { patch: [{ op: 'replace', path: '/items/1/title', value: 'Le chemin des paquets' }, { op: 'replace', path: '/items/2/title', value: 'Le réflexe' }] }, AGENT);
  edit.setPlanNote(dir, { target: 'item:ITEM-2', text: 'Le mot du métier.' }, PERSON);
  edit.setPlanNote(dir, { target: 'item:ITEM-3', text: 'Plus court.' }, PERSON);
  assert.equal(planVersionsView(loadProjectFromDir(dir)).notes, 2);
  edit.writePlan(dir, { patch: [{ op: 'replace', path: '/items/2/title', value: readJSON(dir, 'plan-versions/V1.json').plan.items[2].title }] }, AGENT);
  const v2 = edit.createPlanVersion(dir, {}, PERSON);
  assert.deepEqual([v2.notes, v2.droppedNotes], [1, ['item:ITEM-3']]);
  assert.deepEqual(readJSON(dir, 'plan-versions/V2.json').notes, [{ target: 'item:ITEM-2', text: 'Le mot du métier.' }]);
  assert.ok(!fs.existsSync(path.join(dir, 'plan-versions/notes.json')), 'no note waits any more');
});

test('exporting records the send on the version it shows; it never makes one', () => {
  const dir = copyExample();
  edit.recordPlanSend(dir, { version: 'V1', format: 'docx', date: '2026-10-16' }, AGENT);
  assert.deepEqual(readJSON(dir, 'plan-versions/V1.json').sends, [{ date: '2026-10-16', format: 'docx' }]);
  assert.throws(() => edit.recordPlanSend(dir, { version: 'V2', format: 'pdf' }, AGENT), /no version V2/);
  assert.equal(fs.readdirSync(path.join(dir, 'plan-versions')).length, 1);
});

test('write_plan: the whole plan or a patch, its schema checked first; a plan\'s old state is dropped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-write-'));
  try {
    const dir = path.join(root, 'c');
    initProject(dir, { id: 'grande-sante', title: 'Nietzsche et la grande santé' });
    assert.equal(readJSON(dir, 'plan.json').status, undefined);
    const plan = {
      id: 'PLAN-GRANDE-SANTE', title: 'Nietzsche et la grande santé', status: 'approved', approval: { by: 'agent', date: '2026-10-13', contentHash: 'sha256:0' },
      objectives: [{ id: 'OBJ-1', statement: 'Expliquer avec ses mots ce que Nietzsche appelle la grande santé, à partir d’un extrait du Gai Savoir.' }],
      items: [{ id: 'ITEM-1', kind: 'intro', title: 'Une santé qui se sert de la maladie', objectives: ['OBJ-1'] }]
    };
    const written = edit.writePlan(dir, { plan }, AGENT);
    assert.ok(written.change);
    const drafted = readJSON(dir, 'plan.json');
    assert.deepEqual([drafted.status, drafted.approval], [undefined, undefined]);
    assert.match(drafted.$schema, /plan\.schema\.json$/);
    edit.writePlan(dir, { patch: [{ op: 'add', path: '/spacing', value: ['J+2', 'J+7'] }] }, AGENT);
    assert.deepEqual(readJSON(dir, 'plan.json').spacing, ['J+2', 'J+7']);
    const before = fs.readFileSync(path.join(dir, 'plan.json'), 'utf8');
    assert.throws(() => edit.writePlan(dir, { patch: [{ op: 'add', path: '/spacing/-', value: 'J+90 : relire en entier la troisième Dissertation (trop long)' }] }, AGENT), /would not match its schema, so nothing was written: \/spacing\/2: must NOT have more than 50 characters/);
    assert.throws(() => edit.writePlan(dir, { plan: { ...plan, items: [] } }, AGENT), /\/items: must NOT have fewer than 1 items/);
    assert.throws(() => edit.writePlan(dir, { patch: [{ op: 'remove', path: '/objectives/9' }] }, AGENT), /does not apply/);
    assert.equal(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'), before);
    assert.throws(() => edit.writePlan(dir, {}, AGENT), /one of them/);
    // Validated, the plan is still written: the diff says what changed.
    edit.createPlanVersion(dir, {}, PERSON);
    edit.approvePlan(dir, { by: 'Aurélien, auteur' }, PERSON);
    edit.writePlan(dir, { patch: [{ op: 'replace', path: '/title', value: 'Autre' }] }, AGENT);
    assert.deepEqual(planDiffBetween(loadProjectFromDir(dir)).changes.map((change) => change.key), ['plan:title']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a draft says what the agent decided by itself and asks one question; validating a version removes both (D51)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-decided-'));
  try {
    const dir = path.join(root, 'c');
    initProject(dir, { id: 'incident', title: 'Réagir à un incident réseau', brief: { duration: { min: 10, max: 20 } } });
    const plan = {
      id: 'PLAN-INCIDENT', title: 'Réagir à un incident réseau', businessGoal: 'Moins d’incidents transférés au niveau 2.', duration: { min: 10, max: 20 },
      objectives: [{ id: 'OBJ-1', statement: 'Signaler un incident réseau en appliquant la procédure P-12.' }],
      items: [
        { id: 'ITEM-1', kind: 'intro', title: 'L’appel du lundi matin', objectives: [] },
        { id: 'ITEM-2', kind: 'scenario', title: 'Signaler l’incident', objectives: ['OBJ-1'] }
      ],
      decided: [
        { topic: '3d', choice: 'Non : un schéma du réseau', why: 'partie 2', items: ['ITEM-2'] },
        { topic: 'tone', choice: 'Direct, au vouvoiement' },
        { topic: 'fil-rouge', label: 'Un fil rouge ?', choice: 'L’appel de Marc', items: ['ITEM-1', 'ITEM-2'] }
      ],
      question: { text: 'Le ticket doit-il reprendre le formulaire de votre outil de support ?', topic: 'case', items: ['ITEM-2'] }
    };
    edit.writePlan(dir, { plan }, AGENT);
    const drafted = readJSON(dir, 'plan.json');
    assert.deepEqual(drafted.decided, plan.decided);
    assert.deepEqual(drafted.question, plan.question);
    assert.ok(!codes(validateDir(dir).diagnostics).includes('E_PLAN_REFERENCE'));
    edit.writePlan(dir, { patch: [{ op: 'add', path: '/decided/0/items/-', value: 'ITEM-9' }, { op: 'replace', path: '/question/items', value: ['ITEM-8'] }] }, AGENT);
    const references = validateDir(dir).diagnostics.filter((d) => d.code === 'E_PLAN_REFERENCE').map((d) => `${d.path} ${d.target}`);
    assert.deepEqual(references, ['/decided/0/items/1 ITEM-9', '/question/items/0 ITEM-8']);
    assert.throws(() => edit.writePlan(dir, { patch: [{ op: 'add', path: '/decided/-', value: { topic: 'Ton', choice: 'Direct' } }] }, AGENT), /\/decided\/3\/topic: does not match the expected pattern/);
    assert.throws(() => edit.writePlan(dir, { patch: [{ op: 'replace', path: '/question', value: [{ text: 'Une ?' }, { text: 'Deux ?' }] }] }, AGENT), /\/question: must be object/);
    edit.writePlan(dir, { patch: [{ op: 'remove', path: '/decided/0/items/1' }, { op: 'replace', path: '/question/items', value: ['ITEM-2'] }] }, AGENT);

    // A version never holds them; validating it removes them from the working copy.
    edit.createPlanVersion(dir, {}, PERSON);
    assert.equal(readJSON(dir, 'plan-versions/V1.json').plan.decided, undefined);
    edit.approvePlan(dir, { by: 'Claire Martin, Hélios Énergie', date: '2026-10-15' }, PERSON);
    const validated = readJSON(dir, 'plan.json');
    assert.deepEqual([validated.decided, validated.question], [undefined, undefined]);
    assert.deepEqual(validated.duration, { min: 10, max: 20 });
    assert.equal(planState(loadProjectFromDir(dir)), 'approved');
    // They are outside the contract's hash: written again, they change nothing in the plan's state.
    writeJSON(dir, 'plan.json', { ...validated, question: { text: 'Encore une ?' } });
    assert.equal(planState(loadProjectFromDir(dir)), 'approved');
    // A duration whose min is above its max is found.
    writeJSON(dir, 'plan.json', { ...validated, duration: { min: 30, max: 10 } });
    assert.ok(validateDir(dir).diagnostics.some((d) => d.code === 'E_SCHEMA' && d.path === '/duration'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('versions and notes stay with the course (its archive, its backups), never in a SCORM or web package; a release lists the changes since the validated version', async () => {
  const { build } = await import('@elabora/node/build');
  const { readZip } = await import('@elabora/node/zip');
  const { exportProject } = await import('@elabora/node/library/index');
  const { createVersion } = await import('@elabora/node/backups/index');
  const { proofMarkdown } = await import('@elabora/core/compile/proof');
  const { ROOT } = await import('../helpers.ts');
  const dir = copyExample(path.join(ROOT, 'examples/diagnostic-reseau')); // V2 validated, two changes since, a note
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-versions-build-'));
  try {
    for (const options of [{ release: true }, { release: true, target: 'web' as const }]) {
      const result = await build(dir, { ...options, out: fs.mkdtempSync(path.join(out, 'b-')) });
      assert.ok(result.ok && result.zipPath, JSON.stringify(result.diagnostics.filter((d) => d.severity === 'error')));
      const files = readZip(fs.readFileSync(result.zipPath)).files;
      assert.deepEqual([...files.keys()].filter((name) => /plan-versions|notes\.json/.test(name)), []);
      assert.ok(![...files.values()].some((content) => content.toString('utf8').includes('Formulation plus directe')), 'no note for the client in a package');
      const plan = result.report!.plan;
      assert.deepEqual(plan.validated && [plan.validated.version, plan.validated.by], ['V2', 'Claire Martin, Hélios Énergie (client fictif)']);
      assert.deepEqual(plan.changesSince?.changes.map((change) => change.key), ['text:TXT-2', 'item:ITEM-3']);
      assert.ok(result.diagnostics.some((d) => d.code === 'W_PLAN_MODIFIED_SINCE_VALIDATION'));
      const proof = proofMarkdown(result.report!);
      assert.match(proof, /V2, validée par Claire Martin, Hélios Énergie \(client fictif\) le 2026-10-05 \(Storyboard v3 validé par courriel\)/);
      assert.match(proof, /2 modification\(s\) depuis la V2 validée, livrées sans validation du client/);
      assert.match(proof, /  - Texte TXT-2 « Suivez toujours le chemin/);
    }
    const archive = await exportProject(dir, path.join(out, 'course.elabora'));
    assert.ok(['plan-versions/V1.json', 'plan-versions/V2.json', 'plan-versions/notes.json'].every((name) => readZip(fs.readFileSync(archive.file)).files.has(name)));
    const backup = await createVersion(dir, { reason: 'manual', author: null });
    assert.ok(backup && ['plan-versions/V2.json', 'plan-versions/notes.json'].every((name) => name in backup.files));
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
