import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable } from '@elabora/core/charts/index';

const context = { id: 'risks', language: 'en', tokens: {} };
const base = {
  takeaway: 'Which risks come first?',
  x: { label: 'Likelihood', low: 'Rare', high: 'Frequent' },
  y: { label: 'Impact', low: 'Minor', high: 'Severe' },
  quadrants: { topLeft: 'Plan for it', topRight: 'Act now', bottomLeft: 'Accept', bottomRight: 'Fix soon' }
};
const risks = [
  { id: 'usb', label: 'Unknown USB key plugged in', x: 0.18, y: 0.86, text: 'Rare, but can infect the whole network' },
  { id: 'laptop', label: 'Laptop left unlocked', x: 0.78, y: 0.76, text: 'Frequent, and opens every account', at: { line: 'l2', word: 'laptop' } },
  { id: 'sticky', label: 'Password on a sticky note', x: 0.68, y: 0.6 },
  { id: 'browser', label: 'Outdated browser', x: 0.85, y: 0.3, text: 'Mostly patched by IT' },
  { id: 'visitor', label: 'Visitor without a badge', x: 0.2, y: 0.34 }
];
const props = (extra: Record<string, unknown> = {}) => ({ ...base, items: risks, ...extra });
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test('matrix: markup hooks, dots first, labels on their side, axes and quadrants', () => {
  const { html } = renderChart('matrix', props(), context);
  assert.match(html, /data-t-chart="matrix"/);
  assert.match(html, /data-t-axis="xy"/);
  assert.equal(count(html, /class="t-matrix-dot"/g), 5);
  // The dot is the item's first element: it says the item and carries its reason in the tip.
  assert.ok(html.indexOf('class="t-matrix-dot" data-t-item="laptop"') < html.indexOf('class="t-matrix-label" data-t-item="laptop"'));
  assert.match(html, /data-t-item="laptop" data-t-say="Laptop left unlocked, Act now: Frequent, and opens every account" data-t-tip="Frequent, and opens every account" data-t-tip-at style="left:78%;top:24%"/);
  assert.match(html, /data-t-item="sticky" data-t-say="Password on a sticky note, Act now" data-t-tip-at/);
  assert.match(html, /class="t-matrix-label" data-t-item="usb" data-side="r" data-nside="[a-z]+" style="left:18%;top:14%">Unknown USB key plugged in</);
  // Labels on the right half look toward the middle.
  assert.match(html, /data-t-item="browser" data-side="l"/);
  assert.match(html, /<span class="t-matrix-low">Rare<\/span><b class="t-matrix-axis-name">Likelihood<\/b><span class="t-matrix-high">Frequent<\/span>/);
  assert.match(html, /class="t-matrix-q is-tr"><span class="t-matrix-q-name">Act now<\/span>/);
  assert.match(html, /<line class="t-matrix-cross-x"/);
  assert.match(html, /<ol class="t-matrix-legend"><li class="t-matrix-key" data-t-item="usb"><b>1<\/b><span>Unknown USB key plugged in<small>Rare, but can infect the whole network<\/small><\/span><\/li>/);
});

test('matrix: the data table names each item\'s quadrant', () => {
  assert.deepEqual(chartTable('matrix', props(), context).rows[1], ['Laptop left unlocked', 'Act now', 'Frequent, and opens every account']);
  assert.deepEqual(chartTable('matrix', props(), context).rows[4], ['Visitor without a badge', 'Accept', '']);
});

test('matrix: items with their moments', () => {
  const items = chartItems('matrix', props());
  assert.deepEqual(items.map((item) => item.id), ['usb', 'laptop', 'sticky', 'browser', 'visitor']);
  assert.deepEqual(items[1], { id: 'laptop', at: { line: 'l2', word: 'laptop' }, path: '/items/1/at' });
});

test('matrix: an item highlight, a quadrant highlight, both', () => {
  const item = renderChart('matrix', props({ highlight: 'laptop' }), context);
  assert.match(item.html, /class="t-chart t-chart--matrix is-pulled"/);
  assert.equal(count(item.html, /is-hl/g), 3); // dot, label, legend line
  assert.equal(item.data, undefined);
  const quadrant = renderChart('matrix', props({ highlightQuadrant: 'topRight' }), context);
  // A highlighted quadrant is pulled like an item (the frame and the player see its .is-hl).
  assert.match(quadrant.html, /class="t-chart t-chart--matrix is-pulled"/);
  assert.match(quadrant.html, /class="t-matrix-q is-tr is-hl"/);
  assert.equal(quadrant.data, undefined);
  const both = renderChart('matrix', props({ highlight: 'usb', highlightQuadrant: 'topLeft' }), context);
  assert.equal(count(both.html, /is-pulled/g), 1);
  assert.equal(both.data, undefined);
  assert.doesNotMatch(renderChart('matrix', props(), context).html, /is-hl|is-pulled/);
});

test('a spacious matrix keeps its labels and a close pair faces opposite directions', () => {
  assert.doesNotMatch(renderChart('matrix', props(), context).html, /t-matrix--legend/);
  const pair = renderChart('matrix', props({ items: [{ id: 'a', label: 'Phishing drills', x: 0.3, y: 0.5 }, { id: 'b', label: 'Single sign-on', x: 0.36, y: 0.5 }] }), context).html;
  const sides = [...pair.matchAll(/class="t-matrix-label"[^>]*data-side="([^"]+)"/g)].map(match => match[1]);
  assert.equal(sides.length, 2);
  assert.notEqual(sides[0], sides[1]);
});

test('matrix: a crowded plot numbers its dots on a phone, with a legend', () => {
  const crowd = Array.from({ length: 8 }, (_, index) => ({ id: `i${index}`, label: `A rather long label number ${index + 1}`, x: 0.2 + (index % 4) * 0.08, y: 0.6 + Math.floor(index / 4) * 0.1 }));
  assert.match(renderChart('matrix', { ...base, items: crowd }, context).html, /class="t-matrix t-matrix--legend"/);
});

test('matrix: deterministic, one item, values out of range, missing ends, escaped words', () => {
  const a = renderChart('matrix', props({ highlight: 'usb' }), context).html;
  assert.equal(a, renderChart('matrix', props({ highlight: 'usb' }), context).html);
  const one = renderChart('matrix', { ...base, x: { label: 'Effort' }, items: [{ id: 'a', label: '<Edge>', x: 1.4, y: -1 }] }, context).html;
  assert.match(one, /data-t-item="a" data-t-say="&lt;Edge&gt;, Fix soon" data-t-tip-at style="left:100%;top:100%"/);
  assert.match(one, /<span class="t-matrix-low"><\/span><b class="t-matrix-axis-name">Effort<\/b>/);
  assert.doesNotMatch(one, /<Edge>/);
  const none = renderChart('matrix', { ...base, items: [] }, context).html;
  assert.match(none, /t-matrix-q is-bl/);
  assert.doesNotMatch(none, /t-matrix-legend|data-t-item/);
});
