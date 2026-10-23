import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChart, chartItems, chartTable, chartMarkdown } from '@elabora/core/charts/index';
import { alternates, linesIn, milestonesOf } from '@elabora/core/charts/milestones';

const context = { id: 'rules', language: 'en', tokens: {} };
const short = (extra: Record<string, unknown> = {}) => ({
  takeaway: 'How our rules came about',
  items: [
    { id: 'charter', date: '2017', title: 'First IT charter', text: 'Signed on arrival.' },
    { id: 'vault', date: '2019', title: 'A password manager for all' },
    { id: 'mfa', date: '2021', title: 'Two-step login everywhere', text: 'Mail, VPN and HR.', at: { line: 'l2', word: 'two-step' } }
  ],
  ...extra
});
const long = () => ({
  takeaway: 'Phishing grew from a prank into an industry',
  items: [
    { id: 'aol', date: '1995', title: 'AOL accounts stolen by fake staff messages', text: 'The word appears.' },
    { id: 'paypal', date: '2003', title: 'Fake PayPal pages copy the real site pixel for pixel' },
    { id: 'spear', date: '2011', title: 'Spear phishing breaches a security firm', text: 'One attachment.' },
    { id: 'bec', date: '2016', title: 'Business email compromise passes ransomware in losses', text: 'Fake invoices.' },
    { id: 'kits', date: '2019', title: 'Phishing kits sold as a service' }
  ]
});
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length;

test('milestones: the measure decides when events alternate', () => {
  assert.equal(linesIn('First IT charter', 200), 1);
  assert.ok(linesIn('Fake PayPal pages copy the real site pixel for pixel', 100) > 3);
  assert.equal(linesIn('Überprüfungsverantwortlichkeit', 100), Infinity);
  assert.equal(alternates(milestonesOf(short())), false);
  assert.equal(alternates(milestonesOf(long())), true);
  // Two events never alternate: each has half the line.
  assert.equal(alternates(milestonesOf({ items: long().items.slice(0, 2) })), false);
});

test('milestones: markup hooks, one line, a dot per event, words in their column', () => {
  const { html, data } = renderChart('milestones', short(), context);
  assert.equal(data, undefined);
  assert.match(html, /data-t-chart="milestones"/);
  assert.match(html, /<div class="t-ms" style="--n:3;--columns:3"><i class="t-ms-line"><\/i>/);
  assert.equal(count(html, /class="t-ms-dot/g), 3);
  // The date is the item's first element and says the event; dot and label belong to it.
  assert.match(html, /<p class="t-ms-date" data-t-item="charter" data-t-say="2017: First IT charter. Signed on arrival." style="--c:1;--span:1">2017<\/p>/);
  assert.match(html, /data-t-say="2019: A password manager for all"/);
  assert.equal(count(html, /data-t-item="mfa"/g), 3);
  assert.match(html, /<i class="t-ms-dot" data-t-item="vault" style="--c:2;--span:1"><\/i>/);
  // Room for the texts: they are written under the titles, no tip.
  assert.match(html, /<p class="t-ms-text">Mail, VPN and HR.<\/p>/);
  assert.doesNotMatch(html, /data-t-tip/);
  assert.doesNotMatch(html, /is-alternate|is-above|is-below/);
});

test('milestones: long titles alternate above and below, two columns each, texts in tips', () => {
  const { html } = renderChart('milestones', long(), context);
  assert.match(html, /<div class="t-ms is-alternate" style="--n:5;--columns:6">/);
  assert.equal(count(html, /class="t-ms-date is-above/g), 3);
  assert.equal(count(html, /class="t-ms-date is-below/g), 2);
  assert.match(html, /class="t-ms-label is-below" data-t-item="paypal" style="--c:2;--span:2"/);
  // The tip: over the title above the line, over the dot below it; only for events with a text.
  assert.match(html, /data-t-item="aol" data-t-say="1995: AOL accounts stolen by fake staff messages. The word appears." data-t-tip="The word appears."/);
  assert.match(html, /<p class="t-ms-title"><span data-t-tip-at>AOL accounts/);
  assert.match(html, /<i class="t-ms-dot" data-t-item="aol" style/);
  assert.match(html, /<i class="t-ms-dot" data-t-item="bec" data-t-tip-at style/);
  assert.equal(count(html, /data-t-tip=/g), 3);
  assert.equal(count(html, /data-t-tip-at/g), 3);
  assert.doesNotMatch(html, /data-t-item="paypal"[^>]*data-t-tip=/);
});

test('milestones: the highlight marks its event, and the figure is pulled at rest', () => {
  const { html } = renderChart('milestones', short({ highlight: 'vault' }), context);
  assert.match(html, /class="t-chart t-chart--milestones is-pulled"/);
  assert.match(html, /class="t-ms-date is-hl" data-t-item="vault"/);
  assert.match(html, /class="t-ms-dot is-hl" data-t-item="vault"/);
  assert.match(html, /class="t-ms-label is-hl" data-t-item="vault"/);
  assert.equal(count(html, /is-hl/g), 3);
  assert.doesNotMatch(renderChart('milestones', short(), context).html, /is-pulled/);
});

test('milestones: items with their moments, the table and the Markdown fallback', () => {
  assert.deepEqual(chartItems('milestones', short()).map((item) => [item.id, item.path, !!item.at]), [['charter', '/items/0/at', false], ['vault', '/items/1/at', false], ['mfa', '/items/2/at', true]]);
  assert.deepEqual(chartTable('milestones', short(), context).rows, [['2017', 'First IT charter', 'Signed on arrival.'], ['2019', 'A password manager for all', ''], ['2021', 'Two-step login everywhere', 'Mail, VPN and HR.']]);
  assert.deepEqual(chartTable('milestones', { items: [{ id: 'a', date: '1 May', title: 'Rules apply' }] }, context).rows, [['1 May', 'Rules apply']]);
  assert.match(chartMarkdown('milestones', short(), context), /\| 2019 \| A password manager for all \|  \|/);
});

test('milestones: one event, escaped words, bad items, determinism', () => {
  const one = renderChart('milestones', { takeaway: 'One date', items: [{ id: 'a', date: '2026', title: '<i>Now</i>' }] }, context).html;
  assert.equal(count(one, /class="t-ms-dot/g), 1);
  assert.match(one, /&lt;i&gt;Now&lt;\/i&gt;/);
  const bad = renderChart('milestones', { takeaway: 'Bad', items: [null, { id: 'a', date: '2026', title: 'Ok' }, 3] }, context).html;
  assert.match(bad, /--n:1/);
  assert.equal(renderChart('milestones', long(), context).html, renderChart('milestones', long(), context).html);
});
