import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable, chartMarkdown } from '@elabora/core/charts/index';
import { stagesOf, arcOf } from '@elabora/core/charts/cycle';

const context = { id: 'loop', language: 'en', tokens: {} };
const props = (extra: Record<string, unknown> = {}) => ({
  takeaway: 'An incident is a loop, not a line',
  center: { title: 'Incident response', text: 'Point at a stage.' },
  items: [
    { id: 'prepare', title: 'Prepare', text: 'Keep a plan ready.' },
    { id: 'detect', title: 'Detect', text: 'Notice the odd login.', at: { line: 'l1', word: 'notice' } },
    { id: 'contain', title: 'Contain', text: 'Isolate the machine.' },
    { id: 'recover', title: 'Recover' }
  ],
  ...extra
});
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test('cycle: stages placed clockwise from the top, words on their outer side', () => {
  const stages = stagesOf(props());
  assert.deepEqual(stages.map((stage) => stage.side), ['top', 'right', 'bottom', 'left']);
  assert.ok(Math.abs(stages[0].x - 150) < 1e-9 && stages[0].y < 100);
  assert.ok(stages[1].x > 150 && Math.abs(stages[1].y - 100) < 1e-9);
  const arc = arcOf(stages[0], 4);
  assert.ok(arc && /^M[\d. ]+A66 66 0 0 1 [\d. ]+$/.test(arc.d) && /Z$/.test(arc.head));
  assert.equal(arcOf(stages[0], 1), null);
});

test('cycle: markup hooks, the centre, the arcs and the data table', () => {
  const { html } = renderChart('cycle', props(), context);
  assert.match(html, /data-t-chart="cycle"/);
  assert.match(html, /data-t-axis="xy"/);
  assert.equal(count(html, /class="t-cycle-stage /g), 4);
  assert.equal(count(html, /<g class="t-cycle-arc/g), 4);
  // A stage comes before its arc: it is its item's first element and says it.
  assert.ok(html.indexOf('class="t-cycle-stage is-right" data-t-item="detect"') < html.indexOf('<g class="t-cycle-arc" data-t-item="detect"'));
  assert.match(html, /data-t-item="detect" data-t-say="2. Detect: Notice the odd login."/);
  assert.match(html, /data-t-item="recover" data-t-say="4. Recover"/);
  // The arc into the first stage closes the loop (it comes from the last).
  assert.match(html, /<g class="t-cycle-arc" data-t-item="prepare">/);
  // The centre: the loop at rest, each stage's words stacked (the player shows one).
  assert.match(html, /<div class="t-cycle-rest"><p class="t-cycle-name">Incident response<\/p><p class="t-cycle-about">Point at a stage.<\/p><\/div>/);
  assert.equal(count(html, /class="t-cycle-say" data-t-for="/g), 4);
  assert.match(html, /viewBox="0 0 300 200"/);
  assert.doesNotMatch(html, /preserveAspectRatio="none"/);
  assert.deepEqual(chartTable('cycle', props(), context).rows, [['1. Prepare', 'Keep a plan ready.'], ['2. Detect', 'Notice the odd login.'], ['3. Contain', 'Isolate the machine.'], ['4. Recover', '']]);
  assert.match(html, /<table class="t-chart-table">.*<th scope="row">2. Detect<\/th><td>Notice the odd login.<\/td>/);
  assert.match(chartMarkdown('cycle', props(), context), /\| 3. Contain \| Isolate the machine. \|/);
});

test('cycle: items with their moments, in order', () => {
  assert.deepEqual(chartItems('cycle', props()), [
    { id: 'prepare', path: '/items/0/at' },
    { id: 'detect', at: { line: 'l1', word: 'notice' }, path: '/items/1/at' },
    { id: 'contain', path: '/items/2/at' },
    { id: 'recover', path: '/items/3/at' }
  ]);
});

test('cycle: the highlight marks the stage and the arc that brings it, and the figure is pulled', () => {
  const { html } = renderChart('cycle', props({ highlight: 'contain' }), context);
  assert.match(html, /class="t-chart t-chart--cycle is-pulled"/);
  assert.match(html, /class="t-cycle-stage is-bottom is-hl" data-t-item="contain"/);
  assert.match(html, /<g class="t-cycle-arc is-hl" data-t-item="contain">/);
  assert.equal(count(html, /is-hl/g), 2);
  assert.doesNotMatch(renderChart('cycle', props(), context).html, /is-hl|is-pulled/);
});

test('cycle: built the same twice, numbers short and stable', () => {
  const a = renderChart('cycle', props({ highlight: 'detect' }), context).html;
  assert.equal(a, renderChart('cycle', props({ highlight: 'detect' }), context).html);
  assert.doesNotMatch(a, /\d\.\d{5,}|e-\d/);
});

test('cycle: one stage, two stages, eight long ones, words escaped', () => {
  const one = renderChart('cycle', { takeaway: 't', center: { title: 'c' }, items: [{ id: 'a', title: 'Alone' }] }, context).html;
  assert.match(one, /data-t-item="a"/);
  assert.doesNotMatch(one, /t-cycle-arc|<svg/);
  const two = renderChart('cycle', { takeaway: 't', center: { title: 'c' }, items: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] }, context).html;
  assert.equal(count(two, /<g class="t-cycle-arc/g), 2);
  const long = 'Share what worked with the other teams <b>';
  const eight = renderChart('cycle', { takeaway: 't', center: { title: 'c' }, items: Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, title: long, text: 'x' })) }, context).html;
  assert.equal(count(eight, /<g class="t-cycle-arc/g), 8);
  assert.doesNotMatch(eight, /<b>/);
  assert.match(eight, /the other teams &lt;b&gt;/);
  assert.equal(renderChart('cycle', { takeaway: 't', items: [] }, context).html.includes('t-cycle'), false);
});

test('cycle: without a centre, the middle stays empty until a stage is pointed at', () => {
  const { html } = renderChart('cycle', { takeaway: 't', items: props().items }, context);
  assert.match(html, /<div class="t-cycle-centre"><div class="t-cycle-say" data-t-for="prepare">/);
  assert.doesNotMatch(html, /t-cycle-rest|<p class="t-cycle-name"><\/p>/);
  assert.equal(count(html, /<g class="t-cycle-arc/g), 4);
  const titleOnly = renderChart('cycle', { takeaway: 't', center: { title: 'Loop' }, items: props().items }, context).html;
  assert.match(titleOnly, /<div class="t-cycle-rest"><p class="t-cycle-name">Loop<\/p><\/div>/);
});
