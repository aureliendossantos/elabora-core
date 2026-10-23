import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDir, loadProjectFromDir } from '@elabora/node/project-reader';
import { readLock, assignKeys } from '@elabora/core/compile/state-model';
import { compileCourseData } from '@elabora/core/compile/course-data';
import { renderChart, chartItems, chartMarkdown, CHART_TYPES } from '@elabora/core/charts/index';
import { diagramIds, parseDiagram, isProblem } from '@elabora/core/charts/diagram';
import { extractUnits, writeUnit } from '@elabora/core/i18n/units';
import { createCourseState } from '@elabora/player/course-state';
import type { PredictBlock } from '@elabora/player/course-data';
import { monotoneY, monotonePath, dodge, formatValue } from '@elabora/player/charts/kit';
import { copyExample, readJSON, writeJSON, codes } from '../helpers.ts';

// Charts and diagrams (D60): drawn at build time, moved by the player, in step with the voice.

const context = { id: 'c1', language: 'en', tokens: { 'color.accent': '#C2410C', 'color.surface': '#FFFFFF', 'color.text': '#111111' } };
const bars = { takeaway: 'Most incidents start with an email', highlight: 'email', unit: '%', rows: [{ id: 'web', label: 'Website', value: 18 }, { id: 'email', label: 'Email', value: 62, note: 'Fake invoices' }, { id: 'usb', label: 'USB stick', value: 6 }] };
const months = [{ x: 'Jan', y: 32 }, { x: 'Mar', y: 27 }, { x: 'May', y: 21 }, { x: 'Jul', y: 14 }, { x: 'Sep', y: 9 }, { x: 'Nov', y: 5 }];
const predict = { takeaway: 'Drills divide clicks by six', unit: '%', mode: 'predict', points: months, predict: { from: 'May' } };
const flow = { takeaway: 'Hover before you click', mermaid: 'flowchart LR\n  A[Email arrives] --> B{Link inside?}\n  B -- yes --> C[Hover the link]\n  B -- no --> D[Read on]', highlight: 'C' };

test('every chart type is registered with a renderer, and draws its frame without script', () => {
  assert.deepEqual(Object.keys(CHART_TYPES).sort(), ['bars', 'before-after', 'cycle', 'diagram', 'donut', 'key-figures', 'levels', 'matrix', 'milestones', 'process', 'proportion', 'trend']);
  const { html, data } = renderChart('bars', bars, context);
  assert.match(html, /^<figure class="t-chart t-chart--bars is-pulled" data-t-chart="bars" data-t-axis="y" aria-labelledby="c1-title"/);
  assert.match(html, /<p class="t-chart-title" id="c1-title">Most incidents start with an email<\/p>/);
  assert.match(html, /<div class="t-chart-body" aria-hidden="true">/);
  assert.match(html, /<table class="t-chart-table"><caption>Most incidents start with an email<\/caption>/, 'a table for screen readers');
  assert.match(html, /--t-chart-on-accent:#FFFFFF/, 'what reads on the accent, from the tokens');
  // Sorted: the largest first; each row's label and track are the same item, the highlight marked.
  const order = [...html.matchAll(/class="t-bars-label[^"]*" data-t-item="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, ['email', 'web', 'usb']);
  assert.match(html, /class="t-bars-label is-hl" data-t-item="email" data-t-say="Email: 62%, Fake invoices" data-t-tip="Fake invoices"/);
  assert.match(html, /class="t-bars-track is-hl" data-t-item="email" style="--w:1"/);
  assert.match(html, /<span class="t-bars-value" data-t-tip-at data-t-num="62">62%<\/span>/);
  assert.deepEqual(data, { format: { unit: '%', decimals: 0 } }, 'the player counts with the chart\'s format');
  assert.equal(renderChart('bars', bars, context).html, html, 'deterministic');
});

test('trend: points placed in fractions, the note at its year, predict mode hides nothing at rest and asks after the drawing', () => {
  const { html, data } = renderChart('trend', { ...predict, note: { x: 'Mar', text: 'Drills start' } }, context);
  assert.match(html, /class="t-chart t-chart--trend is-predict"/);
  assert.match(html, /<path class="t-trend-line" d="M0,[\d.]+C/);
  assert.match(html, /<path class="t-trend-guess" d=""\/>/);
  assert.match(html, /<div class="t-trend-note" style="left:20%" data-t-at="p1"><span>Drills start<\/span><\/div>/);
  assert.match(html, /<div class="t-trend-zone" style="left:40%" data-t-from="2">/);
  // The slider and button come after the drawing: screen readers and keys reach them.
  const body = html.indexOf('<div class="t-chart-body"'), ask = html.indexOf('<div class="t-trend-ask">'), table = html.indexOf('<table');
  assert.ok(body < ask && ask < table, 'the ask between the drawing and the table');
  assert.match(html, /<input class="t-trend-range t-sr-only" type="range" min="0" max="40" step="0.2" value="21">/);
  const points = (data as { points: { px: number; py: number }[] }).points;
  assert.deepEqual(points.map((point) => point.px), [0, 0.2, 0.4, 0.6, 0.8, 1]);
  assert.deepEqual((data as { predict: unknown }).predict, { from: 2, tolerance: 4, scored: false, weight: 1 });
  assert.deepEqual(chartItems('trend', { points: [{ x: 1, y: 2, at: { line: 'l1' } }, { x: 2, y: 3 }] }), [{ id: 'p0', at: { line: 'l1' }, path: '/points/0/at' }]);
});

test('diagram: Pele draws it wide and narrow, its nodes become items by depth, colours written in it are left out', () => {
  const { html } = renderChart('diagram', { ...flow, mermaid: `${flow.mermaid}\n  style A fill:#ff0000` }, context);
  assert.match(html, /<div class="t-diagram t-diagram--flowchart"><div class="t-diagram-wide"><svg/);
  assert.match(html, /<div class="t-diagram-narrow"><svg/);
  assert.match(html, /<g class="pele-node pele-shape-rect" data-id="A" data-t-item="A" data-t-say="Email arrives" data-t-depth="0"/);
  assert.match(html, /<g class="pele-node pele-shape-rect is-hl" data-id="C" data-t-item="C" data-t-say="Hover the link" data-t-depth="2"/);
  assert.match(html, /<g class="pele-edge" data-id="L_B_C_0" data-t-from="B" data-t-to="C" data-t-depth="1"/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.ok(!html.includes('style A'), 'the Mermaid text is not shown');
  const parsed = parseDiagram('pie\n "a": 1');
  assert.ok(isProblem(parsed) && parsed.code === 'E_DIAGRAM_TYPE');
  assert.deepEqual(diagramIds('venn-beta\n  set A["Email"]\n  set B["Web"]\n  union A,B["Both"]'), { items: ['A', 'B', 'A|B'], edges: [] });
  assert.match(chartMarkdown('diagram', flow, context), /^\*\*Hover before you click\*\*\n\n\| {2}\| {2}\|\n\|/);
});

// A copy of the example with a narrated screen of charts.
function chartsCourse(edit: (screen: Record<string, any>) => void = () => {}): string {
  const dir = copyExample();
  const screen = readJSON(dir, 'screens/chemin.json');
  screen.narration = { lines: [{ id: 'l1', text: 'Most incidents start with an email, far more than with websites.' }, { id: 'l2', text: 'Look at how clicks fall after the drills.' }] };
  screen.blocks.push(
    { id: 'origin', type: 'bars', props: { ...bars, rows: bars.rows.map((row) => (row.id === 'email' ? { ...row, at: { line: 'l1', word: 'email' } } : row.id === 'web' ? { ...row, at: { line: 'l1', word: 'websites' } } : row)) } },
    { id: 'clicks', type: 'trend', props: predict },
    { id: 'flow', type: 'diagram', props: flow }
  );
  edit(screen);
  writeJSON(dir, 'screens/chemin.json', screen);
  return dir;
}

test('compile: charts carry their drawing, their beats on the timeline, and a trend that predicts is an activity', () => {
  const project = loadProjectFromDir(chartsCourse());
  const { keys } = assignKeys(project, readLock(project), { dryRun: true });
  const data = compileCourseData(project, keys, { buildId: 'test' });
  const screen = data.screens.find((candidate) => candidate.id === 'chemin')!;
  const origin = screen.blocks.find((block) => block.id === 'origin')!;
  assert.equal(origin.behavior, 'chart');
  assert.match(origin.html ?? '', /data-t-chart="bars"/);
  const beats = (origin.props as { beats: Record<string, number>; beatsEnd: number; revealOnBeats: boolean });
  assert.deepEqual(Object.keys(beats.beats).sort(), ['email', 'web']);
  assert.ok(beats.beats.email < beats.beats.web, 'email is said before websites');
  assert.ok(beats.beatsEnd > beats.beats.web, 'the spotlight ends with the line');
  assert.equal(beats.revealOnBeats, true);
  const clicks = screen.blocks.find((block) => block.id === 'clicks') as PredictBlock;
  assert.equal(clicks.behavior, 'predict');
  assert.ok(clicks.key, 'its guess has a key in the learner state');
  assert.equal(screen.blocks.find((block) => block.id === 'flow')!.behavior, 'chart');

  // The guess is kept like a numeric answer, closes the activity, and counts only when scored.
  const state = createCourseState(data);
  assert.equal(state.activityDone(clicks), false);
  assert.deepEqual(state.answerPredict('clicks', 12), { close: false, actual: 5 });
  assert.equal(state.answerPredict('clicks', 6), null, 'one guess');
  assert.equal(state.predictState(clicks), 12);
  assert.equal(state.activityDone(clicks), true);
  assert.equal(state.computeStatus().score.items, createCourseState(data).computeStatus().score.items, 'not scored by default');
  const again = createCourseState(data, { suspendData: state.encode() });
  assert.equal(again.predictState(clicks), 12, 'resumed');
});

test('validation: item ids, what names an item, a trend that cannot be drawn, a widening funnel, diagram types and colours, beat anchors', () => {
  const dir = chartsCourse((screen) => {
    screen.blocks.push(
      { id: 'dup', type: 'bars', props: { takeaway: 'Twice the same id', highlight: 'nope', rows: [{ id: 'a', label: 'A', value: 1 }, { id: 'a', label: 'B', value: 2 }] } },
      { id: 'late', type: 'trend', props: { ...predict, predict: { from: 'Nov' }, note: { x: 'Dec', text: 'Too late' } } },
      { id: 'funnel', type: 'levels', props: { takeaway: 'A funnel that widens', items: [{ id: 'a', label: 'Sent', value: 100 }, { id: 'b', label: 'Opened', value: 140 }] } },
      { id: 'pie', type: 'diagram', props: { takeaway: 'Not a diagram', mermaid: 'pie\n "a": 1' } },
      { id: 'painted', type: 'diagram', props: { ...flow, highlight: 'Z', mermaid: `${flow.mermaid}\n  classDef hot fill:#f00`, beats: [{ node: 'Q', at: { line: 'l2' } }], labels: { X: 'Nowhere' } } }
    );
    screen.blocks.find((block: { id: string }) => block.id === 'origin').props.rows[0].at = { line: 'l1', word: 'phone' };
  });
  const diagnostics = validateDir(dir).diagnostics;
  const found = (code: string, target: string) => diagnostics.some((d) => d.code === code && d.target === target);
  assert.ok(found('E_CHART_ITEM_DUPLICATE', 'dup'));
  assert.ok(found('E_CHART_ITEM_UNKNOWN', 'dup'), 'highlight');
  assert.ok(found('E_CHART_DATA', 'late'), 'predict from the last point');
  assert.ok(found('E_CHART_ITEM_UNKNOWN', 'late'), 'the note names no point');
  assert.ok(found('W_CHART_ORDER', 'funnel'));
  assert.ok(found('E_DIAGRAM_TYPE', 'pie'));
  assert.ok(found('W_DIAGRAM_COLOR', 'painted'));
  assert.equal(diagnostics.filter((d) => d.code === 'E_CHART_ITEM_UNKNOWN' && d.target === 'painted').length, 3, 'highlight, beat and label');
  assert.ok(diagnostics.some((d) => d.code === 'E_TIMELINE_ANCHOR_MISSING' && d.target === 'origin' && d.path?.endsWith('/at/word')), 'a beat on a word the line does not say');
  assert.ok(!codes(validateDir(chartsCourse()).diagnostics).some((code) => code.startsWith('E_CHART') || code.startsWith('E_DIAGRAM') || code === 'E_TIMELINE_ANCHOR_MISSING'), 'the charts course is clean');
});

test('translation: a diagram\'s words by id into labels, a trend\'s references follow the words of its points', () => {
  const project = loadProjectFromDir(chartsCourse((screen) => { screen.blocks.find((block: { id: string }) => block.id === 'clicks').props.note = { x: 'May', text: 'Halfway' }; }));
  const units = extractUnits(project);
  const label = units.find((unit) => unit.id === 'block.flow.labels.C')!;
  assert.equal(label.text, 'Hover the link');
  assert.match(label.pointer, /\/props\/labels\/C$/);
  assert.deepEqual(label.base?.value, {}, 'labels written first when the block has none');
  assert.ok(units.some((unit) => unit.id === 'block.flow.labels.L_B_C_0' && unit.text === 'yes'));
  const may = units.find((unit) => unit.id === 'block.clicks.points.2.x')!;
  assert.equal(may.follows?.length, 2);
  const screen = structuredClone(project.screens.get('chemin')!.data) as unknown as Record<string, any>;
  writeUnit(screen, may, 'Mai');
  const clicks = screen.blocks.find((block: { id: string }) => block.id === 'clicks').props;
  assert.deepEqual([clicks.points[2].x, clicks.predict.from, clicks.note.x], ['Mai', 'Mai', 'Mai']);
});

test('the kit: the monotone curve the core draws, labels pushed apart, numbers in the course language', () => {
  const points = [{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 1 }, { x: 3, y: 3 }];
  for (const point of points) assert.equal(monotoneY(points, point.x), point.y, 'through every point');
  const y = monotoneY(points, 1.5);
  assert.ok(y > 1 && y < 2, 'monotone between two points');
  assert.match(monotonePath(points), /^M0,0C0\.33,/);
  assert.deepEqual(dodge([10, 11, 30], 4).map(Math.round), [9, 13, 30]);
  assert.equal(formatValue(62, { unit: '%' }, 'fr'), '62\u00a0%');
  assert.equal(formatValue(1250.5, { decimals: 1, unit: 'h' }, 'fr'), '1\u202f250,5\u202fh');
});
