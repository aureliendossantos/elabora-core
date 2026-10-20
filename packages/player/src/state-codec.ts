// Learner state ⇄ cmi.suspend_data. Shared by the browser runtime and by the compiler,
// which computes the worst-case length with the same encoder (so the budget is exact).
//
// Every stateful element (screen, quiz, decision, free object, variable) has a short key from
// elabora.lock.json. Keys never change for a given id, so content updates keep learner progress
// for every element that still exists, whatever its new position.
//
// Format v1 (JSON, short fields):
//   v: format version
//   s: visited screen keys joined by "."      c: completed screen keys joined by "."
//   q: { quizKey: "optA.optB|attempts" }       d: { decisionKey: "optionId" }
//   n: { numericKey: "value|attempts" }        (numeric answers, value as a JS number literal)
//   x: { varKey: value }                        o: { objectBlockKey: state }
//   k: { objectBlockKey: score } completed free objects (score 0..1, 2 decimals)
//   a: assessment retakes count
//   b: { blockKey: 0|1 } block visibility overrides (show-block / hide-block)
//   p: { screenKey: step } screens left before their last step: the step reached (resumed there)
//   w: visited control keys joined by "." (buttons, tabs and disclosures the learner has used)
//
// The strings this module writes are saved by LMSs: the encoding must never change for a given state.

import { isRecord } from './json.ts';
import type { VariableValue } from './course-data.ts';

export const STATE_VERSION = 1;

export interface QuizAnswer {
  selected: string[];
  attempts: number;
}

export interface NumericAnswer {
  value: number | null;
  attempts: number;
}

// Everything saved for a learner, by element key.
export interface LearnerState {
  visited: Set<string>;
  completed: Set<string>;
  quizzes: Record<string, QuizAnswer>;
  numerics: Record<string, NumericAnswer>;
  // Chosen option id.
  decisions: Record<string, string>;
  // Values of persisted variables (null: a variable of an unknown type, in the worst case only).
  vars: Record<string, VariableValue | null>;
  // Saved states of free objects, as their getState() returned them (only their length is checked).
  objects: Record<string, unknown>;
  // Scores (0..1) of completed free objects.
  objectsDone: Record<string, number>;
  retakes: number;
  // 1: shown, 0: hidden by an event.
  visibility: Record<string, number>;
  // Step reached on screens left before their last step.
  steps: Record<string, number>;
  // Visited controls.
  visits: Set<string>;
  // The language the learner chose in a package of several languages (D59).
  language?: string;
}

// The JSON written to suspend data. Fields are added in this order: the order is part of the format.
interface EncodedState {
  v: number;
  s?: string;
  c?: string;
  q?: Record<string, string>;
  n?: Record<string, string>;
  d?: Record<string, string>;
  x?: Record<string, VariableValue | null>;
  o?: Record<string, unknown>;
  k?: Record<string, number>;
  a?: number;
  b?: Record<string, number>;
  p?: Record<string, number>;
  w?: string;
  g?: string;
}

export function emptyState(): LearnerState {
  return { visited: new Set(), completed: new Set(), quizzes: {}, numerics: {}, decisions: {}, vars: {}, objects: {}, objectsDone: {}, retakes: 0, visibility: {}, steps: {}, visits: new Set() };
}

// The fallbacks (|| [], || 0, || {}) accept states built by hand, without every field.
export function encodeState(state: LearnerState): string {
  const encoded: EncodedState = { v: STATE_VERSION };
  if (state.visited.size) encoded.s = [...state.visited].join('.');
  if (state.completed.size) encoded.c = [...state.completed].join('.');
  const quizzes: Record<string, string> = {};
  for (const [key, answer] of Object.entries(state.quizzes)) quizzes[key] = `${(answer.selected || []).join('.')}|${answer.attempts || 0}`;
  if (Object.keys(quizzes).length) encoded.q = quizzes;
  const numerics: Record<string, string> = {};
  for (const [key, answer] of Object.entries(state.numerics || {})) numerics[key] = `${answer.value ?? ''}|${answer.attempts || 0}`;
  if (Object.keys(numerics).length) encoded.n = numerics;
  if (Object.keys(state.decisions).length) encoded.d = { ...state.decisions };
  if (Object.keys(state.vars).length) encoded.x = { ...state.vars };
  if (Object.keys(state.objects).length) encoded.o = { ...state.objects };
  if (Object.keys(state.objectsDone).length) encoded.k = { ...state.objectsDone };
  if (state.retakes) encoded.a = state.retakes;
  if (Object.keys(state.visibility).length) encoded.b = { ...state.visibility };
  if (Object.keys(state.steps || {}).length) encoded.p = { ...state.steps };
  if (state.visits?.size) encoded.w = [...state.visits].join('.');
  if (state.language) encoded.g = state.language;
  return JSON.stringify(encoded);
}

// Suspend data comes from the LMS: anything that is not a v1 state starts a fresh state. Within a
// v1 state, maps are taken as they are (this module wrote them) and numbers are checked.
export function decodeState(text: string): LearnerState {
  const state = emptyState();
  if (!text) return state;
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { return state; }
  if (!isRecord(decoded) || decoded.v !== STATE_VERSION) return state;
  if (decoded.s) for (const key of String(decoded.s).split('.')) if (key) state.visited.add(key);
  if (decoded.c) for (const key of String(decoded.c).split('.')) if (key) state.completed.add(key);
  for (const [key, value] of entriesOf(decoded.q)) {
    const [selected, attempts] = String(value).split('|');
    state.quizzes[key] = { selected: selected ? selected.split('.') : [], attempts: Number(attempts) || 0 };
  }
  for (const [key, value] of entriesOf(decoded.n)) {
    const [written, attempts] = String(value).split('|');
    const number = written === '' ? null : Number(written);
    state.numerics[key] = { value: Number.isFinite(number) ? number : null, attempts: Number(attempts) || 0 };
  }
  Object.assign(state.decisions, decoded.d || {});
  Object.assign(state.vars, decoded.x || {});
  Object.assign(state.objects, decoded.o || {});
  for (const [key, value] of entriesOf(decoded.k)) state.objectsDone[key] = Number(value) || 0;
  state.retakes = Number(decoded.a) || 0;
  Object.assign(state.visibility, decoded.b || {});
  for (const [key, value] of entriesOf(decoded.p)) if (typeof value === 'number' && Number.isInteger(value) && value > 0) state.steps[key] = value;
  if (decoded.w) for (const key of String(decoded.w).split('.')) if (key) state.visits.add(key);
  if (typeof decoded.g === 'string' && /^[A-Za-z0-9-]{2,16}$/.test(decoded.g)) state.language = decoded.g;
  return state;
}

// Object.entries(value || {}): a missing field has no entries (a string field has its characters).
const entriesOf = (value: unknown): [string, unknown][] => Object.entries(value || {});

// What the compiler knows of the course (compile/state-model.ts in @elabora/core), by element key.
export interface StateModel {
  screens: string[];
  quizzes: { key: string; optionIds: string[]; maxAttempts: number }[];
  numerics: { key: string; maxAttempts: number }[];
  decisions: { key: string; longestOptionId: string }[];
  // type and maxLength as written in course.json (the course may still be invalid).
  variables: { key: string; type: string; maxLength?: number; options?: string[] }[];
  objects: { key: string; persistMax: number }[];
  toggleableBlocks: string[];
  steppedScreens: { key: string; step: number }[];
  controls: string[];
  // The languages of a package of several languages (D59).
  languages?: string[];
}

// Worst case: every screen visited and completed, every quiz answered with all options, every control visited,
// every variable at its longest value, every persisted object state at its declared maximum.
// `model` is produced by the compiler (compile/state-model.ts) from the course and the lock.
export function worstCaseState(model: StateModel): LearnerState {
  const state = emptyState();
  for (const key of model.screens) { state.visited.add(key); state.completed.add(key); }
  for (const quiz of model.quizzes) state.quizzes[quiz.key] = { selected: quiz.optionIds, attempts: quiz.maxAttempts };
  for (const numeric of model.numerics || []) state.numerics[numeric.key] = { value: -1.2345678901234567e+300, attempts: numeric.maxAttempts };
  for (const decision of model.decisions) state.decisions[decision.key] = decision.longestOptionId;
  for (const variable of model.variables) state.vars[variable.key] = worstValue(variable);
  for (const object of model.objects) {
    if (object.persistMax) state.objects[object.key] = 'x'.repeat(Math.max(0, object.persistMax - 2)); // JSON text of maxLength
    state.objectsDone[object.key] = 0.33;
  }
  for (const key of model.toggleableBlocks || []) state.visibility[key] = 1;
  for (const screen of model.steppedScreens || []) state.steps[screen.key] = screen.step;
  for (const key of model.controls || []) state.visits.add(key);
  // A package of several languages keeps the one chosen (D59): the longest code.
  if (model.languages?.length) state.language = model.languages.reduce((longest, code) => (code.length > longest.length ? code : longest), '');
  state.retakes = 99;
  return state;
}

function worstValue(variable: StateModel['variables'][number]): VariableValue | null {
  switch (variable.type) {
    case 'boolean': return false;
    case 'number': return -1.2345678901234567e+300; // longest JSON number form
    case 'choice': return (variable.options || []).reduce((longest, option) => (option.length > longest.length ? option : longest), '');
    // Quotes and backslashes are escaped by JSON: the runtime caps strings at maxLength,
    // so the worst case is every character escaped.
    case 'string': return '\\'.repeat(variable.maxLength || 0);
    default: return null;
  }
}

export function worstCaseLength(model: StateModel): number {
  return encodeState(worstCaseState(model)).length;
}
