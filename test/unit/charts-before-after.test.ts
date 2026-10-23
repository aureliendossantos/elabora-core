import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable, chartMarkdown } from '@elabora/core/charts/index';
import { slopeGeometry, dodgeSized, SLOPE } from '@elabora/core/charts/before-after';

// before-after (D60): a slope chart drawn at build time, its labels pushed apart there.

const context = { id: 'ba', language: 'en', tokens: { 'color.accent': '#C2410C', 'color.surface': '#FFFFFF', 'color.text': '#111111' } };
const sites = {
  takeaway: 'Every site improved, the head office least', beforeLabel: '2022', afterLabel: '2025', unit: '%', highlight: 'hq',
  items: [
    { id: 'lyon', label: 'Lyon', before: 34, after: 8 },
    { id: 'grenoble', label: 'Grenoble', before: 31, after: 6, at: { line: 'l2', word: 'Grenoble' } },
    { id: 'nantes', label: 'Nantes', before: 29, after: 11 },
    { id: 'hq', label: 'Head office', before: 22, after: 14 }
  ]
};
const attr = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].map((match) => Number(match[1]));

test('before-after: two columns, a line per item between its values, labels at both ends', () => {
  const { html } = renderChart('before-after', sites, context);
  assert.match(html, /^<figure class="t-chart t-chart--before-after is-pulled" data-t-chart="before-after" data-t-axis="y"/);
  assert.match(html, /<p class="t-slope-head is-before">2022<\/p><p class="t-slope-head is-after">2025<\/p>/);
  // The plot's height (rem) and the room its headings take, wide and narrow.
  assert.match(html, /<div class="t-slope-plot" style="--h:18;--hn:18;--heads:1;--headsn:1">/);
  // Each item: its left label first (what the keys say), its line (stretched, drawn by clipping), its dots, its right label.
  assert.match(html, /<p class="t-slope-label is-before" data-t-item="lyon" data-t-say="Lyon: 34% → 8%" style="--y:[\d.-]+;--yn:[\d.-]+"><span class="t-slope-name">Lyon<\/span> <b class="t-slope-num" data-t-num="34">34%<\/b><\/p>/);
  assert.match(html, /<svg class="t-slope-line" data-t-item="lyon" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false"><line x1="0" y1="3" x2="100" y2="[\d.]+"\/><\/svg>/);
  assert.match(html, /<i class="t-slope-dot is-after" data-t-item="grenoble" style="--y:0.97"><\/i>/, 'the lowest value at the bottom');
  assert.match(html, /<p class="t-slope-label is-after is-hl" data-t-item="hq"[^>]*><b class="t-slope-num" data-t-num="14">14%<\/b> <span class="t-slope-name">Head office<\/span><\/p>/);
  // The highlight marks every element of its item.
  assert.equal((html.match(/ is-hl" data-t-item="hq"/g) ?? []).length, 5);
});

test('before-after: labels never overlap, wide and narrow; the plot grows when they crowd', () => {
  const crowded = {
    ...sites, highlight: undefined,
    items: [
      { id: 'a', label: 'Accounting and purchasing', before: 12, after: 41 },
      { id: 'b', label: 'Sales', before: 9, after: 22 },
      { id: 'c', label: 'Customer support in Lyon and Grenoble', before: 15, after: 23 },
      { id: 'd', label: 'IT', before: 30, after: 44 },
      { id: 'e', label: 'Human resources', before: 14, after: 39 },
      { id: 'g', label: 'Legal', before: 13, after: 13 }
    ]
  };
  const { html } = renderChart('before-after', crowded, context);
  const height = attr(html, /--h:([\d.]+)/g)[0];
  assert.ok(height > SLOPE.plot && height <= SLOPE.most, 'a taller plot when labels crowd');
  const narrowHeight = attr(html, /--hn:([\d.]+)/g)[0];
  const labels = [...html.matchAll(/t-slope-label (is-before|is-after)[^"]*" data-t-item="[^"]+"[^>]*style="--y:([\d.-]+);--yn:([\d.-]+)"/g)].map((match) => ({ side: match[1], y: Number(match[2]), yn: Number(match[3]) }));
  assert.equal(labels.length, 12);
  for (const side of ['is-before', 'is-after']) {
    for (const [key, plot] of [['y', height], ['yn', narrowHeight]] as const) {
      const ys = labels.filter((label) => label.side === side).map((label) => label[key] * plot).sort((a, b) => a - b);
      for (let k = 1; k < ys.length; k++) assert.ok(ys[k] - ys[k - 1] >= SLOPE.line + SLOPE.space - 1e-3, `${side} ${key}: ${ys.join(', ')}`);
    }
  }
  // The long label takes two lines on the right, wide: its neighbours keep two lines' room.
  assert.ok(dodgeSized([5, 5.2], [2.5, 1.25], 0.25).reduce((a, b) => Math.abs(b - a)) >= 2.125 - 1e-9);
});

test('before-after: a small dodge keeps order, stays within bounds when it can, and moves nothing apart already', () => {
  assert.deepEqual(dodgeSized([1, 5, 9], [1, 1, 1], 0.25), [1, 5, 9]);
  const pushed = dodgeSized([4, 4, 4], [1, 1, 1], 0, [0, 18]);
  assert.deepEqual(pushed, [3, 4, 5]);
  const top = dodgeSized([0, 0.1], [1, 1], 0, [0, 18]);
  assert.ok(top[0] >= 0.5 - 1e-9 && top[1] - top[0] >= 1 - 1e-9, 'kept within the plot');
});

test('before-after: scale, items with their moments, the table, determinism and edge cases', () => {
  // The scale spans the values (a slope chart compares changes), with a little room at both ends.
  const geometry = slopeGeometry(sites);
  assert.equal(geometry[0].y0, 0.03);
  assert.equal(geometry[1].y1, 0.97);
  assert.deepEqual(chartItems('before-after', sites).map((item) => item.path), ['/items/0/at', '/items/1/at', '/items/2/at', '/items/3/at']);
  assert.deepEqual(chartItems('before-after', sites)[1].at, { line: 'l2', word: 'Grenoble' });
  assert.deepEqual(chartTable('before-after', sites, context), { head: ['', '2022', '2025'], rows: [['Lyon', '34%', '8%'], ['Grenoble', '31%', '6%'], ['Nantes', '29%', '11%'], ['Head office', '22%', '14%']] });
  assert.match(chartMarkdown('before-after', sites, { ...context, language: 'fr' }), /\| Lyon \| 34\s% \| 8\s% \|/);
  assert.equal(renderChart('before-after', sites, context).html, renderChart('before-after', structuredClone(sites), context).html);
  // Every value equal, one item, a long heading: drawn without failing, without NaN.
  const flat = renderChart('before-after', { ...sites, items: [{ id: 'a', label: 'A', before: 5, after: 5 }] }, context).html;
  assert.doesNotMatch(flat, /NaN|Infinity/);
  assert.match(flat, /<line x1="0" y1="50" x2="100" y2="50"\/>/);
  assert.match(renderChart('before-after', { ...sites, beforeLabel: 'Before the training', afterLabel: 'Six months later' }, context).html, /--headsn:2/);
});
