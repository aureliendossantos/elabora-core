import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateDir } from '@elabora/node/project-reader';
import { renderMarkdown, mathErrors } from '@elabora/core/compile/markdown';
import { parseNumber, gradeNumeric } from '@elabora/player/numeric';
import { createCourseState } from '@elabora/player/course-state';
import type { CourseData } from '@elabora/player/course-data';
import { encodeState, decodeState, emptyState } from '@elabora/player/state-codec';
import { runGenerators } from '@elabora/node/generators';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { readZip } from '@elabora/node/zip';
import { ROOT, copyExample, readJSON, writeJSON, codes, addLayerProbe, LAYER_PROBE } from '../helpers.ts';
import { build } from '@elabora/node/build';
import { runtimeFiles } from '@elabora/node/bundles';
import { BASE_LAYER } from '@elabora/core/render/styles';
import { propertyFamily, splitOverrides, upgradeTheme } from '@elabora/core/render/cascade';
import { literalColors } from '@elabora/core/project/css';
import { renderScreen } from '@elabora/core/render/screen';

const write = (dir: string, rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), content); };
const out = () => fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-design-'));

// ── Maths ──
test('maths: $…$ and $$…$$ render as MathML at build time, prices stay text', () => {
  assert.match(renderMarkdown('Speed $n_c = 278$ rpm.'), /<math><mrow><msub><mi>n<\/mi><mi>c<\/mi><\/msub>/);
  assert.match(renderMarkdown('$$\\frac{1}{2}$$'), /<div class="t-math-display"><math display="block"/);
  assert.equal(renderMarkdown('It costs $5 and $6.'), '<p>It costs $5 and $6.</p>');
  assert.equal(mathErrors('ok $x^2$ but $\\frac{1}{2$').length, 1);
});

test('maths: punctuation around inline maths stays on its line', () => {
  assert.match(renderMarkdown('At 500 km ($T = 5676$ s), $x$, done.'), /<span class="t-nobr">\(<math>.*?<\/math><\/span> s\), <span class="t-nobr"><math><mi>x<\/mi><\/math>,<\/span> done\./);
  assert.equal(renderMarkdown('Alone $x$ here'), '<p>Alone <math><mi>x</mi></math> here</p>');
});

test('maths: LaTeX errors are reported with E_MATH_PARSE', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks.push({ id: 'chemin-eq', type: 'math', props: { tex: '\\frac{a}{', caption: 'Débit $\\sqrt{x$' } });
  writeJSON(dir, 'screens/chemin.json', s);
  const c = codes(validateDir(dir).diagnostics);
  assert.equal(c.filter((x) => x === 'E_MATH_PARSE').length, 2);
});

// ── Numeric answers ──
test('numeric: locale-aware parsing', () => {
  assert.equal(parseNumber('1,385', 'en'), 1385);
  assert.equal(parseNumber('1,5', 'fr'), 1.5);
  assert.equal(parseNumber('1 385,5', 'fr'), 1385.5);
  assert.equal(parseNumber('1.385,5', 'de'), 1385.5);
  assert.equal(parseNumber('−2.6', 'en'), -2.6);
  assert.equal(parseNumber('abc', 'en'), null);
});

test('numeric: tolerance, misconceptions, course state and scoring', () => {
  const props = { answer: 722.2, tolerance: { absolute: 1.5 }, misconceptions: [{ id: 'inv', value: 1384.6, feedback: 'x' }], attempts: 2 };
  assert.equal(gradeNumeric(props, 722).correct, true);
  assert.equal(gradeNumeric(props, 1384.6).misconception?.id, 'inv');
  // A course reduced to what the course state reads here.
  const course = {
    completion: { reportAs: 'passed-failed', masteryScore: 50 }, variables: [],
    screens: [{ id: 's', key: '0', completeWhen: 'interactions-done', blocks: [{ id: 'n', type: 'numeric', key: '1', props: { ...props, scored: true } }], events: [] }]
  } as unknown as CourseData;
  const e = createCourseState(course);
  e.visit(course.screens[0]);
  const r1 = e.answerNumeric('n', 1384.6);
  assert.ok(r1);
  assert.deepEqual([r1.correct, r1.final, r1.misconception?.id], [false, false, 'inv']);
  const r2 = e.answerNumeric('n', 722.5);
  assert.ok(r2);
  assert.deepEqual([r2.correct, r2.final], [true, true]);
  e.refreshScreenCompletion(course.screens[0]);
  assert.equal(e.score().raw, 100);
  const st = emptyState();
  (st.numerics as Record<string, unknown>).k = { value: -0.25, attempts: 2 };
  assert.deepEqual((decodeState(encodeState(st)).numerics as Record<string, unknown>).k, { value: -0.25, attempts: 2 });
});

test('numeric: feedback required, ambiguous misconception, plan question type', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/evaluation.json');
  s.blocks.push({ id: 'eval-calc', type: 'numeric', props: { stem: 'Débit ?', answer: 100, tolerance: { percent: 5 }, feedback: { correct: 'Oui.', incorrect: '' }, misconceptions: [{ id: 'near', value: 103, feedback: 'Trop proche' }] } });
  s.blocks.push({ id: 'eval-wrong-ref', type: 'numeric', props: { questionRef: 'Q-1' } });
  writeJSON(dir, 'screens/evaluation.json', s);
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_FEEDBACK_MISSING', 'W_NUMERIC_AMBIGUOUS', 'E_QUIZ_SOURCE']) assert.ok(c.includes(code), code);
});

// ── Layouts, slots and styles ──
function addLayout(dir: string, { html, css = '', slots }: { html?: string; css?: string; slots?: unknown[] } = {}) {
  write(dir, 'components/split/component.json', JSON.stringify({ id: 'split', title: 'Split', version: '1.0.0', level: 'screen', slots: slots || [{ id: 'side', label: 'Side', accepts: ['image', 'text'] }, { id: 'main', label: 'Main', default: true }] }));
  write(dir, 'components/split/template.html', html ?? '<div class="g"><div data-title></div><div data-slot="side"></div><div data-slot="main"></div><svg aria-hidden="true"><path d="M0 0H1"/></svg></div>');
  write(dir, 'components/split/component.css', css || '.t-layout--split .g { display: grid; grid-template-columns: 1fr 2fr; }');
}

test('layouts: slots are checked and the template is shipped with the screen', async () => {
  const dir = copyExample();
  addLayout(dir);
  const s = readJSON(dir, 'screens/chemin.json');
  s.layout = 'split';
  s.blocks[1].slot = 'side';
  writeJSON(dir, 'screens/chemin.json', s);
  const ok = validateDir(dir);
  assert.equal(ok.summary.errors, 0, JSON.stringify(ok.diagnostics.filter((d) => d.severity === 'error')));
  const r = await build(dir, { out: out(), emit: 'both' });
  assert.ok(r.ok && r.dirPath);
  const data = fs.readFileSync(path.join(r.dirPath, 'elabora/course.js'), 'utf8');
  assert.match(data, /"layout":\{"id":"split","lineage":\["split"\],"fullBleed":false,"defaultSlot":"main","html":"<div class=\\"g\\"><div data-title><\/div><div data-slot=\\"side\\">/);
  assert.ok(fs.existsSync(path.join(r.dirPath, 'components/split/component.css')));
  assert.match(fs.readFileSync(path.join(r.dirPath, 'elabora/theme.css'), 'utf8'), /@import url\("\.\.\/components\/split\/component\.css"\) layer\(elabora\.components\);/);

  s.blocks[2].slot = 'side'; // a callout is not accepted by "side"
  s.blocks[3].slot = 'nowhere';
  writeJSON(dir, 'screens/chemin.json', s);
  const c = codes(validateDir(dir).diagnostics);
  assert.equal(c.filter((x) => x === 'E_COMPONENT_SLOT').length, 2);
});

test('layouts: templates hold structure only (no script, no text, decorative SVG hidden)', () => {
  const dir = copyExample();
  addLayout(dir, { html: '<div data-slot="side"></div><div data-slot="main"><script>x()</script></div><p>Bonjour</p><svg><path d="M0 0"/></svg><img src="https://x.org/a.png">' });
  const s = readJSON(dir, 'screens/chemin.json');
  s.layout = 'split';
  writeJSON(dir, 'screens/chemin.json', s);
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_COMPONENT_TEMPLATE', 'W_COMPONENT_TEXT', 'W_COMPONENT_DECORATION']) assert.ok(c.includes(code), code);
});

test('styles must be declared by the theme', () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks[0].style = 'card';
  s.style = 'dark';
  writeJSON(dir, 'screens/chemin.json', s);
  assert.equal(codes(validateDir(dir).diagnostics).filter((x) => x === 'E_UNKNOWN_REFERENCE').length, 2);
  const course = readJSON(dir, 'course.json');
  course.theme.styles = { [s.blocks[0].type]: { card: 'Card' }, screen: { dark: 'Dark' } };
  writeJSON(dir, 'course.json', course);
  assert.ok(!codes(validateDir(dir).diagnostics).includes('E_UNKNOWN_REFERENCE'));
});

// ── Theme stylesheet, fonts, custom tokens ──
test('theme: stylesheet rules, fonts and custom tokens', async () => {
  const dir = copyExample();
  write(dir, 'theme/theme.css', '.t-callout { color: #123456; background: url("https://cdn.example.com/bg.png"); }\n.t-x::before { content: "Attention"; }\n@import "other.css";\n');
  const course = readJSON(dir, 'course.json');
  course.theme.stylesheet = 'theme/theme.css';
  course.theme.custom = { 'color.blueprint': '#0B2440' };
  course.theme.fonts = [{ family: 'Demo', src: 'theme/fonts/demo.woff2' }];
  writeJSON(dir, 'course.json', course);
  const c = codes(validateDir(dir).diagnostics);
  for (const code of ['E_STYLE_RULE', 'W_STYLE_LITERAL_COLOR', 'W_STYLE_TEXT', 'E_ASSET_MISSING']) assert.ok(c.includes(code), code);

  write(dir, 'theme/theme.css', '.t-callout { background: var(--t-color-blueprint) url("img/bg.svg"); }\n');
  write(dir, 'theme/img/bg.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  write(dir, 'theme/fonts/demo.woff2', 'not really a font');
  const r = await build(dir, { out: out(), emit: 'both' });
  assert.ok(r.ok && r.dirPath, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
  for (const f of ['theme/theme.css', 'theme/img/bg.svg', 'theme/fonts/demo.woff2']) assert.ok(fs.existsSync(path.join(r.dirPath, f)), f);
  const html = fs.readFileSync(path.join(r.dirPath, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="elabora\/theme\.css">/);
  assert.match(html, /--t-color-blueprint:#0B2440/);
  assert.match(fs.readFileSync(path.join(r.dirPath, 'elabora/theme.css'), 'utf8'), /@font-face\{font-family:"Demo"/);
});

// ── Cascade layers ──
test('player.css: no pseudo-element inside :is(), :where(), :not() or :has(), which cannot hold one (the rule would miss it: a backdrop layer\'s ::after kept its fade under reduced motion)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'packages/player/src/player.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const match of css.matchAll(/:(?:is|where|not|has)\(/g)) {
    let depth = 1;
    let end = match.index + match[0].length;
    while (depth && end < css.length) { if (css[end] === '(') depth++; else if (css[end] === ')') depth--; end++; }
    const inside = css.slice(match.index + match[0].length, end - 1);
    if (/::[a-z-]+/.test(inside)) found.push(css.slice(match.index, end));
  }
  assert.deepEqual(found, []);
});

test('cascade layers: the course\'s order first in every stylesheet that names its layers, the player\'s layer alone first in elabora/player.css', async () => {
  const LEGACY = '@layer elabora.base, elabora.components, elabora.theme, elabora.overrides;';
  const CURRENT = '@layer elabora.base, elabora.theme, elabora.components, elabora.overrides;';
  for (const [cascade, order] of [[undefined, LEGACY], ['components-over-theme', CURRENT]] as const) {
    const dir = copyExample();
    addLayerProbe(dir);
    write(dir, 'theme/theme.css', `.lp-probe { color: red; }\n@layer overrides {\n  .t-block--layer-probe .lp-probe { background: url(img/bg.svg); }\n}\n`);
    write(dir, 'theme/img/bg.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const course = readJSON(dir, 'course.json');
    if (cascade) course.theme.cascade = cascade; else delete course.theme.cascade;
    writeJSON(dir, 'course.json', course);
    const r = await build(dir, { out: out(), emit: 'dir', writeLock: false });
    assert.ok(r.ok && r.dirPath, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
    const packaged = (name: string) => fs.readFileSync(path.join(r.dirPath!, name), 'utf8');
    // A browser orders layers where their names first appear. index.html loads elabora/player.css
    // first: it names elabora.base alone, and elabora/theme.css the course's order.
    const html = packaged('index.html');
    assert.ok(html.indexOf('href="elabora/player.css"') < html.indexOf('href="elabora/theme.css"'));
    const player = packaged('elabora/player.css');
    const theme = packaged('elabora/theme.css');
    assert.ok(player.startsWith(`${BASE_LAYER}\n@layer elabora.base {\n`), player.slice(0, 120));
    assert.ok(theme.startsWith(`${order}\n`), theme.slice(0, 120));
    assert.deepEqual([...theme.matchAll(/^@import url\("\.\.\/([^"]+)"\) layer\(([a-z.]+)\);$/gm)].map((m) => `${m[2]} ${m[1]}`),
      ['elabora.components components/layer-probe/component.css', 'elabora.theme theme/theme.css', 'elabora.overrides elabora/overrides.css']);
    // The theme's top-level @layer overrides blocks go to elabora/overrides.css, their url() rebased;
    // the theme keeps its lines.
    assert.equal(packaged('theme/theme.css'), '.lp-probe { color: red; }\n\n\n\n');
    assert.equal(packaged('elabora/overrides.css').trim(), '.t-block--layer-probe .lp-probe { background: url("../theme/img/bg.svg"); }');
    for (const css of [player, theme]) {
      for (const m of css.matchAll(/@layer\s+([^{;]+)[{;]/g)) for (const name of m[1].split(',')) assert.ok(['elabora.base', 'elabora.components', 'elabora.theme', 'elabora.overrides'].includes(name.trim()), name);
    }
    // The editor canvas loads the same elabora/player.css, then the design layer inline, the course's
    // order first.
    assert.equal((await runtimeFiles())['elabora/player.css'], player);
    const sheets = renderScreen(loadProjectFromDir(dir), LAYER_PROBE.screen).styles.sheets;
    assert.deepEqual(sheets.map((sheet) => sheet.id), ['layers', 'components/layer-probe/component.css', 'theme/theme.css', 'elabora/overrides.css', 'root']);
    assert.equal(sheets[0].css, order);
    assert.ok(sheets[1].css.startsWith('@layer elabora.components {') && sheets[2].css.startsWith('@layer elabora.theme {') && sheets[3].css.startsWith('@layer elabora.overrides {'));
    assert.match(sheets[3].css, /url\("theme\/img\/bg\.svg"\)/);
  }
});

test('cascade: @layer overrides blocks found at the top only, the course told when its theme still overrides its components', () => {
  const css = '/* a { } */ .a { color: red; }\n@layer overrides {\n  .b { content: "}"; }\n}\n@media print { @layer overrides { .c { color: blue; } } }\n@layer overrides { .d { background: url(x;y.png); } }\n';
  const split = splitOverrides(css);
  assert.equal(split.nested, 1);
  assert.match(split.overrides, /\.b \{ content: "\}"; \}[\s\S]*\.d \{ background: url\(x;y\.png\); \}/);
  assert.equal(split.defaults.split('\n').length, css.split('\n').length);
  assert.ok(!split.defaults.includes('.b') && split.defaults.includes('@media print { @layer overrides'));

  const dir = copyExample();
  addLayerProbe(dir);
  const legacy = readJSON(dir, 'course.json');
  delete legacy.theme.cascade;
  writeJSON(dir, 'course.json', legacy);
  let c = codes(validateDir(dir).diagnostics);
  assert.ok(c.includes('I_THEME_CASCADE_OLD'));
  write(dir, 'theme/theme.css', css);
  const course = readJSON(dir, 'course.json');
  course.theme.cascade = 'components-over-theme';
  writeJSON(dir, 'course.json', course);
  c = codes(validateDir(dir).diagnostics);
  assert.ok(!c.includes('I_THEME_CASCADE_OLD') && c.includes('W_STYLE_OVERRIDES_NESTED'));
});

test('cascade: properties that act on one another share a family', () => {
  const same = [['margin', 'margin-block-start', 'margin-top'], ['inset', 'top', 'inset-inline'], ['font', 'line-height', 'font-variant-numeric'], ['white-space', 'text-wrap-mode'], ['gap', 'column-gap', 'grid-template-columns', 'columns'], ['width', 'max-inline-size', 'aspect-ratio'], ['-webkit-mask-image', 'mask'], ['word-wrap', 'overflow-wrap'], ['place-items', 'align-items', 'justify-self']];
  for (const group of same) assert.equal(new Set(group.map(propertyFamily)).size, 1, group.join(' '));
  assert.notEqual(propertyFamily('color'), propertyFamily('background-color'));
  assert.equal(propertyFamily('--t-gap'), '--t-gap');
  assert.equal(propertyFamily('all'), '*');
});

test('cascade: a theme upgrade moves to @layer overrides what the components also set, and nothing else', () => {
  const theme = [
    '/* Paper */',
    'html { background: var(--t-surface); }',
    '.t-figure img { display: block; width: 100%; height: auto; box-shadow: var(--t-shadow); }',
    '.t-text { hyphens: auto; line-height: 1.5; }',
    '@media (max-width: 600px) {',
    '  .t-figure img { width: 80%; }',
    '}',
    '@keyframes spin { to { rotate: 1turn; } }',
    '@keyframes pulse { to { opacity: .5; } }',
    '@layer overrides { .t-layout--x .t-text { line-height: 1.2; } }',
    ''
  ].join('\n');
  const component = '.t-layout--x .t-figure img { height: 6rem; width: auto; }\n.t-layout--x .t-text { font-size: 1rem; }\n@keyframes spin { to { rotate: -1turn; } }\n';
  const upgrade = upgradeTheme(theme, [component]);
  assert.deepEqual(upgrade.families, ['font', 'size']);
  assert.equal(upgrade.moved, 4);
  const { defaults, overrides } = splitOverrides(upgrade.css);
  // What stays: the declarations of families no component sets, in their rules and lines.
  assert.match(defaults, /^\/\* Paper \*\/\nhtml \{ background: var\(--t-surface\); \}\n\.t-figure img \{ display: block; box-shadow: var\(--t-shadow\); \}\n\.t-text \{ hyphens: auto; \}\n@keyframes pulse/);
  assert.ok(!/@media/.test(defaults) && !/spin/.test(defaults), defaults);
  // What goes: in order, in their at-rules, before the theme's own overrides (which still come last).
  const body = overrides.replace(/\s+/g, ' ');
  assert.ok(body.indexOf('.t-figure img { width: 100%; height: auto; }') < body.indexOf('@media (max-width: 600px) { .t-figure img { width: 80%; } }'), body);
  assert.ok(body.indexOf('@keyframes spin') > 0 && body.indexOf('.t-layout--x .t-text { line-height: 1.2; }') > body.indexOf('@keyframes spin'), body);
  // Beside the author's overrides, what moved sits in a sublayer under them: theirs keep winning
  // whatever the specificity, as they did over the theme.
  assert.match(body, /^ ?@layer upgraded \{ \.t-figure img \{/);
  // Moved as written: a string holding « /* » is not taken for a comment.
  const quoted = upgradeTheme('.t-quote::before { content: "/* » */"; color: red; }\n', ['.t-quote::before { content: "«"; }']);
  assert.match(splitOverrides(quoted.css).overrides, /content: "\/\* » \*\/";/);
  // Nothing to move: the theme stays as it is.
  assert.equal(upgradeTheme('.a { color: red; }\n', ['.b { margin: 0; }']).css, '.a { color: red; }\n');
  // A component that sets every property: the whole theme moves.
  assert.equal(upgradeTheme('.a { color: red; }\n', ['.b { all: unset; }']).moved, 1);
});

// ── Figures and generators ──
test('figures: words inside an SVG are reported, numbers are not', () => {
  const dir = copyExample();
  write(dir, 'assets/images/chemin-impression.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>1</text><text>450</text></svg>');
  write(dir, 'assets/images/ticket-marc.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>1</text></svg>');
  assert.ok(!codes(validateDir(dir).diagnostics).includes('W_ASSET_SVG_TEXT'));
  write(dir, 'assets/images/ticket-marc.svg', '<svg xmlns="http://www.w3.org/2000/svg"><text>Routeur</text></svg>');
  assert.ok(codes(validateDir(dir).diagnostics).includes('W_ASSET_SVG_TEXT'));
});

test('generators: provenance, stale inputs and hand edits', async () => {
  const dir = copyExample();
  write(dir, 'generators/_lib.mjs', 'export const shape = (c) => `<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="${c}"/></svg>`;\n');
  write(dir, 'generators/badge.mjs', "import { shape } from './_lib.mjs';\nexport default async function ({ tokens, write }) { write('images/badge.svg', shape(tokens['color.accent'])); }\n");
  assert.ok(codes(validateDir(dir).diagnostics).includes('W_GENERATED_ASSET_STALE'), 'never run');
  const p = loadProjectFromDir(dir);
  const r = await runGenerators(dir, { course: p.course, plan: p.plan });
  assert.deepEqual(r.results[0].outputs, ['images/badge.svg']);
  assert.match(fs.readFileSync(path.join(dir, 'assets/images/badge.svg'), 'utf8'), new RegExp(String(p.course?.theme?.tokens?.['color.accent'])));
  let c = codes(validateDir(dir).diagnostics);
  assert.ok(!c.includes('W_GENERATED_ASSET_STALE') && !c.includes('W_GENERATED_ASSET_EDITED'));
  const course = readJSON(dir, 'course.json');
  course.theme.tokens['color.accent'] = '#9A3412';
  writeJSON(dir, 'course.json', course);
  write(dir, 'assets/images/badge.svg', '<svg/>');
  c = codes(validateDir(dir).diagnostics);
  assert.ok(c.includes('W_GENERATED_ASSET_STALE') && c.includes('W_GENERATED_ASSET_EDITED'));
});

test('the planetary sample validates without errors or warnings', () => {
  const r = validateDir(path.join(ROOT, 'examples/planetary-gearset'), { profiles: ['moodle'] });
  assert.equal(r.summary.errors + r.summary.warnings, 0, JSON.stringify(r.diagnostics.filter((d) => d.severity !== 'info'), null, 1));
});

test('free objects: relative imports are analysed with the same rules', () => {
  const dir = copyExample();
  const od = path.join(dir, 'objects/diagnostic-reseau');
  fs.writeFileSync(path.join(od, 'util.js'), 'export const jitter = () => Math.random();\nexport function get(parent) { return parent; }\n');
  fs.appendFileSync(path.join(od, 'object.js'), "\nimport { jitter } from './util.js';\n");
  const d = validateDir(dir).diagnostics.filter((x) => x.file === 'objects/diagnostic-reseau/util.js');
  assert.deepEqual(d.map((x) => x.code), ['E_OBJECT_NONDETERMINISM']);
});

// ── Size classes and steps ──
test('size classes: font sizes in px in a course stylesheet are reported, rem and clamp() with rem bounds are not', () => {
  const dir = copyExample();
  const course = readJSON(dir, 'course.json');
  course.theme.stylesheet = 'theme/theme.css';
  writeJSON(dir, 'course.json', course);
  write(dir, 'theme/theme.css', '.t-text { font-size: 1.125rem; } .t-screen-title { font-size: clamp(1.5rem, 3vw, 2rem); margin: 12px 0; }\n.t-callout-title { font: 700 15px/1.2 var(--t-font-heading); } .t-counter { font-size: 13px; }\n');
  const diags = validateDir(dir).diagnostics.filter((d) => d.code === 'W_STYLE_FIXED_FONT_SIZE');
  assert.equal(diags.length, 1);
  assert.equal(diags[0].measured, 2);
});

test('steps: compiled with the block, out-of-order steps flagged in scroll presentation, nested steps flagged', async () => {
  const dir = copyExample();
  const s = readJSON(dir, 'screens/chemin.json');
  s.blocks[0].step = 2;
  writeJSON(dir, 'screens/chemin.json', s);
  let c = codes(validateDir(dir).diagnostics);
  assert.ok(c.includes('W_STEP_ORDER'), 'a step-1 block after a step-2 block in reading order');
  s.blocks[0].step = 1;
  s.blocks[s.blocks.length - 1].step = 2;
  writeJSON(dir, 'screens/chemin.json', s);
  c = codes(validateDir(dir).diagnostics);
  assert.ok(!c.includes('W_STEP_ORDER'));
  const r = await build(dir, { emit: 'dir', out: out() });
  assert.ok(r.ok && r.dirPath);
  const js = fs.readFileSync(path.join(r.dirPath, 'elabora', 'course.js'), 'utf8');
  assert.match(js, new RegExp(`"id":"${s.blocks[s.blocks.length - 1].id}"[^}]*"step":2`));
  // In slides, steps build in place: any order is fine.
  const course = readJSON(dir, 'course.json');
  course.presentation = { mode: 'slides', fit: { reference: '1600x900', minimum: '1280x720' } };
  writeJSON(dir, 'course.json', course);
  s.blocks[0].step = 3;
  s.layers = [{ id: 'chemin-aide', title: 'Aide', blocks: [{ id: 'chemin-aide-texte', type: 'text', step: 2, props: { markdown: 'Un rappel.' } }] }];
  writeJSON(dir, 'screens/chemin.json', s);
  c = codes(validateDir(dir).diagnostics);
  assert.ok(!c.includes('W_STEP_ORDER'));
  assert.ok(c.includes('W_STEP_PLACEMENT'), 'a step on a block of a layer');
});

test('object gates: the last full run is recorded and the dossier tells passed from stale', async () => {
  const { writeGatesRecord, gatesStatus } = await import('@elabora/node/objects/gates-record');
  const { proofMarkdown } = await import('@elabora/core/compile/proof');
  const dir = copyExample();
  const odir = path.join(dir, 'objects/diagnostic-reseau');
  fs.rmSync(path.join(odir, 'object.gates.json'), { force: true }); // the example may carry its own record
  assert.equal(gatesStatus(odir).status, 'not-run');
  writeGatesRecord(odir, { object: 'diagnostic-reseau', elabora: '0.1.0', at: '2026-10-05T10:00:00Z', ok: true, gates: { smoke: 'passed' }, perf: { bootMs: 420 } });
  assert.equal(gatesStatus(odir).status, 'passed');
  const r = await build(dir, { out: out() });
  assert.ok(r.ok, JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error')));
  const md = fs.readFileSync(r.reportPath.replace(/\.report\.json$/, '.proof.md'), 'utf8');
  assert.match(md, /portes 2 à 6 réussies le 2026-10-05/);
  assert.doesNotMatch(md, /Smoke test in SCORM Cloud/, 'pending items in the course language');
  fs.appendFileSync(path.join(odir, 'object.js'), '\n// changed\n');
  assert.equal(gatesStatus(odir).status, 'stale');
  assert.ok(proofMarkdown);
});

test('colours of masks are not charter colours: only their alpha counts', () => {
  assert.deepEqual(literalColors('.a { mask-image: radial-gradient(#000 40%, transparent); -webkit-mask-image: conic-gradient(#000 var(--sweep), transparent 0); }'), []);
  assert.deepEqual(literalColors('.a { mask: linear-gradient(#000, transparent); background: #123456; }'), ['#123456']);
});

test('fit: an overflowing slide names the quizzes whose compact feedback would reserve less room', async () => {
  const { fitDiagnostics } = await import('@elabora/node/fit');
  const screen = { screen: 'evaluation', overflow: 120, spare: 0, windows: 1.2, below: ['q2'], feedback: [{ block: 'q1', px: 57 }, { block: 'q2', px: 40 }] };
  const [overflow] = fitDiagnostics({ ok: true, mode: 'slides', sizes: [{ role: 'reference', size: '1600x900', screens: [screen] }] });
  assert.equal(overflow.code, 'W_SLIDE_OVERFLOW');
  assert.match(overflow.message, /feedbackStyle "compact" on q1 \(−57 px\), q2 \(−40 px\)\.$/);
});
