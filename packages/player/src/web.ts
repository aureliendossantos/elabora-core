// The web target's adapter (docs/decisions.md D41): a module served by a plain web server, with no
// LMS around it. The player talks to it as to an LMS (the SCORM 1.2 data model), and it keeps what a
// learner needs to come back where they left:
// - progress "local": in the browser's localStorage, from one visit to the next (lesson location,
//   status, score and suspend data, the same encoding and keys as in an LMS, D4); interactions and
//   session time are an LMS's journal and are not kept. Dated at each save, it is forgotten a year
//   after the last one (D41, amended on 29 Oct 2026): Elabora's hosting does the same for whatever
//   an origin keeps, with a cookie this player never sees (elabora-cloud C33); here the rule holds
//   on any server;
// - progress "none": nothing is kept anywhere; a reload starts the module again.
// It never looks for an LMS and shows no banner: unlike the preview's standalone adapter, it is what
// the public sees.

import { isRecord } from './json.ts';
import type { LmsAdapter, LmsCall, LmsPhase } from './scorm12.ts';

export type WebProgress = 'local' | 'none';

// What the adapter uses of the browser's storage (localStorage, or a stand-in in tests).
export interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WebAdapterOptions {
  progress: WebProgress;
  storage?: WebStorage | null; // default: window.localStorage (null or refused: nothing is kept)
  now?: () => number;
}

// Elements a visit keeps: what resuming reads, not the LMS's journal.
const KEPT = /^cmi\.(suspend_data|core\.(lesson_location|lesson_status|exit|score\.(raw|min|max)))$/;

// When the progress was last saved (milliseconds), beside the kept elements; a year later it is forgotten.
const SAVED_AT = 'savedAt';
export const WEB_PROGRESS_KEPT_MS = 365 * 86_400_000;

export const webStorageKey = (courseId: string): string => `elabora:web:${courseId}`;

function defaultStorage(): WebStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; } // refused (privacy settings)
}

export function createWebAdapter(courseId: string, { progress, storage = progress === 'local' ? defaultStorage() : null, now = () => Date.now() }: WebAdapterOptions): LmsAdapter {
  const key = webStorageKey(courseId);
  const store = progress === 'local' ? storage : null;
  const data: Record<string, string> = {};
  if (store) {
    try {
      const stored: unknown = JSON.parse(store.getItem(key) || '{}');
      const savedAt = isRecord(stored) ? stored[SAVED_AT] : undefined;
      if (typeof savedAt === 'number' && now() - savedAt > WEB_PROGRESS_KEPT_MS) store.removeItem(key);
      else if (isRecord(stored)) for (const [element, value] of Object.entries(stored)) if (KEPT.test(element) && typeof value === 'string') data[element] = value;
    } catch { /* unreadable: a fresh start */ }
  }
  const log: LmsCall[] = [];
  let phase: LmsPhase = 'none';
  let interactions = 0;
  const record = (method: LmsCall['method'], args: string[]) => {
    log.push({ t: now(), method, args, result: 'true', error: '0' });
    if (log.length > 2000) log.shift();
  };
  const persist = () => {
    if (!store) return;
    const kept: Record<string, string | number> = {};
    for (const element of Object.keys(data).sort()) if (KEPT.test(element)) kept[element] = data[element];
    kept[SAVED_AT] = now();
    try { store.setItem(key, JSON.stringify(kept)); } catch { /* full or refused: this visit only */ }
  };
  const set = (element: string, value: string | number) => {
    const text = String(value);
    record('LMSSetValue', [element, text]);
    if (/^cmi\.interactions\.\d+\.id$/.test(element)) interactions++;
    else if (!element.startsWith('cmi.interactions.')) data[element] = text;
    return true;
  };
  return {
    kind: 'web',
    where: 'none',
    log,
    get phase() { return phase; },
    initialize() {
      if (phase !== 'none') return phase === 'initialized';
      phase = 'initialized';
      if (!data['cmi.core.lesson_status']) data['cmi.core.lesson_status'] = 'not attempted';
      data['cmi.core.entry'] = data['cmi.suspend_data'] ? 'resume' : 'ab-initio';
      record('LMSInitialize', ['']);
      return true;
    },
    get(element) {
      if (element === 'cmi.interactions._count') return String(interactions);
      if (element === 'cmi.core.student_name' || element === 'cmi.core.student_id') return '';
      return data[element] ?? '';
    },
    set,
    setAlways: set,
    commit() { persist(); record('LMSCommit', ['']); return true; },
    finish() { persist(); phase = 'finished'; record('LMSFinish', ['']); return true; },
    reset() {
      for (const element of Object.keys(data)) delete data[element];
      interactions = 0;
      try { store?.removeItem(key); } catch { /* see persist */ }
    }
  };
}
