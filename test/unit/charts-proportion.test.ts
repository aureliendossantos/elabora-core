import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable, chartMarkdown } from '@elabora/core/charts/index';
import { proportionGeometry, PROPORTION_ITEM } from '@elabora/core/charts/proportion';

// proportion (D60): "1 in 10" as an icon array drawn at build time.

const context = { id: 'pr', language: 'en', tokens: { 'color.accent': '#C2410C', 'color.surface': '#FFFFFF', 'color.text': '#111111' } };
const clicks = { takeaway: 'Roughly one employee in ten still clicks', of: 100, part: 9, figure: '1 in 10', label: 'clicked the link of the test email', at: { line: 'l2', word: 'ten' } };
const icons = (html: string) => [...html.matchAll(/<i class="t-prop-icon( is-lit)?"[^>]*><\/?/g)].map((match) => !!match[1]);

test('proportion: one item, the figure and the lit icons; the figure says it to the keys', () => {
  const { html } = renderChart('proportion', clicks, context);
  assert.match(html, /<figure class="t-chart t-chart--proportion" data-t-chart="proportion" data-t-axis="none"/);
  assert.match(html, /<div class="t-prop-layout t-prop--person"><div class="t-prop-figure" data-t-item="part" data-t-say="1 in 10 clicked the link of the test email">/);
  // An author's figure is written as is (not counted).
  assert.match(html, /<p class="t-prop-big">1 in 10<\/p><p class="t-prop-label">clicked the link of the test email<\/p>/);
  assert.equal([...html.matchAll(/data-t-item="part"/g)].length, 1 + 9);
  assert.equal([...html.matchAll(/<b class="t-prop-ink"><\/b>/g)].length, 9);
  assert.equal(icons(html).length, 100);
  assert.match(html, /<div class="t-prop-grid" style="--cols:20">/);
  assert.deepEqual(chartItems('proportion', clicks), [{ id: PROPORTION_ITEM, at: { line: 'l2', word: 'ten' }, path: '/at' }]);
  assert.deepEqual(chartItems('proportion', { ...clicks, at: undefined }), [{ id: 'part', path: '/at' }]);
});

test('proportion: lit icons fill column after column from the top left, as one block, each with its turn', () => {
  // 100 in 20 columns (5 rows): 9 lit are the first column and four of the second.
  const { lit, rows, columns } = proportionGeometry(clicks);
  assert.equal(columns, 20);
  assert.equal(rows, 5);
  assert.deepEqual([...lit], [0, 20, 40, 60, 80, 1, 21, 41, 61]);
  const { html } = renderChart('proportion', clicks, context);
  const lights = icons(html);
  assert.deepEqual(lights.flatMap((on, index) => (on ? [index] : [])), [0, 1, 20, 21, 40, 41, 60, 61, 80]);
  // The wave runs from the top left (0) to the bottom right (1); turns follow the lit order.
  assert.match(html, /^.*?<i class="t-prop-icon is-lit" data-t-item="part" data-wave="0" data-turn="0">/s);
  assert.match(html, /<i class="t-prop-icon" data-wave="1"><\/i><\/div>/);
  assert.match(html, /<i class="t-prop-icon is-lit" data-t-item="part" data-wave="0.0435" data-turn="0.5556">/);
  // A short last row: cells that do not exist are skipped.
  const short = proportionGeometry({ of: 25, part: 23, columns: 10 });
  assert.equal(short.lit.size, 23);
  assert.ok([...short.lit].every((index) => index < 25));
});

test('proportion: the default figure is the share, counted; columns, icons and bounds', () => {
  const dots = { takeaway: 'Most teams report within the hour', of: 20, part: 13, icon: 'circle', label: 'of the teams' };
  const { html } = renderChart('proportion', dots, context);
  assert.match(html, /<p class="t-prop-big" data-t-num="65">65%<\/p>/);
  assert.match(html, /t-prop--circle/);
  assert.match(html, /--cols:10/);
  const fr = renderChart('proportion', { ...dots, of: 3, part: 1 }, { ...context, language: 'fr' }).html;
  assert.match(fr, /data-t-num="33">33 %</);
  // Bounds: part above of is all of them; nothing lit is a grid of quiet icons; an unknown icon is a person.
  assert.equal(proportionGeometry({ of: 10, part: 40 }).lit.size, 10);
  const none = renderChart('proportion', { takeaway: 'T', of: 10, part: 0, icon: 'star' }, context).html;
  assert.doesNotMatch(none, /is-lit/);
  assert.match(none, /t-prop--person/);
  assert.match(none, /data-t-num="0">0%</);
  assert.equal(proportionGeometry({ of: 50, part: 5, columns: 25 }).rows, 2);
});

test('proportion: the table and the Markdown fallback name the figure and the count', () => {
  assert.deepEqual(chartTable('proportion', clicks, context), { head: [], rows: [['1 in 10', 'clicked the link of the test email', '9 / 100']] });
  assert.match(chartMarkdown('proportion', clicks, context), /\| 1 in 10 \| clicked the link of the test email \| 9 \/ 100 \|/);
  // Long labels are escaped HTML that wraps; identical inputs give identical markup.
  const long = renderChart('proportion', { ...clicks, label: 'clicked <the> link & typed their password on the fake page' }, context).html;
  assert.match(long, /clicked &lt;the&gt; link &amp; typed/);
  assert.equal(renderChart('proportion', clicks, context).html, renderChart('proportion', clicks, context).html);
});
