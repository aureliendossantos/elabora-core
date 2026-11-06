// elabora/lms.js: the start of a package that talks to its LMS over HTTP (cmi5, xAPI). It makes
// the connection first, without a synchronous request (browsers drop them as a page goes, and the
// emulator refuses them), then starts the player (elabora/player.js), which finds the connection in
// window.__elaboraLms. Without launch parameters (a file opened directly, a preview), the player
// starts alone, as a SCORM package without its LMS does.

import { PROGRESS_STATE, stateUrl, xapiHeaders } from './xapi.ts';
import { activityIdOf } from './activity-id.ts';
import { preferenceList } from './start-language.ts';
import type { Cmi5Launch, XapiAgent, XapiProgress, XapiSession } from './xapi.ts';
import type { CourseData } from './course-data.ts';

declare global {
  interface Window {
    __elaboraLms?: XapiSession | null;
    // Why the connection failed, for the debugger and the emulator.
    __elaboraLmsError?: string;
    // The learning record store set at build time, for launches outside an LMS (elabora/lrs.js).
    ELABORA_LRS?: { endpoint: string; auth: string };
    // The compiled course (elabora/course.js), as player.ts declares it.
    ELABORA_COURSE: CourseData;
  }
}

type Fetch = typeof fetch;

const parseJson = <T>(text: string | null): T | null => { try { return text ? JSON.parse(text) as T : null; } catch { return null; } };
const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);

async function readState<T>(fetcher: Fetch, session: Pick<XapiSession, 'endpoint' | 'activityId' | 'actor' | 'registration' | 'auth'>, stateId: string): Promise<T | null> {
  const response = await fetcher(stateUrl(session, stateId), { headers: xapiHeaders(session.auth, false) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`state ${stateId}: HTTP ${response.status} ${(await response.text().catch(() => '')).slice(0, 300)}`.trim());
  return parseJson<T>(await response.text());
}

// cmi5 (docs/delivery-cmi5.md): the LMS gives endpoint, fetch, actor, registration and activityId;
// the token is fetched once (kept for the tab, so a reload goes on with it), then LMS.LaunchData.
export async function connectCmi5(search: URLSearchParams, { fetcher = fetch, storage = sessionStorage }: { fetcher?: Fetch; storage?: Pick<Storage, 'getItem' | 'setItem'> } = {}): Promise<XapiSession | null> {
  const endpoint = search.get('endpoint');
  const fetchUrl = search.get('fetch');
  const actor = parseJson<XapiAgent>(search.get('actor'));
  const registration = search.get('registration');
  const activityId = search.get('activityId');
  if (!endpoint || !fetchUrl || !actor || !registration || !activityId) return null;
  // A launch's token, kept for the tab under its fetch URL (each launch has its own): a reload goes on
  // with it, a new launch fetches its own.
  const key = `elabora:cmi5:${fetchUrl}`;
  let token: string | null = null;
  try { token = storage.getItem(key); } catch { /* storage refused */ }
  if (!token) {
    const response = await fetcher(fetchUrl, { method: 'POST' });
    const body = parseJson<{ 'auth-token'?: string; 'error-code'?: string; 'error-text'?: string }>(await response.text());
    token = body?.['auth-token'] ?? null;
    if (!token) throw new Error(`cmi5 fetch: ${body?.['error-text'] ?? `HTTP ${response.status}`}`);
    try { storage.setItem(key, token); } catch { /* storage refused */ }
  }
  const base = { endpoint: withSlash(endpoint), auth: `Basic ${token}`, actor, registration, activityId };
  // cmi5 asks the AU to read the learner's preferences before initialized (section 11); an LMS
  // refuses its statements otherwise (SCORM Cloud: 403). Their languagePreference (RFC 5646 tags,
  // comma-separated, in order) is the language the learner starts in (D71); 404: none.
  const preferences = await fetcher(`${base.endpoint}agents/profile?${new URLSearchParams({ agent: JSON.stringify(actor), profileId: 'cmi5LearnerPreferences' })}`, { headers: xapiHeaders(base.auth, false) });
  if (!preferences.ok && preferences.status !== 404) throw new Error(`cmi5 learner preferences: HTTP ${preferences.status}`);
  const languages = preferences.ok ? preferenceList(parseJson<{ languagePreference?: string }>(await preferences.text())?.languagePreference) : [];
  const launch = await readState<{ contextTemplate?: Record<string, unknown>; launchMode?: Cmi5Launch['launchMode']; moveOn?: string; masteryScore?: number }>(fetcher, base, 'LMS.LaunchData');
  if (!launch) throw new Error('cmi5: no LMS.LaunchData for this registration');
  const extensions = (launch.contextTemplate?.extensions ?? {}) as Record<string, unknown>;
  const cmi5: Cmi5Launch = {
    sessionId: String(extensions['https://w3id.org/xapi/cmi5/context/extensions/sessionid'] ?? ''),
    contextTemplate: launch.contextTemplate ?? {},
    launchMode: launch.launchMode ?? 'Normal',
    ...(launch.moveOn ? { moveOn: launch.moveOn } : {}),
    ...(typeof launch.masteryScore === 'number' ? { masteryScore: launch.masteryScore } : {})
  };
  return { format: 'cmi5', ...base, cmi5, ...(languages.length ? { languages } : {}), progress: await readState<XapiProgress>(fetcher, base, PROGRESS_STATE), where: 'cmi5' };
}

// A visitor outside an LMS: an anonymous account kept in the browser.
function anonymousActor(homePage: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null): XapiAgent {
  let name: string | null = null;
  try { name = storage?.getItem('elabora:xapi:learner') ?? null; } catch { /* refused */ }
  if (!name) {
    name = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    try { storage?.setItem('elabora:xapi:learner', name); } catch { /* refused */ }
  }
  return { objectType: 'Agent', account: { homePage, name } };
}

// Old Tin Can launches (SCORM Cloud's among them) give the actor in xAPI 0.95's form: its fields as
// lists, an account as accountServiceHomePage and accountName. An xAPI 1.0.3 LRS wants one value
// each, an account as homePage and name.
export function tincanActor(param: Record<string, unknown>): XapiAgent {
  const one = (value: unknown) => (Array.isArray(value) ? value[0] : value);
  const actor: Record<string, unknown> = { objectType: 'Agent' };
  for (const [field, value] of Object.entries(param)) actor[field] = one(value);
  const account = actor.account as { accountServiceHomePage?: string; accountName?: string; homePage?: string; name?: string } | undefined;
  if (account) actor.account = { homePage: account.homePage ?? account.accountServiceHomePage, name: account.name ?? account.accountName };
  return actor as unknown as XapiAgent;
}

// xAPI alone (docs/delivery-xapi.md): the Tin Can launch of an LMS (endpoint, auth, actor,
// registration, activity_id), else the LRS set at build time with an anonymous learner.
export async function connectXapi(search: URLSearchParams, activityId: string, { fetcher = fetch, lrs = typeof window !== 'undefined' ? window.ELABORA_LRS : undefined, storage = typeof localStorage !== 'undefined' ? localStorage : null }: { fetcher?: Fetch; lrs?: { endpoint: string; auth: string }; storage?: Pick<Storage, 'getItem' | 'setItem'> | null } = {}): Promise<XapiSession | null> {
  const endpoint = search.get('endpoint');
  const auth = search.get('auth');
  const actorParam = parseJson<Record<string, unknown>>(search.get('actor'));
  let base: Pick<XapiSession, 'endpoint' | 'auth' | 'actor' | 'activityId' | 'where'> & { registration?: string };
  if (endpoint && auth && actorParam) {
    const actor = tincanActor(actorParam);
    const registration = search.get('registration');
    base = { endpoint: withSlash(endpoint), auth, actor, activityId: search.get('activity_id') || activityId, where: 'tincan', ...(registration ? { registration } : {}) };
  } else if (lrs?.endpoint) {
    base = { endpoint: withSlash(lrs.endpoint), auth: lrs.auth, actor: anonymousActor(lrs.endpoint, storage), activityId, where: 'lrs' };
  } else return null;
  return { format: 'xapi', ...base, progress: await readState<XapiProgress>(fetcher, base, PROGRESS_STATE) };
}

export async function connect(course: Pick<CourseData, 'id' | 'lms'>, search: URLSearchParams): Promise<XapiSession | null> {
  const format = course.lms?.format;
  if (format === 'cmi5') return connectCmi5(search);
  if (format === 'xapi') return connectXapi(search, activityIdOf(course));
  return null;
}

if (typeof window !== 'undefined' && window.ELABORA_COURSE) {
  const src = document.currentScript instanceof HTMLScriptElement ? document.currentScript.src : '';
  const start = () => {
    const script = document.createElement('script');
    script.src = src ? src.replace(/lms\.js(\?.*)?$/, 'player.js') : 'elabora/player.js';
    document.body.appendChild(script);
  };
  void connect(window.ELABORA_COURSE, new URLSearchParams(location.search))
    .then((session) => { window.__elaboraLms = session; })
    .catch((error: unknown) => { window.__elaboraLms = null; window.__elaboraLmsError = error instanceof Error ? error.message : String(error); })
    .finally(start);
}
