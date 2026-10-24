import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable, chartMarkdown } from '@elabora/core/charts/index';

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

test('before-after: two columns, a line per item between its values, labels at both ends', () => {
  const { html } = renderChart('before-after', sites, context);
  assert.match(html, /^<figure class="t-chart t-chart--before-after is-pulled" data-t-chart="before-after" data-t-axis="y"/);
  assert.match(html, /<p class="t-slope-head is-before">2022<\/p><p class="t-slope-head is-after">2025<\/p>/);
  // The plot's height (rem) and the room its headings take, wide and narrow.
  // Each item: its left label first (what the keys say), its line (stretched, drawn by clipping), its dots, its right label.
  assert.match(html, /<p class="t-slope-label is-before" data-t-item="lyon" data-t-say="Lyon: 34% → 8%" style="--y:[\d.-]+;--yn:[\d.-]+"><span class="t-slope-name">Lyon<\/span> <b class="t-slope-num" data-t-num="34">34%<\/b><\/p>/);
  assert.match(html, /<svg class="t-slope-line" data-t-item="lyon" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false"><line x1="0" y1="[\d.]+" x2="100" y2="[\d.]+"\/><\/svg>/);
  assert.match(html, /<i class="t-slope-dot is-after" data-t-item="grenoble" style="--y:0\.[\d]+"><\/i>/, 'the lowest value at the bottom');
  assert.match(html, /<p class="t-slope-label is-after is-hl" data-t-item="hq"[^>]*><b class="t-slope-num" data-t-num="14">14%<\/b> <span class="t-slope-name">Head office<\/span><\/p>/);
  // The highlight marks every element of its item.
  assert.equal((html.match(/ is-hl" data-t-item="hq"/g) ?? []).length, 5);
});

test('before-after: scale, items with their moments, the table, determinism and edge cases', () => {
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
