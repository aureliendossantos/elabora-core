import { findingKey } from '../diagnostics/index.ts';
import { pointer } from '../util/json.ts';
import { resolveBlockProps, screenBlocks, planRefs } from '../project/load.ts';
import { latestValidated, planContentHash, planState, versionLabel } from '../project/plan-versions.ts';
import { planDiff } from '../project/plan-diff.ts';
import { planCourse } from '../project/plan-order.ts';
import type { PlanRef } from '../project/load.ts';
import { instanceBehavior } from '../components/registry.ts';
import type { CourseCheckContext, ScreenFile } from './context.ts';
import { list, byId, hasId, fieldsOf } from './guards.ts';

const VAGUE_VERBS = /^\s*(comprendre|connaître|connaitre|savoir|être sensibilisé|etre sensibilise|découvrir|decouvrir|appréhender|apprehender|understand|know|learn about|be aware|become familiar|appreciate|discover)\b/i;
const NEUROMYTHS = /(styles? d['’]apprentissage|learning styles?|visuel, auditif,? (et )?kinesth|\bVAK\b|cerveau (gauche|droit)|left[- ]brain|right[- ]brain|pyramide de l['’]apprentissage|learning pyramid|on retient 10 ?%)/i;

// Contract layer: the plan is the client's storyboard, validated as a version (D52). Screens
// implement the working copy; nothing is added or dropped silently (guardrails A1 and A5).

// The plan itself, and what all screens together make of it: coverage, locked texts and
// questions used, objectives practised.
export function checkPlan(ctx: CourseCheckContext): void {
  const { project, reporter, planIndex, options } = ctx;
  const plan = project.plan;
  if (!plan) return;

  // The plan's state is its versions': a release needs a validated one, and what changed since is
  // said (the proof dossier lists it), never refused.
  const state = planState(project);
  if (state === 'draft') {
    if (options.release) reporter.emit('E_PLAN_NOT_APPROVED', { file: 'plan.json', message: 'Release builds need a version of the plan the client validated: the plan has none.' });
    else reporter.emit('W_PLAN_DRAFT', { file: 'plan.json', message: project.planVersions.length ? 'No version of the plan is validated yet.' : 'The plan has no version yet, so none is validated.' });
  } else if (state === 'modified') {
    const validated = latestValidated(project)!;
    const diff = planDiff(validated.data.plan, plan, planCourse(project));
    reporter.emit('W_PLAN_MODIFIED_SINCE_VALIDATION', {
      file: 'plan.json', measured: planContentHash(plan), limit: validated.data.contentHash,
      message: `The plan changed since ${versionLabel(validated.number)}, validated by ${validated.data.validation?.by} on ${validated.data.validation?.date}: ${diff.changes.length} change(s) (elabora plan diff).`,
      details: { version: versionLabel(validated.number), changes: diff.changes.length }
    });
    for (const change of diff.changes.filter((candidate) => candidate.verbatim)) {
      reporter.emit('W_PLAN_VERBATIM_CHANGED', { file: 'plan.json', target: change.id, message: `${change.id}, kept « à l'identique » in ${versionLabel(validated.number)}, ${change.status === 'removed' ? 'was removed' : 'changed'} since its validation.` });
    }
  }

  const seen = new Map<string, string>();
  const claim = (id: string, path: string) => {
    if (seen.has(id)) reporter.emit('E_DUPLICATE_ID', { file: 'plan.json', path, target: id, message: `Plan id "${id}" is used twice (first at ${seen.get(id)}).` });
    else seen.set(id, path);
  };
  const objectives = list(plan.objectives);
  const items = list(plan.items);
  objectives.forEach((objective, i) => { if (objective != null) claim(objective.id, pointer('objectives', i, 'id')); });
  list(plan.sources).forEach((source, i) => { if (source != null) claim(source.id, pointer('sources', i, 'id')); });
  items.forEach((item, i) => {
    if (item == null) return;
    claim(item.id, pointer('items', i, 'id'));
    list(item.lockedTexts).forEach((locked, j) => { if (locked != null) claim(locked.id, pointer('items', i, 'lockedTexts', j, 'id')); });
    list(item.questions).forEach((question, j) => { if (question != null) claim(question.id, pointer('items', i, 'questions', j, 'id')); });
  });

  const unknownReference = (path: string, id: string, kind: string) => reporter.emit('E_PLAN_REFERENCE', { file: 'plan.json', path, target: id, message: `Unknown ${kind} "${id}".` });
  objectives.forEach((objective, i) => {
    if (objective == null) return;
    list(objective.sources).forEach((source, j) => { if (!planIndex.sources.has(source)) unknownReference(pointer('objectives', i, 'sources', j), source, 'source'); });
    if (VAGUE_VERBS.test(objective.statement || '')) reporter.emit('W_OBJECTIVE_VAGUE', { file: 'plan.json', path: pointer('objectives', i, 'statement'), target: objective.id, message: `Objective ${objective.id} starts with a non-observable verb: "${objective.statement.slice(0, 60)}".` });
    if (!objective.sources?.length && (plan.sources || []).length) reporter.emit('I_PLAN_SOURCE_UNCITED', { file: 'plan.json', path: pointer('objectives', i), target: objective.id });
  });
  const usedObjectives = new Set<string>();
  items.forEach((item, i) => {
    if (item == null) return;
    list(item.objectives).forEach((objective, j) => { usedObjectives.add(objective); if (!planIndex.objectives.has(objective)) unknownReference(pointer('items', i, 'objectives', j), objective, 'objective'); });
    list(item.sources).forEach((source, j) => { if (!planIndex.sources.has(source)) unknownReference(pointer('items', i, 'sources', j), source, 'source'); });
    if (!(item.objectives || []).length && !['intro', 'summary'].includes(item.kind)) {
      reporter.emit('E_PLAN_REFERENCE', { file: 'plan.json', path: pointer('items', i, 'objectives'), target: item.id, message: `Item ${item.id} (${item.kind}) serves no objective; only intro and summary items may.` });
    }
    list(item.questions).forEach((question, j) => list(question?.objectives).forEach((objective, k) => { usedObjectives.add(objective); if (!planIndex.objectives.has(objective)) unknownReference(pointer('items', i, 'questions', j, 'objectives', k), objective, 'objective'); }));
  });
  objectives.forEach((objective, i) => {
    if (objective == null) return;
    if (!usedObjectives.has(objective.id)) reporter.emit('E_PLAN_OBJECTIVE_UNUSED', { file: 'plan.json', path: pointer('objectives', i), target: objective.id, message: `Objective ${objective.id} is not served by any plan item.` });
  });
  const duration = plan.duration;
  if (duration && typeof duration.min === 'number' && typeof duration.max === 'number' && duration.min > duration.max) {
    reporter.emit('E_SCHEMA', { file: 'plan.json', path: '/duration', message: `plan.json duration: min (${duration.min} minutes) is above max (${duration.max}).` });
  }
  // What the agent decided and asks while the plan is a draft (D51) names items of this plan.
  list(plan.decided).forEach((decision, i) => list(decision?.items).forEach((item, j) => { if (!planIndex.items.has(item)) unknownReference(pointer('decided', i, 'items', j), item, 'plan item'); }));
  list(plan.question?.items).forEach((item, j) => { if (!planIndex.items.has(item)) unknownReference(pointer('question', 'items', j), item, 'plan item'); });
  if (!plan.spacing?.length) reporter.emit('W_SPACING_MISSING', { file: 'plan.json', path: '/spacing' });
  if (!plan.businessGoal) reporter.emit('W_BUSINESS_GOAL_MISSING', { file: 'plan.json', path: '/businessGoal' });

  // Screens ↔ plan items coverage (unknown items: checkScreenPlan).
  const covered = new Set<string>();
  for (const { data } of ctx.screens.values()) for (const itemId of list(data.covers)) if (planIndex.items.has(itemId)) covered.add(itemId);
  items.forEach((item, i) => {
    if (item == null) return;
    if (!covered.has(item.id)) reporter.emit('E_PLAN_ITEM_UNCOVERED', { file: 'plan.json', path: pointer('items', i), target: item.id, message: `Plan item ${item.id} "${item.title}" is not covered by any screen.` });
  });

  // Locked texts and validated questions must be used (where: checkScreenPlan).
  const usedTexts = new Set<string>();
  const usedQuestions = new Set<string>();
  for (const screen of ctx.screens.values()) {
    for (const { reference } of screenPlanReferences(screen)) {
      if (!reference) continue;
      if (reference.kind === 'textRef') { if (planIndex.texts.has(reference.id)) usedTexts.add(reference.id); }
      else if (planIndex.questions.has(reference.id)) usedQuestions.add(reference.id);
    }
  }
  items.forEach((item, i) => {
    if (item == null) return;
    list(item.lockedTexts).forEach((locked, j) => { if (locked != null && !usedTexts.has(locked.id)) reporter.emit('E_LOCKED_TEXT_NOT_USED', { file: 'plan.json', path: pointer('items', i, 'lockedTexts', j), target: locked.id, message: `Locked text ${locked.id} of ${item.id} does not appear in any block (textRef).` }); });
    list(item.questions).forEach((question, j) => { if (question != null && !usedQuestions.has(question.id)) reporter.emit('E_PLAN_QUESTION_NOT_USED', { file: 'plan.json', path: pointer('items', i, 'questions', j), target: question.id, message: `Validated question ${question.id} of ${item.id} is not used by any quiz or numeric block (questionRef).` }); });
  });

  // Every objective should be practised or assessed (A2, presence only).
  const practised = new Set<unknown>();
  for (const { block } of ctx.blocks.values()) {
    const props = resolveBlockProps(block, planIndex, ctx.registry);
    const behavior = instanceBehavior(ctx.registry, block);
    if ((behavior === 'quiz' || behavior === 'numeric' || behavior === 'fill-in' || behavior === 'sort' || behavior === 'decision') && props.objective) practised.add(props.objective);
    if (behavior === 'predict' && fieldsOf(props.predict).objective) practised.add(fieldsOf(props.predict).objective);
    // A dialogue practises its objective, and those of its decisions and options (D61).
    if (behavior === 'dialogue') for (const value of [props.objective, ...list(props.nodes).flatMap((node) => [fieldsOf(node).objective, ...list(fieldsOf(node).options).map((option) => fieldsOf(option).objective)])]) if (typeof value === 'string') practised.add(value);
    if ((behavior === 'quiz' || behavior === 'numeric') && props.questionRef) for (const objective of list(byId(planIndex.questions, props.questionRef)?.objectives)) practised.add(objective);
    if (behavior === 'object') for (const objective of list(byId(project.objects, props.object)?.manifest?.planRefs?.objectives)) practised.add(objective);
  }
  objectives.forEach((objective, i) => {
    if (objective == null) return;
    if (usedObjectives.has(objective.id) && !practised.has(objective.id)) reporter.emit('W_OBJECTIVE_NOT_PRACTISED', { file: 'plan.json', path: pointer('objectives', i), target: objective.id, message: `Objective ${objective.id} has no quiz, decision or free object linked to it.` });
  });

  // Unsupported claims (E7), in the plan here, in each screen in checkScreenPlan.
  reportNeuromyth(ctx, JSON.stringify(plan), 'plan.json', plan.id);
}

// What a screen does with the plan: the items it covers, the locked texts and questions it uses
// (on a screen covering their item), the objectives its blocks measure, its claims.
export function checkScreenPlan(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { reporter, planIndex } = ctx;
  if (!ctx.project.plan) return;
  const { id, file, data } = screen;
  const covers = list(data.covers);
  covers.forEach((itemId, i) => {
    if (!planIndex.items.has(itemId)) reporter.emit('E_PLAN_REFERENCE', { file, path: pointer('covers', i), target: itemId, message: `Screen "${id}" covers unknown plan item "${itemId}".` });
  });

  // Locked texts and validated questions can appear anywhere in props (component props take
  // { "textRef": … }) and in layout props.
  const covered = new Set(covers);
  for (const { owner, reference, props, path } of screenPlanReferences(screen)) {
    if (reference) {
      if (reference.kind === 'textRef') {
        const locked = planIndex.texts.get(reference.id);
        if (!locked) reporter.emit('E_PLAN_REFERENCE', { file, path: reference.path, target: owner, message: `"${owner}" references unknown locked text "${reference.id}".` });
        else if (!covered.has(locked.item)) reporter.emit('E_LOCKED_TEXT_OUTSIDE_ITEM', { file, path: reference.path, target: owner, message: `Locked text ${reference.id} belongs to ${locked.item}, which screen "${id}" does not cover.` });
      } else {
        const question = planIndex.questions.get(reference.id);
        if (!question) reporter.emit('E_PLAN_REFERENCE', { file, path: reference.path, target: owner, message: `"${owner}" references unknown plan question "${reference.id}".` });
        else if (!covered.has(question.item)) reporter.emit('E_LOCKED_TEXT_OUTSIDE_ITEM', { file, path: reference.path, target: owner, message: `Question ${reference.id} belongs to ${question.item}, which screen "${id}" does not cover.` });
      }
    } else if (props?.objective && !hasId(planIndex.objectives, props.objective)) {
      reporter.emit('E_PLAN_REFERENCE', { file, path: `${path}/props/objective`, target: owner, message: `Block "${owner}" measures unknown objective "${props.objective}".` });
    }
  }
  // Each block on its own, then the rest of the screen (its title, its narration…): a myth named in
  // one block and ignored there does not hide another one, and moving a block changes no key.
  for (const { block, path } of screenBlocks(data, file)) if (block) reportNeuromyth(ctx, JSON.stringify(block.props ?? {}), file, block.id, true, `${path}/props`);
  const { blocks: _blocks, layers: _layers, ...rest } = data as typeof data & { layers?: unknown };
  reportNeuromyth(ctx, JSON.stringify(rest), file, id, true);
}

// Plan references of a screen in document order: those of the layout props, then for each block
// its references and, after them, the block itself (props: for the objective it measures).
function* screenPlanReferences({ id, file, data }: ScreenFile): Generator<{ owner: string | undefined; reference: PlanRef | null; props?: Record<string, unknown>; path?: string }> {
  if (data.layoutProps) for (const reference of planRefs(data.layoutProps, '/layoutProps')) yield { owner: id, reference };
  for (const { block, path } of screenBlocks(data, file)) {
    const props = block?.props || {};
    for (const reference of planRefs(props, `${path}/props`)) yield { owner: block?.id, reference };
    yield { owner: block?.id, reference: null, props, path };
  }
}

// On a screen the author may ignore it (D31: a myth named to be refuted), keyed by the text of the
// block (or of the rest of the screen) that names it; in the plan it is the client's (a waiver).
function reportNeuromyth(ctx: CourseCheckContext, json: string, file: string, target: string, ignorable = false, path = ''): void {
  const match = NEUROMYTHS.exec(json || '');
  if (match) ctx.reporter.emit('W_NEUROMYTH', { file, path, target, ...(ignorable ? { key: findingKey(`${target}/${match[0].toLowerCase()}`, json) } : {}), message: `"${match[0]}" found. ${target ? `(${target})` : ''}`.trim() });
}
