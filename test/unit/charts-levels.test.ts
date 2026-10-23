import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable, chartMarkdown } from '@elabora/core/charts/index';
import { levelsGeometry, LEVELS } from '@elabora/core/charts/levels';

// levels (D60): a funnel or a pyramid drawn as one silhouette at build time.

const context = { id: 'lv', language: 'en', tokens: { 'color.accent': '#C2410C', 'color.surface': '#FFFFFF', 'color.text': '#111111' } };
const funnel = {
  takeaway: 'Half of those who open the email click the link', highlight: 'clicked',
  items: [
    { id: 'sent', label: 'Received the email', value: 1240 },
    { id: 'opened', label: 'Opened it', value: 770, text: 'Most within the first hour.', at: { line: 'l1', word: 'opened' } },
    { id: 'clicked', label: 'Clicked the link', value: 380 },
    { id: 'reported', label: 'Reported it', value: 61 }
  ]
};
const pyramid = {
  takeaway: 'Every control rests on people', shape: 'pyramid',
  items: [{ id: 'audit', label: 'Audit' }, { id: 'tools', label: 'Tools' }, { id: 'rules', label: 'Rules' }, { id: 'people', label: 'People who notice', text: 'The colleague who stops.' }]
};
const rows = (html: string) => [...html.matchAll(/<div class="t-levels-row([^"]*)" data-t-item="([^"]+)"[^>]*style="--top:([\d.]+);--bottom:([\d.]+);--edge:([\d.]+)"/g)]
  .map((match) => ({ classes: match[1], id: match[2], top: Number(match[3]), bottom: Number(match[4]), edge: Number(match[5]) }));

test('levels: a funnel is one silhouette sized by its values, its slanted sides carried on through the gaps', () => {
  const { html } = renderChart('levels', funnel, context);
  assert.match(html, /<div class="t-levels t-levels--funnel is-sized" style="--n:4">/);
  const drawn = rows(html);
  assert.deepEqual(drawn.map((row) => row.id), ['sent', 'opened', 'clicked', 'reported']);
  // The widest stage spans the column; each top is its value's share of the largest.
  assert.equal(drawn[0].top, 1);
  assert.ok(Math.abs(drawn[1].top - 770 / 1240) < 1e-3);
  // Through the gap, the silhouette goes on: a row's bottom lies between its top and the next row's top,
  // on the line between them (row / pitch of the way).
  const share = LEVELS.row / (LEVELS.row + LEVELS.gap);
  for (let i = 0; i < drawn.length - 1; i++) assert.ok(Math.abs(drawn[i].bottom - (drawn[i].top + (drawn[i + 1].top - drawn[i].top) * share)) < 1e-3, `row ${i}`);
  // The smallest stage keeps a visible width, and the neck narrows a little more.
  assert.ok(drawn[3].top >= 0.1 && drawn[3].bottom < drawn[3].top);
  // Each row is a trapezoid stretched to its cell, its corners rounded by a non-scaling stroke (CSS).
  assert.match(html, /<svg class="t-levels-svg" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false"><polygon points="0,0 100,0 [\d.]+,100 [\d.]+,100"\/><\/svg>/);
  // The values are inside (counted by the entrance), the drops between stages in the gap.
  assert.match(html, /<span class="t-levels-in" data-t-num="1240">1,240<\/span>/);
  assert.match(html, /data-t-item="opened"[^>]*>.*?<span class="t-levels-drop">−38%<\/span>/);
  assert.ok(!/data-t-item="sent"[^>]*>(?:(?!data-t-item).)*t-levels-drop/.test(html), 'no drop above the first stage');
  assert.doesNotMatch(renderChart('levels', { ...funnel, showDrops: false }, context).html, /t-levels-drop/, 'showDrops: false leaves the values alone');
  // Beside: the label, the sentence; what the arrow keys say.
  assert.match(html, /<div class="t-levels-note[^"]*" data-t-item="opened"><p class="t-levels-head"><span class="t-levels-name">Opened it<\/span>/);
  assert.match(html, /<p class="t-levels-text">Most within the first hour.<\/p>/);
  assert.match(html, /data-t-say="Opened it: 770. Most within the first hour."/);
  // The highlight marks the row and its note.
  assert.match(html, /<div class="t-levels-row is-hl[^"]*" data-t-item="clicked"/);
  assert.match(html, /<div class="t-levels-note is-hl[^"]*" data-t-item="clicked"/);
  assert.match(html, /^<figure class="t-chart t-chart--levels is-pulled"/);
});

test('levels: words go inside a row only where they fit, decided for the wide and the narrow layouts', () => {
  const drawn = rows(renderChart('levels', funnel, context).html);
  assert.match(drawn[0].classes, /is-in-wide/);
  assert.match(drawn[0].classes, /is-in-narrow/);
  // The last stage is too narrow for its value: it is written beside, in the note.
  assert.doesNotMatch(drawn[3].classes, /is-in-/);
  // A pyramid writes its labels inside; its tip is too narrow, so its label is beside.
  const pyramidRows = rows(renderChart('levels', pyramid, context).html);
  assert.doesNotMatch(pyramidRows[0].classes, /is-in-wide/);
  assert.match(pyramidRows[3].classes, /is-in-wide/);
  // A label too long for any row stays beside.
  const long = { ...pyramid, items: pyramid.items.map((item, index) => (index === 3 ? { ...item, label: 'People who notice something odd and say so to the security team' } : item)) };
  assert.doesNotMatch(rows(renderChart('levels', long, context).html)[3].classes, /is-in-wide/);
});

test('levels: a pyramid widens regularly from its tip to its base; a funnel without values narrows regularly', () => {
  const drawn = rows(renderChart('levels', pyramid, context).html);
  assert.match(renderChart('levels', pyramid, context).html, /t-levels--pyramid/);
  assert.ok(drawn[0].top < 0.1, 'a tip');
  assert.equal(drawn[3].bottom, 1, 'the base spans the column');
  for (let i = 0; i < drawn.length - 1; i++) assert.ok(drawn[i].top < drawn[i].bottom && drawn[i].bottom < drawn[i + 1].top);
  const plain = levelsGeometry({ items: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C', value: 3 }] });
  assert.equal(plain.sized, false, 'not every stage has a value');
  assert.ok(plain.levels[0].top === 1 && plain.levels[2].bottom < plain.levels[2].top);
});

test('levels: items with their moments, the table, determinism and edge cases', () => {
  assert.deepEqual(chartItems('levels', funnel), [
    { id: 'sent', path: '/items/0/at' },
    { id: 'opened', at: { line: 'l1', word: 'opened' }, path: '/items/1/at' },
    { id: 'clicked', path: '/items/2/at' },
    { id: 'reported', path: '/items/3/at' }
  ]);
  assert.deepEqual(chartTable('levels', funnel, context), { head: [], rows: [['Received the email', '1,240', ''], ['Opened it', '770', 'Most within the first hour.'], ['Clicked the link', '380', ''], ['Reported it', '61', '']] });
  assert.deepEqual(chartTable('levels', pyramid, context).rows[0], ['Audit', '']);
  assert.match(chartMarkdown('levels', { ...funnel, unit: '%' }, { ...context, language: 'fr' }), /\| Received the email \| 1\s240\s% \|/);
  // Byte-identical for identical inputs.
  assert.equal(renderChart('levels', funnel, context).html, renderChart('levels', structuredClone(funnel), context).html);
  // One item, values of zero, nothing at all: drawn without failing.
  assert.match(renderChart('levels', { takeaway: 'One', items: [{ id: 'a', label: 'All', value: 0 }] }, context).html, /t-levels-row/);
  assert.match(renderChart('levels', { takeaway: 'Zero', items: [{ id: 'a', label: 'A', value: 0 }, { id: 'b', label: 'B', value: 0 }] }, context).html, /--top:/);
  assert.doesNotMatch(renderChart('levels', { takeaway: 'None', items: [] }, context).html, /NaN|Infinity/);
  // Narrow, long sentences go under the shape so rows stay short; short ones stay beside.
  const long = { ...funnel, items: funnel.items.map((item) => ({ ...item, text: 'A sentence long enough to take more than two lines beside a narrow row of the funnel.' })) };
  assert.match(renderChart('levels', long, context).html, /is-texts-under"[^>]*>.*<\/div><ul class="t-levels-texts"><li data-t-item="sent"><b>Received the email<\/b>/);
  assert.match(renderChart('levels', long, context).html, /<li class="is-hl" data-t-item="clicked">/);
  assert.doesNotMatch(renderChart('levels', pyramid, context).html, /t-levels-texts/);
});
