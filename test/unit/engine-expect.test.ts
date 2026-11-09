import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openProject } from '@elabora/engine';
import type { OpenOptions, Session } from '@elabora/engine';
import { copyExample } from '../helpers.ts';

// A change written for the values its author read (unmetExpectation, Session.run's expect): checked in
// the write queue, under the lock, just before the command. An AI's alt text for an image the author
// replaced, or written over the alt the author typed meanwhile, is refused and nothing is written
// (elabora-notes/reports/unenforced-invariants, I02 and I03).

const temporary: string[] = [];
const sessions: Session[] = [];
after(async () => {
  for (const session of sessions) await session.close().catch(() => {});
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});
const QUIET: OpenOptions = { backups: { onOpen: false, prune: false }, media: { enabled: false }, rescanIntervalMs: 0 };
async function open(): Promise<Session> {
  const dir = copyExample();
  temporary.push(dir);
  const session = await openProject(dir, { ...QUIET, watch: false });
  sessions.push(session);
  return session;
}
const props = (session: Session, block: string) => session.project.screens.get('chemin')!.data.blocks!.find((each) => each.id === block)!.props as Record<string, unknown>;
const refusal = async (work: Promise<unknown>) => { try { await work; return null; } catch (error) { return error as { kind?: string; code?: string; message: string }; } };

test('as expected: the change is written', async () => {
  const session = await open();
  await session.run('add_block', { screen: 'chemin', block: { id: 'chemin-photo', type: 'image', props: { asset: 'images/a.svg' } } });
  await session.run('update_block', { block: 'chemin-photo', props: { alt: 'Un plan' } }, undefined, [{ block: 'chemin-photo', props: { asset: 'images/a.svg', alt: null } }]);
  assert.equal(props(session, 'chemin-photo').alt, 'Un plan');
});

test('the author typed in the field meanwhile: refused, their words kept', async () => {
  const session = await open();
  await session.run('add_block', { screen: 'chemin', block: { id: 'chemin-photo', type: 'image', props: { asset: 'images/a.svg' } } });
  await session.run('update_block', { block: 'chemin-photo', props: { alt: 'Le plan de Marc' } });
  const error = await refusal(session.run('update_block', { block: 'chemin-photo', props: { alt: 'Un plan' } }, { kind: 'agent', name: 'opencode' }, [{ block: 'chemin-photo', props: { asset: 'images/a.svg', alt: null } }]));
  assert.equal(error?.kind, 'refused');
  assert.equal(error?.code, 'E_EXPECTED');
  assert.equal(props(session, 'chemin-photo').alt, 'Le plan de Marc');
});

test('the image replaced meanwhile: its old description is refused', async () => {
  const session = await open();
  await session.run('add_block', { screen: 'chemin', block: { id: 'chemin-photo', type: 'image', props: { asset: 'images/a.svg' } } });
  await session.run('update_block', { block: 'chemin-photo', props: { asset: 'images/b.svg' } });
  const error = await refusal(session.run('update_block', { block: 'chemin-photo', props: { alt: 'Un plan' } }, undefined, [{ block: 'chemin-photo', props: { asset: 'images/a.svg', alt: null } }]));
  assert.equal(error?.code, 'E_EXPECTED');
  assert.equal(props(session, 'chemin-photo').alt, undefined);
});

test('a translation for a source that changed, or over a target written meanwhile: refused', async () => {
  const session = await open();
  const first = session.translationTable('en').rows[0];
  assert.ok(first, 'a unit to translate');
  // Its target written by the author meanwhile.
  await session.run('translate_text', { language: 'en', unit: first.id, target: 'The author’s words' });
  const row = session.translationTable('en').rows.find((candidate) => candidate.id === first.id)!;
  const over = await refusal(session.run('translate_text', { language: 'en', unit: row.id, target: 'AI words' }, undefined, [{ translation: 'en', unit: row.id, source: row.source, target: null }]));
  assert.equal(over?.code, 'E_EXPECTED');
  // The source it was asked about is not the source now.
  const stale = await refusal(session.run('translate_text', { language: 'en', unit: row.id, target: 'AI words' }, undefined, [{ translation: 'en', unit: row.id, source: `${row.source} (old)` }]));
  assert.equal(stale?.code, 'E_EXPECTED');
  assert.equal(session.translationTable('en').rows.find((candidate) => candidate.id === row.id)?.target, row.target);
  // As expected: written.
  await session.run('translate_text', { language: 'en', unit: row.id, target: 'New words' }, undefined, [{ translation: 'en', unit: row.id, source: row.source, target: row.target }]);
  assert.equal(session.translationTable('en').rows.find((candidate) => candidate.id === row.id)?.target, 'New words');
});

test('the protocol carries expect', async () => {
  const session = await open();
  await session.run('add_block', { screen: 'chemin', block: { id: 'chemin-photo', type: 'image', props: { asset: 'images/a.svg', alt: 'Déjà' } } });
  const answer = await session.handle({ kind: 'request', id: 'r1', type: 'run', params: { command: 'update_block', args: { block: 'chemin-photo', props: { alt: 'Un plan' } }, expect: [{ block: 'chemin-photo', props: { alt: null } }] } });
  assert.equal(answer.ok, false);
  assert.equal(!answer.ok && answer.error.code, 'E_EXPECTED');
  assert.equal(props(session, 'chemin-photo').alt, 'Déjà');
});

// Settings changed one by one (I04): the window sends only the field it changed; the engine applies it to
// course.json and to the layer as they are when it writes, so two edits close together both stay.
test('delivery changed field by field: both settings stay, null removes one', async () => {
  const session = await open();
  // The window read delivery once, then changes the quality, then the LMS, before it hears of the first.
  await session.run('update_course', { deliveryPatch: { mediaQuality: 'low' } });
  await session.run('update_course', { deliveryPatch: { lms: ['moodle'] } });
  const both = session.project.course!.delivery as Record<string, unknown>;
  assert.equal(both.mediaQuality, 'low');
  assert.deepEqual(both.lms, ['moodle']);
  await session.run('update_course', { deliveryPatch: { lms: null } });
  const delivery = session.project.course!.delivery as Record<string, unknown>;
  assert.equal(delivery.mediaQuality, 'low');
  assert.equal('lms' in delivery, false);
});

test('a layer retitled: its blocks edited meanwhile stay', async () => {
  const session = await open();
  const { result } = await session.run('upsert_layer', { screen: 'chemin', layer: { title: 'Détails', blocks: [{ type: 'text', props: { markdown: 'Premier texte' } }] } }) as unknown as { result: { layer: string } };
  const layer = result.layer;
  const block = session.project.screens.get('chemin')!.data.layers!.find((each) => each.id === layer)!.blocks[0]!.id;
  // An agent edits the layer's text, then the author's new title arrives.
  await session.run('update_block', { block, props: { markdown: 'Texte de l’agent' } }, { kind: 'agent', name: 'claude' });
  await session.run('upsert_layer', { screen: 'chemin', layer: { id: layer, title: 'En savoir plus', presentation: 'panel' } });
  let found = session.project.screens.get('chemin')!.data.layers!.find((each) => each.id === layer)!;
  assert.equal(found.title, 'En savoir plus');
  assert.equal(found.presentation, 'panel');
  assert.equal((found.blocks[0]!.props as { markdown: string }).markdown, 'Texte de l’agent');
  await session.run('upsert_layer', { screen: 'chemin', layer: { id: layer, presentation: null } });
  found = session.project.screens.get('chemin')!.data.layers!.find((each) => each.id === layer)!;
  assert.equal('presentation' in found, false);
});
