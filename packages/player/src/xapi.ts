// xAPI formats' content-side adapter: cmi5 (a session the LMS launches, docs/delivery-cmi5.md) and
// xAPI alone (Tin Can launch, or a learning record store set at build time, docs/delivery-xapi.md).
// The connection is made before the player starts (lms-boot.ts: launch parameters, the cmi5 token,
// the launch data and the learner's last state), so the player reads its values at once; what it
// sets is kept here and sent when it commits, in order and without waiting:
// - the learner's place, suspend data, status and score: one state document (State API, stateId
//   elabora-progress), what a relaunch reads back;
// - what happens: statements. initialized, then completed, passed or failed once decided (in cmi5:
//   with the moveOn category, once per registration, never in Browse or Review), each answer as
//   answered (cmi.interaction), terminated when the session ends.
// The player talks SCORM 1.2's data model (scorm12.ts): this adapter translates it, as scorm2004.ts.

import { scorm2004Duration, scorm2004Response } from './scorm2004.ts';
import type { LmsAdapter, LmsCall, LmsPhase } from './scorm12.ts';

export const XAPI_VERSION = '1.0.3';
export const PROGRESS_STATE = 'elabora-progress';


export interface XapiAgent {
  objectType?: 'Agent';
  name?: string;
  mbox?: string;
  account?: { homePage: string; name: string };
}

// What the learner's state document holds (and the statements this registration already sent).
export interface XapiProgress {
  location?: string;
  suspendData?: string;
  status?: string;
  score?: { raw: number; min: number; max: number };
  exit?: string;
  sent?: { completed?: boolean; passed?: boolean; failed?: boolean };
}

// cmi5's launch data (LMS.LaunchData), as the AU uses it.
export interface Cmi5Launch {
  sessionId: string;
  contextTemplate: Record<string, unknown>;
  launchMode: 'Normal' | 'Browse' | 'Review';
  moveOn?: string;
  masteryScore?: number;
}

// The connection lms-boot.ts made: where to send, as whom, about what, and what was kept.
export interface XapiSession {
  format: 'cmi5' | 'xapi';
  endpoint: string; // ends with /
  auth: string; // the Authorization header
  actor: XapiAgent;
  registration?: string;
  activityId: string;
  progress: XapiProgress | null; // the state document at launch (null: a first launch)
  cmi5?: Cmi5Launch;
  where: string; // how it was launched: cmi5, tincan, lrs (the LRS set at build time)
}

export type Fetcher = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const VERBS: Record<string, string> = {
  initialized: 'http://adlnet.gov/expapi/verbs/initialized',
  completed: 'http://adlnet.gov/expapi/verbs/completed',
  passed: 'http://adlnet.gov/expapi/verbs/passed',
  failed: 'http://adlnet.gov/expapi/verbs/failed',
  answered: 'http://adlnet.gov/expapi/verbs/answered',
  terminated: 'http://adlnet.gov/expapi/verbs/terminated'
};
const CMI5_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/cmi5';
const MOVEON_CATEGORY = 'https://w3id.org/xapi/cmi5/context/categories/moveon';

export function xapiHeaders(auth: string, json = true): Record<string, string> {
  return { Authorization: auth, 'X-Experience-API-Version': XAPI_VERSION, ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

// The State API address of a document of this learner, activity and registration.
export function stateUrl(session: Pick<XapiSession, 'endpoint' | 'activityId' | 'actor' | 'registration'>, stateId: string): string {
  const query = new URLSearchParams({ activityId: session.activityId, agent: JSON.stringify(session.actor), stateId, ...(session.registration ? { registration: session.registration } : {}) });
  return `${session.endpoint}activities/state?${query}`;
}

// A version 4 UUID (statement ids).
export function uuid(random: () => number = Math.random): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface PendingInteraction { id?: string; type?: string; pattern?: string; response?: string; objective?: string; result?: string }

export interface XapiAdapterOptions {
  now?: () => number;
  fetch?: Fetcher;
  // Requests after the page is hidden go with keepalive (the browser sends them after it is gone).
  hidden?: () => boolean;
  onLog?: (call: LmsCall) => void;
}

export function createXapiAdapter(session: XapiSession, { now = () => Date.now(), fetch: send = globalThis.fetch?.bind(globalThis) as Fetcher, hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden', onLog }: XapiAdapterOptions = {}): LmsAdapter {
  const log: LmsCall[] = [];
  let phase: LmsPhase = 'none';
  const progress: XapiProgress = { ...(session.progress ?? {}), sent: { ...(session.progress?.sent ?? {}) } };
  const first = session.progress === null;
  let dirty = false;
  let sessionTime = 'PT0S';
  let statements: Record<string, unknown>[] = [];
  const interactions = new Map<string, PendingInteraction>();
  const cmi5 = session.cmi5;
  // cmi5: Browse and Review launches record nothing that judges the learner.
  const judged = !cmi5 || cmi5.launchMode === 'Normal';
  let queue: Promise<unknown> = Promise.resolve();
  const record = (call: LmsCall) => {
    log.push(call);
    if (log.length > 2000) log.shift();
    onLog?.(call);
  };
  // One request after the other: the LRS gets them in the order the learner did things. Once the page
  // is hidden it may be gone before an answer comes: each request then leaves at once, with keepalive
  // (a request waiting for the one before would never leave).
  const request = (method: string, args: string[], url: string, init: RequestInit) => {
    const t = now();
    const done = (sent: Promise<Awaited<ReturnType<Fetcher>>>) => sent
      .then((response) => record({ t, method: method as LmsCall['method'], args, result: response.ok ? 'true' : 'false', error: response.ok ? '0' : String(response.status) }))
      .catch((error: unknown) => record({ t, method: method as LmsCall['method'], args, result: 'false', error: `exception: ${error instanceof Error ? error.message : String(error)}` }));
    if (hidden()) {
      const leaving = done(send(url, { ...init, keepalive: true }));
      queue = Promise.all([queue, leaving]);
    } else queue = queue.then(() => done(send(url, init)));
    return queue;
  };
  const context = (categories: string[] = []): Record<string, unknown> => {
    const template = (cmi5?.contextTemplate ?? {}) as { contextActivities?: Record<string, unknown[]>; extensions?: Record<string, unknown> };
    const activities = { ...(template.contextActivities ?? {}) };
    const category = [...((activities.category as { id: string }[] | undefined) ?? []), ...categories.map((id) => ({ id }))];
    return {
      ...template,
      ...(session.registration ? { registration: session.registration } : {}),
      contextActivities: { ...activities, ...(category.length ? { category } : {}) }
    };
  };
  const statement = (verb: string, extra: Record<string, unknown> = {}, categories: string[] = []): Record<string, unknown> => ({
    id: uuid(),
    actor: session.actor,
    verb: { id: VERBS[verb], display: { 'en-US': verb } },
    object: { objectType: 'Activity', id: session.activityId },
    context: context(categories),
    timestamp: new Date(now()).toISOString(),
    ...extra
  });
  // cmi5-defined statements carry the cmi5 category (and moveOn for completion and success).
  const defined = (verb: string, extra: Record<string, unknown> = {}, moveOn = false) => statement(verb, extra, cmi5 ? [CMI5_CATEGORY, ...(moveOn ? [MOVEON_CATEGORY] : [])] : []);
  const scoreResult = () => {
    const score = progress.score;
    if (!score) return {};
    const range = score.max - score.min;
    return { score: { scaled: range > 0 ? Math.round(((score.raw - score.min) / range) * 10000) / 10000 : 0, raw: score.raw, min: score.min, max: score.max } };
  };
  // The success the LMS's mastery score decides (cmi5: it overrides the AU's).
  const success = (status: 'passed' | 'failed') => {
    if (cmi5?.masteryScore === undefined || !progress.score) return status;
    const scaled = (progress.score.raw - progress.score.min) / Math.max(1, progress.score.max - progress.score.min);
    return scaled >= cmi5.masteryScore ? 'passed' : 'failed';
  };
  const decide = (status: string) => {
    if (!judged) return;
    const sent = progress.sent!;
    if ((status === 'completed' || status === 'passed' || status === 'failed') && !sent.completed) {
      statements.push(defined('completed', { result: { completion: true, duration: sessionTime } }, true));
      sent.completed = true;
    }
    if (status === 'passed' || status === 'failed') {
      const verdict = success(status);
      // Passed is final; failed may come again until then, never after.
      if (sent.passed || (verdict === 'failed' && sent.failed)) return;
      statements.push(defined(verdict, { result: { success: verdict === 'passed', duration: sessionTime, ...scoreResult() } }, true));
      sent[verdict] = true;
    }
  };
  const answered = (index: string) => {
    const entry = interactions.get(index);
    interactions.delete(index);
    if (!entry?.id || !entry.type) return;
    const type = entry.type === 'performance' ? 'other' : entry.type;
    const definition = { type: 'http://adlnet.gov/expapi/activities/cmi.interaction', interactionType: type, ...(entry.pattern ? { correctResponsesPattern: [scorm2004Response(type, entry.pattern, true)] } : {}) };
    const result = { response: scorm2004Response(type, entry.response ?? ''), ...(entry.result === 'correct' ? { success: true } : entry.result === 'wrong' ? { success: false } : {}) };
    const objective = entry.objective ? { contextActivities: { ...(context().contextActivities as Record<string, unknown>), parent: [{ id: session.activityId }], other: [{ id: `${session.activityId}/objectives/${encodeURIComponent(entry.objective)}` }] } } : {};
    const base = statement('answered', { result });
    statements.push({ ...base, object: { objectType: 'Activity', id: `${session.activityId}/interactions/${encodeURIComponent(entry.id)}`, definition }, context: { ...(base.context as Record<string, unknown>), ...objective } });
  };
  const set = (element: string, value: string | number) => {
    if (phase !== 'initialized') return false;
    const text = String(value);
    const interaction = /^cmi\.interactions\.(\d+)\.(.+)$/.exec(element);
    if (interaction) {
      const [, index, field] = interaction as unknown as [string, string, string];
      const entry = interactions.get(index) ?? {};
      if (field === 'id') entry.id = text;
      else if (field === 'type') entry.type = text;
      else if (field === 'correct_responses.0.pattern') entry.pattern = text;
      else if (field === 'student_response') entry.response = text;
      else if (field === 'objectives.0.id') entry.objective = text;
      else if (field === 'result') entry.result = text;
      interactions.set(index, entry);
      // The result is the last field the player writes.
      if (field === 'result') answered(index);
      return true;
    }
    const change = (key: 'location' | 'suspendData' | 'exit' | 'status', next: string) => { if (progress[key] !== next) { progress[key] = next; dirty = true; } };
    if (element === 'cmi.suspend_data') change('suspendData', text);
    else if (element === 'cmi.core.lesson_location') change('location', text);
    else if (element === 'cmi.core.exit') change('exit', text);
    else if (element === 'cmi.core.session_time') sessionTime = scorm2004Duration(text);
    else if (element === 'cmi.core.lesson_status') { if (progress.status !== text) { change('status', text); decide(text); } }
    else if (element.startsWith('cmi.core.score.')) {
      const score = progress.score ?? { raw: 0, min: 0, max: 100 };
      const part = element.slice('cmi.core.score.'.length) as 'raw' | 'min' | 'max';
      if (score[part] !== Number(text) || !progress.score) { progress.score = { ...score, [part]: Number(text) }; dirty = true; }
    }
    return true;
  };
  const flush = () => {
    if (statements.length) {
      const batch = statements;
      statements = [];
      request('statements', batch.map((entry) => String((entry.verb as { display: Record<string, string> }).display['en-US'])), `${session.endpoint}statements`, { method: 'POST', headers: xapiHeaders(session.auth), body: JSON.stringify(batch) });
    }
    if (dirty) {
      dirty = false;
      request('state', [PROGRESS_STATE], stateUrl(session, PROGRESS_STATE), { method: 'PUT', headers: xapiHeaders(session.auth), body: JSON.stringify(progress) });
    }
    return true;
  };

  return {
    kind: session.format,
    where: session.where,
    log,
    get phase() { return phase; },
    initialize() {
      if (phase !== 'none') return phase === 'initialized';
      phase = 'initialized';
      statements.push(defined('initialized'));
      flush();
      return true;
    },
    get(element) {
      if (phase !== 'initialized') return '';
      if (element === 'cmi.suspend_data') return progress.suspendData ?? '';
      if (element === 'cmi.core.lesson_location') return progress.location ?? '';
      if (element === 'cmi.core.lesson_status') return progress.status ?? 'not attempted';
      if (element === 'cmi.core.entry') return first ? 'ab-initio' : progress.exit === 'suspend' ? 'resume' : '';
      if (element === 'cmi.core.student_name') return session.actor.name ?? '';
      if (element === 'cmi.interactions._count') return '0';
      return '';
    },
    set,
    setAlways: set,
    commit: () => (phase === 'initialized' ? flush() : false),
    finish() {
      if (phase !== 'initialized') return false;
      flush();
      statements.push(defined('terminated', { result: { duration: sessionTime } }));
      flush();
      phase = 'finished';
      return true;
    },
    // The requests sent so far, all answered (tests).
    settled: () => queue.then(() => undefined)
  } as LmsAdapter & { settled(): Promise<void> };
}
