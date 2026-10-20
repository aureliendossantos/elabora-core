import { CommandError, Draft } from './context.ts';
import type { CommandContext, CommandOutput } from './context.ts';

// The import report the author settles (docs/decisions.md D47), in the app: decisions accepted as the
// import made them (accept: their places in decisions[], marked accepted), or the report closed for
// good (close: import-report.json deleted). Each is one journaled change, which undo reverts; making a
// choice otherwise is importing again (@elabora/node/import, importCourse with replace and choices).

export const IMPORT_REPORT = 'import-report.json';

export interface SettleImportReportArgs {
  accept?: number[];
  close?: boolean;
}

export function settleImportReport(context: CommandContext, { accept = [], close = false }: SettleImportReportArgs): CommandOutput<{ closed: boolean; accepted: number[] }> {
  const draft = new Draft(context.files);
  if (!draft.exists(IMPORT_REPORT)) throw new CommandError(`The course has no ${IMPORT_REPORT}: there is no import report to settle.`, [], 'E_NO_IMPORT_REPORT');
  if (close) {
    draft.remove(IMPORT_REPORT);
    return { files: draft.files(), result: { closed: true, accepted: [] } };
  }
  if (!accept.length) throw new CommandError('Say which decisions are accepted (accept: their places in decisions[]), or close the report.');
  const report = draft.json<{ decisions?: { accepted?: boolean }[] }>(IMPORT_REPORT);
  const decisions = Array.isArray(report.decisions) ? report.decisions : [];
  for (const index of accept) {
    if (!Number.isInteger(index) || !decisions[index] || typeof decisions[index] !== 'object') throw new CommandError(`${IMPORT_REPORT} has no decision ${index} (it has ${decisions.length}).`);
    decisions[index].accepted = true;
  }
  draft.writeText(IMPORT_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  return { files: draft.files(), result: { closed: false, accepted: [...new Set(accept)].sort((a, b) => a - b) } };
}
