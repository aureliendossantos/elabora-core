import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable, chartMarkdown } from '@elabora/core/charts/index';

const context = { id: 'moves', language: 'en', tokens: { 'color.accent': '#C2410C', 'color.surface': '#FFFFFF', 'color.text': '#1F2933' } };
const props = (extra: Record<string, unknown> = {}) => ({
  takeaway: 'An email looks wrong? Three moves',
  items: [
    { id: 'stop', title: 'Don’t click, don’t reply', text: 'Not even to unsubscribe.' },
    { id: 'report', title: 'Press “Report”', text: 'It goes to the security team.', at: { line: 'l1', word: 'report' } },
    { id: 'delete', title: 'Delete it' }
  ],
  ...extra
});
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test('process: markup hooks, numbered circles and the links between them', () => {
  const { html, data } = renderChart('process', props(), context);
  assert.equal(data, undefined);
  assert.match(html, /data-t-chart="process"/);
  assert.match(html, /data-t-axis="xy"/);
  assert.match(html, /<div class="t-process" style="--n:3">/);
  assert.equal(count(html, /class="t-process-step/g), 3);
  // A link from each step to the next: none after the last.
  assert.equal(count(html, /class="t-process-link"/g), 2);
  assert.ok(!/t-process-link[^]*t-process-link[^]*t-process-link/.test(html));
  // The circle is the item's first element and says the step; title and text belong to the item.
  assert.match(html, /<span class="t-process-n" data-t-item="stop" data-t-say="1. Don’t click, don’t reply: Not even to unsubscribe.">1<\/span>/);
  assert.match(html, /data-t-item="delete" data-t-say="3. Delete it">3</);
  assert.equal(count(html, /data-t-item="report"/g), 3);
  assert.equal(count(html, /data-t-item="delete"/g), 2); // no text: circle and title
  // The step itself is not an item, so its link never dims with it.
  assert.ok(!/class="t-process-step[^"]*" data-t-item/.test(html));
  // Words are escaped HTML.
  assert.match(html, /Press “Report”/);
  assert.doesNotMatch(html, /<script/);
});

test('process: the highlight marks its step, and the figure is pulled at rest', () => {
  const plain = renderChart('process', props(), context).html;
  assert.doesNotMatch(plain, /is-hl|is-pulled/);
  const { html } = renderChart('process', props({ highlight: 'report' }), context);
  assert.match(html, /class="t-chart t-chart--process is-pulled"/);
  assert.match(html, /class="t-process-step is-hl"/);
  assert.match(html, /class="t-process-n is-hl" data-t-item="report"/);
  assert.match(html, /class="t-process-title is-hl" data-t-item="report"/);
  assert.equal(count(html, /is-hl/g), 4);
  // What reads on the accent comes from the theme.
  assert.match(html, /--t-chart-on-accent:#FFFFFF/);
});

test('process: items with their moments, the table and the Markdown fallback', () => {
  assert.deepEqual(chartItems('process', props()), [
    { id: 'stop', path: '/items/0/at' },
    { id: 'report', at: { line: 'l1', word: 'report' }, path: '/items/1/at' },
    { id: 'delete', path: '/items/2/at' }
  ]);
  assert.deepEqual(chartTable('process', props(), context), { head: [], rows: [['1', 'Don’t click, don’t reply', 'Not even to unsubscribe.'], ['2', 'Press “Report”', 'It goes to the security team.'], ['3', 'Delete it', '']] });
  const noTexts = props({ items: [{ id: 'a', title: 'Plug in' }, { id: 'b', title: 'Sign in' }] });
  assert.deepEqual(chartTable('process', noTexts, context).rows, [['1', 'Plug in'], ['2', 'Sign in']]);
  const markdown = chartMarkdown('process', props(), context);
  assert.match(markdown, /^\*\*An email looks wrong\? Three moves\*\*/);
  assert.match(markdown, /\| 2 \| Press “Report” \| It goes to the security team\. \|/);
  const { html } = renderChart('process', props(), context);
  assert.match(html, /<table class="t-chart-table">/);
});

test('process: one step, long words and bad items are drawn without breaking', () => {
  const one = renderChart('process', { takeaway: 'One move', items: [{ id: 'only', title: 'Report it' }] }, context).html;
  assert.equal(count(one, /class="t-process-step/g), 1);
  assert.doesNotMatch(one, /t-process-link/);
  const long = 'Überprüfungsverantwortlichkeitsbeauftragter '.repeat(2).trim();
  const html = renderChart('process', { takeaway: 'Long', items: [{ id: 'a', title: long, text: '<b>x</b>' }, 'junk', { id: 'b', title: 'B' }] }, context).html;
  assert.match(html, /--n:2/);
  assert.ok(html.includes(long));
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.equal(renderChart('process', { takeaway: 'Nothing' }, context).html.includes('t-process-step'), false);
});

test('process: the build is deterministic', () => {
  const a = renderChart('process', props({ highlight: 'stop' }), context);
  const b = renderChart('process', props({ highlight: 'stop' }), context);
  assert.equal(a.html, b.html);
});
