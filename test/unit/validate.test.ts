import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { validateProject, validateScreen, validateProjectChecks, createValidationContext, FILE_CHECKS, COURSE_CHECKS } from '@elabora/core/validate/index';
import type { Diagnostic } from '@elabora/core/diagnostics/index';
import type { Block } from '@elabora/format';
import { loadProject } from '@elabora/core/project/load';
import { binaryFile, createProjectFiles, textFile } from '@elabora/core/project/files';
import type { FileMedia } from '@elabora/core/media/conformance';
import { ROOT, EXAMPLE, copyExample, readJSON, writeJSON, writeFixture, codes, addExplorer } from '../helpers.ts';

test('the example course has no error', () => {
  const r = validateDir(EXAMPLE, { profiles: ['moodle', 'successfactors'] });
  assert.equal(r.summary.errors, 0, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'), null, 1));
});

test('contract rules: uncovered item, unused locked text, orphan reference', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.covers = ['ITEM-9'];
  writeJSON(dir, 'screens/chemin.json', s);
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_PLAN_ITEM_UNCOVERED', 'E_PLAN_REFERENCE', 'E_LOCKED_TEXT_OUTSIDE_ITEM']) assert.ok(c.includes(code), code);
});

test('item-writing and feedback rules', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/evaluation.json');
  s.blocks.push({ id: 'q3', type: 'quiz', props: { stem: "Quel équipement n'est pas sur le chemin ?", mode: 'single', options: [{ id: 'a', text: 'Toutes les réponses', correct: true }, { id: 'b', text: 'Le routeur', correct: true }] } });
  writeJSON(dir, 'screens/evaluation.json', s);
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_FEEDBACK_MISSING', 'E_QUIZ_SINGLE_MULTIPLE_CORRECT', 'W_QUIZ_ALL_NONE', 'W_QUIZ_NEGATION', 'W_QUIZ_OPTION_COUNT']) assert.ok(c.includes(code), code);
});

test('accessibility rules: alt text, heading order, contrast', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  delete s.blocks[1].props.alt;
  s.blocks.push({ id: 'chemin-h', type: 'heading', props: { text: 'x', level: 4 } });
  writeJSON(dir, 'screens/chemin.json', s);
  const course = readJSON(dir, 'course.json');
  course.theme.tokens['color.muted'] = '#AAAAAA';
  writeJSON(dir, 'course.json', course);
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_IMAGE_ALT_MISSING', 'E_HEADING_ORDER', 'E_THEME_CONTRAST']) assert.ok(c.includes(code), code);
});

test('videos and sounds: captions and a transcript when heard, alt for a loop, nothing when decorative', () => {
  const dir = copyExample();
  for (const file of ['assets/video/demo.mp4', 'assets/audio/appel.mp3']) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'x');
  }
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(
    { id: 'v-plain', type: 'video', props: { asset: 'video/demo.mp4', title: 'Démonstration' } },
    { id: 'v-loop', type: 'video', props: { asset: 'video/demo.mp4', title: 'Le voyant', loop: true } },
    { id: 'v-loop-alt', type: 'video', props: { asset: 'video/demo.mp4', title: 'Le voyant', loop: true, alt: 'Le voyant du routeur clignote en orange.' } },
    { id: 'v-deco', type: 'video', props: { asset: 'video/demo.mp4', title: 'Fond', decorative: true } },
    { id: 'a-plain', type: 'audio', props: { asset: 'audio/appel.mp3', title: 'L’appel de Marc' } },
    { id: 'a-deco', type: 'audio', props: { asset: 'audio/appel.mp3', title: 'Ambiance', decorative: true } }
  );
  writeJSON(dir, 'screens/chemin.json', s);
  const wanted = new Set(['E_VIDEO_CAPTIONS_MISSING', 'E_MEDIA_TRANSCRIPT_MISSING', 'E_VIDEO_ALT_MISSING']);
  const found = (project: ReturnType<typeof loadProjectFromDir>) => validateScreen(createValidationContext(project), 'chemin').filter((d) => wanted.has(d.code)).map((d) => `${d.target} ${d.code}`).sort();
  const project = loadProjectFromDir(dir);
  assert.deepEqual(found(project), ['a-plain E_MEDIA_TRANSCRIPT_MISSING', 'v-loop E_VIDEO_ALT_MISSING', 'v-plain E_MEDIA_TRANSCRIPT_MISSING', 'v-plain E_VIDEO_CAPTIONS_MISSING']);
  // A video the media probe found silent: no captions; its alt stands for a transcript.
  const silent = loadProject(createProjectFiles([...project.files].map(([name, file]) => [name, name === 'assets/video/demo.mp4' ? binaryFile(1, { media: { kind: 'video', audioCodec: null } as unknown as FileMedia }) : file] as const)), { root: project.root });
  assert.deepEqual(found(silent), ['a-plain E_MEDIA_TRANSCRIPT_MISSING', 'v-loop E_VIDEO_ALT_MISSING', 'v-plain E_MEDIA_TRANSCRIPT_MISSING']);
  const described = withScreenProps(silent, 'chemin', 'v-plain', { alt: 'Le technicien débranche puis rebranche le câble réseau.' });
  assert.deepEqual(found(described), ['a-plain E_MEDIA_TRANSCRIPT_MISSING', 'v-loop E_VIDEO_ALT_MISSING']);
});

// The project with the props of one block of a screen merged, in memory.
function withScreenProps(project: ReturnType<typeof loadProjectFromDir>, screen: string, block: string, props: Record<string, unknown>) {
  const file = `screens/${screen}.json`;
  const data = structuredClone(project.screens.get(screen)!.data);
  const target = data.blocks.find((candidate) => candidate.id === block)!;
  target.props = { ...target.props, ...props };
  return loadProject(createProjectFiles([...project.files].map(([name, content]) => [name, name === file ? textFile(JSON.stringify(data)) : content] as const)), { root: project.root });
}

test('events: wrong target kind, unknown screen, value type, undeclared object event', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/simulation.json');
  s.events[0].on.name = 'nope';
  s.events.push({ id: 'bad', on: { type: 'click', target: 'simulation-consigne' }, do: [{ type: 'go-to', screen: 'nowhere' }, { type: 'set-variable', variable: 'bonsReflexes', value: 'trois' }] });
  writeJSON(dir, 'screens/simulation.json', s);
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_OBJECT_EVENT_UNDECLARED', 'E_EVENT_TARGET', 'E_ACTION_TARGET', 'E_VARIABLE_TYPE']) assert.ok(c.includes(code), code);
});

test('events: one without actions is valid, with a warning; with conditions, else may hold them', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/simulation.json');
  s.events.push({ id: 'simulation-vide', on: { type: 'screen.enter' }, do: [] });
  s.events.push({ id: 'simulation-sinon', on: { type: 'screen.enter' }, if: [{ variable: 'indiceVu', op: 'eq', value: true }], do: [], else: [{ type: 'set-variable', variable: 'indiceVu', value: true }] });
  writeJSON(dir, 'screens/simulation.json', s);
  const d = validateDir(dir).diagnostics;
  assert.equal(d.filter((x) => x.severity === 'error').length, 0, JSON.stringify(d.filter((x) => x.severity === 'error')));
  assert.deepEqual(d.filter((x) => x.code === 'W_EVENT_NO_ACTION').map((x) => [x.target, x.path]), [['simulation-vide', `/events/${s.events.length - 2}/do`]]);
});

test('events: hide-layer without a layer closes the open one, on a screen that has a layer', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.layers = [{ id: 'chemin-detail', title: 'Détail', blocks: [
    { id: 'chemin-detail-t', type: 'text', props: { markdown: 'Détail.' } },
    { id: 'chemin-detail-fermer', type: 'button', props: { label: 'Fermer' } }
  ] }];
  s.events = [
    { id: 'ouvrir', on: { type: 'screen.enter' }, do: [{ type: 'show-layer', layer: 'chemin-detail' }] },
    { id: 'fermer', on: { type: 'click', target: 'chemin-detail-fermer' }, do: [{ type: 'hide-layer' }] }
  ];
  writeJSON(dir, 'screens/chemin.json', s);
  let d = validateDir(dir).diagnostics;
  assert.deepEqual(d.filter((x) => x.severity === 'error').map((x) => x.message), []);
  // Without a layer on the screen, there is nothing to close.
  s.layers = [];
  s.events = [{ id: 'fermer', on: { type: 'screen.enter' }, do: [{ type: 'hide-layer' }] }];
  writeJSON(dir, 'screens/chemin.json', s);
  d = validateDir(dir).diagnostics;
  assert.deepEqual(d.filter((x) => x.code === 'E_ACTION_TARGET').map((x) => [x.path, x.message]), [['/events/0/do/0', 'hide-layer: screen "chemin" has no layer to close.']]);
  // show-layer still names its layer.
  s.layers = [{ id: 'chemin-detail', title: 'Détail', blocks: [{ id: 'chemin-detail-t', type: 'text', props: { markdown: 'Détail.' } }] }];
  s.events = [{ id: 'ouvrir', on: { type: 'screen.enter' }, do: [{ type: 'show-layer' }] }];
  writeJSON(dir, 'screens/chemin.json', s);
  assert.ok(codes(validateDir(dir).diagnostics).includes('E_SCHEMA'));
});

test('events: reveal-step names a step of the screen', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.splice(1, 0, { id: 'chemin-voir', type: 'button', props: { label: 'Voir le schéma' } });
  s.blocks[2].step = 2;
  s.events = [{ id: 'voir', on: { type: 'click', target: 'chemin-voir' }, do: [{ type: 'reveal-step', step: 2 }] }];
  writeJSON(dir, 'screens/chemin.json', s);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_ACTION_TARGET'));
  s.events[0].do[0].step = 3;
  writeJSON(dir, 'screens/chemin.json', s);
  const d = validateDir(dir).diagnostics.find((x) => x.code === 'E_ACTION_TARGET');
  assert.match(d?.message || '', /no block of screen "chemin" has step 3 \(steps: 1, 2\)/);
  delete s.events[0].do[0].step;
  writeJSON(dir, 'screens/chemin.json', s);
  assert.ok(codes(validateDir(dir).diagnostics).includes('E_SCHEMA'), 'step is required');
  // Steps left to the screen's triggers: every step must be reachable.
  s.events[0].do[0].step = 2;
  s.blocks[3].step = 3;
  s.continueRevealsSteps = false;
  writeJSON(dir, 'screens/chemin.json', s);
  const u = validateDir(dir).diagnostics.find((x) => x.code === 'E_STEP_UNREACHABLE');
  assert.match(u?.message || '', /reaches step 3/);
  s.continueRevealsSteps = true;
  writeJSON(dir, 'screens/chemin.json', s);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_STEP_UNREACHABLE'));
});

test('events: named controls of components and visited conditions', () => {
  const dir = copyExample();
  addExplorer(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(
    { id: 'chemin-marques', type: 'markers', props: { items: [{ id: 'poste', label: 'Le poste' }, { id: 'switch', label: 'Le commutateur' }] } },
    { id: 'chemin-facettes', type: 'facets', props: { items: [{ id: 'cable', label: 'Câble', body: 'Branché ?' }, { id: 'ip', label: 'Adresse', body: 'Valide ?' }] } }
  );
  s.layers = [{ id: 'chemin-detail', title: 'Détail', blocks: [{ id: 'chemin-detail-t', type: 'text', props: { markdown: 'Détail.' } }] }];
  s.events = [
    { id: 'poste', on: { type: 'click', target: 'chemin-marques', name: 'poste' }, do: [{ type: 'show-layer', layer: 'chemin-detail' }] },
    { id: 'tout-vu', on: { type: 'click', target: 'chemin-facettes' }, if: [{ visited: 'chemin-facettes' }, { visited: 'chemin-marques', name: 'poste' }], do: [{ type: 'complete-screen' }] }
  ];
  writeJSON(dir, 'screens/chemin.json', s);
  let d = validateDir(dir).diagnostics;
  assert.deepEqual(d.filter((x) => x.severity === 'error').map((x) => x.message), []);
  // The marker without its own event is a dead button; tabs act by themselves.
  assert.deepEqual(d.filter((x) => x.code === 'W_DEAD_BUTTON').map((x) => x.message), ['markers "chemin-marques" has a button named "switch" but no click event for it.']);
  // Names are checked against the rendered instance (they come from its props here).
  s.events[0].on.name = 'routeur';
  s.events[1].if = [{ visited: 'chemin-intro' }, { visited: 'chemin-facettes', name: 'dns' }, { visited: 'nulle-part' }];
  writeJSON(dir, 'screens/chemin.json', s);
  d = validateDir(dir).diagnostics;
  assert.match(d.find((x) => x.code === 'E_EVENT_TARGET')?.message || '', /markers "chemin-marques" has no control named "routeur" \(controls: poste, switch\)/);
  assert.deepEqual(d.filter((x) => x.code === 'E_VISITED_TARGET').map((x) => x.message), ['visited: text "chemin-intro" has no control the learner could use (button, tab, disclosure, sequence item, flip card, details, element brought into view).', 'visited: facets "chemin-facettes" has no control named "dns" (controls: cable, ip).']);
  assert.ok(d.some((x) => x.code === 'E_UNKNOWN_REFERENCE' && /nulle-part/.test(x.message)));
  // A condition is either a variable test or a visited state.
  s.events[1].if = [{ visited: 'chemin-facettes', variable: 'indiceVu', op: 'eq', value: true }];
  writeJSON(dir, 'screens/chemin.json', s);
  assert.ok(codes(validateDir(dir).diagnostics).includes('E_SCHEMA'));
  // Names: literal in the template, or rendered from props.
  s.events[1].if = [{ visited: 'chemin-facettes' }];
  s.blocks.at(-2).props.items[1].id = 'Le switch';
  writeJSON(dir, 'screens/chemin.json', s);
  assert.match(validateDir(dir).diagnostics.find((x) => x.code === 'E_COMPONENT_HOOK')?.message || '', /renders data-t-click="Le switch"/);
  fs.writeFileSync(path.join(dir, 'components/markers/template.html'), '<ul><li data-each="items"><button data-t-click="Voir">{{label}}</button></li></ul>');
  assert.ok(validateDir(dir).diagnostics.some((x) => x.code === 'E_COMPONENT_HOOK' && /data-t-click="Voir"/.test(x.message)));
});

test('free object code: forbidden APIs and non-determinism are errors', () => {
  const dir = copyExample();
  fs.appendFileSync(path.join(dir, 'objects/diagnostic-reseau/object.js'), "\nconst x = Math.random() + Date.now(); fetch('https://example.com'); localStorage.x = 1;\n");
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_OBJECT_FORBIDDEN_API', 'E_OBJECT_NONDETERMINISM', 'E_EXTERNAL_RESOURCE']) assert.ok(c.includes(code), code);
});

test('free object code: XML namespace names are not external resources', () => {
  const dir = copyExample();
  fs.appendFileSync(path.join(dir, 'objects/diagnostic-reseau/object.js'), "\nexport const svgNode = (tag) => document.createElementNS('http://www.w3.org/2000/svg', tag);\n");
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_EXTERNAL_RESOURCE'));
});

test('free object props bind to custom tokens with hyphens (x-token)', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.theme.custom = { ...(course.theme.custom || {}), 'color.deep-sea': '#0F2A47' };
  writeJSON(dir, 'course.json', course);
  const m = readJSON(dir, 'objects/diagnostic-reseau/object.manifest.json');
  m.props.properties.accentColor['x-token'] = 'color.deep-sea';
  writeJSON(dir, 'objects/diagnostic-reseau/object.manifest.json', m);
  const c = codes(validateDir(dir).diagnostics);
  assert.ok(!c.includes('E_SCHEMA') && !c.includes('E_OBJECT_TOKEN'), c.join(', '));
});

test('free object props are validated against the manifest', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/simulation.json');
  s.blocks[1].props.props.packetSpeed = 9;
  s.blocks[1].props.props.unknown = 1;
  writeJSON(dir, 'screens/simulation.json', s);
  const d = validateDir(dir).diagnostics.filter((x) => x.code === 'E_OBJECT_PROP_VALUE');
  assert.equal(d.length, 2);
});

// A list prop for the example object: devices the packets stop at, with a note (a field called
// description, which is a name here, not an annotation).
const STOPS = {
  type: 'array', title: 'Étapes', description: 'Équipements où les paquets s’arrêtent', 'x-group': 'Scénario', 'x-control': 'list', maxItems: 4,
  items: {
    type: 'object', title: 'Étape', required: ['device'],
    properties: {
      device: { type: 'string', title: 'Équipement', enum: ['commutateur', 'routeur', 'parefeu', 'serveur'], 'x-control': 'select' },
      description: { type: 'string', title: 'Note', maxLength: 40, default: 'À vérifier', 'x-translatable': true }
    }
  },
  default: [{ device: 'routeur', description: 'Premier saut' }]
};
const withStops = (dir: string, stops: object = STOPS): void => {
  const m = readJSON(dir, 'objects/diagnostic-reseau/object.manifest.json');
  m.props.properties.stops = structuredClone(stops);
  writeJSON(dir, 'objects/diagnostic-reseau/object.manifest.json', m);
};

test('free object list props: every item is checked against the items of the manifest', () => {
  const dir = copyExample();
  withStops(dir);
  assert.deepEqual(validateDir(dir).diagnostics.filter((d) => d.severity === 'error'), []);
  const s = readJSON(dir, 'screens/simulation.json');
  s.blocks[1].props.props.stops = [{ device: 'parefeu', description: 'Ici' }, { device: 'imprimante' }, { device: 'serveur', couleur: 'rouge' }, { description: 'Sans équipement' }, { device: 'routeur' }];
  writeJSON(dir, 'screens/simulation.json', s);
  const d = validateDir(dir).diagnostics.filter((x) => x.code === 'E_OBJECT_PROP_VALUE');
  assert.equal(d.length, 1, 'one finding per prop');
  assert.match(d[0].path ?? '', /\/props\/props\/stops/);
  for (const part of [/\/1\/device must be equal to one of the allowed values/, /\/2 must NOT have additional properties \("couleur"\)/, /\/3 must have required property 'device'/, /must NOT have more than 4 items/]) assert.match(d[0].message, part);
});

test('free object list props: defaults of the list and of its fields match the items', () => {
  const dir = copyExample();
  const stops = structuredClone(STOPS);
  stops.default = [{ device: 'routeur', description: 'Une note bien trop longue pour tenir dans la ligne' }];
  stops.items.properties.description.default = 'Une autre note bien trop longue pour la ligne';
  withStops(dir, stops);
  const d = validateDir(dir).diagnostics.filter((x) => x.code === 'E_OBJECT_PROP_DEFAULT');
  assert.deepEqual(d.map((x) => x.path).sort(), ['/props/properties/stops/default', '/props/properties/stops/items/properties/description/default']);
});

test('editor controls fit their props (W_OBJECT_PROP_CONTROL)', () => {
  const dir = copyExample();
  const stops = structuredClone(STOPS);
  (stops.items.properties.description as Record<string, unknown>)['x-control'] = 'toggle';
  withStops(dir, stops);
  const m = readJSON(dir, 'objects/diagnostic-reseau/object.manifest.json');
  m.props.properties.packetSpeed['x-control'] = 'list';
  m.props.properties.hintAfterErrors['x-control'] = 'slider';
  delete m.props.properties.hintAfterErrors.maximum;
  m.props.properties.showLabels['x-control'] = 'select';
  writeJSON(dir, 'objects/diagnostic-reseau/object.manifest.json', m);
  const d = validateDir(dir).diagnostics.filter((x) => x.code === 'W_OBJECT_PROP_CONTROL');
  assert.deepEqual(d.map((x) => x.path).sort(), [
    '/props/properties/hintAfterErrors/x-control', '/props/properties/packetSpeed/x-control', '/props/properties/showLabels/x-control', '/props/properties/stops/items/properties/description/x-control'
  ]);
  assert.match(d.find((x) => x.path === '/props/properties/packetSpeed/x-control')?.message ?? '', /edits array values, not a number/);
  // A colour of the scene with a literal default needs no token, and an integer range is a select.
  m.props.properties.packetSpeed['x-control'] = 'slider';
  m.props.properties.hintAfterErrors.maximum = 5;
  m.props.properties.hintAfterErrors['x-control'] = 'select';
  m.props.properties.showLabels['x-control'] = 'toggle';
  m.props.properties.brassColor = { type: 'string', format: 'color', default: '#C79A45', description: 'Laiton des équipements', 'x-group': 'Matériaux', 'x-control': 'color' };
  m.props.properties.stops.items.properties.description['x-control'] = 'text';
  writeJSON(dir, 'objects/diagnostic-reseau/object.manifest.json', m);
  const after = codes(validateDir(dir).diagnostics);
  assert.ok(!after.includes('W_OBJECT_PROP_CONTROL') && !after.includes('E_OBJECT_TOKEN'), after.join(', '));
});

test('range, vec2 and vec3 edit two or three numbers, a range on a scale, low first (W_OBJECT_PROP_CONTROL)', () => {
  const dir = copyExample();
  const mf = 'objects/diagnostic-reseau/object.manifest.json';
  const m = readJSON(dir, mf);
  const numbers = (count: number, items: Record<string, unknown> = {}) => ({ type: 'array', items: { type: 'number', ...items }, minItems: count, maxItems: count });
  m.props.properties.window = { ...numbers(2, { minimum: 0, maximum: 24, multipleOf: 0.5 }), default: [8, 18], description: 'Heures d’ouverture', 'x-control': 'range' };
  m.props.properties.anchor = { ...numbers(2), default: [0.5, 0.25], description: 'Point d’ancrage', 'x-control': 'vec2' };
  m.props.properties.routerPosition['x-control'] = 'vec3';
  writeJSON(dir, mf, m);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('W_OBJECT_PROP_CONTROL'));

  m.props.properties.window = { ...numbers(2), default: [18, 8], description: 'Heures d’ouverture', 'x-control': 'range' };
  m.props.properties.anchor = { ...numbers(3), default: [0, 0, 0], description: 'Point d’ancrage', 'x-control': 'vec2' };
  m.props.properties.routerPosition.maxItems = 4;
  m.props.properties.instruction['x-control'] = 'range';
  m.props.properties.late = { ...numbers(2, { minimum: 0, maximum: 24 }), default: [18, 8], description: 'Heures du soir', 'x-control': 'range' };
  writeJSON(dir, mf, m);
  const d = validateDir(dir).diagnostics.filter((x) => x.code === 'W_OBJECT_PROP_CONTROL');
  const message = (prop: string) => d.find((x) => x.path === `/props/properties/${prop}/x-control`)?.message ?? '';
  assert.deepEqual(d.map((x) => x.path).sort(), ['anchor', 'instruction', 'late', 'routerPosition', 'window'].map((prop) => `/props/properties/${prop}/x-control`));
  assert.match(message('window'), /needs its scale: items with a minimum and a maximum/);
  assert.match(message('late'), /low then a high value/);
  assert.match(message('anchor'), /"vec2" edits two numbers/);
  assert.match(message('routerPosition'), /"vec3" edits three numbers/);
  assert.match(message('instruction'), /"range" edits array values, not a string/);
});

test('words of the choices (x-enum-labels, a block\'s props.enumLabels) only word values of their enum (E_OBJECT_ENUM_LABELS)', () => {
  const dir = copyExample();
  const stops = structuredClone(STOPS);
  (stops.items.properties.device as Record<string, unknown>)['x-enum-labels'] = { parefeu: 'Pare-feu', imprimante: 'Imprimante' };
  withStops(dir, stops);
  const mf = 'objects/diagnostic-reseau/object.manifest.json';
  const m = readJSON(dir, mf);
  m.props.properties.failingDevice['x-enum-labels'] = { parefeu: 'Pare-feu', wifi: 'Borne Wi-Fi' };
  m.props.properties.packetSpeed['x-enum-labels'] = { 1: 'Normale' };
  writeJSON(dir, mf, m);
  const s = readJSON(dir, 'screens/simulation.json');
  s.blocks[1].props.enumLabels = { failingDevice: { parefeu: 'Firewall', modem: 'Modem' }, 'stops.device': { routeur: 'Router' }, packetSpeed: { 1: 'Normal' } };
  writeJSON(dir, 'screens/simulation.json', s);
  const d = validateDir(dir).diagnostics.filter((x) => x.code === 'E_OBJECT_ENUM_LABELS');
  assert.deepEqual(d.map((x) => `${x.file} ${x.path}`).sort(), [
    'objects/diagnostic-reseau/object.manifest.json /props/properties/failingDevice/x-enum-labels/wifi',
    'objects/diagnostic-reseau/object.manifest.json /props/properties/packetSpeed/x-enum-labels',
    'objects/diagnostic-reseau/object.manifest.json /props/properties/stops/items/properties/device/x-enum-labels/imprimante',
    'screens/simulation.json /blocks/1/props/enumLabels/failingDevice/modem',
    'screens/simulation.json /blocks/1/props/enumLabels/packetSpeed'
  ]);
  assert.match(d.find((x) => x.path?.endsWith('/wifi'))?.message ?? '', /"wifi" is not a value of prop "failingDevice" \(values: "commutateur", "routeur", "parefeu", "serveur"\)/);
  assert.match(d.find((x) => x.path?.endsWith('/enumLabels/packetSpeed'))?.message ?? '', /with choices: failingDevice, stops.device/);
  // Values of their enum only, numbers written as text: no error.
  delete m.props.properties.failingDevice['x-enum-labels'].wifi;
  delete m.props.properties.packetSpeed['x-enum-labels'];
  m.props.properties.hintAfterErrors.enum = [1, 2, 3];
  m.props.properties.hintAfterErrors['x-enum-labels'] = { 1: 'Dès la première erreur' };
  m.props.properties.stops.items.properties.device['x-enum-labels'] = { parefeu: 'Pare-feu' };
  writeJSON(dir, mf, m);
  s.blocks[1].props.enumLabels = { failingDevice: { parefeu: 'Firewall' }, 'stops.device': { routeur: 'Router' }, hintAfterErrors: { 2: 'After two' } };
  writeJSON(dir, 'screens/simulation.json', s);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_OBJECT_ENUM_LABELS'));
});

test('colours an object draws text in keep their contrast (x-text-on), with the defaults and with each block', () => {
  const dir = copyExample();
  const mf = 'objects/diagnostic-reseau/object.manifest.json';
  const m = readJSON(dir, mf);
  const colour = (fallback: string, extra: object = {}) => ({ type: 'string', format: 'color', default: fallback, description: 'Couleur', 'x-group': 'Style', 'x-control': 'color', ...extra });
  m.props.properties.paperColor = colour('#F4EBD6');
  m.props.properties.labelColor = colour('#2A1F14', { 'x-text-on': 'paperColor' });
  m.props.properties.captionColor = colour('#52606D', { 'x-text-on': 'color.surface' });
  writeJSON(dir, mf, m);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_OBJECT_TEXT_CONTRAST'));
  // The manifest's own defaults, and a reference to nothing.
  m.props.properties.labelColor.default = '#D9CBAE';
  m.props.properties.captionColor['x-text-on'] = 'color.paper';
  writeJSON(dir, mf, m);
  let d = validateDir(dir).diagnostics.filter((x) => x.code === 'E_OBJECT_TEXT_CONTRAST');
  assert.deepEqual(d.map((x) => x.path).sort(), ['/props/properties/captionColor/x-text-on', '/props/properties/labelColor/default']);
  assert.match(d.find((x) => x.path?.endsWith('/default'))?.message ?? '', /labelColor #D9CBAE on paperColor #F4EBD6: 1\.\d\d:1, under 4\.5:1/);
  // A block that darkens the paper, and an event that lightens the caption.
  m.props.properties.labelColor.default = '#2A1F14';
  m.props.properties.captionColor['x-text-on'] = 'color.surface';
  writeJSON(dir, mf, m);
  const s = readJSON(dir, 'screens/simulation.json');
  s.blocks[1].props.props.paperColor = '#3A3A3A';
  s.events.push({ id: 'simulation-pale', on: { type: 'object.event', target: 'simulation-scene', name: 'hint_shown' }, do: [{ type: 'set-object-props', block: 'simulation-scene', props: { captionColor: '#EEEEEE' } }] });
  writeJSON(dir, 'screens/simulation.json', s);
  d = validateDir(dir).diagnostics.filter((x) => x.code === 'E_OBJECT_TEXT_CONTRAST');
  assert.equal(d.length, 2, JSON.stringify(d));
  assert.ok(d.some((x) => x.file === 'screens/simulation.json' && /props\/props\/paperColor$/.test(x.path ?? '') && x.target === 'simulation-scene'));
  assert.ok(d.some((x) => x.target === 'simulation-pale' && /props\/captionColor$/.test(x.path ?? '')));
});

test('object tests give the props values the manifest accepts', () => {
  const dir = copyExample();
  withStops(dir);
  const tf = 'objects/diagnostic-reseau/object.tests.json';
  const t = readJSON(dir, tf);
  t.tests[0].props = { packetSpeed: 9, stops: [{ device: 'routeur' }] };
  t.tests[0].steps.unshift({ action: 'set-props', props: { stops: [{ device: 'modem' }] } });
  writeJSON(dir, tf, t);
  const d = validateDir(dir).diagnostics.filter((x) => x.code === 'E_OBJECT_PROP_VALUE');
  assert.deepEqual(d.map((x) => `${x.file} ${x.path}`).sort(), [`${tf} /tests/0/props/packetSpeed`, `${tf} /tests/0/steps/0/props/stops/0/device`]);
});

test('suspend data budget follows the strictest selected profile', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  for (let i = 0; i < 6; i++) course.variables.push({ id: `note${i}`, type: 'string', default: '', maxLength: 400 });
  writeJSON(dir, 'course.json', course);
  assert.ok(codes(validateDir(dir, { profiles: ['moodle'] }).diagnostics).includes('E_SUSPEND_DATA_BUDGET'));
  assert.ok(!codes(validateDir(dir, { profiles: ['successfactors'] }).diagnostics).includes('E_SUSPEND_DATA_BUDGET'));
});

test('waivers turn a pedagogical finding into an approved exception', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push({ id: 'chemin-btn', type: 'button', props: { label: 'Voir' } });
  writeJSON(dir, 'screens/chemin.json', s);
  const plan = readJSON(dir, 'plan.json');
  plan.waivers = [{ code: 'W_DEAD_BUTTON', target: 'chemin-btn', reason: 'Bouton de démonstration', approvedBy: 'Client' }];
  writeJSON(dir, 'plan.json', plan);
  const d = validateDir(dir).diagnostics.find((x) => x.code === 'W_DEAD_BUTTON');
  assert.ok(d?.waived);
});

test('object strings: rewordings match the manifest; other languages and undeclared keys are reported', () => {
  const dir = copyExample();
  const mf = 'objects/diagnostic-reseau/object.manifest.json';
  const m = readJSON(dir, mf);
  m.language = 'en';
  m.strings = { found: { text: 'Fault found in {n, plural, one {# step} other {# steps}}', description: 'Status line' }, hint: { text: 'Check the path in order.' } };
  writeJSON(dir, mf, m);
  fs.appendFileSync(path.join(dir, 'objects/diagnostic-reseau/object.js'), "\nexport const label = (ctx) => ctx.t('missingKey');\n");
  const s = readJSON(dir, 'screens/simulation.json');
  const b = s.blocks.find((x: Block) => x.type === 'free-object');
  b.props.strings = { found: 'Panne trouvée en {count} étapes', nope: 'x' };
  writeJSON(dir, 'screens/simulation.json', s);
  const d = validateDir(dir).diagnostics;
  const msgs = d.filter((x) => x.code === 'E_OBJECT_STRINGS').map((x) => x.message).join(' | ');
  assert.match(msgs, /"nope" is not declared/);
  assert.match(msgs, /placeholders \{count\} instead of \{n\}/);
  assert.ok(codes(d).includes('W_OBJECT_STRINGS_LANGUAGE'), 'course in fr, manifest in en, "hint" not reworded');
  assert.ok(codes(d).includes('W_OBJECT_STRING_UNDECLARED'));
});

test('backdrop: variants and the decorative object are checked; decorations stay out of blocks', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.theme.backdrop = { layers: ['far', 'near'], variants: { dim: 'Darker' }, object: { id: 'diagnostic-reseau' } };
  writeJSON(dir, 'course.json', course);
  const s = readJSON(dir, 'screens/accueil.json');
  s.backdrop = 'bright';
  writeJSON(dir, 'screens/accueil.json', s);
  let c = codes(validateDir(dir).diagnostics);
  assert.ok(c.includes('E_BACKDROP_VARIANT'));
  assert.ok(c.includes('E_BACKDROP_OBJECT'), 'a scored simulation is not a decoration');
  // Made a decoration, the same object may not sit in a block any more.
  const mf = 'objects/diagnostic-reseau/object.manifest.json';
  const m = readJSON(dir, mf);
  m.pedagogicalRole = 'decoration';
  m.events = [];
  delete m.planRefs;
  writeJSON(dir, mf, m);
  s.backdrop = 'dim';
  writeJSON(dir, 'screens/accueil.json', s);
  c = codes(validateDir(dir).diagnostics);
  assert.ok(!c.includes('E_BACKDROP_VARIANT') && !c.includes('E_BACKDROP_OBJECT'), c.join(', '));
  assert.ok(c.includes('E_OBJECT_DECORATION'));
});

test('player labels: a course language without built-in labels must give them in course.ui', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.language = 'ja';
  writeJSON(dir, 'course.json', course);
  assert.ok(codes(validateDir(dir).diagnostics).includes('W_UI_LABELS_LANGUAGE'));
});

// The same findings, whatever their order.
const findings = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => JSON.stringify(d)).sort();

test('validateScreen: the findings of one screen; with the project checks, those of validateProject', () => {
  const names = [...FILE_CHECKS, ...COURSE_CHECKS].map((check) => check.name);
  assert.equal(new Set(names).size, names.length, 'check names are unique');

  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  delete s.blocks[1].props.alt;
  s.covers.push('ITEM-9');
  s.blocks.push({ id: 'chemin-voir', type: 'button', props: { label: 'Voir' } });
  writeJSON(dir, 'screens/chemin.json', s);
  writeJSON(dir, 'screens/brouillon.json', { id: 'brouillon', title: 'Brouillon', covers: [], blocks: [{ id: 'brouillon-texte', type: 'text', props: {} }] });
  for (const course of [dir, ...['planetary-gearset', 'orbital-rendezvous'].map((name) => copyExample(path.join(ROOT, 'examples', name)))]) {
    const project = loadProjectFromDir(course);
    const context = createValidationContext(project);
    const parts = [...validateProjectChecks(context), ...[...project.screens.keys()].flatMap((id) => validateScreen(context, id))];
    assert.deepEqual(findings(parts), findings(validateProject(project).diagnostics), course);
  }

  const context = createValidationContext(loadProjectFromDir(dir));
  const chemin = codes(validateScreen(context, 'chemin'));
  for (const code of ['E_IMAGE_ALT_MISSING', 'E_PLAN_REFERENCE', 'W_DEAD_BUTTON']) assert.ok(chemin.includes(code), code);
  assert.ok(!codes(validateScreen(context, 'accueil')).includes('E_IMAGE_ALT_MISSING'));
  // A screen course.json does not list: the checks of its file only.
  assert.deepEqual(codes(validateScreen(context, 'brouillon')).sort(), ['E_SCHEMA', 'W_SCREEN_FILE_UNUSED']);
  assert.deepEqual(validateScreen(context, 'nowhere'), []);
});

test('checks read documents that fail their schema without throwing', () => {
  const cases: [string, (dir: string) => void][] = [
    ['covers as a string', (dir) => { const s = readJSON(dir, 'screens/chemin.json'); s.covers = 'ITEM-1'; writeJSON(dir, 'screens/chemin.json', s); }],
    ['actions as a string, a null condition', (dir) => { const s = readJSON(dir, 'screens/simulation.json'); s.events[0].do = 'go'; s.events[1].if = [null]; writeJSON(dir, 'screens/simulation.json', s); }],
    ['alt text and heading text as numbers', (dir) => { const s = readJSON(dir, 'screens/chemin.json'); s.blocks[1].props.alt = 42; s.blocks.push({ id: 'chemin-titre', type: 'heading', props: { text: 7, level: 2 } }); writeJSON(dir, 'screens/chemin.json', s); }],
    ['quiz options as a string', (dir) => { const s = readJSON(dir, 'screens/evaluation.json'); s.blocks.push({ id: 'evaluation-q3', type: 'quiz', props: { stem: 'Où ?', mode: 'single', options: 'abc' } }); writeJSON(dir, 'screens/evaluation.json', s); }],
    ['plan sources as a string', (dir) => { const plan = readJSON(dir, 'plan.json'); plan.items[0].sources = 'SRC-1'; plan.waivers = 'none'; writeJSON(dir, 'plan.json', plan); }],
    ['a colour token as a number', (dir) => { const course = readJSON(dir, 'course.json'); course.theme.tokens['color.text'] = 42; writeJSON(dir, 'course.json', course); }],
    ['a null provenance entry (a file without schema)', (dir) => writeFixture(dir, 'generators/provenance.json', { format: 'elabora-generated/1', assets: { 'x.svg': null } })],
    ['a null component example', (dir) => { addExplorer(dir); const m = readJSON(dir, 'components/markers/component.json'); m.examples = [null]; writeJSON(dir, 'components/markers/component.json', m); }]
  ];
  for (const [what, mutate] of cases) {
    const dir = copyExample();
    mutate(dir);
    let found: string[] = [];
    assert.doesNotThrow(() => { found = codes(validateDir(dir).diagnostics); }, what);
    if (!what.includes('without schema')) assert.ok(found.includes('E_SCHEMA'), what);
  }
});

test('a free object placed on no screen has its own warning', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/simulation.json');
  s.blocks = s.blocks.filter((block: Block) => block.type !== 'free-object');
  s.events = [];
  writeJSON(dir, 'screens/simulation.json', s);
  const unused = validateDir(dir).diagnostics.filter((d) => d.code === 'W_OBJECT_UNUSED');
  assert.deepEqual(unused.map((d) => [d.file, d.target, d.message]), [['objects/diagnostic-reseau/object.manifest.json', 'diagnostic-reseau', 'Free object "diagnostic-reseau" is not placed on any screen.']]);
  assert.ok(!validateDir(dir).diagnostics.some((d) => d.code === 'W_SCREEN_FILE_UNUSED'));
});

test('text density follows the presentation: a slide is read at once, a scroll page by stretches', () => {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/chemin.json');
  const words = (count: number) => Array.from({ length: count }, (_, index) => `mot${index}`).join(' ');
  // Five paragraphs of 110 words after the accordion: 550 words to read in a row.
  for (let n = 1; n <= 5; n++) screen.blocks.push({ id: `chemin-long-${n}`, type: 'text', props: { markdown: words(110) } });
  writeJSON(dir, 'screens/chemin.json', screen);
  const density = () => validateDir(dir).diagnostics.filter((d) => d.code === 'W_TEXT_DENSITY' && d.target === 'chemin');
  // Scroll presentation (the example's): the longest stretch without anything to do.
  let found = density();
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].message, /550 words to read in a row, from "chemin-long-1" to "chemin-long-5"/);
  // A check in the middle breaks the stretch: two short stretches are fine.
  screen.blocks.splice(screen.blocks.length - 2, 0, { id: 'chemin-check', type: 'quiz', props: { stem: 'Quel équipement relie les réseaux ?', mode: 'single', scored: false, options: [
    { id: 'a', text: 'Le routeur', correct: true, feedback: 'Oui : il relie les réseaux.' },
    { id: 'b', text: 'Le switch', correct: false, feedback: 'Non : il relie les postes d’un même réseau.' },
    { id: 'c', text: 'Le câble', correct: false, feedback: 'Non : il ne fait que transporter le signal.' }
  ] } });
  writeJSON(dir, 'screens/chemin.json', screen);
  assert.deepEqual(density(), []);
  // A page of more than 1,500 words is two lessons, whatever its activities.
  // (an accordion every three paragraphs keeps each stretch short)
  for (let n = 6; n <= 16; n++) {
    if (n % 3 === 0) screen.blocks.push({ id: `chemin-open-${n}`, type: 'accordion', props: { items: [{ id: 'detail', title: 'Détail', markdown: 'Un détail.' }] } });
    screen.blocks.push({ id: `chemin-long-${n}`, type: 'text', props: { markdown: words(110) } });
  }
  writeJSON(dir, 'screens/chemin.json', screen);
  found = density();
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0].message, /two lessons rather than one/);
  // Slides: the screen as a whole, 250 words at most.
  const course = readJSON(dir, 'course.json');
  course.presentation = { mode: 'slides' };
  writeJSON(dir, 'course.json', course);
  found = density();
  assert.equal(found.length, 1);
  assert.match(found[0].message, /^Screen "chemin" shows about \d+ words\.$/);
});

test('text density: a component\'s alternative text is not reading, its caption is', () => {
  const dir = copyExample();
  const words = (count: number) => Array.from({ length: count }, (_, index) => `mot${index}`).join(' ');
  fs.mkdirSync(path.join(dir, 'components/figure-caption'), { recursive: true });
  writeJSON(dir, 'components/figure-caption/component.json', { $schema: 'https://elabora.studio/schemas/0.1.1/component.schema.json', id: 'figure-caption', title: 'Figure', version: '1.0.0', level: 'block', category: 'media', description: 'Une image et sa légende.',
    props: { type: 'object', additionalProperties: false, required: ['image', 'alt', 'caption'], properties: {
      image: { type: 'string', 'x-kind': 'asset' }, alt: { type: 'string', 'x-translatable': true }, caption: { type: 'string', 'x-translatable': true } } } });
  fs.writeFileSync(path.join(dir, 'components/figure-caption/template.html'), '<figure class="figure-caption"><img src="{{image}}" alt="{{alt}}"><figcaption>{{caption}}</figcaption></figure>\n');
  fs.writeFileSync(path.join(dir, 'components/figure-caption/component.css'), '.figure-caption { margin: 0; }\n');
  const screen = readJSON(dir, 'screens/chemin.json');
  // 440 words in a row, then a figure: 5 words of caption keep the stretch under 450, its 30 words of alt do not count.
  for (let n = 1; n <= 4; n++) screen.blocks.push({ id: `chemin-long-${n}`, type: 'text', props: { markdown: words(110) } });
  screen.blocks.push({ id: 'chemin-figure', type: 'figure-caption', props: { image: 'assets/images/chemin-impression.svg', alt: words(30), caption: words(5) } });
  writeJSON(dir, 'screens/chemin.json', screen);
  const density = () => validateDir(dir).diagnostics.filter((d) => d.code === 'W_TEXT_DENSITY' && d.target === 'chemin');
  assert.deepEqual(density(), []);
  // A caption is read: 15 words of it take the stretch past 450.
  screen.blocks.at(-1).props.caption = words(15);
  writeJSON(dir, 'screens/chemin.json', screen);
  assert.match(density()[0]?.message ?? '', /455 words to read in a row/);
});

test('step settings: only for steps of the screen after the first; opening once answered needs an activity above', () => {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.blocks.find((block: Block) => block.id === 'chemin-regle').step = 2;
  screen.blocks.find((block: Block) => block.id === 'chemin-roles').step = 3;
  screen.steps = { 1: { label: 'Commencer' }, 2: { opens: 'answered' }, 5: { opens: 'continue' } };
  writeJSON(dir, 'screens/chemin.json', screen);
  const found = validateDir(dir).diagnostics.filter((d) => d.target === 'chemin' && /STEP/.test(d.code)).map((d) => `${d.code} ${d.path}`).sort();
  assert.deepEqual(found, ['E_STEP_UNREACHABLE /steps/2/opens', 'W_STEP_SETTING_UNUSED /steps/1', 'W_STEP_SETTING_UNUSED /steps/5']);
  // An activity in step 1: step 2 opens once it is answered, also when Continue is left to events.
  screen.blocks.splice(1, 0, { id: 'chemin-check', type: 'quiz', props: { stem: 'Quel équipement relie les réseaux ?', mode: 'single', scored: false, options: [
    { id: 'a', text: 'Le routeur', correct: true, feedback: 'Oui : il relie les réseaux.' },
    { id: 'b', text: 'Le switch', correct: false, feedback: 'Non : il relie les postes d’un même réseau.' },
    { id: 'c', text: 'Le câble', correct: false, feedback: 'Non : il transporte seulement le signal.' }
  ] } });
  screen.steps = { 2: { opens: 'answered' } };
  screen.continueRevealsSteps = false;
  screen.events = [...(screen.events || []), { id: 'chemin-open-roles', on: { type: 'click', target: 'chemin-roles' }, do: [{ type: 'reveal-step', step: 3 }] }];
  writeJSON(dir, 'screens/chemin.json', screen);
  const again = validateDir(dir).diagnostics.filter((d) => d.target === 'chemin' && /STEP/.test(d.code)).map((d) => `${d.code} ${d.message}`);
  assert.deepEqual(again, []);
});
