import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDir } from '@elabora/node/project-reader';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { parseTemplate, renderTemplate, analyzeTemplate } from '@elabora/core/components/template';
import { getRegistry, BUILTINS } from '@elabora/core/components/registry';
import { fallbackBlocks } from '@elabora/core/components/fallback';
import { checkTemplate } from '@elabora/core/validate/components';
import { createReporter } from '@elabora/core/diagnostics/index';
import { exportLessonMd } from '@elabora/node/lesson-md';
import type { Block, PlanItem, PlanQuestion, PlanQuestionOption } from '@elabora/format';
import { ROOT, copyExample, readJSON, writeJSON, writeFixture as write, codes } from '../helpers.ts';
import { build } from '@elabora/node/build';
import * as edit from '@elabora/node/edit';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-comp-'));
const errors = (dir: string) => validateDir(dir).diagnostics.filter((d) => d.severity === 'error');

// A small card component with a list, a token, a slot and an explicit fallback.
function addCard(dir: string, extra: Record<string, unknown> = {}) {
  write(dir, 'components/key-card/component.json', {
    id: 'key-card', title: 'Key card', version: '1.0.0',
    props: { type: 'object', additionalProperties: false, required: ['title'], properties: {
      title: { type: 'string', maxLength: 80, 'x-translatable': true },
      body: { type: 'string', 'x-kind': 'markdown' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' } } } },
      accent: { type: 'string', 'x-kind': 'token', default: 'color.accent' }
    } },
    slots: [{ id: 'more', label: 'More', accepts: ['text', 'image'] }],
    fallback: [{ type: 'text', props: { markdown: '**{{title}}**\n\n{{body}}{{#steps}}\n- {{label}}{{/steps}}' } }, { $slot: 'more' }],
    ...extra
  });
  write(dir, 'components/key-card/template.html', '<div class="kc" style="--kc: {{accent}}"><h2>{{title}}</h2><div class="t-text" data-if="body">{{body}}</div><ol data-if="steps"><li data-each="steps">{{label}}</li></ol><button data-t-toggle="more">{{title}}</button><div data-t-part="more"><div data-slot="more"></div></div></div>');
  write(dir, 'components/key-card/component.css', '.kc { border-top: 4px solid var(--kc); }');
}
const card = (id: string, props: Record<string, unknown> = {}, blocks?: Block[]): Block => ({ id, type: 'key-card', props: { title: 'Ping first', body: 'Check the **link**.', steps: [{ label: 'Cable' }, { label: 'Switch' }], accent: 'color.primary', ...props }, ...(blocks ? { blocks } : {}) });

test('templates: bindings, lists, conditions, Markdown, tokens and escaping', () => {
  const tpl = parseTemplate('<div class="c c--{{size}}" style="--a: {{accent}}"><p data-if="label">{{label}}</p><div>{{body}}</div><ul><li data-each="items" data-if="!hidden">{{@number}} {{name}}</li></ul><img src="{{photo}}" alt=""><h3 data-if="level == 3">{{label}}</h3></div>');
  const schema = { type: 'object', properties: { size: { enum: ['s', 'l'] }, accent: { type: 'string', 'x-kind': 'token' }, label: { type: 'string' }, body: { type: 'string', 'x-kind': 'markdown' }, photo: { type: 'string', 'x-kind': 'asset' }, level: { type: 'integer' }, items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, hidden: { type: 'boolean' } } } } } };
  const r = renderTemplate(tpl, { props: { size: 'l', accent: 'color.copper', label: 'A <b>', body: 'x **y**', photo: 'images/a.png', level: 3, items: [{ name: 'one' }, { name: 'two', hidden: true }] }, schema, id: 'b1' });
  assert.equal(r.html, '<div class="c c--l" style="--a: var(--t-color-copper)"><p>A &lt;b&gt;</p><div><p>x <strong>y</strong></p></div><ul><li>1 one</li></ul><img src="assets/images/a.png" alt=""><h3>A &lt;b&gt;</h3></div>');
  assert.deepEqual(r.headings, [3]);
  const a = analyzeTemplate(tpl, schema);
  assert.deepEqual([...a.usedProps].sort(), ['accent', 'body', 'items', 'label', 'level', 'photo', 'size']);
  assert.equal(a.unknown.length, 0);
  assert.equal(analyzeTemplate(parseTemplate('<p>{{nope}}</p><i data-each="label"></i>'), schema).unknown.length + analyzeTemplate(parseTemplate('<i data-each="label"></i>'), schema).badEach.length, 2);
});

test('built-in templates follow the rules agents follow', () => {
  const project = loadProjectFromDir(copyExample());
  const reg = getRegistry(project);
  for (const id of Object.keys(BUILTINS).filter((t) => BUILTINS[t].render === 'template')) {
    const reporter = createReporter();
    const component = reg.get(id);
    assert.ok(component, id);
    checkTemplate({ project, reporter }, component);
    assert.deepEqual(reporter.items.filter((d) => d.severity !== 'info').map((d) => `${d.code} ${d.message}`), [], id);
  }
});

test('a course component: props, slots, fallback, rendering and stylesheet', async () => {
  const dir = copyExample();
  addCard(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(card('chemin-card', {}, [{ id: 'chemin-card-note', type: 'text', slot: 'more', props: { markdown: 'Then the switch.' } }]));
  writeJSON(dir, 'screens/chemin.json', s);
  assert.deepEqual(errors(dir), []);
  const r = await build(dir, { out: tmp(), emit: 'both' });
  assert.ok(r.ok && r.dirPath, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
  const data = fs.readFileSync(path.join(r.dirPath, 'elabora/course.js'), 'utf8');
  assert.match(data, /"type":"key-card","width":"full","html":"<div class=\\"kc\\" style=\\"--kc: var\(--t-color-primary\)\\"><h2>Ping first<\/h2>/);
  assert.match(data, /"blocks":\[\{"id":"chemin-card-note","type":"text","width":"full","slot":"more","html":"<div class=\\"t-text\\"><p>Then the switch.<\/p><\/div>"\}\]/);
  assert.match(fs.readFileSync(path.join(r.dirPath, 'elabora/theme.css'), 'utf8'), /@import url\("\.\.\/components\/key-card\/component\.css"\) layer\(elabora\.components\);/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'elabora.lock.json'), 'utf8')).components['key-card'], '1.0.0');

  // Instance errors: props, token, slot type, unknown type.
  s.blocks[s.blocks.length - 1].props.accent = 'color.nope';
  s.blocks[s.blocks.length - 1].props.extra = 1;
  s.blocks[s.blocks.length - 1].blocks.push({ id: 'chemin-card-q', type: 'callout', slot: 'more', props: { markdown: 'x' } });
  s.blocks.push({ id: 'chemin-x', type: 'no-such-thing', props: {} });
  writeJSON(dir, 'screens/chemin.json', s);
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_COMPONENT_PROPS', 'E_UNKNOWN_REFERENCE', 'E_COMPONENT_SLOT', 'E_COMPONENT_UNKNOWN']) assert.ok(c.includes(code), code);
});

test('fallback: native blocks with the same text, plan links kept; losses are reported', () => {
  const dir = copyExample();
  addCard(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(card('chemin-card', {}, [{ id: 'chemin-card-note', type: 'text', slot: 'more', props: { markdown: 'Then the switch.' } }]));
  writeJSON(dir, 'screens/chemin.json', s);
  const project = loadProjectFromDir(dir);
  const fb = fallbackBlocks(getRegistry(project), s.blocks[s.blocks.length - 1]);
  assert.deepEqual(fb, [
    { id: 'chemin-card', type: 'text', props: { markdown: '**Ping first**\n\nCheck the **link**.\n- Cable\n- Switch' } },
    { id: 'chemin-card-note', type: 'text', props: { markdown: 'Then the switch.' } }
  ]);
  // A fallback that forgets a prop is reported.
  addCard(dir, { fallback: [{ type: 'text', props: { markdown: '{{title}}' } }] });
  assert.ok(codes(validateDir(dir).diagnostics).includes('W_COMPONENT_FALLBACK_LOSS'));
  // Without fallback, Elabora generates one that carries the text.
  addCard(dir, { fallback: undefined });
  assert.ok(!codes(validateDir(dir).diagnostics).includes('W_COMPONENT_FALLBACK_LOSS'));
});

test('duplicate and detach: copies get new ids; detach keeps the id and the content', () => {
  const dir = copyExample();
  addCard(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(card('chemin-card', {}, [{ id: 'chemin-card-note', type: 'text', slot: 'more', props: { markdown: 'Then the switch.' } }]));
  writeJSON(dir, 'screens/chemin.json', s);
  const d = edit.duplicateBlock(dir, { block: 'chemin-card' });
  assert.equal(d.block, 'chemin-card-copy');
  assert.deepEqual(d.renamed, { 'chemin-card': 'chemin-card-copy', 'chemin-card-note': 'chemin-card-note-copy' });
  let after = readJSON(dir, 'screens/chemin.json');
  assert.equal(after.blocks[after.blocks.length - 1].blocks[0].id, 'chemin-card-note-copy');
  assert.deepEqual(errors(dir), []);
  // Edit the copy only.
  edit.updateBlock(dir, { block: 'chemin-card-copy', props: { title: 'Ping the printer' } });
  // Detach the original: two native text blocks in its place.
  const r = edit.detachBlock(dir, { block: 'chemin-card' });
  assert.deepEqual(r.blocks, ['text:chemin-card', 'text:chemin-card-note']);
  after = readJSON(dir, 'screens/chemin.json');
  assert.equal(after.blocks.find((b: Block) => b.id === 'chemin-card').type, 'text');
  assert.equal(after.blocks.find((b: Block) => b.id === 'chemin-card-copy').props.title, 'Ping the printer');
  assert.deepEqual(errors(dir), []);
  edit.undo(dir);
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.find((b: Block) => b.id === 'chemin-card').type, 'key-card');
  // Blocks move into and out of slots.
  edit.moveBlock(dir, { block: 'chemin-card-note-copy', parent: 'chemin-card', slot: 'more' });
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.find((b: Block) => b.id === 'chemin-card').blocks.length, 2);
  assert.ok(!readJSON(dir, 'screens/chemin.json').blocks.find((b: Block) => b.id === 'chemin-card-copy').blocks);
});

test('fork of quiz: headless template, extra props, plan question, same state key and scoring', async () => {
  const dir = copyExample();
  const r = edit.forkComponent(dir, { component: 'quiz', id: 'card-quiz', title: 'Card quiz' });
  assert.equal(r.component, 'card-quiz');
  const m = readJSON(dir, 'components/card-quiz/component.json');
  assert.deepEqual(m.extends, { component: 'quiz', version: getRegistry(loadProjectFromDir(dir)).get('quiz')!.version });
  m.propsExtend = { properties: { options: { items: { properties: { icon: { type: 'string', enum: ['a', 'b'] } } } } } };
  writeJSON(dir, 'components/card-quiz/component.json', m);
  write(dir, 'components/card-quiz/template.html', '<fieldset class="t-quiz cq" data-t-group><div data-t-stem>{{stem}}</div><div class="cards"><label data-each="options" data-t-option="{{id}}" class="card card--{{icon}}"><input data-t-input><span>{{text}}</span></label></div><button type="button" data-t-submit></button><div data-t-feedback></div></fieldset>');
  // Use it for an inline quiz of the example.
  const proj = loadProjectFromDir(dir);
  const [sid, entry] = [...proj.screens].find(([, e]) => e.data.blocks.some((b) => b.type === 'quiz'))!;
  const s = entry.data;
  const q = s.blocks.find((b) => b.type === 'quiz')!;
  q.type = 'card-quiz';
  // A plan question: the plan gives text, correctness and feedback; the fork adds an icon per option id.
  assert.ok(q.props.questionRef);
  const planQ = readJSON(dir, 'plan.json').items.flatMap((it: PlanItem) => it.questions || []).find((x: PlanQuestion) => x.id === q.props.questionRef);
  q.props.options = planQ.options.map((o: PlanQuestionOption, i: number) => ({ id: o.id, icon: i % 2 ? 'b' : 'a' }));
  writeJSON(dir, `screens/${sid}.json`, s);
  assert.deepEqual(errors(dir), []);
  const b = await build(dir, { out: tmp(), emit: 'both' });
  assert.ok(b.ok && b.dirPath);
  const data = JSON.parse(fs.readFileSync(path.join(b.dirPath, 'elabora/course.js'), 'utf8').replace(/^window\.ELABORA_COURSE = |;\s*$/g, ''));
  // Blocks of the compiled course data, slots included.
  interface CompiledBlock { id: string; behavior?: string; lineage?: string[]; key?: string; html: string; blocks?: CompiledBlock[] }
  const flat = (blocks: CompiledBlock[]): CompiledBlock[] => blocks.flatMap((x) => [x, ...flat(x.blocks || [])]);
  const cq = flat(data.screens.flatMap((x: { blocks: CompiledBlock[] }) => x.blocks)).find((x) => x.id === q.id)!;
  assert.equal(cq.behavior, 'quiz');
  assert.deepEqual(cq.lineage, ['card-quiz', 'quiz']);
  assert.ok(cq.key, 'learner state key kept');
  assert.equal(b.report.stateKeys[`quiz:${q.id}`], cq.key);
  assert.match(cq.html, /data-t-option="[a-z0-9]+" class="card card--[ab]"/);

  // A missing hook is an error; a hook of another behaviour too.
  write(dir, 'components/card-quiz/template.html', '<div data-t-stem>{{stem}}</div><label data-each="options" data-t-option="{{id}}">{{text}}</label><div data-t-feedback></div><button type="button" data-t-choice="x"></button>');
  const c = codes(validateDir(dir).diagnostics);
  assert.ok(c.includes('E_COMPONENT_HOOK'));
  // The fork falls back to a native quiz (detach keeps the id, hence the learner state).
  write(dir, 'components/card-quiz/template.html', fs.readFileSync(path.join(ROOT, 'packages/core/src/components/builtin/quiz.html'), 'utf8'));
  const d = edit.detachBlock(dir, { block: q.id });
  assert.deepEqual(d.blocks, [`quiz:${q.id}`]);
  const detached = readJSON(dir, `screens/${sid}.json`).blocks.find((x: Block) => x.id === q.id);
  assert.deepEqual(detached, { id: q.id, type: 'quiz', props: { questionRef: q.props.questionRef } });
  // Text of the plan in the options is refused (the plan owns it).
  q.type = 'card-quiz';
  q.props.options = [{ id: planQ.options[0].id, text: 'Changed' }];
  const s2 = readJSON(dir, `screens/${sid}.json`);
  s2.blocks = s2.blocks.map((x: Block) => (x.id === q.id ? q : x));
  writeJSON(dir, `screens/${sid}.json`, s2);
  assert.ok(codes(validateDir(dir).diagnostics).includes('E_QUIZ_SOURCE'));
});

test('screen layouts are screen-level components; block components cannot be layouts', () => {
  const dir = copyExample();
  addCard(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.layout = 'key-card';
  writeJSON(dir, 'screens/chemin.json', s);
  assert.ok(codes(validateDir(dir).diagnostics).includes('E_COMPONENT_LEVEL'));
});

test('migrations: steps run on every instance, are checked, and are undoable', async () => {
  const dir = copyExample();
  addCard(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(card('chemin-card'), card('chemin-card-2', { title: 'Swap the cable' }));
  writeJSON(dir, 'screens/chemin.json', s);
  assert.ok((await build(dir, { out: tmp() })).ok); // records key-card 1.0.0 in the lock
  // 2.0.0 renames title → heading.
  const m = readJSON(dir, 'components/key-card/component.json');
  m.version = '2.0.0';
  m.props.required = ['heading'];
  m.props.properties.heading = m.props.properties.title;
  delete m.props.properties.title;
  m.fallback[0].props.markdown = m.fallback[0].props.markdown.replace('{{title}}', '{{heading}}');
  writeJSON(dir, 'components/key-card/component.json', m);
  write(dir, 'components/key-card/template.html', fs.readFileSync(path.join(dir, 'components/key-card/template.html'), 'utf8').replaceAll('{{title}}', '{{heading}}'));
  write(dir, 'components/key-card/migrations.mjs', "export default {\n  '2.0.0': ({ title, ...rest }) => ({ ...rest, heading: title })\n};\n");
  let c = codes(validateDir(dir).diagnostics);
  assert.ok(c.includes('E_COMPONENT_MIGRATION_PENDING'));
  assert.ok(c.includes('E_COMPONENT_PROPS'));
  const r = await edit.migrateComponents(dir);
  assert.deepEqual(r.migrated, ['chemin-card', 'chemin-card-2']);
  assert.equal(readJSON(dir, 'screens/chemin.json').blocks.find((b: Block) => b.id === 'chemin-card-2').props.heading, 'Swap the cable');
  assert.equal(readJSON(dir, 'elabora.lock.json').components['key-card'], '2.0.0');
  assert.deepEqual(errors(dir), []);
  // A step whose result does not match the schema writes nothing.
  edit.undo(dir);
  write(dir, 'components/key-card/migrations.mjs', "export default { '2.0.0': (p) => p };\n");
  await assert.rejects(() => edit.migrateComponents(dir), /Migration refused/);
  assert.equal(readJSON(dir, 'elabora.lock.json').components['key-card'], '1.0.0');
});

test('libraries: add pins a copy, local edits are reported, upgrade and publish', () => {
  const lib = tmp();
  write(lib, 'library.json', { id: 'acme', title: 'ACME design system' });
  const dir = copyExample();
  addCard(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(card('chemin-card'));
  writeJSON(dir, 'screens/chemin.json', s);
  const p = edit.publishComponent(dir, { library: lib, component: 'key-card' });
  assert.equal(p.library, 'acme');
  assert.ok(fs.existsSync(path.join(lib, 'components/key-card/template.html')));
  assert.equal(readJSON(dir, 'components/key-card/component.json').origin.library, 'acme');
  assert.ok(!codes(validateDir(dir).diagnostics).includes('W_COMPONENT_DIVERGED'));

  // Another course adds it.
  const other = copyExample();
  const a = edit.addLibraryComponent(other, { library: lib, component: 'key-card' });
  assert.equal(a.to, '1.0.0');
  assert.ok(!codes(validateDir(other).diagnostics).includes('W_COMPONENT_DIVERGED'));
  // Local edit → diverged; upgrade refuses without force.
  write(other, 'components/key-card/component.css', '.kc { border: 0; }');
  assert.ok(codes(validateDir(other).diagnostics).includes('W_COMPONENT_DIVERGED'));
  const lm = readJSON(lib, 'components/key-card/component.json');
  lm.version = '1.1.0';
  writeJSON(lib, 'components/key-card/component.json', lm);
  assert.throws(() => edit.addLibraryComponent(other, { library: lib, component: 'key-card', upgrade: true }), /edited since/);
  const u = edit.addLibraryComponent(other, { library: lib, component: 'key-card', upgrade: true, force: true });
  assert.deepEqual([u.from, u.to], ['1.0.0', '1.1.0']);
  assert.ok(!codes(validateDir(other).diagnostics).includes('W_COMPONENT_DIVERGED'));
});

test('exports and the client view use the fallback', () => {
  const dir = copyExample();
  addCard(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push(card('chemin-card'));
  writeJSON(dir, 'screens/chemin.json', s);
  const out = tmp();
  const r = exportLessonMd(loadProjectFromDir(dir), out);
  const file = r.files.find((f) => f.endsWith('-chemin.md'));
  assert.ok(file);
  const lesson = fs.readFileSync(path.join(out, file), 'utf8');
  assert.match(lesson, /\*\*Ping first\*\*\n\nCheck the \*\*link\*\*\.\n- Cable\n- Switch/);
  assert.ok(r.losses.some((l) => /component key-card exported through its fallback/.test(l.loss)));
});

test('the planetary sample uses course components, a fork of quiz and screen layouts', () => {
  const dir = path.join(ROOT, 'examples/planetary-gearset');
  const project = loadProjectFromDir(dir);
  const reg = getRegistry(project);
  assert.deepEqual([...project.components.keys()].sort(), ['config-quiz', 'figure-split', 'hero', 'ratio-card', 'stage']);
  assert.equal(reg.get('config-quiz')?.behavior, 'quiz');
  assert.equal(reg.get('hero')?.level, 'screen');
  const v = validateDir(dir);
  assert.equal(v.summary.errors + v.summary.warnings, 0, JSON.stringify(v.diagnostics.filter((d) => d.severity !== 'info')));
});

test('template headings marked data-t-heading follow the page: one level under the heading before the instance', async () => {
  const dir = copyExample();
  write(dir, 'components/fact-card/component.json', {
    id: 'fact-card', title: 'Fact card', version: '1.0.0', level: 'block', category: 'content',
    props: { type: 'object', additionalProperties: false, required: ['title', 'detail', 'body'], properties: { title: { type: 'string', 'x-translatable': true }, detail: { type: 'string', 'x-translatable': true }, body: { type: 'string', 'x-kind': 'markdown', 'x-translatable': true } } }
  });
  write(dir, 'components/fact-card/template.html', '<article class="fact"><h3 data-t-heading>{{title}}</h3><h4 data-t-heading>{{detail}}</h4><div class="t-text">{{body}}</div></article>\n');
  write(dir, 'components/fact-card/component.css', '');
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.blocks.unshift({ id: 'chemin-fact-top', type: 'fact-card', props: { title: 'Le chemin', detail: 'Du poste à l’imprimante', body: 'Six équipements.' } });
  screen.blocks.push({ id: 'chemin-heading', type: 'heading', props: { text: 'Les rôles', level: 2 } }, { id: 'chemin-fact-under', type: 'fact-card', props: { title: 'Le switch', detail: 'Au centre', body: 'Il relie les postes.' } });
  writeJSON(dir, 'screens/chemin.json', screen);
  const diagnostics = validateDir(dir).diagnostics.filter((d) => d.code === 'E_HEADING_ORDER' || d.code === 'E_COMPONENT_HOOK');
  assert.deepEqual(diagnostics, []);
  const b = await build(dir, { emit: 'dir', out: fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-headings-')), writeLock: false });
  assert.ok(b.ok && b.dirPath, JSON.stringify(b.diagnostics.filter((d) => d.severity === 'error')));
  const data = fs.readFileSync(path.join(b.dirPath, 'elabora/course.js'), 'utf8');
  const html = (id: string) => JSON.parse(data.slice(data.indexOf('{'), data.lastIndexOf('}') + 1)).screens.flatMap((s: { blocks: { id: string; html?: string }[] }) => s.blocks).find((block: { id: string }) => block.id === id).html as string;
  assert.match(html('chemin-fact-top'), /^<article class="fact"><h2>Le chemin<\/h2><h3>Du poste/, 'under the screen title: h2, then h3');
  assert.match(html('chemin-fact-under'), /<h3>Le switch<\/h3><h4>Au centre<\/h4>/, 'under an h2: h3, then h4');
  // On another tag, the hook is refused.
  write(dir, 'components/fact-card/template.html', '<article class="fact" data-t-heading><h3>{{title}}</h3><p>{{detail}}</p><div class="t-text">{{body}}</div></article>\n');
  assert.ok(validateDir(dir).diagnostics.some((d) => d.code === 'E_COMPONENT_HOOK' && /data-t-heading goes on a heading/.test(d.message)));
});
