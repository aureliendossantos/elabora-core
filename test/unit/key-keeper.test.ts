import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyKeeper } from '@elabora/engine/browser/keys/keeper';
import type { KeyStore } from '@elabora/engine/browser/keys/keeper';

// The page of a browser's ElevenLabs key (keys.elabora.studio): the key checked, held and kept as the
// author says; the operations of the list sent with it, nothing else; no answer carrying it.

const KEY = 'sk_' + 'a1b2c3d4'.repeat(5);
const asked: { url: string; key?: string; body?: string; redirect?: string }[] = [];
// ElevenLabs' imitation: this key alone is accepted; an error quotes the key it was given.
const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: string }) => {
  asked.push({ url, key: init.headers['xi-api-key'], body: init.body, redirect: init.redirect });
  const given = init.headers['xi-api-key'];
  if (url.startsWith('https://storage.googleapis.com/')) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  if (given !== KEY) return new Response(JSON.stringify({ detail: { status: 'invalid_api_key', message: `Invalid API key: ${given}` } }), { status: 401 });
  // The account as ElevenLabs gives it: its ids and its key's preview beside its plan.
  if (url.endsWith('/v1/user')) return new Response(JSON.stringify({ user_id: 'u_1', xi_api_key_preview: 'sk_a…b2c3', seat_type: 'workspace_admin', subscription: { tier: 'starter', character_count: 10, character_limit: 30000, next_character_count_reset_unix: 1767225600, currency: 'eur', open_invoices: [{ amount: 5 }] } }), { status: 200 });
  if (url.endsWith('/v1/user/subscription')) return new Response(JSON.stringify({ tier: 'starter', character_count: 10, character_limit: 30000, voice_slots_used: 2, next_invoice: { amount_due_cents: 500 } }), { status: 200 });
  if (url.includes('/v1/voices/')) return new Response(JSON.stringify({ detail: { status: 'voice_not_found', message: `No voice for ${given}` } }), { status: 404 });
  return new Response(JSON.stringify({ voices: [] }), { status: 200 });
};

function memory(): KeyStore & { kept: string | null } {
  return { kept: null, async load() { return this.kept; }, async save(key) { this.kept = key; }, async clear() { this.kept = null; } };
}

test('the key\'s page: checked, held, kept as asked, the operations of the list alone, the key never in an answer', async () => {
  const store = memory();
  const keeper = new KeyKeeper({ store, fetch });
  await keeper.open();
  assert.deepEqual(keeper.state(), { present: false, masked: null, kept: false });
  assert.equal((await keeper.ask('voices', { page_size: 1 }) as { code: string }).code, 'E_VOICE_KEY_MISSING', 'nothing asked without a key');
  assert.equal(asked.length, 0);

  assert.equal((await keeper.commit('', false) as { code: string }).code, 'E_VOICE_KEY_MISSING');
  assert.equal((await keeper.commit('not a key', false) as { code: string }).code, 'E_VOICE_KEY_FORMAT');
  const wrong = 'sk_' + 'z9'.repeat(15);
  const refused = await keeper.commit(wrong, true);
  assert.equal((refused as { code: string }).code, 'E_VOICE_KEY_INVALID');
  assert.ok(!JSON.stringify(refused).includes(wrong), 'a refusal does not quote the key');
  assert.equal(store.kept, null);

  const held = await keeper.commit(`  ${KEY} `, false);
  assert.deepEqual((held as { state: unknown }).state, { present: true, masked: 'sk_…c3d4', kept: false });
  assert.equal(store.kept, null, 'held in memory only');
  assert.deepEqual(await keeper.setKeep(true), { present: true, masked: 'sk_…c3d4', kept: true });
  assert.equal(store.kept, KEY, 'kept once ticked');

  const voices = await keeper.ask('voices', { page_size: 1 });
  assert.deepEqual(voices, { ok: true, status: 200, body: { voices: [] }, cost: null });
  assert.deepEqual(asked.at(-1), { url: 'https://api.elevenlabs.io/v2/voices?page_size=1', key: KEY, body: undefined, redirect: 'error' }, 'no redirect followed with the key');
  // Of the account and its subscription, the plan and its count alone.
  assert.deepEqual(await keeper.ask('account', {}), { ok: true, status: 200, body: { subscription: { tier: 'starter', character_count: 10, character_limit: 30000, next_character_count_reset_unix: 1767225600 } }, cost: null });
  assert.deepEqual(await keeper.ask('subscription', {}), { ok: true, status: 200, body: { tier: 'starter', character_count: 10, character_limit: 30000 }, cost: null });
  const unknown = await keeper.ask('voice', { id: 'abc' });
  assert.equal((unknown as { status: number }).status, 404);
  assert.ok(!JSON.stringify(unknown).includes(KEY), 'an error quoting the key is given back without it');
  assert.equal((await keeper.ask('history', {}) as { code: string }).code, 'E_KEY_REQUEST');
  const preview = await keeper.ask('preview', { url: 'https://storage.googleapis.com/eleven-public-prod/a.mp3' });
  assert.equal((preview as { bytes: ArrayBuffer }).bytes.byteLength, 3);
  assert.equal(asked.at(-1)!.key, undefined, 'a sample is fetched without the key');
  assert.ok(asked.every((each) => each.redirect === 'error'), 'no redirect followed, ever');

  // Opened again (the next visit): the kept key is there; forgotten, it is gone everywhere.
  const again = new KeyKeeper({ store, fetch });
  await again.open();
  assert.deepEqual(again.state(), { present: true, masked: 'sk_…c3d4', kept: true });
  assert.deepEqual(await again.forget(), { present: false, masked: null, kept: false });
  assert.equal(store.kept, null);
});
