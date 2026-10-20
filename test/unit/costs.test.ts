import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { costAverages, expectedShare, ledgerProblems } from '@elabora/core/ai/costs';
import type { CostBook, CostLedger, Measurement, OwnCharge, PricePeriod } from '@elabora/core/ai/costs';
import { COST_BOOK } from '@elabora/core/ai/cost-ledger.generated';
import { aiCostsModule, OUTPUT, readLedger, readMeasurements } from '../../scripts/gen-ai-costs.ts';
import { recordElevenLabs } from '../../scripts/costs-record.ts';

// The ledger of what paid AI services charge (docs/decisions.md D36, ai-costs/README.md).

test('costs: the averages shipped are generated from the ledger as it is, and every measurement has its one period', () => {
  const ledger = readLedger();
  const measurements = readMeasurements();
  assert.deepEqual(ledgerProblems(ledger, measurements), []);
  assert.equal(fs.readFileSync(OUTPUT, 'utf8'), aiCostsModule(ledger, measurements), 'cost-ledger.generated.ts is stale: npm run gen');
  // What the estimates start from: a Starter plan is charged 0.4 of the list price, the launch discount's 0.11 left in its period.
  const share = (model: string) => expectedShare(COST_BOOK, { provider: 'elevenlabs', model, plan: 'starter', now: Date.parse('2026-10-14T00:00:00Z') });
  assert.deepEqual({ ...share('eleven_v4'), share: undefined }, { share: undefined, from: 'ledger', period: 'elevenlabs/eleven_v4/starter/2026-10-13' });
  assert.ok(share('eleven_v4').share >= 0.4 && share('eleven_v4').share < 0.41, `${share('eleven_v4').share}`);
  assert.equal(share('eleven_v4_turbo').from, 'ledger');
  assert.equal(share('eleven_v3').from, 'ledger');
  assert.deepEqual(share('eleven_multilingual_v2'), { share: 1, from: 'list', period: 'elevenlabs/eleven_multilingual_v2/starter/2026-10-13' }, 'one measurement is too few');
  assert.equal(expectedShare(COST_BOOK, { provider: 'elevenlabs', model: 'eleven_v4', plan: 'creator' }).share, 1, 'a plan not measured');
});

// A made-up service whose prices move: a list price, a discount that starts and ends, a new model.
const iso = (day: number) => new Date(Date.UTC(2027, 0, day)).toISOString().replace(/\.\d+Z$/, 'Z');
const at = (day: number) => Date.UTC(2027, 0, day, 12);
const period = (id: string, model: string, start: number | null, end: number | null, rate = 1, discount: number | null | undefined = undefined): PricePeriod => ({
  id, provider: 'voices', model, plan: 'basic', start: start === null ? null : iso(start), end: end === null ? null : iso(end),
  list: [{ rates: { characters: rate } }], discount: discount === undefined ? null : { rate: discount, announcedEnd: null, source: 'test' }, source: 'test'
});
const measured = (model: string, day: number, characters: number, credits: number, periodId: string, extra: Partial<Measurement> = {}): Measurement => ({
  provider: 'voices', model, kind: 'speech', plan: 'basic', date: new Date(at(day)).toISOString(), settings: {}, sent: { characters }, billed: { credits }, period: periodId, source: { kind: 'test', id: `${model}-${day}-${characters}` }, ...extra
});
const bookOf = (ledger: CostLedger, measurements: Measurement[]): CostBook => {
  assert.deepEqual(ledgerProblems(ledger, measurements), []);
  return { ...ledger, averages: costAverages(ledger, measurements) };
};
const providers = { voices: { billed: 'credits', listMultipliers: ['voice_rate'] } };

test('costs: a discount that starts and ends: its figures are taken off while it runs, never used after, and one without a rate or an end is not counted on', () => {
  const ledger: CostLedger = {
    providers,
    periods: [
      period('v/m1/basic/1', 'm1', 1, 10),
      period('v/m1/basic/10', 'm1', 10, 20, 1, 0.5),
      period('v/m1/basic/20', 'm1', 20, 30),
      period('v/m1/basic/30', 'm1', 30, null, 1, null)
    ]
  };
  const measurements = [
    measured('m1', 2, 100, 40, 'v/m1/basic/1'), measured('m1', 3, 200, 80, 'v/m1/basic/1'), measured('m1', 4, 100, 40, 'v/m1/basic/1'),
    measured('m1', 11, 100, 20, 'v/m1/basic/10'), measured('m1', 12, 100, 20, 'v/m1/basic/10'), measured('m1', 13, 100, 20, 'v/m1/basic/10'),
    measured('m1', 31, 100, 10, 'v/m1/basic/30'), measured('m1', 32, 100, 10, 'v/m1/basic/30'), measured('m1', 33, 100, 10, 'v/m1/basic/30')
  ];
  const book = bookOf(ledger, measurements);
  const ask = (day: number, own?: OwnCharge[]) => expectedShare(book, { provider: 'voices', model: 'm1', plan: 'basic', now: at(day), ...(own ? { own } : {}) });
  assert.deepEqual(ask(5), { share: 0.4, from: 'ledger', period: 'v/m1/basic/1' });
  assert.deepEqual(book.averages.find((a) => a.period === 'v/m1/basic/10')?.share, 0.2, 'billed at half the price while the discount ran');
  assert.deepEqual(ask(15), { share: 0.4, from: 'ledger', period: 'v/m1/basic/10' }, 'the discount is taken off: 0.2 / (1 − 0.5)');
  // The discount ended: a new period with no measurement yet is told the list price, never the older periods' figures.
  assert.deepEqual(ask(25), { share: 1, from: 'list', period: 'v/m1/basic/20' });
  // A discount whose rate is not known, with no end: never counted on, its measurements not used.
  assert.deepEqual(ask(35), { share: 1, from: 'list', period: 'v/m1/basic/30' });
  const own = [31, 32, 33].map((day): OwnCharge => ({ provider: 'voices', model: 'm1', plan: 'basic', date: new Date(at(day)).toISOString(), list: 100, billed: 10 }));
  assert.equal(ask(35, own).share, 1, 'the author\'s own requests in it neither');
});

test('costs: a new model, or a model whose list price changed, starts from the list price; an empty period too', () => {
  const ledger: CostLedger = { providers, periods: [period('v/m1/basic/1', 'm1', 1, null), period('v/m2/basic/1', 'm2', 1, null, 0.5), period('v/m3/basic/1', 'm3', 1, null)] };
  const book = bookOf(ledger, [
    measured('m1', 2, 100, 40, 'v/m1/basic/1'), measured('m1', 3, 100, 40, 'v/m1/basic/1'), measured('m1', 4, 100, 40, 'v/m1/basic/1'),
    measured('m3', 2, 100, 40, 'v/m3/basic/1'), measured('m3', 3, 100, 40, 'v/m3/basic/1')
  ]);
  const ask = (model: string, rates?: Record<string, number>) => expectedShare(book, { provider: 'voices', model, plan: 'basic', now: at(5), ...(rates ? { rates } : {}) });
  assert.equal(ask('m1').share, 0.4);
  assert.equal(ask('m1', { characters: 1 }).share, 0.4, 'the service says the period\'s list price: the period holds');
  assert.deepEqual(ask('m1', { characters: 2 }), { share: 1, from: 'list', period: null }, 'another list price: the period is over, whatever was measured in it');
  assert.deepEqual(ask('m1-2027'), { share: 1, from: 'list', period: null }, 'a new model id knows nothing of the old one');
  assert.deepEqual(ask('m2'), { share: 1, from: 'list', period: 'v/m2/basic/1' }, 'a period with no measurement');
  assert.deepEqual(ask('m3'), { share: 1, from: 'list', period: 'v/m3/basic/1' }, 'two measurements are too few');
});

test('costs: the author\'s own requests take over where the ledger has none, follow a rise at once, and stay in their period and list price', () => {
  const ledger: CostLedger = { providers, periods: [period('v/m1/basic/1', 'm1', 1, 10), period('v/m1/basic/10', 'm1', 10, null)] };
  const book = bookOf(ledger, [measured('m1', 11, 100, 40, 'v/m1/basic/10'), measured('m1', 12, 100, 40, 'v/m1/basic/10'), measured('m1', 13, 100, 40, 'v/m1/basic/10')]);
  const charge = (day: number, billed: number, extra: Partial<OwnCharge> = {}): OwnCharge => ({ provider: 'voices', model: 'm1', plan: 'basic', date: new Date(at(day)).toISOString(), list: 100, billed, rates: { characters: 1 }, ...extra });
  const ask = (own: OwnCharge[], extra: Record<string, unknown> = {}) => expectedShare(book, { provider: 'voices', model: 'm1', plan: 'basic', now: at(20), rates: { characters: 1 }, own, ...extra });
  // Lower than the ledger: an unannounced discount is not counted on.
  assert.deepEqual(ask([charge(14, 10), charge(15, 10), charge(16, 10)]), { share: 0.4, from: 'ledger', period: 'v/m1/basic/10' });
  // Higher: followed at once, never past the list price.
  assert.deepEqual(ask([charge(14, 80), charge(15, 80), charge(16, 80)]), { share: 0.8, from: 'own', period: 'v/m1/basic/10' });
  assert.equal(ask([charge(14, 150), charge(15, 150), charge(16, 150)]).share, 1);
  assert.deepEqual(ask([charge(14, 60)]), { share: 0.6, from: 'own', period: 'v/m1/basic/10' }, 'from the first request');
  // Requests of an earlier period, of a list price no longer said, or too small to say a share do not count.
  assert.equal(ask([charge(2, 80), charge(3, 80), charge(4, 80)]).share, 0.4);
  assert.equal(ask([charge(14, 80, { rates: { characters: 2 } }), charge(15, 80, { rates: { characters: 2 } }), charge(16, 80, { rates: { characters: 2 } })]).share, 0.4);
  assert.equal(ask([charge(14, 30, { list: 30 }), charge(15, 30, { list: 30 }), charge(16, 30, { list: 30 })]).share, 0.4);
  // Where the ledger has nothing (another plan): the list price, then from three requests what they say and a quarter more.
  const other = (own: OwnCharge[]) => expectedShare(book, { provider: 'voices', model: 'm1', plan: 'pro', now: at(20), own });
  assert.deepEqual(other([charge(14, 40, { plan: 'pro' }), charge(15, 40, { plan: 'pro' })]), { share: 1, from: 'list', period: null });
  assert.deepEqual(other([charge(14, 40, { plan: 'pro' }), charge(15, 40, { plan: 'pro' }), charge(16, 40, { plan: 'pro' })]), { share: 0.5, from: 'own', period: null });
  // Without a period of its own, a plan's requests from before the model's last change of price (the end
  // of another plan's discount, here day 10) do not count, nor do a plan not known's (null).
  assert.deepEqual(other([charge(2, 11, { plan: 'pro' }), charge(3, 11, { plan: 'pro' }), charge(4, 11, { plan: 'pro' })]), { share: 1, from: 'list', period: null });
  assert.deepEqual(expectedShare(book, { provider: 'voices', model: 'm1', plan: null, now: at(20), own: [2, 3, 4, 14].map((day) => charge(day, 11, { plan: null })) }), { share: 1, from: 'list', period: null });
});

test('costs: the check names a measurement with no period, in two, or under another period than its date\'s', () => {
  const ledger: CostLedger = { providers, periods: [period('v/m1/basic/1', 'm1', 1, 10), period('v/m1/basic/8', 'm1', 8, null)] };
  const problems = ledgerProblems(ledger, [
    measured('m1', 9, 100, 40, 'v/m1/basic/1'),
    measured('m1', 5, 100, 40, 'v/m1/basic/8'),
    measured('m9', 5, 100, 40, 'v/m9/basic/1'),
    measured('m1', 5, 100, 40, 'v/m1/basic/1', { sent: { seconds: 3 } }),
    measured('m1', 5, 100, 40, 'v/m1/basic/1'),
    measured('m1', 6, 100, 40, 'v/m1/basic/1', { date: '2027-01-06T12:00:00' })
  ]);
  assert.equal(problems.length, 8, problems.join('\n'));
  assert.match(problems.join('\n'), /measurement 6 .*: its date is not a UTC date/);
  assert.match(problems.join('\n'), /periods v\/m1\/basic\/1 and v\/m1\/basic\/8 overlap/);
  assert.match(problems.join('\n'), /measurement 1 .*: in 2 periods/);
  assert.match(problems.join('\n'), /measurement 2 .*: its period is v\/m1\/basic\/1, not v\/m1\/basic\/8/);
  assert.match(problems.join('\n'), /measurement 3 .*: no price period of voices m9 for the basic plan holds its date/);
  assert.match(problems.join('\n'), /measurement 4 .*: period v\/m1\/basic\/1 has no list price for what it sent \(seconds\)/);
  assert.match(problems.join('\n'), /measurement 5 .*: recorded twice/);
  assert.throws(() => aiCostsModule(ledger, [measured('m9', 5, 100, 40, 'v/m9/basic/1')]), /no price period/);
});

test('costs: the same ledger holds a language model\'s tokens, priced per million and by settings (batch), billed in dollars', () => {
  const ledger: CostLedger = {
    providers: { llm: { billed: 'usd', priceSettings: ['batch'] } },
    periods: [{
      id: 'llm/model-a/standard/1', provider: 'llm', model: 'model-a', plan: 'standard', start: iso(1), end: null, discount: null, source: 'test',
      list: [{ rates: { input_tokens: 3, output_tokens: 15, cache_read_tokens: 0.3 }, per: 1_000_000 }, { when: { batch: true }, rates: { input_tokens: 1.5, output_tokens: 7.5, cache_read_tokens: 0.15 }, per: 1_000_000 }]
    }]
  };
  const call = (day: number, batch: boolean, usd: number): Measurement => ({
    provider: 'llm', model: 'model-a', kind: 'chat', plan: 'standard', date: new Date(at(day)).toISOString(), settings: { batch, max_tokens: 1000 },
    sent: { input_tokens: 100_000, output_tokens: 10_000 }, billed: { usd }, period: 'llm/model-a/standard/1', source: { kind: 'test', id: `${day}-${batch}` }
  });
  const book = bookOf(ledger, [call(2, false, 0.45), call(3, false, 0.45), call(4, false, 0.45), call(2, true, 0.225), call(3, true, 0.225), call(4, true, 0.225)]);
  assert.deepEqual(book.averages.map((a) => [a.key, a.list, a.share]), [['llm/model-a/standard/1 {"batch":false}', 1.35, 1], ['llm/model-a/standard/1 {"batch":true}', 0.675, 1]]);
  assert.equal(expectedShare(book, { provider: 'llm', model: 'model-a', plan: 'standard', settings: { batch: true }, now: at(5) }).from, 'ledger');
});

test('costs: npm run costs:record appends the history\'s new requests once, with what GET /v1/models says, and says a discount the period lacks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-costs-'));
  fs.writeFileSync(path.join(dir, 'key'), 'sk_test_ledger_key\n');
  const ledger: CostLedger = {
    providers: { elevenlabs: { billed: 'credits', priceSettings: [], listMultipliers: ['voice_rate'] } },
    periods: [{ id: 'elevenlabs/eleven_v4/starter/x', provider: 'elevenlabs', model: 'eleven_v4', plan: 'starter', start: null, end: null, list: [{ rates: { characters: 1 } }], discount: null, source: 'test' }]
  };
  fs.writeFileSync(path.join(dir, 'periods.json'), JSON.stringify(ledger));
  const known = { provider: 'elevenlabs', model: 'eleven_v4', kind: 'speech', plan: 'starter', date: '2026-10-13T09:00:00Z', settings: {}, sent: { characters: 100 }, billed: { credits: 40 }, period: 'elevenlabs/eleven_v4/starter/x', source: { kind: 'GET /v1/history', id: 'old1' } };
  fs.writeFileSync(path.join(dir, 'measurements.jsonl'), `${JSON.stringify(known)}\n`);
  const item = (id: string, minute: number, extra: object) => ({ history_item_id: id, model_id: 'eleven_v4', voice_id: null, text: null, date_unix: Date.UTC(2026, 9, 13, 10, minute) / 1000, character_count_change_from: 0, character_count_change_to: 0, source: 'TTS', settings: { stability: 0.5 }, output_format: 'pcm_24000', dialogue: null, ...extra });
  const pages: Record<string, unknown> = {
    '': { history: [item('new2', 2, { dialogue: [{ text: 'Bonjour.', voice_id: 'lib' }, { text: 'Salut !', voice_id: 'premade' }], character_count_change_to: 9 }), item('new1', 1, { text: 'Une ligne de trente caractères', voice_id: 'premade', character_count_change_to: 12 })], has_more: true, last_history_item_id: 'new1' },
    new1: { history: [item('old1', 0, { text: 'x', voice_id: 'premade' }), item('sts', 0, { source: 'STS', text: 'x' })], has_more: false, last_history_item_id: 'sts' }
  };
  const seen: string[] = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '', 'http://x');
    seen.push(`${url.pathname} ${request.headers['xi-api-key'] === 'sk_test_ledger_key'}`);
    const json = (body: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (url.pathname === '/v1/user') return json({ subscription: { tier: 'starter' } });
    if (url.pathname === '/v1/models') return json([{ model_id: 'eleven_v4', model_rates: { character_cost_multiplier: 1, cost_discount_multiplier: 0.5 } }]);
    if (url.pathname === '/v1/history') return json(pages[url.searchParams.get('start_after_history_item_id') ?? '']);
    if (url.pathname === '/v1/voices/lib') return json({ sharing: { rate: 2 } });
    if (url.pathname === '/v1/voices/premade') return json({ sharing: null });
    response.writeHead(404); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const options = { ledgerDir: dir, keyFile: path.join(dir, 'key'), baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, now: new Date('2026-10-13T11:00:00Z') };
  try {
    const first = await recordElevenLabs(options);
    assert.deepEqual(first.added.map((m) => [m.source.id, m.kind, m.sent.characters, m.billed.credits, m.settings.voice_rate, m.period]), [
      ['new1', 'speech', 30, 12, undefined, 'elevenlabs/eleven_v4/starter/x'],
      ['new2', 'dialogue', 15, 9, 1.533, 'elevenlabs/eleven_v4/starter/x']
    ]);
    assert.deepEqual(first.added[0].observed, { at: '2026-10-13T11:00:00Z', character_cost_multiplier: 1, cost_discount_multiplier: 0.5 });
    assert.deepEqual(first.skipped, ['sts: STS, not text to speech']);
    assert.match(first.warnings.join('\n'), /eleven_v4: GET \/v1\/models says cost_discount_multiplier 0\.5: a discount the current period does not have/);
    assert.deepEqual(first.problems, []);
    assert.equal(readMeasurements(path.join(dir, 'measurements.jsonl')).length, 3);
    const again = await recordElevenLabs(options);
    assert.deepEqual([again.added.length, readMeasurements(path.join(dir, 'measurements.jsonl')).length], [0, 3], 'nothing recorded twice');
    assert.ok(seen.every((line) => line.endsWith('true')), 'the key from its file');
    assert.ok(!JSON.stringify(first).includes('sk_test_ledger_key'), 'the key is never in what it says');
  } finally {
    server.close();
  }
});
