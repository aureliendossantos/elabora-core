// SCORM 1.2 content-side adapter.
// - Finds the LMS API in parent frames, then in the opener chain (SuccessFactors puts it at
//   top.opener.opener). The content never opens a window itself.
// - Initialises once, never again after LMSFinish (error 101 on bfcache restore, MDL-89642).
// - Skips SetValue calls that would not change anything, so commits stay idempotent.
// - Logs every call with its result and error code, for the debugger and the LMS emulator.

import { isRecord } from './json.ts';

declare global {
  interface Window {
    // The LMS API object, set by the LMS on one of the windows around the course.
    API?: unknown;
  }
}

// The SCORM 1.2 API of the LMS: LMSInitialize(''), LMSGetValue(element), LMSSetValue(element, value),
// LMSGetErrorString(code)… What it returns is whatever the LMS returns: it is read as a string.
type ApiFunction = (...args: string[]) => unknown;
export interface Scorm12Api {
  LMSInitialize: ApiFunction;
  LMSFinish: ApiFunction;
  LMSGetValue: ApiFunction;
  LMSSetValue: ApiFunction;
  LMSCommit: ApiFunction;
  LMSGetLastError: ApiFunction;
  LMSGetErrorString: ApiFunction;
}

export interface FoundApi {
  api: Scorm12Api;
  // Where it was found: self, parent^n, opener.…
  where: string;
}

export type Scorm12Method = 'LMSInitialize' | 'LMSFinish' | 'LMSGetValue' | 'LMSSetValue' | 'LMSCommit';

export interface LmsCall {
  t: number;
  method: Scorm12Method;
  args: string[];
  result: string;
  error: string;
}

export type LmsPhase = 'none' | 'initialized' | 'finished';

// What the player uses of the LMS, found or not.
export interface LmsAdapter {
  kind: 'scorm12' | 'standalone' | 'web'; // web: the web target's (web.ts)
  where: string;
  log: LmsCall[];
  readonly phase: LmsPhase;
  initialize(): boolean;
  get(element: string): string;
  set(element: string, value: string | number): boolean;
  setAlways(element: string, value: string | number): boolean;
  commit(): boolean;
  finish(): boolean;
  // Standalone and web only: forget the data kept.
  reset?(): void;
}

// A cmi.interactions.n entry. SCORM 1.2 interactions are a write-only journal; responses use
// single characters for choices (a, b, c…).
export interface Interaction {
  id: string;
  type: 'choice' | 'true-false' | 'performance' | 'sequencing' | 'numeric' | 'fill-in' | 'matching' | 'likert';
  objective?: string;
  response: string;
  correctPattern?: string;
  result: 'correct' | 'wrong' | 'neutral';
  weight?: number;
}

const MAX_PARENT_DEPTH = 12;

// Windows of other origins throw on access.
function safe<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}

// Only LMSInitialize is checked: the adapter catches the failures of the other calls.
function isScorm12Api(value: unknown): value is Scorm12Api {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && 'LMSInitialize' in value && typeof value.LMSInitialize === 'function';
}

function findInParents(start: Window): FoundApi | null {
  let current: Window | null = start;
  for (let depth = 0; current && depth <= MAX_PARENT_DEPTH; depth++) {
    const win: Window = current;
    const api = safe(() => win.API);
    if (api && isScorm12Api(api)) return { api, where: depth === 0 ? 'self' : `parent^${depth}` };
    const parent = safe(() => win.parent);
    if (!parent || parent === win) break;
    current = parent;
  }
  return null;
}

export function findScorm12API(win: Window): FoundApi | null {
  const direct = findInParents(win);
  if (direct) return direct;
  // Opener chain: top.opener, then top.opener.opener (and their parents).
  let top: Window = safe(() => win.top) || win;
  for (let depth = 1; depth <= 3; depth++) {
    const opener: Window | null | undefined = safe(() => top.opener);
    if (!opener) break;
    const found = findInParents(opener);
    if (found) return { api: found.api, where: `${'opener.'.repeat(depth)}${found.where}` };
    top = safe(() => opener.top) || opener;
  }
  return null;
}

export function pad(value: number, width: number): string { return String(value).padStart(width, '0'); }

// CMITimespan HHHH:MM:SS.SS
export function scorm12Duration(ms: number): string {
  const totalCentiseconds = Math.max(0, Math.round(ms / 10));
  const centiseconds = totalCentiseconds % 100;
  const seconds = Math.floor(totalCentiseconds / 100) % 60;
  const minutes = Math.floor(totalCentiseconds / 6000) % 60;
  const hours = Math.min(9999, Math.floor(totalCentiseconds / 360000));
  return `${pad(hours, 4)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(centiseconds, 2)}`;
}

export interface AdapterOptions {
  now?: () => number;
  onLog?: (call: LmsCall) => void;
}

export function createScorm12Adapter(found: FoundApi, { now = () => Date.now(), onLog }: AdapterOptions = {}): LmsAdapter {
  const api = found.api;
  const log: LmsCall[] = [];
  let phase: LmsPhase = 'none'; // none → initialized → finished
  const sent = new Map<string, string>();
  const record = (call: LmsCall) => {
    log.push(call);
    if (log.length > 2000) log.shift();
    onLog?.(call);
  };
  const call = (method: Scorm12Method, ...args: [string] | [string, string]) => {
    const t = now();
    let result: string;
    let error = '0';
    try { result = String(api[method](...args)); } catch (e) { result = 'false'; error = `exception: ${(e as Error).message}`; }
    if (result === 'false' || (method === 'LMSGetValue' && error === '0')) {
      const code = safe(() => String(api.LMSGetLastError())) || '0';
      if (code !== '0') error = `${code} ${safe(() => api.LMSGetErrorString(code)) || ''}`.trim();
    }
    record({ t, method, args, result, error });
    return { result, error };
  };

  return {
    kind: 'scorm12',
    where: found.where,
    log,
    get phase() { return phase; },
    initialize() {
      if (phase !== 'none') return phase === 'initialized';
      const r = call('LMSInitialize', '');
      if (r.result === 'true') phase = 'initialized';
      return phase === 'initialized';
    },
    get(element) {
      if (phase !== 'initialized') return '';
      return call('LMSGetValue', element).result;
    },
    set(element, value) {
      if (phase !== 'initialized') return false;
      const text = String(value);
      if (sent.get(element) === text) return true;
      const r = call('LMSSetValue', element, text);
      if (r.result === 'true') { sent.set(element, text); return true; }
      return false;
    },
    // Interactions are write-only and append-only in SCORM 1.2: never deduplicated.
    setAlways(element, value) {
      if (phase !== 'initialized') return false;
      return call('LMSSetValue', element, String(value)).result === 'true';
    },
    commit() {
      if (phase !== 'initialized') return false;
      return call('LMSCommit', '').result === 'true';
    },
    finish() {
      if (phase !== 'initialized') return false;
      const r = call('LMSFinish', '');
      phase = 'finished';
      return r.result === 'true';
    }
  };
}

// Used when no LMS is found (preview, file opened directly). Keeps data in sessionStorage
// for the convenience of previews only: it is never a source of truth.
export function createStandaloneAdapter(courseId: string, { now = () => Date.now() }: Pick<AdapterOptions, 'now'> = {}): LmsAdapter {
  const key = `elabora:${courseId}`;
  let data: Record<string, unknown> = {};
  try { const stored: unknown = JSON.parse(sessionStorage.getItem(key) || '{}'); data = isRecord(stored) ? stored : {}; } catch { data = {}; }
  const log: LmsCall[] = [];
  let phase: LmsPhase = 'none';
  const persist = () => { try { sessionStorage.setItem(key, JSON.stringify(data)); } catch { /* storage unavailable */ } };
  const set = (element: string, value: string | number) => { data[element] = String(value); log.push({ t: now(), method: 'LMSSetValue', args: [element, String(value)], result: 'true', error: '0' }); return true; };
  return {
    kind: 'standalone',
    where: 'none',
    log,
    get phase() { return phase; },
    initialize() {
      phase = 'initialized';
      if (!data['cmi.core.lesson_status']) data['cmi.core.lesson_status'] = 'not attempted';
      data['cmi.core.entry'] = data['cmi.suspend_data'] ? 'resume' : 'ab-initio';
      log.push({ t: now(), method: 'LMSInitialize', args: [''], result: 'true', error: '0' });
      return true;
    },
    get(element) { const value = element === 'cmi.core.student_name' ? '' : data[element]; return value === undefined || value === null ? '' : String(value); },
    set,
    setAlways: set,
    commit() { persist(); log.push({ t: now(), method: 'LMSCommit', args: [''], result: 'true', error: '0' }); return true; },
    finish() { persist(); phase = 'finished'; log.push({ t: now(), method: 'LMSFinish', args: [''], result: 'true', error: '0' }); return true; },
    reset() { data = {}; persist(); }
  };
}
