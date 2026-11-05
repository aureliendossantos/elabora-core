import { translateUnits, translationApproval, translationApprovalAsk, translationExport } from '../i18n/translate.ts';
import type { TranslatedText, TranslationApprovalAsk, TranslationCounts } from '../i18n/translate.ts';
import type { TranslationApproval } from '../project/model.ts';
import { CommandError, Draft } from './context.ts';
import type { CommandContext, CommandOutput } from './context.ts';

// Translations as changes (the app's « Traduction »): a language started or brought up to date
// with the source (translations/<lang>.xlf, as `elabora translate export` writes it), texts translated,
// reviewed or cleared, and the translated plan approved by the author (or by their agent on their yes). Each is one step to undo.

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

// The translated plan approved by the person who read it (translations/<lang>.approval.json): valid
// while the translated plan, and so its source, keeps the same content. A person records it; an agent
// asks the author first (D70), as before a paid generation: its call without authorApproved writes
// nothing and says what to ask, and with the author's yes (authorApproved: the translated plan's
// contentHash it was told) it records their approval, with its own name beside theirs.
export interface ApproveTranslationArgs {
  to: string;
  by?: string; // « name, organisation »; an agent's call may leave it out: the author's name as their approvals show it
  reference?: string;
  date?: string; // YYYY-MM-DD, today by default
  authorApproved?: string; // an agent's: the contentHash of the translated plan the author said yes to
}

export function approveTranslation(context: CommandContext, args: ApproveTranslationArgs): CommandOutput<{ language: string; by: string; date: string; approval: TranslationApproval }> {
  const agent = context.author?.kind === 'agent' ? (context.author.name || 'agent') : undefined;
  const by = agent ? agentsApprover(context, args) : (args.by ?? '');
  const { file, text, approval } = refusing(() => translationApproval(context.project(), { to: args.to, by, ...(args.reference ? { reference: args.reference } : {}), ...(args.date ? { date: args.date } : {}), ...(agent ? { agent } : {}) }));
  const draft = new Draft(context.files);
  draft.writeText(file, text);
  return { files: draft.files(), result: { language: approval.language, by: approval.by, date: approval.date, approval } };
}

// An agent records the author's approval only with their yes to this very plan, translated through.
function agentsApprover(context: CommandContext, args: ApproveTranslationArgs): string {
  const ask = refusing(() => translationApprovalAsk(context.project(), { to: args.to }));
  const by = args.by?.trim() || ask.by;
  if (args.authorApproved !== ask.contentHash) throw new CommandError(askAuthor(ask, args.authorApproved !== undefined), [], 'E_TRANSLATION_ASK_AUTHOR');
  if (ask.texts.toTranslate || ask.texts.stale) throw new CommandError(`${ask.texts.toTranslate + ask.texts.stale} text(s) of the plan are not translated into ${ask.language} yet (elabora_translation_table with todo): translate them, then ask the author again. Nothing was written.`);
  if (!by) throw new CommandError('Ask the author the name their approval shows (« Aurélien Martin », or with an organisation), then approve again with by. Nothing was written.', [], 'E_TRANSLATION_ASK_AUTHOR');
  return by;
}

// What the agent asks the author, in English for it to say in the author's language.
export function askAuthor(ask: TranslationApprovalAsk, changed = false): string {
  const { texts } = ask;
  const left = texts.toTranslate + texts.stale;
  const state = left ? `${left} of its ${texts.units} texts not translated yet: translate them first` : `all ${texts.units} of its texts translated`;
  const name = ask.by ? `, as « ${ask.by} »` : '';
  return `${changed ? `The ${ask.language} plan changed since the author said yes, or this is not the plan they were asked about. ` : ''}Ask the author first: do they approve the ${ask.language} translation of the plan « ${ask.plan.title} » (${ask.plan.items} items; ${state})${name}?${ask.by ? '' : ' Ask also the name their approval shows (theirs, perhaps with an organisation).'} It is recorded as their approval, made through you, and ⌘Z or elabora undo takes it back. Nothing was written. With their yes, approve again with authorApproved: "${ask.contentHash}"${ask.by ? '' : ' and by'} (elabora translate approve --to ${ask.language} --author-approved ${ask.contentHash}${ask.by ? '' : ' --by "<name>"'}).`;
}

// The translation module throws plain errors: here they are refusals of the command.
function refusing<T>(run: () => T): T {
  try { return run(); } catch (error) { throw error instanceof CommandError ? error : new CommandError(error instanceof Error ? error.message : String(error)); }
}
