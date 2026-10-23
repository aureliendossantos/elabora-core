// Course state: learner progress, events (trigger → conditions → actions), completion, scoring and
// the SCORM 1.2 status machine. No DOM here: the player wires it to the page.

import { emptyState, encodeState, decodeState } from './state-codec.ts';
import type { NumericAnswer, QuizAnswer } from './state-codec.ts';
import { gradeNumeric } from './numeric.ts';
import { fieldOf } from './json.ts';
import type {
  Action, ActivityBlock, Behavior, BlockByBehavior, BlockData, Condition, CourseData, DecisionBlock, DecisionOption, LayerData, Misconception,
  NumericBlock, ObjectBlock, PredictBlock, QuizBlock, ScreenData, Trigger, TriggerType, VariableData, VariableValue
} from './course-data.ts';

// The reported lesson status never goes down. Statuses the LMS may return that are not here rank as
// nothing: they compare neither above nor below.
const RANK: Readonly<Record<string, number | undefined>> = { 'not attempted': 0, browsed: 0, incomplete: 1, failed: 2, completed: 3, passed: 3 };
const rank = (status: string): number => RANK[status] ?? NaN;

// Activities are recognised by their behaviour: a fork of the quiz block scores like a quiz. The
// compiler gives every activity its behaviour; built-in types stand for it in hand-written data.
const BUILTIN_BEHAVIOR: Readonly<Record<string, Behavior | undefined>> = { quiz: 'quiz', numeric: 'numeric', decision: 'decision', 'free-object': 'object', results: 'results' };
export const behaviorOf = (block: BlockData): Behavior | null => block.behavior || BUILTIN_BEHAVIOR[block.type] || null;
export function hasBehavior<K extends Behavior>(block: BlockData, behavior: K): block is BlockByBehavior[K] {
  return behaviorOf(block) === behavior;
}
const ACTIVITIES = new Set<Behavior | null>(['quiz', 'numeric', 'decision', 'object', 'predict']);
export const isActivity = (block: BlockData): block is ActivityBlock => ACTIVITIES.has(behaviorOf(block));

// Blocks of a list and the blocks placed in their slots, depth first.
export function flatBlocks(blocks: readonly BlockData[] | undefined, out: BlockData[] = []): BlockData[] {
  for (const block of blocks || []) { out.push(block); if (block.blocks) flatBlocks(block.blocks, out); }
  return out;
}

// What changed, for onChange.
export type ChangeKind = 'variable' | 'quiz' | 'numeric' | 'decision' | 'object' | 'object-state' | 'visibility' | 'visited' | 'step' | 'completion' | 'visit' | 'retake';

export interface CourseStateOptions {
  // cmi.suspend_data saved by the previous sessions.
  suspendData?: string;
  // cmi.core.lesson_status, as the LMS returned it.
  initialStatus?: string;
  onChange?: (change: ChangeKind) => void;
}

// What the course state reads of the course.
export type CourseStateInput = Pick<CourseData, 'screens' | 'variables' | 'completion'>;

// Where a block sits: its screen, and its layer when it is in one.
export interface BlockPlace {
  block: BlockData;
  screen: ScreenData;
  layer: LayerData | null;
}

export interface QuizResult {
  correct: boolean;
  final: boolean;
  attemptsLeft: number;
}

export interface NumericResult extends QuizResult {
  misconception: Misconception | null;
}

export interface Score {
  // Percentage, or null when nothing is scored.
  raw: number | null;
  // Every scored activity is done.
  decided: boolean;
  items: number;
}

export type TargetStatus = 'passed' | 'incomplete' | 'failed' | 'completed';

// What happened, for the triggers that filter on it (target, control name, result, option, payload).
export interface TriggerInfo {
  target?: string;
  name?: string;
  correct?: boolean;
  option?: string;
  payload?: unknown;
  variable?: string;
  // timeline.reached: the event whose moment playback crossed (the compiler resolved its anchor);
  // or, from older course data, the line crossed and whether its start or its end.
  event?: string;
  line?: string;
  edge?: 'start' | 'end';
}

export interface EventRun {
  event: string;
  actions: Action[];
}

export type CourseState = ReturnType<typeof createCourseState>;

export function createCourseState(course: CourseStateInput, { suspendData = '', initialStatus = 'not attempted', onChange }: CourseStateOptions = {}) {
  const learner = suspendData ? decodeState(suspendData) : emptyState();
  const screens = course.screens;
  const screenIndex = new Map(screens.map((screen, index) => [screen.id, index]));
  const blockIndex = new Map<string, BlockPlace>();
  for (const screen of screens) {
    for (const block of flatBlocks(screen.blocks)) blockIndex.set(block.id, { block, screen, layer: null });
    for (const layer of screen.layers || []) for (const block of flatBlocks(layer.blocks)) blockIndex.set(block.id, { block, screen, layer });
  }
  const variables = new Map<string, { definition: VariableData; value: VariableValue | null }>();
  for (const definition of course.variables || []) {
    const saved = definition.key && definition.key in learner.vars ? learner.vars[definition.key] : undefined;
    variables.set(definition.id, { definition, value: saved !== undefined ? saved : definition.default });
  }
  let lmsStatus = initialStatus || 'not attempted';

  const changed = (change: ChangeKind) => onChange?.(change);

  // ── variables ──
  function getVar(id: string): VariableValue | null | undefined { return variables.get(id)?.value; }
  function setVar(id: string, value: VariableValue): boolean {
    const variable = variables.get(id);
    if (!variable) return false;
    let next = value;
    const definition = variable.definition;
    if (definition.type === 'number') {
      next = Number(next);
      if (!Number.isFinite(next)) return false;
      if (definition.minimum !== undefined) next = Math.max(definition.minimum, next);
      if (definition.maximum !== undefined) next = Math.min(definition.maximum, next);
    } else if (definition.type === 'boolean') next = !!next;
    else if (definition.type === 'string') next = String(next).slice(0, definition.maxLength || 0);
    else if (definition.type === 'choice' && !(definition.options || []).some((option) => option === next)) return false;
    if (variable.value === next) return false;
    variable.value = next;
    if (definition.key) learner.vars[definition.key] = next;
    changed('variable');
    return true;
  }
  // The sum keeps JavaScript semantics whatever the variable type (the validator checks it is a number).
  function incrementVar(id: string, by: number): boolean {
    return setVar(id, ((getVar(id) || 0) as number) + by);
  }

  // ── items (quizzes, decisions, objects) ──
  const quizState = (block: QuizBlock): QuizAnswer | null => learner.quizzes[block.key] || null;
  function quizIsCorrect(block: QuizBlock, selected: readonly string[]): boolean {
    const correct = block.props.options.filter((option) => option.correct).map((option) => option.id).sort();
    const chosen = [...selected].sort();
    return correct.length === chosen.length && correct.every((id, index) => id === chosen[index]);
  }
  function quizFinal(block: QuizBlock): boolean {
    const answer = quizState(block);
    if (!answer) return false;
    return quizIsCorrect(block, answer.selected) || answer.attempts >= (block.props.attempts || 1);
  }
  function answerQuiz(blockId: string, selected: readonly string[]): QuizResult | null {
    const block = blockIndex.get(blockId)?.block;
    if (!block || !hasBehavior(block, 'quiz') || quizFinal(block)) return null;
    const previous = quizState(block) || { selected: [], attempts: 0 };
    const answer = { selected: [...selected], attempts: previous.attempts + 1 };
    learner.quizzes[block.key] = answer;
    const correct = quizIsCorrect(block, answer.selected);
    const final = correct || answer.attempts >= (block.props.attempts || 1);
    changed('quiz');
    return { correct, final, attemptsLeft: (block.props.attempts || 1) - answer.attempts };
  }
  const numericState = (block: NumericBlock): NumericAnswer | null => learner.numerics[block.key] || null;
  function numericFinal(block: NumericBlock): boolean {
    const answer = numericState(block);
    if (!answer) return false;
    return gradeNumeric(block.props, answer.value).correct || answer.attempts >= (block.props.attempts || 1);
  }
  // value: parsed number (the player parses what the learner typed with the course language).
  function answerNumeric(blockId: string, value: number): NumericResult | null {
    const block = blockIndex.get(blockId)?.block;
    if (!block || !hasBehavior(block, 'numeric') || numericFinal(block) || !Number.isFinite(value)) return null;
    const previous = numericState(block) || { value: null, attempts: 0 };
    const answer = { value, attempts: previous.attempts + 1 };
    learner.numerics[block.key] = answer;
    const grade = gradeNumeric(block.props, value);
    const final = grade.correct || answer.attempts >= (block.props.attempts || 1);
    changed('numeric');
    return { correct: grade.correct, misconception: grade.misconception, final, attemptsLeft: (block.props.attempts || 1) - answer.attempts };
  }
  // A trend in predict mode (D60): the learner's guess at the last point, kept like a numeric answer;
  // close when within the tolerance of the real value.
  const predictState = (block: PredictBlock): number | null => learner.numerics[block.key]?.value ?? null;
  const predictActual = (block: PredictBlock): number => block.props.points?.at(-1)?.y ?? 0;
  const predictClose = (block: PredictBlock, guess: number): boolean => Math.abs(guess - predictActual(block)) <= block.props.predict.tolerance + 1e-9;
  function answerPredict(blockId: string, guess: number): { close: boolean; actual: number } | null {
    const block = blockIndex.get(blockId)?.block;
    if (!block || !hasBehavior(block, 'predict') || predictState(block) !== null || !Number.isFinite(guess)) return null;
    learner.numerics[block.key] = { value: guess, attempts: 1 };
    changed('numeric');
    return { close: predictClose(block, guess), actual: predictActual(block) };
  }
  function chooseDecision(blockId: string, optionId: string): { option: DecisionOption | undefined } | null {
    const block = blockIndex.get(blockId)?.block;
    if (!block || !hasBehavior(block, 'decision')) return null;
    if (learner.decisions[block.key] && !block.props.allowChange) return null;
    if (!block.props.options.some((option) => option.id === optionId)) return null;
    learner.decisions[block.key] = optionId;
    changed('decision');
    return { option: block.props.options.find((option) => option.id === optionId) };
  }
  // score: what the object reported (0..1, rounded to 2 decimals); anything else counts as 1.
  function completeObject(blockId: string, score?: unknown): void {
    const block = blockIndex.get(blockId)?.block;
    if (!block || !hasBehavior(block, 'object')) return;
    const value = typeof score === 'number' && Number.isFinite(score) ? Math.round(Math.max(0, Math.min(1, score)) * 100) / 100 : 1;
    if (learner.objectsDone[block.key] === value) return;
    learner.objectsDone[block.key] = value;
    changed('object');
  }
  // state: what the object's getState() returned; saved when its JSON fits in maxLength.
  function saveObjectState(blockId: string, state: unknown, maxLength: number): boolean {
    const block = blockIndex.get(blockId)?.block;
    if (!block || !hasBehavior(block, 'object') || !maxLength) return false;
    const json = JSON.stringify(state);
    if (json.length > maxLength) return false;
    learner.objects[block.key] = state;
    changed('object-state');
    return true;
  }
  const objectSavedState = (blockId: string): unknown => {
    const block = blockIndex.get(blockId)?.block;
    return block && hasBehavior(block, 'object') ? learner.objects[block.key] ?? null : null;
  };

  // ── visibility (show-block / hide-block, persisted for keyed blocks) ──
  function blockVisible(block: BlockData): boolean {
    if (block.vkey && block.vkey in learner.visibility) return !!learner.visibility[block.vkey];
    return !block.hidden;
  }
  function setBlockVisible(blockId: string, visible: boolean): void {
    const block = blockIndex.get(blockId)?.block;
    if (!block) return;
    if (block.vkey) learner.visibility[block.vkey] = visible ? 1 : 0;
    changed('visibility');
  }

  // ── controls (buttons, tabs, disclosures): visited once the learner has used them ──
  // Keys come from the compiler (block.visits: name → key; '' for an unnamed button).
  function visitControl(blockId: string, name = ''): boolean {
    const key = blockIndex.get(blockId)?.block.visits?.[name];
    if (!key || learner.visits.has(key)) return false;
    learner.visits.add(key);
    changed('visited');
    return true;
  }
  function controlVisited(blockId: string, name = ''): boolean {
    const key = blockIndex.get(blockId)?.block.visits?.[name];
    return !!key && learner.visits.has(key);
  }
  // A block is visited once every one of its controls is.
  function blockVisited(blockId: string): boolean {
    const keys = Object.values(blockIndex.get(blockId)?.block.visits || {});
    return keys.length > 0 && keys.every((key) => learner.visits.has(key));
  }

  // ── screens ──
  function activitiesOf(screen: { blocks: readonly BlockData[] }): ActivityBlock[] { return flatBlocks(screen.blocks).filter(isActivity); }
  function activityDone(block: BlockData): boolean {
    if (hasBehavior(block, 'quiz')) return quizFinal(block);
    if (hasBehavior(block, 'numeric')) return numericFinal(block);
    if (hasBehavior(block, 'decision')) return !!learner.decisions[block.key];
    if (hasBehavior(block, 'object')) return block.key in learner.objectsDone;
    if (hasBehavior(block, 'predict')) return predictState(block) !== null;
    return true;
  }
  // Answered at least once, right or wrong (a step that opens once answered); an object, once completed.
  function activityAnswered(block: BlockData): boolean {
    if (hasBehavior(block, 'quiz')) return !!quizState(block);
    if (hasBehavior(block, 'numeric')) return !!numericState(block);
    return activityDone(block);
  }
  function screenComplete(screen: ScreenData): boolean { return learner.completed.has(screen.key); }
  // Step reached on a screen left part-way (saved for resume); null once its last step was shown.
  const savedStep = (screen: ScreenData): number | null => learner.steps[screen.key] ?? null;
  function saveStep(screen: ScreenData, step: number, last: number): void {
    const before = learner.steps[screen.key];
    if (step >= last) delete learner.steps[screen.key];
    else learner.steps[screen.key] = step;
    if (learner.steps[screen.key] !== before) changed('step');
  }
  function markComplete(screen: ScreenData): boolean {
    if (learner.completed.has(screen.key)) return false;
    learner.completed.add(screen.key);
    changed('completion');
    return true;
  }
  // allSteps: a screen with steps counts as viewed once its last step is revealed.
  function visit(screen: ScreenData, { allSteps = true }: { allSteps?: boolean } = {}): void {
    if (!learner.visited.has(screen.key)) { learner.visited.add(screen.key); changed('visit'); }
    if (allSteps && (screen.completeWhen || 'viewed') === 'viewed') markComplete(screen);
    refreshScreenCompletion(screen);
  }
  function refreshScreenCompletion(screen: ScreenData): void {
    if (screen.completeWhen === 'interactions-done' && activitiesOf(screen).every(activityDone)) markComplete(screen);
  }

  // ── scoring and status ──
  function scoredItems(): ActivityBlock[] {
    const out: ActivityBlock[] = [];
    for (const screen of screens) for (const block of flatBlocks(screen.blocks)) {
      if ((hasBehavior(block, 'quiz') || hasBehavior(block, 'numeric')) && block.props.scored !== false) out.push(block);
      else if ((hasBehavior(block, 'decision') || hasBehavior(block, 'object')) && block.props.scored) out.push(block);
      else if (hasBehavior(block, 'predict') && block.props.predict.scored) out.push(block);
    }
    return out;
  }
  function itemScore(block: ActivityBlock): number {
    if (hasBehavior(block, 'quiz')) { const answer = quizState(block); return answer && quizIsCorrect(block, answer.selected) ? 1 : 0; }
    if (hasBehavior(block, 'numeric')) { const answer = numericState(block); return answer && gradeNumeric(block.props, answer.value).correct ? 1 : 0; }
    if (hasBehavior(block, 'decision')) { const option = block.props.options.find((candidate) => candidate.id === learner.decisions[block.key]); return option?.correct ? 1 : 0; }
    if (hasBehavior(block, 'object')) return learner.objectsDone[block.key] ?? 0;
    if (hasBehavior(block, 'predict')) { const guess = predictState(block); return guess !== null && predictClose(block, guess) ? 1 : 0; }
    return 0;
  }
  const weightOf = (block: ActivityBlock): number => (hasBehavior(block, 'predict') ? block.props.predict.weight : block.props.weight) || 1;
  function score(): Score {
    const items = scoredItems();
    if (!items.length) return { raw: null, decided: true, items: 0 };
    const total = items.reduce((sum, block) => sum + weightOf(block), 0);
    const earned = items.reduce((sum, block) => sum + weightOf(block) * itemScore(block), 0);
    return { raw: Math.round((100 * earned) / total), decided: items.every(activityDone), items: items.length };
  }
  function computeStatus(): { target: TargetStatus; score: Score; requiredDone: boolean } {
    const requiredDone = screens.filter((screen) => screen.required !== false).every(screenComplete);
    const current = score();
    const mastery = course.completion.masteryScore;
    const passed = current.raw === null ? true : mastery === undefined ? true : current.raw >= mastery;
    let target: TargetStatus;
    switch (course.completion.reportAs) {
      case 'passed-incomplete': target = requiredDone && current.decided && passed ? 'passed' : 'incomplete'; break;
      case 'passed-failed': target = current.decided ? (passed ? 'passed' : 'failed') : 'incomplete'; break;
      case 'completed-failed': target = current.decided && !passed ? 'failed' : requiredDone && current.decided ? 'completed' : 'incomplete'; break;
      default: target = requiredDone ? 'completed' : 'incomplete';
    }
    return { target, score: current, requiredDone };
  }
  // Never regress: completed/passed stay; failed may only improve.
  function nextLmsStatus(): { status: string; score: Score } {
    const { target, score: current } = computeStatus();
    let status = lmsStatus;
    if (rank(target) > rank(lmsStatus) || (lmsStatus === 'failed' && (target === 'passed' || target === 'completed'))) status = target;
    if (rank(lmsStatus) === 3) status = lmsStatus;
    return { status, score: current };
  }
  function commitStatus(status: string): void { lmsStatus = status; }

  // Clears the answers of scored activities and the completion of their screens; returns the first
  // screen to take again.
  function retake(): string | undefined {
    const scored = scoredItems();
    const scoredBlocks: readonly BlockData[] = scored;
    for (const block of scored) {
      if (hasBehavior(block, 'quiz')) delete learner.quizzes[block.key];
      if (hasBehavior(block, 'numeric') || hasBehavior(block, 'predict')) delete learner.numerics[block.key];
      if (hasBehavior(block, 'decision')) delete learner.decisions[block.key];
      if (hasBehavior(block, 'object')) { delete learner.objectsDone[block.key]; delete learner.objects[block.key]; }
    }
    for (const screen of screens) if (activitiesOf(screen).some((block) => scoredBlocks.includes(block))) learner.completed.delete(screen.key);
    learner.retakes++;
    changed('retake');
    const first = screens.find((screen) => flatBlocks(screen.blocks).some((block) => scoredBlocks.includes(block)));
    return first?.id;
  }

  // ── events ──
  function matches(on: Trigger, type: TriggerType, info: TriggerInfo): boolean {
    if (on.type !== type) return false;
    if (on.target && on.target !== info.target) return false;
    if (type === 'click' && on.name !== undefined && on.name !== (info.name || '')) return false;
    if (type === 'quiz.submitted' && on.result && on.result !== 'any' && on.result !== (info.correct ? 'correct' : 'incorrect')) return false;
    if (type === 'decision.selected' && on.option && on.option !== info.option) return false;
    if (type === 'object.event') {
      if (on.name !== info.name) return false;
      for (const [field, value] of Object.entries(on.where || {})) if (fieldOf(info.payload, field) !== value) return false;
    }
    if (type === 'variable.changed' && on.variable !== info.variable) return false;
    if (type === 'timeline.reached' && info.event === undefined && (on.at?.line !== info.line || (on.at?.edge || 'start') !== info.edge)) return false;
    return true;
  }
  function conditionHolds(condition: Condition): boolean {
    if (condition.visited !== undefined) return condition.name !== undefined ? controlVisited(condition.visited, condition.name) : blockVisited(condition.visited);
    const value = getVar(condition.variable);
    // Order comparisons keep JavaScript semantics whatever the types (the validator checks they agree).
    const left = value as number;
    const right = condition.value as number;
    switch (condition.op) {
      case 'eq': return value === condition.value;
      case 'neq': return value !== condition.value;
      case 'gt': return left > right;
      case 'gte': return left >= right;
      case 'lt': return left < right;
      case 'lte': return left <= right;
      default: return false;
    }
  }
  // Returns the list of actions to run, in order; the player executes them (some touch the DOM).
  function eventsFor(screen: ScreenData, type: TriggerType, info: TriggerInfo): EventRun[] {
    const out: EventRun[] = [];
    for (const event of screen.events || []) {
      if (type === 'timeline.reached' && info.event !== undefined && event.id !== info.event) continue;
      if (!matches(event.on, type, info)) continue;
      const holds = (event.if || []).every(conditionHolds);
      out.push({ event: event.id, actions: holds ? event.do : (event.else || []) });
    }
    return out;
  }

  return {
    // The learner state. The name is part of the debug hook (window.__elabora.engine.st): previews,
    // the LMS emulator and tests mark screens visited through it.
    st: learner,
    course,
    screens,
    screenIndex,
    blockIndex,
    getVar, setVar, incrementVar,
    answerQuiz, quizState, quizFinal, quizIsCorrect,
    answerNumeric, numericState, numericFinal,
    answerPredict, predictState, predictClose,
    chooseDecision, decisionOf: (block: DecisionBlock): string | null => learner.decisions[block.key] || null,
    completeObject, objectDone: (block: ObjectBlock): boolean => block.key in learner.objectsDone, saveObjectState, objectSavedState,
    blockVisible, setBlockVisible,
    visitControl, controlVisited, blockVisited,
    visit, markComplete, screenComplete, refreshScreenCompletion, activitiesOf, activityDone, activityAnswered, savedStep, saveStep,
    score, computeStatus, nextLmsStatus, commitStatus, get lmsStatus(): string { return lmsStatus; },
    retake,
    eventsFor,
    encode: (): string => encodeState(learner),
    isVisited: (screen: ScreenData): boolean => learner.visited.has(screen.key)
  };
}
