// Where a browser's session does not run a model (D113): on a phone, whose memory and time are not a
// computer's (the word aligners, the local voices), and a language's models on a computer with too
// little memory for them, where the browser says how much it has (navigator.deviceMemory, Chromium
// alone). Elsewhere a model is tried, and the runtime's failure to grow its memory says the same.

import { EngineError } from '../../base/errors.ts';

export function onAPhone(): boolean {
  const data = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  return data?.mobile ?? /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

// The memory a language's models take at their peak, in GB of the computer (measured, the study's
// section 3.4: the French aligner 1.6 GB, the French voice 2.3 GB).
const NEEDS_GB: Readonly<Record<string, number>> = { fr: 8 };

// A language whose models are not kept in memory beside another (the models Worker frees the other first).
export const heavy = (language: string): boolean => language.toLowerCase().split('-')[0] in NEEDS_GB;

// what: the work refused, as the message says it (« Timing words », « Saying lines »).
export function refusal(language: string, what: string): EngineError | null {
  if (onAPhone()) return new EngineError('not-available', `${what} is done on a computer: a phone has neither the memory nor the time it takes.`, { code: 'E_LOCAL_AI_PLATFORM' });
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const needs = NEEDS_GB[language.toLowerCase().split('-')[0]];
  if (needs && memory !== undefined && memory < needs) return new EngineError('not-available', `${what} in this language needs a computer with ${needs} GB of memory or more (this one says ${memory} GB).`, { code: 'E_LOCAL_AI_MEMORY' });
  return null;
}
