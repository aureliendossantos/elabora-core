import type { Project } from '../project/model.ts';
import { translationTable } from '../i18n/translate.ts';
import { isRecord } from '../util/values.ts';
import { findBlock } from './context.ts';

// What a change expects to find when it is written: the values its author read before deciding it (an
// AI's answer written into an empty field, for the text it was asked about). The engine checks them in
// its write queue, under the project lock, just before the command: a value changed meanwhile (the
// author typed in the field, the image was replaced, the source text was edited) refuses the change,
// and nothing is written.
export type Expectation =
  // Each prop of the block holds this value; null: the prop is empty (absent, null or blank text).
  | { block: string; props: Record<string, unknown> }
  // The translation unit in this language: its source text, and its target (null: not translated yet).
  | { translation: string; unit: string; source?: string; target?: string | null };

// The first expectation the project no longer meets, said in a sentence; null when all hold.
export function unmetExpectation(project: Project, expectations: readonly Expectation[]): string | null {
  const tables = new Map<string, ReturnType<typeof translationTable>>();
  for (const expectation of expectations) {
    if ('block' in expectation) {
      let props: Record<string, unknown>;
      try {
        const found = findBlock(project, expectation.block).block.props;
        props = isRecord(found) ? found : {};
      } catch { return `Block "${expectation.block}" is gone`; }
      for (const [key, expected] of Object.entries(expectation.props)) {
        if (!same(props[key], expected)) return `Block "${expectation.block}": ${key} changed meanwhile`;
      }
    } else {
      let table = tables.get(expectation.translation);
      if (!table) { table = translationTable(project, expectation.translation); tables.set(expectation.translation, table); }
      const row = table.rows.find((candidate) => candidate.id === expectation.unit);
      if (!row) return `Translation unit "${expectation.unit}" is gone`;
      if (expectation.source !== undefined && row.source !== expectation.source) return `The source of "${expectation.unit}" changed meanwhile`;
      if (expectation.target !== undefined && !same(row.target, expectation.target)) return `The ${expectation.translation} text of "${expectation.unit}" changed meanwhile`;
    }
  }
  return null;
}

const empty = (value: unknown): boolean => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
function same(value: unknown, expected: unknown): boolean {
  if (expected === null) return empty(value);
  return JSON.stringify(value) === JSON.stringify(expected);
}
