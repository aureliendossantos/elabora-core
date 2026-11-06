import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createXapiAdapter, stateUrl } from '@elabora/player/xapi';
import type { Fetcher, XapiSession } from '@elabora/player/xapi';
import { connectCmi5, connectXapi } from '@elabora/player/lms-boot';
import { cmi5Manifest, cmi5MoveOn, tincanManifest } from '@elabora/core/compile/manifests-xapi';
import { createFakeLrs } from '@elabora/node/emulator/lrs';
import type { IncomingMessage } from 'node:http';

// The formats that talk to their LMS over HTTP (docs/delivery-cmi5.md, delivery-xapi.md): the
// connection before the player starts, and what the adapters send.

interface Sent { url: string; method: string; headers: Record<string, string>; body: string; keepalive: boolean }

// A fetch that records what it is asked and answers from a table (by method and path).
function fakeFetch(answers: Record<string, { status?: number; body?: unknown }> = {}): Fetcher & { sent: Sent[] } {
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    sent.push({ url, method, headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? ''), keepalive: !!init.keepalive });
    const path = new URL(url).pathname;
    const stateId = new URL(url).searchParams.get('stateId');
    const answer = answers[`${method} ${path}${stateId ? `#${stateId}` : ''}`] ?? answers[`${method} ${path}`] ?? { status: method === 'GET' ? 404 : 200, body: '' };
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? '');
    const status = answer.status ?? 200;
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text };
  }) as Fetcher & { sent: Sent[] };
  fetcher.sent = sent;
  return fetcher;
}

const memory = () => { const items = new Map<string, string>(); return { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value); } }; };
const ACTOR = { objectType: 'Agent' as const, name: 'Alex', account: { homePage: 'https://lms.example', name: 'alex' } };

test('cmi5: the token is fetched once and kept for the tab, then LMS.LaunchData and the progress are read', async () => {
  const search = new URLSearchParams({ endpoint: 'https://lms.example/lrs', fetch: 'https://lms.example/fetch/1', actor: JSON.stringify(ACTOR), registration: 'reg-1', activityId: 'urn:elabora:course:c/au' });
  const fetcher = fakeFetch({
    'POST /fetch/1': { body: { 'auth-token': 'T0K' } },
    'GET /lrs/activities/state#LMS.LaunchData': { body: { contextTemplate: { extensions: { 'https://w3id.org/xapi/cmi5/context/extensions/sessionid': 's-1' } }, launchMode: 'Normal', moveOn: 'Passed', masteryScore: 0.8 } },
    'GET /lrs/activities/state#elabora-progress': { body: { location: 'k2', suspendData: 'v1', status: 'incomplete', exit: 'suspend' } }
  });
  const storage = memory();
  const session = await connectCmi5(search, { fetcher: fetcher as unknown as typeof fetch, storage });
  assert.ok(session);
  assert.deepEqual([session.format, session.endpoint, session.auth, session.cmi5?.sessionId, session.cmi5?.masteryScore, session.progress?.location], ['cmi5', 'https://lms.example/lrs/', 'Basic T0K', 's-1', 0.8, 'k2']);
  assert.equal(fetcher.sent.filter((call) => call.url.endsWith('/fetch/1')).length, 1);
  assert.ok(fetcher.sent.every((call) => call.method === 'POST' || call.headers['X-Experience-API-Version'] === '1.0.3'));
  // A reload in the same tab goes on with the token.
  await connectCmi5(search, { fetcher: fetcher as unknown as typeof fetch, storage });
  assert.equal(fetcher.sent.filter((call) => call.url.endsWith('/fetch/1')).length, 1);
  // Without its parameters, no connection: the player runs alone.
  assert.equal(await connectCmi5(new URLSearchParams(), { fetcher: fetcher as unknown as typeof fetch, storage }), null);
  // A fetch the LMS refuses says why.
  await assert.rejects(connectCmi5(search, { fetcher: fakeFetch({ 'POST /fetch/1': { body: { 'error-code': '1', 'error-text': 'already fetched' } } }) as unknown as typeof fetch, storage: memory() }), /already fetched/);
});

function cmi5Session(overrides: Partial<XapiSession> = {}): XapiSession {
  return {
    format: 'cmi5', endpoint: 'https://lms.example/lrs/', auth: 'Basic T0K', actor: ACTOR, registration: 'reg-1', activityId: 'urn:a/au', progress: null, where: 'cmi5',
    cmi5: { sessionId: 's-1', contextTemplate: { extensions: { 'https://w3id.org/xapi/cmi5/context/extensions/sessionid': 's-1' } }, launchMode: 'Normal', masteryScore: 0.8 },
    ...overrides
  };
}
const verbs = (sent: Sent[]) => sent.filter((call) => call.url.endsWith('/statements')).flatMap((call) => (JSON.parse(call.body) as { verb: { display: { 'en-US': string } } }[]).map((statement) => statement.verb.display['en-US']));
const statementsOf = (sent: Sent[]) => sent.filter((call) => call.url.endsWith('/statements')).flatMap((call) => JSON.parse(call.body) as Record<string, any>[]);

test('cmi5: initialized, the progress document, completed then passed with the moveOn category and the score, answered, terminated', async () => {
  const fetcher = fakeFetch();
  const lms = createXapiAdapter(cmi5Session(), { fetch: fetcher, hidden: () => false, now: () => Date.UTC(2026, 10, 6) }) as ReturnType<typeof createXapiAdapter> & { settled(): Promise<void> };
  assert.equal(lms.kind, 'cmi5');
  assert.ok(lms.initialize());
  assert.equal(lms.get('cmi.core.lesson_status'), 'not attempted');
  assert.equal(lms.get('cmi.core.entry'), 'ab-initio');
  lms.set('cmi.core.lesson_status', 'incomplete');
  lms.set('cmi.core.exit', 'suspend');
  lms.set('cmi.suspend_data', 'v1');
  lms.set('cmi.core.lesson_location', 'k2');
  lms.commit();
  for (const [field, value] of [['id', 'q1'], ['objectives.0.id', 'obj-1'], ['type', 'choice'], ['correct_responses.0.pattern', 'a,c'], ['student_response', 'a,c'], ['result', 'correct']]) lms.setAlways(`cmi.interactions.0.${field}`, value!);
  lms.set('cmi.core.score.min', '0');
  lms.set('cmi.core.score.max', '100');
  lms.set('cmi.core.score.raw', '90');
  lms.set('cmi.core.session_time', '0000:05:00.00');
  lms.set('cmi.core.lesson_status', 'passed');
  lms.commit();
  lms.finish();
  await lms.settled();
  assert.deepEqual(verbs(fetcher.sent), ['initialized', 'answered', 'completed', 'passed', 'terminated']);
  const [initialized, answered, completed, passed] = statementsOf(fetcher.sent);
  const categories = (statement: Record<string, any>) => (statement.context.contextActivities.category ?? []).map((category: { id: string }) => category.id.replace(/^.*\//, ''));
  assert.deepEqual([categories(initialized!), categories(answered!), categories(completed!), categories(passed!)], [['cmi5'], [], ['cmi5', 'moveon'], ['cmi5', 'moveon']]);
  assert.ok(statementsOf(fetcher.sent).every((statement) => statement.context.registration === 'reg-1' && statement.context.extensions['https://w3id.org/xapi/cmi5/context/extensions/sessionid'] === 's-1' && statement.object.id.startsWith('urn:a/au')));
  assert.deepEqual(passed!.result, { success: true, duration: 'PT0H5M0S', score: { scaled: 0.9, raw: 90, min: 0, max: 100 } });
  assert.deepEqual(completed!.result, { completion: true, duration: 'PT0H5M0S' });
  assert.deepEqual([answered!.object.id, answered!.object.definition.interactionType, answered!.object.definition.correctResponsesPattern, answered!.result], ['urn:a/au/interactions/q1', 'choice', ['a[,]c'], { response: 'a[,]c', success: true }]);
  const states = fetcher.sent.filter((call) => call.method === 'PUT');
  assert.equal(states[0]!.url, stateUrl(cmi5Session(), 'elabora-progress'));
  assert.deepEqual(JSON.parse(states.at(-1)!.body), { location: 'k2', suspendData: 'v1', status: 'passed', exit: 'suspend', score: { raw: 90, min: 0, max: 100 }, sent: { completed: true, passed: true } });
  // After terminated, nothing more.
  assert.equal(lms.set('cmi.suspend_data', 'x'), false);
});

test('cmi5: the LMS\'s mastery score decides; failed never after passed; Browse sends no verdict; a relaunch reads its progress', async () => {
  const fetcher = fakeFetch();
  const lms = createXapiAdapter(cmi5Session(), { fetch: fetcher, hidden: () => true }) as ReturnType<typeof createXapiAdapter> & { settled(): Promise<void> };
  lms.initialize();
  lms.set('cmi.core.score.raw', '70');
  lms.set('cmi.core.lesson_status', 'passed'); // the course's own mastery is lower than the LMS's 0.8
  lms.commit();
  await lms.settled();
  assert.deepEqual(verbs(fetcher.sent), ['initialized', 'completed', 'failed']);
  assert.ok(fetcher.sent.every((call) => call.keepalive), 'a hidden page sends with keepalive');

  const browse = fakeFetch();
  const browsing = createXapiAdapter(cmi5Session({ cmi5: { ...cmi5Session().cmi5!, launchMode: 'Browse' } }), { fetch: browse, hidden: () => false }) as ReturnType<typeof createXapiAdapter> & { settled(): Promise<void> };
  browsing.initialize();
  browsing.set('cmi.core.lesson_status', 'completed');
  browsing.finish();
  await browsing.settled();
  assert.deepEqual(verbs(browse.sent), ['initialized', 'terminated']);

  const again = createXapiAdapter(cmi5Session({ progress: { location: 'k3', suspendData: 'v2', status: 'passed', exit: 'suspend', sent: { completed: true, passed: true } } }), { fetch: fakeFetch(), hidden: () => false });
  again.initialize();
  assert.deepEqual([again.get('cmi.core.lesson_location'), again.get('cmi.suspend_data'), again.get('cmi.core.lesson_status'), again.get('cmi.core.entry')], ['k3', 'v2', 'passed', 'resume']);
});

test('xAPI alone: the Tin Can launch of an LMS, else the LRS set at build time with an anonymous learner', async () => {
  const fetcher = fakeFetch();
  const tincan = await connectXapi(new URLSearchParams({ endpoint: 'https://lms.example/tc', auth: 'Basic QQ==', actor: JSON.stringify({ name: ['Alex'], mbox: ['mailto:alex@example.com'] }), registration: 'r-9', activity_id: 'urn:x' }), 'urn:default', { fetcher: fetcher as unknown as typeof fetch });
  assert.deepEqual([tincan?.where, tincan?.endpoint, tincan?.auth, tincan?.activityId, tincan?.actor], ['tincan', 'https://lms.example/tc/', 'Basic QQ==', 'urn:x', { objectType: 'Agent', name: 'Alex', mbox: 'mailto:alex@example.com' }]);
  const storage = memory();
  const lrs = await connectXapi(new URLSearchParams(), 'urn:default', { fetcher: fetcher as unknown as typeof fetch, lrs: { endpoint: 'https://lrs.example/xapi/', auth: 'Basic S0VZ' }, storage });
  assert.deepEqual([lrs?.where, lrs?.activityId, lrs?.registration, lrs?.actor.account?.homePage], ['lrs', 'urn:default', undefined, 'https://lrs.example/xapi/']);
  const same = await connectXapi(new URLSearchParams(), 'urn:default', { fetcher: fetcher as unknown as typeof fetch, lrs: { endpoint: 'https://lrs.example/xapi/', auth: 'Basic S0VZ' }, storage });
  assert.equal(same?.actor.account?.name, lrs?.actor.account?.name, 'the anonymous learner is kept in the browser');
  assert.equal(await connectXapi(new URLSearchParams(), 'urn:default', { fetcher: fetcher as unknown as typeof fetch, lrs: undefined }), null);
  // Without cmi5, statements carry no cmi5 category.
  const sent = fakeFetch();
  const lms = createXapiAdapter({ ...tincan!, progress: null }, { fetch: sent, hidden: () => false }) as ReturnType<typeof createXapiAdapter> & { settled(): Promise<void> };
  lms.initialize();
  lms.set('cmi.core.lesson_status', 'completed');
  lms.finish();
  await lms.settled();
  assert.deepEqual(verbs(sent.sent), ['initialized', 'completed', 'terminated']);
  assert.ok(statementsOf(sent.sent).every((statement) => !statement.context.contextActivities.category && statement.context.registration === 'r-9'));
});

test('the cmi5 and Tin Can course files', () => {
  const course = { id: 'canal', title: 'Écluses & ponts', description: 'Comment passer une écluse.', language: 'fr', completion: { reportAs: 'passed-failed' as const, masteryScore: 80 } };
  const cmi5 = cmi5Manifest(course);
  assert.match(cmi5, /<course id="urn:elabora:course:canal">/);
  assert.match(cmi5, /<au id="urn:elabora:course:canal\/au" moveOn="Passed" masteryScore="0.8" launchMethod="AnyWindow">/);
  assert.match(cmi5, /<langstring lang="fr">Écluses &amp; ponts<\/langstring>/);
  assert.match(cmi5, /<url>index.html<\/url>/);
  assert.deepEqual(cmi5MoveOn({ completion: { reportAs: 'completed-incomplete' } }), { moveOn: 'Completed' });
  assert.match(cmi5Manifest({ ...course, delivery: { activityId: 'https://client.example/courses/canal' } }), /<course id="https:\/\/client\.example\/courses\/canal">/);
  const tincan = tincanManifest(course);
  assert.match(tincan, /<activity id="urn:elabora:course:canal" type="http:\/\/adlnet\.gov\/expapi\/activities\/course">/);
  assert.match(tincan, /<launch lang="fr">index.html<\/launch>/);
});

test('the emulator\'s LRS refuses what a cmi5 LMS refuses', async () => {
  const lrs = createFakeLrs();
  const { token, sessionId } = lrs.launch('r1', { cmi5: true });
  const call = async (method: string, route: string, body: unknown, auth = `Basic ${token}`) => {
    const request = { method, headers: { authorization: auth, 'x-experience-api-version': '1.0.3' } } as unknown as IncomingMessage;
    const url = new URL(`http://lms.test${route}`);
    return (await lrs.handle(request, url.pathname, url, async () => JSON.stringify(body)))!.status;
  };
  const statement = (verb: string, session = sessionId, cmi5 = true) => ({ actor: ACTOR, verb: { id: `http://adlnet.gov/expapi/verbs/${verb}` }, object: { id: 'urn:a/au' }, context: { registration: 'r1', extensions: { 'https://w3id.org/xapi/cmi5/context/extensions/sessionid': session }, contextActivities: cmi5 ? { category: [{ id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] } : {} } });
  const fetch = async () => (await lrs.handle({ method: 'POST', headers: {} } as unknown as IncomingMessage, '/lms/cmi5/fetch/r1', new URL('http://lms.test/lms/cmi5/fetch/r1'), async () => ''))!.body;
  assert.match(await fetch(), /auth-token/);
  assert.match(await fetch(), /error-code/);
  assert.equal(await call('POST', '/lrs/statements', [statement('completed')]), 400, 'before initialized');
  assert.equal(await call('POST', '/lrs/statements', [statement('initialized')], 'Basic nope'), 401);
  assert.equal(await call('POST', '/lrs/statements', [statement('initialized', 'another')]), 400, 'another session');
  assert.equal(await call('POST', '/lrs/statements', [statement('initialized')]), 200);
  assert.equal(await call('POST', '/lrs/statements', [statement('completed')]), 200);
  assert.equal(await call('POST', '/lrs/statements', [statement('completed')]), 400, 'completed twice');
  assert.equal(await call('POST', '/lrs/statements', [statement('passed')]), 200);
  assert.equal(await call('POST', '/lrs/statements', [statement('failed')]), 400, 'failed after passed');
  assert.equal(await call('PUT', '/lrs/activities/state?activityId=urn:a/au&registration=r1&stateId=elabora-progress', { location: 'k' }, 'Basic nope'), 401);
  assert.equal(await call('PUT', '/lrs/activities/state?activityId=urn:a/au&registration=r1&stateId=elabora-progress', { location: 'k' }), 204);
  assert.equal(await call('POST', '/lrs/statements', [statement('terminated')]), 200);
  assert.equal(await call('POST', '/lrs/statements', [statement('answered', sessionId, false)]), 400, 'after terminated');
  assert.deepEqual(lrs.record('r1'), { location: 'k', suspendData: undefined, exit: undefined, status: 'passed', scoreRaw: undefined });
});
