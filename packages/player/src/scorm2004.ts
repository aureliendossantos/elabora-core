// SCORM 2004 content-side adapter (3rd and 4th editions: one SCO, the same API).
// - Finds API_1484_11 where SCORM 1.2's API is looked for: parent frames, then the opener chain.
// - The player talks SCORM 1.2's data model (scorm12.ts): this adapter translates it. One status
//   becomes completion and success apart, the score gets its scaled value, times their ISO 8601
//   form, interactions their delimiters ([,], [.], [:]) and timestamps.
// - Initialises once, never again after Terminate; skips SetValue calls that would change nothing;
//   logs every call with its result and error code, for the debugger and the LMS emulator.

import { preferenceList } from './start-language.ts';
import { findLmsApi } from './scorm12.ts';
import type { AdapterOptions, LmsAdapter, LmsCall, LmsPhase, Scorm2004Method } from './scorm12.ts';

declare global {
  interface Window {
    // The SCORM 2004 API object, set by the LMS on one of the windows around the course.
    API_1484_11?: unknown;
  }
}

type ApiFunction = (...args: string[]) => unknown;
export interface Scorm2004Api {
  Initialize: ApiFunction;
  Terminate: ApiFunction;
  GetValue: ApiFunction;
  SetValue: ApiFunction;
  Commit: ApiFunction;
  GetLastError: ApiFunction;
  GetErrorString: ApiFunction;
}

export interface FoundScorm2004Api {
  api: Scorm2004Api;
  where: string;
}

export function findScorm2004API(win: Window): FoundScorm2004Api | null {
  return findLmsApi(win, (candidate) => {
    const api = candidate.API_1484_11;
    return (typeof api === 'object' || typeof api === 'function') && api !== null && typeof (api as Record<string, unknown>).Initialize === 'function' ? api as Scorm2004Api : null;
  });
}

const safe = <T>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };

// SCORM 1.2's CMITimespan (HHHH:MM:SS.SS) as SCORM 2004's timeinterval (PT#H#M#S).
export function scorm2004Duration(timespan: string): string {
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.(\d{1,2}))?$/.exec(timespan);
  if (!match) return 'PT0S';
  const [, hours, minutes, seconds, hundredths = '0'] = match;
  const total = Number(seconds) + Number(hundredths.padEnd(2, '0')) / 100;
  return `PT${Number(hours)}H${Number(minutes)}M${Number.isInteger(total) ? total : total.toFixed(2)}S`;
}

// SCORM 2004's time (an ISO 8601 date and time, to the second, local).
export function scorm2004Timestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// A SCORM 1.2 response or pattern in SCORM 2004's form, by the interaction's type.
export function scorm2004Response(type: string, value: string, pattern = false): string {
  if (type === 'choice' || type === 'sequencing') return value.split(',').filter(Boolean).join('[,]');
  if (type === 'matching') return value.split(',').filter(Boolean).map((pair) => pair.replace('.', '[.]')).join('[,]');
  if (type === 'true-false') return /^(t|true|1)$/i.test(value) ? 'true' : 'false';
  if (type === 'numeric' && pattern) return `${value}[:]${value}`;
  // A text: no delimiters inside, no language tag at its start, 250 characters.
  if (type === 'fill-in') return value.replace(/\[[,.:]\]/g, ' ').replace(/^\{/, '(').slice(0, 250);
  return value;
}

// SCORM 1.2's lesson_status from SCORM 2004's two statuses.
function lessonStatus(completion: string, success: string): string {
  if (success === 'passed') return 'passed';
  if (success === 'failed') return 'failed';
  if (completion === 'completed') return 'completed';
  if (completion === 'incomplete') return 'incomplete';
  return 'not attempted';
}

// SCORM 1.2 element names whose SCORM 2004 name only differs.
const RENAMED: Record<string, string> = {
  'cmi.core.lesson_location': 'cmi.location',
  'cmi.core.entry': 'cmi.entry',
  'cmi.core.student_name': 'cmi.learner_name',
  'cmi.core.student_id': 'cmi.learner_id',
  'cmi.core.score.raw': 'cmi.score.raw',
  'cmi.core.score.min': 'cmi.score.min',
  'cmi.core.score.max': 'cmi.score.max',
  'cmi.core.lesson_mode': 'cmi.mode',
  'cmi.core.credit': 'cmi.credit'
};

export function createScorm2004Adapter(found: FoundScorm2004Api, { now = () => Date.now(), onLog }: AdapterOptions = {}): LmsAdapter {
  const api = found.api;
  const log: LmsCall[] = [];
  let phase: LmsPhase = 'none';
  const sent = new Map<string, string>();
  // The types of the interactions written in this session (their responses depend on it).
  const types = new Map<string, string>();
  const score = { min: 0, max: 100 };
  const record = (call: LmsCall) => {
    log.push(call);
    if (log.length > 2000) log.shift();
    onLog?.(call);
  };
  const call = (method: Scorm2004Method, ...args: [string] | [string, string]) => {
    const t = now();
    let result: string;
    let error = '0';
    try { result = String(api[method](...args)); } catch (e) { result = 'false'; error = `exception: ${(e as Error).message}`; }
    if (result === 'false' || method === 'GetValue') {
      const code = safe(() => String(api.GetLastError())) || '0';
      if (code !== '0') error = `${code} ${safe(() => api.GetErrorString(code)) || ''}`.trim();
    }
    record({ t, method, args, result, error });
    return { result, error };
  };
  const setValue = (element: string, value: string, dedupe = true) => {
    if (dedupe && sent.get(element) === value) return true;
    const ok = call('SetValue', element, value).result === 'true';
    if (ok && dedupe) sent.set(element, value);
    return ok;
  };
  const getValue = (element: string) => call('GetValue', element).result;

  // A SCORM 1.2 element and value as the SCORM 2004 ones they stand for (null: nothing to send).
  const translate = (element: string, value: string): [string, string][] | null => {
    if (element === 'cmi.core.lesson_status') {
      if (value === 'passed' || value === 'failed') return [['cmi.completion_status', 'completed'], ['cmi.success_status', value]];
      if (value === 'completed' || value === 'incomplete') return [['cmi.completion_status', value]];
      return [['cmi.completion_status', 'not attempted']];
    }
    // SCORM 1.2's undetermined exit ("", after completion) is SCORM 2004's normal one.
    if (element === 'cmi.core.exit') return [['cmi.exit', value === 'suspend' || value === 'logout' || value === 'time-out' ? value : 'normal']];
    if (element === 'cmi.core.session_time') return [['cmi.session_time', scorm2004Duration(value)]];
    if (element === 'cmi.core.score.min' || element === 'cmi.core.score.max') {
      score[element.endsWith('min') ? 'min' : 'max'] = Number(value);
      return [[RENAMED[element], value]];
    }
    if (element === 'cmi.core.score.raw') {
      const range = score.max - score.min;
      const scaled = range > 0 ? Math.min(1, Math.max(-1, (Number(value) - score.min) / range)) : 0;
      return [['cmi.score.raw', value], ['cmi.score.scaled', String(Math.round(scaled * 10000) / 10000)]];
    }
    const interaction = /^cmi\.interactions\.(\d+)\.(.+)$/.exec(element);
    if (interaction) {
      const [, index, field] = interaction;
      const prefix = `cmi.interactions.${index}`;
      if (field === 'type') {
        // A free response (a free object's) has SCORM 2004's free type.
        const type = value === 'performance' ? 'other' : value;
        types.set(index, type);
        return [[`${prefix}.type`, type]];
      }
      const type = types.get(index) ?? '';
      if (field === 'time') return [[`${prefix}.timestamp`, scorm2004Timestamp(new Date(now()))]];
      if (field === 'student_response') {
        const response = scorm2004Response(type, value);
        return response === '' && type !== 'fill-in' && type !== 'other' ? null : [[`${prefix}.learner_response`, response]];
      }
      if (field === 'correct_responses.0.pattern') return [[`${prefix}.correct_responses.0.pattern`, scorm2004Response(type, value, true)]];
      if (field === 'result') return [[`${prefix}.result`, value === 'wrong' ? 'incorrect' : value]];
      return [[`${prefix}.${field}`, value]];
    }
    return [[RENAMED[element] ?? element, value]];
  };
  const send = (element: string, value: string | number, dedupe: boolean) => {
    if (phase !== 'initialized') return false;
    const pairs = translate(element, String(value));
    if (!pairs) return true;
    let ok = true;
    for (const [name, text] of pairs) ok = setValue(name, text, dedupe) && ok;
    return ok;
  };

  return {
    kind: 'scorm2004',
    where: found.where,
    log,
    get phase() { return phase; },
    initialize() {
      if (phase !== 'none') return phase === 'initialized';
      if (call('Initialize', '').result === 'true') phase = 'initialized';
      return phase === 'initialized';
    },
    get(element) {
      if (phase !== 'initialized') return '';
      if (element === 'cmi.core.lesson_status') return lessonStatus(getValue('cmi.completion_status'), getValue('cmi.success_status'));
      if (element === 'cmi.core.exit') return '';
      return getValue(RENAMED[element] ?? element);
    },
    set: (element, value) => send(element, value, true),
    // Interactions are appended at the next free index: never deduplicated.
    setAlways: (element, value) => send(element, value, false),
    commit() {
      if (phase !== 'initialized') return false;
      return call('Commit', '').result === 'true';
    },
    finish() {
      if (phase !== 'initialized') return false;
      const r = call('Terminate', '');
      phase = 'finished';
      return r.result === 'true';
    },
    // The learner's preferred language (D71): cmi.learner_preference.language, often empty.
    preferredLanguages() {
      if (phase !== 'initialized') return [];
      const r = call('GetValue', 'cmi.learner_preference.language');
      return r.error === '0' ? preferenceList(r.result) : [];
    }
  };
}
