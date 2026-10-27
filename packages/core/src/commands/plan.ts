import { schemaId } from '@elabora/format';
import { validateSchema } from '@elabora/format/schemas';
import type { Course, PatchOperation, Plan, PlanNote, PlanVersion } from '../project/model.ts';
import { applyPatch } from '../util/json-patch.ts';
import { followPlanOrder, planCourse, screenCovers, type PlanOrderFollowed } from '../project/plan-order.ts';
import { planDiff, revertPlanChange as revertedPlan } from '../project/plan-diff.ts';
import {
  PLAN_NOTES_FILE, findVersion, latestValidated, latestVersion, nextVersionNumber, planContentHash, planVersionFile, versionLabel, versionNumber, versionedPlan
} from '../project/plan-versions.ts';
import { localDay } from '../util/local-day.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import { CommandError, Draft, findBlock, type CommandContext, type CommandOutput } from './context.ts';

// The contract layer (docs/decisions.md D52). plan.json is the working copy: the author and their
// agent write it at any time (write_plan, set_plan_text, set_plan_voiceover, revert_plan_change),
// and its diff shows what changed. A person freezes it as a version (create_plan_version: V1, V2…)
// and records the client's validation of one (approve_plan); exporting a version records that it was
// sent (record_plan_send) and never makes one. Agents never make nor validate a version, and never
// change a text the plan keeps « à l'identique » (verbatim): the author does.

// The author's day, not UTC's.
const today = (context: CommandContext) => localDay(context.now);

const isAgent = (context: CommandContext) => context.author?.kind === 'agent';

// A person's command: refused to an agent, with what to tell the author.
function personOnly(context: CommandContext, what: string): void {
  if (isAgent(context)) throw new CommandError(`Only a person ${what}: you write the plan (elabora_write_plan), the author ${what} in Elabora (Plan › Versions) or in a terminal. Nothing was written. Tell the author the plan is ready for it.`, [], 'E_PLAN_PERSON_ONLY');
}

// The course's screens follow the plan's items when they change order or part (D50), in the same
// change: what moved, or null.
function screensFollow(context: CommandContext, draft: Draft, before: Plan | null, after: Plan): PlanOrderFollowed | null {
  if (!before || !draft.exists('course.json')) return null;
  let course: Course;
  try { course = draft.json<Course>('course.json'); } catch { return null; }
  const followed = followPlanOrder(course, screenCovers(context.project()), before, after);
  if (followed) draft.writeJson('course.json', followed.course);
  return followed;
}
type Moved = { screens: string[]; sections: string[]; renamed: string[] };
const followedResult = (followed: PlanOrderFollowed | null): { moved?: Moved } => (followed ? { moved: { screens: followed.screens, sections: followed.sections, renamed: followed.renamed } } : {});

// The texts the plan keeps « à l'identique » that a write would change: their words, their flag, or
// the text itself gone. An agent's write that does is refused: the author decides.
function verbatimChanged(before: Plan | null, after: Plan): string[] {
  if (!before) return [];
  return planDiff(before, after).changes.filter((change) => change.verbatim).map((change) => change.id);
}

function refuseVerbatim(context: CommandContext, before: Plan | null, after: Plan): void {
  if (!isAgent(context)) return;
  const texts = verbatimChanged(before, after);
  if (!texts.length) return;
  throw new CommandError(`${texts.join(', ')} ${texts.length > 1 ? 'are' : 'is'} kept « à l'identique » (verbatim): the client wants ${texts.length > 1 ? 'their' : 'its'} words as signed, and only the author changes them. Nothing was written. Ask the author to change ${texts.length > 1 ? 'them' : 'it'} in Elabora (Plan, the text, « Déverrouiller »), or leave ${texts.length > 1 ? 'them' : 'it'} as ${texts.length > 1 ? 'they are' : 'it is'}.`, [], 'E_PLAN_VERBATIM_LOCKED');
}

// The plan checked against its schema before anything is written; a patch answers only for the
// faults it brings (those the plan already had are reported on plan.json).
function checkPlanSchema(before: Plan | null, written: Plan, patched: boolean): void {
  const known = new Set(patched && before ? validateSchema('plan', before).map((error) => `${error.path}\0${error.message}`) : []);
  const problems = validateSchema('plan', written).filter((error) => !known.has(`${error.path}\0${error.message}`));
  if (problems.length) {
    throw new CommandError(`plan.json would not match its schema, so nothing was written: ${problems.slice(0, 6).map((error) => `${error.path || '/'}: ${error.message}`).join('; ')}${problems.length > 6 ? ` (and ${problems.length - 6} more)` : ''}.`);
  }
}

// The plan written as one change: its schema checked, an agent kept off the verbatim texts, the
// screens following the items it moves.
function writeWorkingPlan(context: CommandContext, draft: Draft, before: Plan | null, next: Plan, patched: boolean): { written: Plan; followed: PlanOrderFollowed | null } {
  const written = { $schema: schemaId('plan'), ...next } as Plan & Record<string, unknown>;
  // The plan's state is its versions': a plan written as it was before D52 loses it.
  delete written.status;
  delete written.approval;
  checkPlanSchema(before, written, patched);
  refuseVerbatim(context, before, written);
  draft.writeJson('plan.json', written);
  return { written, followed: screensFollow(context, draft, before, written) };
}

const currentPlan = (draft: Draft): Plan | null => (draft.exists('plan.json') ? draft.json<Plan>('plan.json') : null);


// The whole plan, or a JSON Patch of the plan as it is: at any time, by the author or their agent.
// Items moved (a patch's move, a part changed) take their screens with them (D50).
export interface WritePlanArgs {
  plan?: Record<string, unknown>;
  patch?: PatchOperation[];
}

export interface WritePlanResult {
  plan: string;
  objectives: number;
  items: number;
  moved?: Moved;
}

export function writePlan(context: CommandContext, { plan, patch }: WritePlanArgs): CommandOutput<WritePlanResult> {
  if (!plan === !patch) throw new CommandError('Give the whole plan (plan) or a JSON Patch of it (patch), one of them.');
  const draft = new Draft(context.files);
  const current = currentPlan(draft);
  let next: unknown;
  if (patch) {
    if (!current) throw new CommandError('There is no plan.json to patch: give the whole plan.');
    try {
      next = applyPatch(structuredClone(current), patch);
    } catch (error) {
      throw new CommandError(`The patch does not apply to plan.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else next = structuredClone(plan);
  if (!isRecord(next)) throw new CommandError('A plan is a JSON object.');
  const { written, followed } = writeWorkingPlan(context, draft, current, next as Plan, !!patch);
  return { files: draft.files(), result: { plan: String(written.id), objectives: Array.isArray(written.objectives) ? written.objectives.length : 0, items: Array.isArray(written.items) ? written.items.length : 0, ...followedResult(followed) } };
}

// A validated text of the plan reworded (on the canvas: the block keeps its textRef and shows the new
// wording, since it shows the plan's): by its id, or by a block that uses it.
export interface SetPlanTextArgs {
  text?: string; // TXT-3
  block?: string; // a text, heading or callout block with textRef
  markdown: string;
}

export function setPlanText(context: CommandContext, { text, block, markdown }: SetPlanTextArgs): CommandOutput<{ text: string }> {
  let id = text;
  if (block !== undefined) {
    const place = findBlock(context.project(), block);
    const ref = isRecord(place.block.props) ? place.block.props.textRef : undefined;
    if (typeof ref !== 'string') throw new CommandError(`Block "${block}" does not show a text of the plan (textRef): edit its text with update_block.`);
    if (id !== undefined && id !== ref) throw new CommandError(`Block "${block}" shows ${ref}, not ${id}.`);
    id = ref;
  }
  if (!id) throw new CommandError('Give the text (its plan id) or a block that shows it.');
  const wording = typeof markdown === 'string' ? markdown.trim() : '';
  if (!wording) throw new CommandError('A text of the plan has words: give them (markdown).');
  const draft = new Draft(context.files);
  const current = draft.json<Plan>('plan.json');
  const next = structuredClone(current);
  const locked = objectsIn(next.items).flatMap((item) => objectsIn(item.lockedTexts)).find((candidate) => candidate.id === id);
  if (!locked) throw new CommandError(`No text ${id} in plan.json.`);
  if (locked.text === wording) return { files: context.files, result: { text: id } };
  locked.text = wording;
  writeWorkingPlan(context, draft, current, next, true);
  return { files: draft.files(), result: { text: id } };
}

// The voice-over of a plan item, line by line (items[].voiceover, D28): a screen covering the item
// takes it as its script. lines null removes it.
export interface SetPlanVoiceoverArgs {
  item: string;
  lines: { speaker?: string; text: string }[] | null;
}

export function setPlanVoiceover(context: CommandContext, { item, lines }: SetPlanVoiceoverArgs): CommandOutput<{ item: string }> {
  const draft = new Draft(context.files);
  const current = draft.json<Plan>('plan.json');
  const plan = structuredClone(current);
  const items = Array.isArray(plan.items) ? plan.items : [];
  const index = items.findIndex((candidate) => isRecord(candidate) && candidate.id === item);
  if (index < 0) throw new CommandError(`No item "${item}" in plan.json (items: ${items.map((candidate) => candidate?.id).join(', ')}).`);
  const value = lines === null ? null : lines.map((line) => {
    const text = typeof line?.text === 'string' ? line.text.replace(/\s+/g, ' ').trim() : '';
    if (!text) throw new CommandError('Every line of a voice-over has its words (text).');
    return { ...(typeof line.speaker === 'string' && line.speaker ? { speaker: line.speaker } : {}), text };
  });
  if (value && !value.length) throw new CommandError('A voice-over has at least one line (null removes it).');
  if (!value && !Array.isArray(items[index].voiceover)) throw new CommandError(`Item "${item}" has no voice-over to remove.`);
  if (value) items[index].voiceover = value;
  else delete items[index].voiceover;
  writeWorkingPlan(context, draft, current, plan, true);
  return { files: draft.files(), result: { item } };
}

// One change undone (« Revenir à la V2 »): the element as a version has it (the latest validated
// version by default, else the latest version). key: as planDiff gives it (item:ITEM-3).
export interface RevertPlanChangeArgs {
  key: string;
  version?: string | number;
}

export function revertPlanChange(context: CommandContext, { key, version }: RevertPlanChangeArgs): CommandOutput<{ key: string; version: string; moved?: Moved }> {
  const project = context.project();
  const number = version === undefined ? null : versionNumber(version);
  if (version !== undefined && number === null) throw new CommandError(`"${version}" is not a version of the plan: V1, V2…`);
  const base = number !== null ? findVersion(project, number) : latestValidated(project) ?? latestVersion(project);
  if (!base) throw new CommandError(number !== null ? `The plan has no version ${versionLabel(number)}.` : 'The plan has no version to go back to.');
  const draft = new Draft(context.files);
  const current = draft.json<Plan>('plan.json');
  if (!planDiff(base.data.plan, current, planCourse(project)).changes.some((change) => change.key === key)) throw new CommandError(`Nothing changed in ${key} since ${versionLabel(base.number)}.`);
  let next: Plan;
  try { next = revertedPlan(current, base.data.plan, key); } catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
  const { followed } = writeWorkingPlan(context, draft, current, next, true);
  return { files: draft.files(), result: { key, version: versionLabel(base.number), ...followedResult(followed) } };
}


const versionAt = (draft: Draft, number: number): PlanVersion => draft.json<PlanVersion>(planVersionFile(number));

// The notes waiting for the next version (plan-versions/notes.json).
function pendingNotes(draft: Draft): PlanNote[] {
  if (!draft.exists(PLAN_NOTES_FILE)) return [];
  const notes = draft.json<{ notes?: unknown }>(PLAN_NOTES_FILE).notes;
  return objectsIn(Array.isArray(notes) ? notes as PlanNote[] : []).filter((note) => typeof note.target === 'string' && typeof note.text === 'string');
}

function writeNotes(draft: Draft, notes: PlanNote[]): void {
  if (notes.length) draft.writeJson(PLAN_NOTES_FILE, { $schema: schemaId('plan-notes'), notes });
  else if (draft.exists(PLAN_NOTES_FILE)) draft.remove(PLAN_NOTES_FILE);
}

// A person's: the working copy frozen as the next version (V1, V2…), with an optional note, and the
// notes for the client whose change it holds (the others, on changes undone since, are dropped).
// Refused when the plan does not match its schema, or when it is the latest version as it is.
export interface CreatePlanVersionArgs {
  note?: string;
  date?: string;
}

export interface CreatePlanVersionResult {
  version: string; // V3
  number: number;
  contentHash: string;
  notes: number;
  droppedNotes: string[]; // notes on changes that are not there any more
}

export function createPlanVersion(context: CommandContext, { note, date }: CreatePlanVersionArgs = {}): CommandOutput<CreatePlanVersionResult> {
  personOnly(context, 'makes a version of the plan');
  const project = context.project();
  const draft = new Draft(context.files);
  const plan = currentPlan(draft);
  if (!plan) throw new CommandError('There is no plan.json to make a version of.');
  const problems = validateSchema('plan', plan);
  if (problems.length) throw new CommandError(`plan.json does not match its schema, so no version was made: ${problems.slice(0, 4).map((error) => `${error.path || '/'}: ${error.message}`).join('; ')}. Correct the plan first (elabora validate).`);
  const frozen = versionedPlan(plan);
  const contentHash = planContentHash(frozen);
  const latest = latestVersion(project);
  if (latest?.data.contentHash === contentHash) throw new CommandError(`The plan is ${versionLabel(latest.number)} as it is: nothing changed since, so no version was made.`);
  const number = nextVersionNumber(project);
  const keys = new Set(planDiff(latest?.data.plan ?? null, frozen, planCourse(project)).changes.map((change) => change.key));
  const waiting = pendingNotes(draft);
  const kept = waiting.filter((entry) => keys.has(entry.target));
  const words = typeof note === 'string' ? note.trim() : '';
  const version: PlanVersion = {
    $schema: schemaId('plan-version'), version: number, date: date || today(context), ...(words ? { note: words } : {}),
    contentHash, plan: frozen, ...(kept.length ? { notes: kept.map(({ target, text }) => ({ target, text })) } : {})
  };
  draft.writeJson(planVersionFile(number), version);
  writeNotes(draft, []);
  return { files: draft.files(), result: { version: versionLabel(number), number, contentHash, notes: kept.length, droppedNotes: waiting.filter((entry) => !keys.has(entry.target)).map((entry) => entry.target) } };
}

// A person's: the client validated a version (the latest by default), never the working copy. What
// the agent decided and asked while the plan was a draft goes (D51).
export interface ApprovePlanArgs {
  version?: string | number;
  by: string;
  reference?: string;
  date?: string;
}

export function approvePlan(context: CommandContext, { version, by, reference, date }: ApprovePlanArgs): CommandOutput<{ version: string; number: number }> {
  personOnly(context, 'records the validation of a version of the plan');
  const name = typeof by === 'string' ? by.trim() : '';
  if (!name) throw new CommandError('Say who validated the version (by: name and organisation).');
  const project = context.project();
  const number = version === undefined ? latestVersion(project)?.number ?? null : versionNumber(version);
  if (version !== undefined && number === null) throw new CommandError(`"${version}" is not a version of the plan: V1, V2…`);
  if (number === null) throw new CommandError('The plan has no version yet: make one first (elabora plan version, the app\'s « Créer la V1 »), send it, then validate it. A validation is of a version the client read, never of the working copy.');
  const entry = findVersion(project, number);
  if (!entry) throw new CommandError(`The plan has no version ${versionLabel(number)}${project.planVersions.length ? ` that holds together (elabora validate)` : ''}.`);
  const draft = new Draft(context.files);
  const data = versionAt(draft, number);
  if (isRecord(data.validation)) throw new CommandError(`${versionLabel(number)} is already validated, by ${data.validation.by} on ${data.validation.date}. Validating changes is validating a new version: make it (elabora plan version), send it, then validate it.`);
  const ref = typeof reference === 'string' ? reference.trim() : '';
  data.validation = { by: name, date: date || today(context), ...(ref ? { reference: ref } : {}) };
  draft.writeJson(planVersionFile(number), data);
  const plan = currentPlan(draft);
  if (plan && (plan.decided !== undefined || plan.question !== undefined)) {
    delete plan.decided;
    delete plan.question;
    draft.writeJson('plan.json', plan);
  }
  return { files: draft.files(), result: { version: versionLabel(number), number } };
}

// Exporting a version records that it was sent (its day and format); exporting never makes one.
export interface RecordPlanSendArgs {
  version: string | number;
  format: 'docx' | 'pdf' | 'html' | 'review';
  date?: string;
}

export function recordPlanSend(context: CommandContext, { version, format, date }: RecordPlanSendArgs): CommandOutput<{ version: string }> {
  const number = versionNumber(version);
  if (number === null || !findVersion(context.project(), number)) throw new CommandError(`The plan has no version ${version}.`);
  if (!['docx', 'pdf', 'html', 'review'].includes(format)) throw new CommandError(`A send is docx, pdf, html or review, not "${format}".`);
  const draft = new Draft(context.files);
  const data = versionAt(draft, number);
  data.sends = [...objectsIn(data.sends), { date: date || today(context), format }];
  draft.writeJson(planVersionFile(number), data);
  return { files: draft.files(), result: { version: versionLabel(number) } };
}

// A note for the client on a change not in a version yet (target: its key in the diff since the
// latest version); text null removes it.
export interface SetPlanNoteArgs {
  target: string;
  text: string | null;
}

export function setPlanNote(context: CommandContext, { target, text }: SetPlanNoteArgs): CommandOutput<{ target: string; notes: number }> {
  const project = context.project();
  const latest = latestVersion(project);
  const draft = new Draft(context.files);
  const notes = pendingNotes(draft).filter((entry) => entry.target !== target);
  const words = typeof text === 'string' ? text.trim() : '';
  if (text !== null && !words) throw new CommandError('A note has words (text); null removes it.');
  if (words) {
    if (!project.plan) throw new CommandError('There is no plan.json.');
    const keys = planDiff(latest?.data.plan ?? null, project.plan, planCourse(project)).changes.map((change) => change.key);
    if (!keys.includes(target)) throw new CommandError(`No change ${target} since ${latest ? versionLabel(latest.number) : 'the plan began'}: a note explains a change that is in no version yet (${keys.slice(0, 8).join(', ') || 'there is none'}${keys.length > 8 ? '…' : ''}).`);
    notes.push({ target, text: words });
  } else if (notes.length === pendingNotes(draft).length) throw new CommandError(`No note on ${target}.`);
  writeNotes(draft, notes);
  return { files: draft.files(), result: { target, notes: notes.length } };
}
