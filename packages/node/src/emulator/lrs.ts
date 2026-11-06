import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';

// The emulator's learning record store and cmi5 launch (docs/delivery-cmi5.md, delivery-xapi.md):
// what an LMS with an LRS does for a cmi5 or xAPI package, kept in memory per registration.
//   POST /lms/cmi5/fetch/<reg>            the auth token, once per launch (then error-code 1)
//   GET|PUT|POST /lrs/activities/state     the State API (activityId, agent, registration, stateId)
//   POST|PUT /lrs/statements               statements, checked as an LMS would (cmi5's rules)
//   GET /lrs/statements?registration=      what was received
// Every request is checked: the Authorization of the launch, X-Experience-API-Version 1.0.x.

export interface LrsCall {
  t: number;
  method: string; // a statement's verb (initialized, completed…), state, fetch
  args: string[];
  result: 'true' | 'false';
  error: string;
}

interface Registration {
  token: string | null; // the launch's (cmi5 fetch, or the Tin Can auth)
  fetched: boolean;
  statements: Record<string, unknown>[];
  calls: LrsCall[];
  sessionId: string;
  terminated: boolean; // cmi5: the session ended; nothing more is accepted for it
  cmi5: boolean; // a cmi5 launch: its rules are checked
  preferences: boolean; // the AU read the learner's preferences in this launch (cmi5: before initialized)
}

export interface LrsRecord {
  location: unknown;
  suspendData: unknown;
  exit: unknown;
  status: unknown;
  scoreRaw: unknown;
}

const VERB = (statement: Record<string, unknown>) => String((statement.verb as { id?: string } | undefined)?.id ?? '').replace(/^.*\//, '');
const CMI5 = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const SESSION = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';

export interface FakeLrs {
  // A launch of a registration: its token and its cmi5 session (a new one each launch).
  launch(reg: string, options?: { cmi5?: boolean; auth?: string }): { token: string; sessionId: string };
  handle(request: IncomingMessage, pathname: string, url: URL, body: () => Promise<string>): Promise<{ status: number; body: string; type?: string } | null>;
  calls(reg: string): LrsCall[];
  statements(reg: string): Record<string, unknown>[];
  state(reg: string, stateId: string): unknown;
  // A document the LMS writes itself (cmi5's LMS.LaunchData).
  putState(reg: string, stateId: string, value: unknown): void;
  // The learner's record in SCORM 1.2's words, from the progress document and the statements.
  record(reg: string): LrsRecord;
  reset(reg: string): void;
}

// What an xAPI 1.0.3 LRS refuses in an agent (null when it takes it).
export function agentProblem(text: string | null): string | null {
  let agent: Record<string, unknown>;
  try { agent = JSON.parse(text ?? ''); } catch { return 'the agent is not JSON'; }
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return 'the agent is not an object';
  for (const [field, value] of Object.entries(agent)) if (Array.isArray(value)) return `the agent's ${field} is a list (xAPI 0.95)`;
  const account = agent.account as Record<string, unknown> | undefined;
  if (account && (typeof account.homePage !== 'string' || typeof account.name !== 'string')) return "the agent's account needs homePage and name";
  if (!['mbox', 'mbox_sha1sum', 'openid', 'account'].some((field) => agent[field] !== undefined)) return 'the agent has no identifier';
  return null;
}

export function createFakeLrs(): FakeLrs {
  const registrations = new Map<string, Registration>();
  // State documents by registration (or the activity and agent outside one), then stateId.
  const states = new Map<string, Map<string, string>>();
  const ofReg = (reg: string): Registration => {
    let entry = registrations.get(reg);
    if (!entry) { entry = { token: null, fetched: false, statements: [], calls: [], sessionId: '', terminated: false, cmi5: false, preferences: false }; registrations.set(reg, entry); }
    return entry;
  };
  // Which registration a request is about: its registration parameter, else the token's.
  const regOf = (url: URL, auth: string | undefined, statements: Record<string, unknown>[] = []): string | null => {
    const fromQuery = url.searchParams.get('registration');
    if (fromQuery) return fromQuery;
    const fromStatement = (statements[0]?.context as { registration?: string } | undefined)?.registration;
    if (fromStatement) return fromStatement;
    for (const [reg, entry] of registrations) if (entry.token && auth === `Basic ${entry.token}`) return reg;
    return null;
  };
  const log = (reg: string, call: Omit<LrsCall, 't'>) => ofReg(reg).calls.push({ t: Date.now(), ...call });

  // cmi5's rules an LMS checks on what an AU sends in a session (cmi5 spec §9).
  function refusal(reg: string, entry: Registration, statement: Record<string, unknown>, cmi5: boolean): string | null {
    if (!statement.actor || !statement.verb || !(statement.object as { id?: string } | undefined)?.id) return 'a statement needs an actor, a verb and an object';
    if (!cmi5) return null;
    const context = (statement.context ?? {}) as { extensions?: Record<string, unknown>; contextActivities?: { category?: { id: string }[] } };
    if (context.extensions?.[SESSION] !== entry.sessionId) return 'the statement is not of the launch\'s session';
    if (entry.terminated) return 'a statement after terminated';
    const verb = VERB(statement);
    const sent = entry.statements.filter((other) => ((other.context as { extensions?: Record<string, unknown> } | undefined)?.extensions?.[SESSION]) === entry.sessionId).map(VERB);
    const defined = context.contextActivities?.category?.some((category) => category.id === CMI5) ?? false;
    if (defined && verb !== 'initialized' && !sent.includes('initialized')) return `${verb} before initialized`;
    if (!defined && !sent.includes('initialized')) return `${verb} before initialized`;
    const all = entry.statements.map(VERB);
    if (verb === 'completed' && all.includes('completed')) return 'completed twice in a registration';
    if (verb === 'passed' && all.includes('passed')) return 'passed twice in a registration';
    if (verb === 'failed' && all.includes('passed')) return 'failed after passed';
    if (verb === 'initialized' && sent.includes('initialized')) return 'initialized twice in a session';
    const launch = states.get(reg)?.get('LMS.LaunchData');
    const mastery = launch ? (JSON.parse(launch) as { masteryScore?: number }).masteryScore : undefined;
    if ((verb === 'passed' || verb === 'failed') && mastery !== undefined && context.extensions?.['https://w3id.org/xapi/cmi5/context/extensions/masteryscore'] !== mastery) return `${verb} without the masteryscore extension of the launch (${mastery})`;
    if (verb === 'initialized' && !entry.preferences) return 'the AU must read the learner preferences (agents/profile cmi5LearnerPreferences) before initialized';
    return null;
  }

  return {
    launch(reg, { cmi5 = false, auth } = {}) {
      const entry = ofReg(reg);
      // The token as cmi5's fetch gives it, sent as Basic <token>; a Tin Can launch's auth is that header.
      entry.token = auth ? auth.replace(/^Basic\s+/i, '') : `tok-${randomUUID()}`;
      entry.fetched = !cmi5;
      entry.sessionId = randomUUID();
      entry.terminated = false;
      entry.cmi5 = cmi5;
      entry.preferences = false;
      return { token: entry.token, sessionId: entry.sessionId };
    },
    async handle(request, pathname, url, body) {
      const auth = request.headers.authorization;
      if (pathname.startsWith('/lms/cmi5/fetch/') && request.method === 'POST') {
        const reg = pathname.split('/')[4]!;
        const entry = ofReg(reg);
        if (entry.fetched || !entry.token) {
          log(reg, { method: 'fetch', args: [], result: 'false', error: 'fetched twice' });
          return { status: 200, body: JSON.stringify({ 'error-code': '1', 'error-text': 'The auth token was already fetched for this launch.' }), type: 'application/json' };
        }
        entry.fetched = true;
        log(reg, { method: 'fetch', args: [], result: 'true', error: '0' });
        return { status: 200, body: JSON.stringify({ 'auth-token': entry.token }), type: 'application/json' };
      }
      if (!pathname.startsWith('/lrs/')) return null;
      const version = request.headers['x-experience-api-version'];
      const route = pathname.slice('/lrs/'.length);
      // The Agent Profile API: the learner's cmi5 preferences (none here: 404), read before initialized.
      if (route === 'agents/profile' && request.method === 'GET') {
        for (const [reg, entry] of registrations) if (entry.token && auth === `Basic ${entry.token}`) { entry.preferences = true; log(reg, { method: 'preferences', args: [url.searchParams.get('profileId') ?? ''], result: 'true', error: '0' }); }
        return { status: 404, body: '' };
      }
      if (route === 'activities/state') {
        const reg = regOf(url, auth);
        const stateId = url.searchParams.get('stateId') ?? '';
        const key = reg ?? `${url.searchParams.get('activityId')}|${url.searchParams.get('agent')}`;
        const known = reg ? registrations.get(reg) : undefined;
        // Every request carries the key of a launch (the LMS's own writes say 'lms').
        if (auth !== 'lms' && (!reg || !known?.token || auth !== `Basic ${known.token}`)) {
          if (reg) log(reg, { method: 'state', args: [stateId], result: 'false', error: '401' });
          return { status: 401, body: 'unauthorized' };
        }
        // An xAPI 1.0.3 agent, as SCORM Cloud's LRS wants it: one value per field, an account as homePage and name.
        const wrong = agentProblem(url.searchParams.get('agent'));
        if (wrong && auth !== 'lms') {
          if (reg) log(reg, { method: 'state', args: [stateId], result: 'false', error: `400 ${wrong}` });
          return { status: 400, body: wrong };
        }
        const documents = states.get(key) ?? new Map<string, string>();
        states.set(key, documents);
        if (request.method === 'GET') {
          const document = documents.get(stateId);
          return document === undefined ? { status: 404, body: '' } : { status: 200, body: document, type: 'application/json' };
        }
        if (request.method === 'PUT' || request.method === 'POST') {
          const text = await body();
          if (!/^1\.0(\.\d)?$/.test(String(version ?? '')) && auth !== 'lms') {
            if (reg) log(reg, { method: 'state', args: [stateId], result: 'false', error: '400 X-Experience-API-Version' });
            return { status: 400, body: 'X-Experience-API-Version 1.0.x' };
          }
          documents.set(stateId, text);
          if (reg && stateId !== 'LMS.LaunchData') log(reg, { method: 'state', args: [stateId, text], result: 'true', error: '0' });
          return { status: 204, body: '' };
        }
        if (request.method === 'DELETE') { documents.delete(stateId); return { status: 204, body: '' }; }
      }
      if (route === 'statements' && (request.method === 'POST' || request.method === 'PUT')) {
        let parsed: unknown;
        try { parsed = JSON.parse(await body()); } catch { return { status: 400, body: 'not JSON' }; }
        const statements = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
        const reg = regOf(url, auth, statements);
        if (!reg) return { status: 400, body: 'no registration' };
        const entry = ofReg(reg);
        if (entry.token && auth !== `Basic ${entry.token}` && auth !== entry.token) {
          log(reg, { method: statements.map(VERB).join(','), args: [], result: 'false', error: '401' });
          return { status: 401, body: 'unauthorized' };
        }
        if (!/^1\.0(\.\d)?$/.test(String(version ?? ''))) {
          log(reg, { method: statements.map(VERB).join(','), args: [], result: 'false', error: '400 X-Experience-API-Version' });
          return { status: 400, body: 'X-Experience-API-Version 1.0.x' };
        }
        const cmi5 = entry.cmi5;
        for (const statement of statements) {
          const why = refusal(reg, entry, statement, cmi5);
          log(reg, { method: VERB(statement), args: [JSON.stringify(statement.result ?? {})], result: why ? 'false' : 'true', error: why ?? '0' });
          if (why) return { status: 400, body: why };
          entry.statements.push(statement);
          if (cmi5 && VERB(statement) === 'terminated') entry.terminated = true;
        }
        return { status: 200, body: JSON.stringify(statements.map((statement) => statement.id ?? randomUUID())), type: 'application/json' };
      }
      if (route === 'statements' && request.method === 'GET') {
        const reg = url.searchParams.get('registration') ?? '';
        return { status: 200, body: JSON.stringify({ statements: registrations.get(reg)?.statements ?? [] }), type: 'application/json' };
      }
      return { status: 404, body: 'not found' };
    },
    calls: (reg) => registrations.get(reg)?.calls ?? [],
    statements: (reg) => registrations.get(reg)?.statements ?? [],
    state: (reg, stateId) => { const text = states.get(reg)?.get(stateId); return text === undefined ? null : JSON.parse(text); },
    putState(reg, stateId, value) {
      const documents = states.get(reg) ?? new Map<string, string>();
      states.set(reg, documents);
      documents.set(stateId, JSON.stringify(value));
    },
    record(reg) {
      const progress = (() => { const text = states.get(reg)?.get('elabora-progress'); return text ? JSON.parse(text) as Record<string, unknown> : {}; })();
      const verbs = (registrations.get(reg)?.statements ?? []).map(VERB);
      const judged = [...(registrations.get(reg)?.statements ?? [])].reverse().find((statement) => ['passed', 'failed'].includes(VERB(statement)));
      const status = verbs.includes('passed') ? 'passed' : verbs.includes('failed') ? 'failed' : verbs.includes('completed') ? 'completed' : verbs.includes('initialized') ? 'incomplete' : undefined;
      return {
        location: progress.location, suspendData: progress.suspendData, exit: progress.exit, status,
        scoreRaw: ((judged?.result as { score?: { raw?: number } } | undefined)?.score?.raw) ?? (progress.score as { raw?: number } | undefined)?.raw
      };
    },
    reset(reg) { registrations.delete(reg); states.delete(reg); }
  };
}
