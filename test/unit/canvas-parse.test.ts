import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askResultOf, parseCanvasMessage } from '@elabora/player/canvas-parse';
import { PLAYER_PREVIEW_PROTOCOL } from '@elabora/player/canvas-protocol';
import type { LayoutMessage } from '@elabora/player/canvas-protocol';

const rect = (x = 0) => ({ x, y: 0, width: 10, height: 5 });
const layout = (): LayoutMessage => ({
  type: 'elabora/layout', id: 7, screen: 'accueil', step: 1, steps: [1, 2], layer: null, state: 'initial', applyMs: 2.5,
  viewport: { width: 1600, height: 900, scrollX: 0, scrollY: 10 }, screenRect: rect(), blocks: [{ id: 'b1', rect: rect(4), slot: null, layer: null, parent: null, hidden: false, fields: [{ path: 'title', rect: rect(1) }], covers: ['b2'] }],
  texts: [{ kind: 'title', path: null, text: 'Titre', rect: rect(), layer: null, read: true, before: 'b1' }], terms: [{ term: 'ip', block: 'b1', words: 'IP', rects: [rect()] }],
  placing: { frame: rect(), flows: [{ slot: null, rect: rect(), places: [{ after: null, y: 3 }], default: true }], columns: { half: 1, full: 2, wide: 3, bleed: 4 } }, glide: { ms: 300, elapsed: 5, easing: 'ease', from: { b1: rect() } }
});

test('canvas messages are read as data: a real layout, the player\'s other messages, and nothing that is not one', () => {
  // A layout is read whole, and what it says comes out unchanged.
  const sent = layout();
  assert.deepEqual(parseCanvasMessage(JSON.parse(JSON.stringify(sent))), sent);
  assert.deepEqual(parseCanvasMessage({ type: 'elabora/ready', chrome: 'live', protocol: PLAYER_PREVIEW_PROTOCOL, extra: 1 }), { type: 'elabora/ready', chrome: 'live', protocol: PLAYER_PREVIEW_PROTOCOL });
  assert.deepEqual(parseCanvasMessage({ type: 'elabora/navigate', screen: 's', by: 'next' }), { type: 'elabora/navigate', screen: 's', by: 'next' });
  assert.deepEqual(parseCanvasMessage({ type: 'elabora/error', id: null, message: 'x' }), { type: 'elabora/error', id: null, message: 'x' });
  assert.deepEqual(parseCanvasMessage({ type: 'elabora/language', protocol: PLAYER_PREVIEW_PROTOCOL, language: 'fr' }), { type: 'elabora/language', protocol: PLAYER_PREVIEW_PROTOCOL, language: 'fr' });
  assert.deepEqual(parseCanvasMessage({ type: 'elabora/answer', request: 3, result: true }), { type: 'elabora/answer', request: 3, result: true });
  assert.deepEqual(parseCanvasMessage({ type: 'elabora/answer', request: 3, error: 'x'.repeat(900) }), { type: 'elabora/answer', request: 3, error: 'x'.repeat(500) });
  for (const bad of [null, 'elabora/layout', [], {}, { type: 'elabora/render' }, { type: 'elabora/ready', chrome: 'other' }, { type: 'elabora/navigate', screen: 5 }, { type: 'elabora/navigate', screen: 's', by: 'sideways' },
    { type: 'elabora/error', id: {}, message: 'x' }, { type: 'elabora/item', protocol: 'other', id: 'a', bar: 'top' }, { type: 'elabora/language', protocol: PLAYER_PREVIEW_PROTOCOL, language: 'x'.repeat(60) },
    { type: 'elabora/answer', request: -1, result: 1 }, { type: 'elabora/answer', request: 1.5, result: 1 }, { type: 'elabora/answer', request: 1 }]) {
    assert.equal(parseCanvasMessage(bad), null, JSON.stringify(bad));
  }
});

test('a layout that is malformed is nothing, one that carries too much is nothing, and an optional part that is wrong is left out', () => {
  const broken = (edit: (message: Record<string, unknown>) => void) => { const message = JSON.parse(JSON.stringify(layout())) as Record<string, unknown>; edit(message); return parseCanvasMessage(message); };
  assert.equal(broken((m) => { m.step = 'one'; }), null);
  assert.equal(broken((m) => { m.state = 'finished'; }), null);
  assert.equal(broken((m) => { m.viewport = { width: 1 }; }), null);
  assert.equal(broken((m) => { m.blocks = 'none'; }), null);
  assert.equal(broken((m) => { (m.blocks as Array<Record<string, unknown>>)[0]!.rect = { x: 0, y: 0, width: Infinity, height: 1 }; }), null);
  assert.equal(broken((m) => { (m.blocks as Array<Record<string, unknown>>)[0]!.id = 'x'.repeat(300); }), null);
  assert.equal(broken((m) => { m.blocks = Array.from({ length: 5001 }, (_, i) => ({ id: `b${i}`, rect: rect(), slot: null, layer: null, parent: null, hidden: false })); }), null);
  const lenient = broken((m) => { m.texts = [{ kind: 'nothing' }]; m.placing = { frame: 1 }; m.glide = 'now'; m.terms = 3; }) as LayoutMessage;
  assert.equal(lenient.type, 'elabora/layout');
  assert.deepEqual([lenient.texts, lenient.placing, lenient.glide, lenient.terms], [undefined, undefined, undefined, undefined]);
  assert.equal(lenient.blocks.length, 1);
  // What a page adds to a block is not kept.
  const extra = broken((m) => { (m.blocks as Array<Record<string, unknown>>)[0]!.evil = '<script>'; }) as LayoutMessage;
  assert.equal('evil' in extra.blocks[0]!, false);
});

test('the result of a question is read as the question says it is made', () => {
  assert.deepEqual(askResultOf('shown', true), { ok: true, result: true });
  assert.equal(askResultOf('shown', 'yes').ok, false);
  assert.deepEqual(askResultOf('mark', true), { ok: true, result: true });
  assert.equal(askResultOf('mark', false).ok, false);
  assert.deepEqual(askResultOf('measure', null), { ok: true, result: null });
  assert.deepEqual(askResultOf('measure', { overflow: 12, fields: [{ block: 'b', path: 'p', width: 1, height: 2, extra: 3 }] }), { ok: true, result: { overflow: 12, fields: [{ block: 'b', path: 'p', width: 1, height: 2 }] } });
  assert.equal(askResultOf('measure', { overflow: 'a', fields: [] }).ok, false);
  assert.equal(askResultOf('measure', { overflow: 1, fields: [{ block: 'b' }] }).ok, false);
  assert.deepEqual(askResultOf('block-preview', { overflow: false, block: null }), { ok: true, result: { overflow: false, block: null } });
  assert.deepEqual(askResultOf('block-preview', { overflow: true, block: rect() }), { ok: true, result: { overflow: true, block: rect() } });
  assert.equal(askResultOf('block-preview', { overflow: true, block: { x: 1 } }).ok, false);
  assert.equal(askResultOf('block-preview-clear', 1).ok, false);
});
