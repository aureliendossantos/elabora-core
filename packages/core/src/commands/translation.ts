import { translateUnits, translationApproval, translationExport } from '../i18n/translate.ts';
import type { TranslatedText, TranslationCounts } from '../i18n/translate.ts';
import type { TranslationApproval } from '../project/model.ts';
import { CommandError, Draft } from './context.ts';
import type { CommandContext, CommandOutput } from './context.ts';

// Translations as changes (the app's « Traduction »): a language started or brought up to date
// with the source (translations/<lang>.xlf, as `elabora translate export` writes it), texts translated,
// reviewed or cleared, and the translated plan approved by a person. Each is one step to undo.

export interface ExportTranslationArgs {
  to: string; // a BCP 47 tag: en, de, pt-BR
}

export function exportTranslation(context: CommandContext, { to }: ExportTranslationArgs): CommandOutput<{ language: string; file: string; units: number } & TranslationCounts> {
  const { file, text, units, ...counts } = refusing(() => translationExport(context.project(), { to }));
  const draft = new Draft(context.files);
  draft.writeText(file, text);
  return { files: draft.files(), result: { language: to, file, units, ...counts } };
}

// One text (unit, target, state), or several in one change (texts). A language the course does not
// have yet starts with them.
export interface TranslateUnitArgs {
  language: string;
  unit?: string; // a translation unit id (elabora translate status, the engine's translationTable)
  target?: string | null; // null or empty: not translated
  state?: 'translated' | 'reviewed' | 'final';
  texts?: TranslatedText[];
}

export function translateText(context: CommandContext, args: TranslateUnitArgs): CommandOutput<{ language: string; unit?: string; units: string[] }> {
  if ((args.unit === undefined) === (args.texts === undefined)) throw new CommandError('translate_text takes a unit and its target, or texts (several units).');
  const texts = args.texts ?? [{ unit: args.unit as string, target: args.target ?? null, ...(args.state ? { state: args.state } : {}) }];
  const { file, text, units } = refusing(() => translateUnits(context.project(), { language: args.language, texts }));
  const draft = new Draft(context.files);
  draft.writeText(file, text);
  return { files: draft.files(), result: { language: args.language, ...(args.unit !== undefined ? { unit: args.unit } : {}), units } };
}

// The translated plan approved by a person who read it (translations/<lang>.approval.json): valid
// while the translated plan, and so its source, keeps the same content.
export interface ApproveTranslationArgs {
  to: string;
  by: string; // « name, organisation »
  reference?: string;
  date?: string; // YYYY-MM-DD, today by default
}

export function approveTranslation(context: CommandContext, args: ApproveTranslationArgs): CommandOutput<{ language: string; by: string; date: string; approval: TranslationApproval }> {
  if (context.author?.kind === 'agent') throw new CommandError('Only a person approves the translated plan. Tell the author the translation is ready to review and approve; nothing was written.', [], 'E_PLAN_PERSON_ONLY');
  const { file, text, approval } = refusing(() => translationApproval(context.project(), args));
  const draft = new Draft(context.files);
  draft.writeText(file, text);
  return { files: draft.files(), result: { language: approval.language, by: approval.by, date: approval.date, approval } };
}

// The translation module throws plain errors: here they are refusals of the command.
function refusing<T>(run: () => T): T {
  try { return run(); } catch (error) { throw error instanceof CommandError ? error : new CommandError(error instanceof Error ? error.message : String(error)); }
}
