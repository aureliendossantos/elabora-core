import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable, chartMarkdown } from '@elabora/core/charts/index';
import { donutGeometry } from '@elabora/core/charts/donut';

// donut (D60): a whole in parts, as a ring drawn at build time, with its centre and its legend.

const context = { id: 'sh', language: 'en', tokens: { 'color.accent': '#C2410C', 'color.surface': '#FFFFFF', 'color.text': '#111111' } };
const share = {
  takeaway: 'Half of suspicious emails are now reported', highlight: 'reported', unit: '%',
  parts: [
    { id: 'reported', label: 'Reported', value: 48, at: { line: 'l1', word: 'reported' } },
    { id: 'deleted', label: 'Deleted', value: 31 },
    { id: 'clicked', label: 'Clicked', value: 21, at: { line: 'l1', word: 'clicked' } }
  ]
};
const ofItem = (html: string, id: string) => [...html.matchAll(new RegExp(`<(\\w+) class="([^"]*)"[^>]*data-t-item="${id}"`, 'g'))].map((match) => `${match[1]}.${match[2]}`);

test('donut: each part answers as one item, its arc first (what the keys say), then its face and its legend row', () => {
  const { html } = renderChart('donut', share, context);
  assert.match(html, /<figure class="t-chart t-chart--donut is-pulled" data-t-chart="donut" data-t-axis="xy"/);
  assert.deepEqual(ofItem(html, 'deleted'), ['path.t-donut-arc', 'p.t-donut-face', 'li.t-donut-row']);
  assert.deepEqual(ofItem(html, 'reported'), ['path.t-donut-arc is-hl', 'p.t-donut-face is-hl', 'li.t-donut-row is-hl']);
  // The first element of an item carries what the live region says.
  assert.match(html, /<path class="t-donut-arc is-hl" data-t-item="reported" data-t-say="Reported: 48%"/);
  // Items come in reading order (clockwise), so the keys walk the ring.
  assert.deepEqual([...html.matchAll(/class="t-donut-arc[^"]*" data-t-item="([^"]+)"/g)].map((match) => match[1]), ['reported', 'deleted', 'clicked']);
  // The ring is a uniform viewBox; each arc is drawn by the mask of its middle line.
  assert.match(html, /<svg class="t-donut-svg" viewBox="-100 -100 200 200"/);
  assert.match(html, /<mask id="sh-donut-m0"[^>]*><path class="t-donut-sweep" d="M0,-81A81,81 0 0 1 [^"]+" pathLength="1"/);
  assert.match(html, /data-t-item="reported"[^>]*mask="url\(#sh-donut-m0\)"/);
});

test('donut: the centre says the highlighted part at rest and counts it; the others step back in tints of ink', () => {
  const { html } = renderChart('donut', share, context);
  assert.match(html, /<p class="t-donut-face is-rest is-hl"><span class="t-donut-figure" data-t-num="48">48%<\/span><span class="t-donut-name">Reported<\/span><\/p>/);
  // Colours: the highlight a darker ink until the pull, the others steps of ink.
  assert.match(html, /data-t-item="reported"[^>]*style="--c:var\(--t-donut-hl\)/);
  assert.match(html, /data-t-item="deleted"[^>]*style="--c:var\(--t-donut-k0\)/);
  assert.match(html, /data-t-item="clicked"[^>]*style="--c:var\(--t-donut-k1\)/);
  // A part moves out along its bisector: Reported spans 0 to 0.48 of the turn, so it leans right.
  const reported = /data-t-item="reported"[^>]*data-turn="([\d.]+) ([\d.]+)"[^>]*style="[^"]*--ux:([-\d.]+);--uy:([-\d.]+)"/.exec(html);
  assert.ok(reported);
  assert.equal(Number(reported[1]), 0);
  assert.equal(Number(reported[2]), 0.48);
  assert.ok(Number(reported[3]) > 0.99 && Math.abs(Number(reported[4])) < 0.07);
});

test('donut: without a highlight (or with center total), the centre says the total and the parts take steps of the accent', () => {
  const total = { takeaway: 'Where the test emails ended up', center: 'total', totalLabel: 'emails sent', parts: [{ id: 'a', label: 'Inbox', value: 1000 }, { id: 'b', label: 'Spam', value: 240 }] };
  const { html } = renderChart('donut', total, context);
  assert.doesNotMatch(html, /is-pulled/);
  assert.match(html, /<p class="t-donut-face is-rest"><span class="t-donut-figure" data-t-num="1240">1,240<\/span><span class="t-donut-name">emails sent<\/span><\/p>/);
  assert.match(html, /data-t-item="a"[^>]*style="--c:var\(--t-donut-a0\)/);
  assert.match(html, /data-t-item="b"[^>]*style="--c:var\(--t-donut-a1\)/);
  // center total with a highlight: the total at rest, the highlight still pulled.
  const both = renderChart('donut', { ...total, highlight: 'b' }, context).html;
  assert.match(both, /is-pulled/);
  assert.match(both, /<p class="t-donut-face is-rest"><span class="t-donut-figure" data-t-num="1240">/);
  // An unknown highlight is not a highlight for the colours.
  assert.match(renderChart('donut', { ...total, highlight: 'zz' }, context).html, /data-t-item="a"[^>]*style="--c:var\(--t-donut-a0\)/);
});

test('donut: the table, the Markdown fallback and the items with their moments', () => {
  const fr = { ...context, language: 'fr' };
  assert.deepEqual(chartTable('donut', share, fr).rows, [['Reported', '48\u00a0%'], ['Deleted', '31\u00a0%'], ['Clicked', '21\u00a0%']]);
  assert.match(chartMarkdown('donut', share, context), /\| Reported \| 48% \|/);
  assert.deepEqual(chartItems('donut', share), [
    { id: 'reported', at: { line: 'l1', word: 'reported' }, path: '/parts/0/at' },
    { id: 'deleted', path: '/parts/1/at' },
    { id: 'clicked', at: { line: 'l1', word: 'clicked' }, path: '/parts/2/at' }
  ]);
  // Values written with the chart's unit, so the counted centre lands on the same text.
  assert.deepEqual(renderChart('donut', share, context).data, { format: { unit: '%', decimals: 0 } });
});

test('donut: edge cases draw what they can, deterministically', () => {
  // One part holds the whole: a full ring, its middle line in two halves, no gap.
  const whole = renderChart('donut', { takeaway: 'All', parts: [{ id: 'a', label: 'All', value: 5 }, { id: 'b', label: 'None', value: 0 }] }, context).html;
  assert.match(whole, /<path class="t-donut-sweep" d="M0,-81A81,81 0 0 1 0,81A81,81 0 0 1 [^"]+"/);
  assert.match(whole, /data-t-item="b"[^>]*data-turn="1 1"/);
  // Nothing at all: no arcs drawn, the centre says 0, the legend stays.
  const empty = renderChart('donut', { takeaway: 'Nothing yet', parts: [{ id: 'a', label: 'A', value: 0 }, { id: 'b', label: 'B', value: 0 }] }, context).html;
  assert.match(empty, /data-t-num="0">0</);
  assert.equal([...empty.matchAll(/<li class="t-donut-row"/g)].length, 2);
  // Long and unsafe labels are escaped HTML: they wrap in the legend.
  const long = 'Opened in the inbox & read to the end <b>by everyone</b>';
  const escaped = renderChart('donut', { takeaway: 'T', highlight: 'a', parts: [{ id: 'a', label: long, value: 3 }, { id: 'b', label: 'B', value: 1 }] }, context).html;
  assert.match(escaped, /<span class="t-donut-label">Opened in the inbox &amp; read to the end &lt;b&gt;by everyone&lt;\/b&gt;<\/span>/);
  assert.doesNotMatch(escaped, /<b>by/);
  // Six parts: the steps stop at the lightest.
  const six = renderChart('donut', { takeaway: 'T', parts: [1, 2, 3, 4, 5, 6].map((v) => ({ id: `p${v}`, label: `P${v}`, value: v })) }, context).html;
  assert.match(six, /data-t-item="p6"[^>]*--c:var\(--t-donut-a5\)/);
  assert.equal(renderChart('donut', share, context).html, renderChart('donut', share, context).html);
  const { arcs, total } = donutGeometry(share);
  assert.equal(total, 100);
  assert.equal(arcs.length, 3);
});
