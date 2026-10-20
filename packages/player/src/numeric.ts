// Numeric answers: parsing what learners type, and grading against a tolerance.

import type { NumericTolerance } from './course-data.ts';

// "1,385" (en) → 1385 · "1 385,5" (fr) → 1385.5 · "−2.6" → -2.6 · "7.2e2" → 720.
// The decimal separator follows the course language; when both "," and "." appear, the last one
// is the decimal separator. Spaces, apostrophes and thin spaces are digit group separators.
const COMMA_DECIMAL = /^(fr|de|es|it|pt|nl|sv|da|fi|nb|nn|no|pl|cs|sk|ru|uk|tr|ro|hu|el|bg|hr|sl|lt|lv|et)\b/i;

export function parseNumber(input: string | null | undefined, language = 'en'): number | null {
  let text = String(input ?? '').trim().replace(/[−‒–—]/g, '-').replace(/^\+/, '');
  text = text.replace(/[\s\u00a0\u202f\u2009'’_]/g, ''); // no-break, narrow no-break and thin spaces
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const grouping = /^-?\d{1,3}(,\d{3})+$/.test(text);
    const singleComma = text.indexOf(',') === lastComma;
    if (COMMA_DECIMAL.test(language) || !grouping) text = singleComma ? text.replace(',', '.') : text.replace(/,/g, '');
    else text = text.replace(/,/g, '');
  }
  if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function withinTolerance(value: number, expected: number, tolerance?: NumericTolerance | null): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(expected)) return false;
  const bounds = tolerance || {};
  const allowed = bounds.absolute !== undefined ? bounds.absolute : bounds.percent !== undefined ? Math.abs(expected) * bounds.percent / 100 : 0;
  return Math.abs(value - expected) <= allowed + 1e-9 * Math.max(1, Math.abs(expected));
}

// What grading needs of numeric block props (compiled, or as authored in tests and validation).
export interface GradedQuestion<M extends GradedMisconception> {
  answer: number;
  tolerance?: NumericTolerance | null;
  misconceptions?: readonly M[];
}

export interface GradedMisconception {
  value: number;
  tolerance?: NumericTolerance | null;
}

export interface Grade<M> {
  correct: boolean;
  misconception: M | null;
}

// { correct, misconception } for a value against numeric block props.
export function gradeNumeric<M extends GradedMisconception>(props: GradedQuestion<M>, value: number | null | undefined): Grade<M> {
  if (value === null || value === undefined) return { correct: false, misconception: null };
  if (withinTolerance(value, props.answer, props.tolerance)) return { correct: true, misconception: null };
  const misconception = (props.misconceptions || []).find((candidate) => withinTolerance(value, candidate.value, candidate.tolerance || props.tolerance));
  return { correct: false, misconception: misconception || null };
}

export function formatNumber(value: number, language = 'en', maxDecimals = 6): string {
  if (!Number.isFinite(value)) return '';
  try { return value.toLocaleString(language, { maximumFractionDigits: maxDecimals }); } catch { return String(value); }
}
