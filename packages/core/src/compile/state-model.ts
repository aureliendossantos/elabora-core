import { screenSteps } from '../narration/narration.ts';
import { parseJSON } from '../util/json.ts';
import { readText } from '../project/files.ts';
import type { Project, Screen, Block } from '../project/model.ts';
import { iterateBlocks, screenOrder, screenBlocks, planIndex, resolveBlockProps } from '../project/load.ts';
import { getRegistry, behaviorOf } from '../components/registry.ts';
import type { Behavior } from '../components/registry.ts';
import { pendingMigrations } from '../components/migrate.ts';
import { blockControls, controlEntity } from '../components/controls.ts';
import type { StateModel } from '@elabora/player/state-codec';
import { isRecord, recordsOf, textOf, numberOr, isText } from './values.ts';
import { listOf, objectsIn } from '../util/values.ts';

// elabora.lock.json gives every stateful element a short, permanent key (base 36 counter), and
// records the version of each course component its instances were written for (migrations).
// It is part of the sources: keep it under version control and never edit it by hand.
// The core computes it; @elabora/node writes it (state-lock.ts).
export const LOCK_FILE = 'elabora.lock.json';

export interface StateLock {
  format: string;
  next: number;
  keys: Record<string, string>;
  components?: Record<string, string>;
}

const emptyLock = (): StateLock => ({ format: 'elabora-lock/1', next: 0, keys: {} });
// Elabora writes the lock (never a person): its keys are enough to recognise it.
export const isStateLock = (value: unknown): value is StateLock => isRecord(value) && isRecord(value.keys);

export function readLock(project: Pick<Project, 'files'>): StateLock {
  const text = readText(project.files, LOCK_FILE);
  if (text === null) return emptyLock();
  const parsed = parseJSON(text);
  return isStateLock(parsed.value) ? parsed.value : emptyLock();
}

// Learner state keys by lock entity (screen:<id>, quiz:<id>, var:<id>, visit:<id>#<name>…).
export type StateKeys = Record<string, string>;

// Activities keep learner state under an entity named by their behaviour, so a fork of the quiz
// block (an image quiz…) keeps learner state like a quiz.
const ACTIVITY_STATE_PREFIX = { quiz: 'quiz', numeric: 'numeric', decision: 'decision', object: 'object' } as const;
export type ActivityBehavior = keyof typeof ACTIVITY_STATE_PREFIX;
const isActivity = (behavior: Behavior | null): behavior is ActivityBehavior => behavior !== null && behavior in ACTIVITY_STATE_PREFIX;
export const activityEntity = (behavior: ActivityBehavior, blockId: string): string => `${ACTIVITY_STATE_PREFIX[behavior]}:${blockId}`;

// Stateful entities in deterministic course order.
export function statefulEntities(project: Project): string[] {
  const entities: string[] = [];
  for (const { id } of screenOrder(project)) entities.push(`screen:${id}`);
  const toggled = toggledBlocks(project);
  for (const { block } of iterateBlocks(project)) entities.push(...blockEntities(project, block, toggled));
  for (const variable of objectsIn(project.course?.variables)) if (variable.persist !== false) entities.push(`var:${variable.id}`);
  return entities;
}

// The stateful entities of one screen, as statefulEntities lists them for the course. project gives
// the components and the plan (it may be the project the screen was edited from); toggled: the
// blocks that events of the course show or hide.
export function screenEntities(project: Pick<Project, 'components' | 'plan' | 'course'>, screenId: string, screen: Screen, toggled: ReadonlySet<string>): string[] {
  const entities = [`screen:${screenId}`];
  for (const { block } of screenBlocks(screen)) entities.push(...blockEntities(project, block, toggled));
  return entities;
}

function blockEntities(project: Pick<Project, 'components' | 'plan' | 'course'>, block: Block, toggled: ReadonlySet<string>): string[] {
  const entities: string[] = [];
  const behavior = behaviorOf(getRegistry(project), block.type);
  if (isActivity(behavior)) entities.push(activityEntity(behavior, block.id));
  if (toggled.has(block.id)) entities.push(`block:${block.id}`);
  for (const name of blockControls(project, block).keys()) entities.push(controlEntity(block.id, name));
  return entities;
}

// Blocks that events show or hide: their visibility is learner state.
export function toggledBlocks(project: Pick<Project, 'screens'>): Set<string> {
  const blocks = new Set<string>();
  for (const { data } of project.screens.values()) for (const id of toggledBy(data)) blocks.add(id);
  return blocks;
}

// Blocks that the events of a screen show or hide.
export function toggledBy(screen: Pick<Screen, 'events'>): string[] {
  const blocks: string[] = [];
  for (const event of objectsIn(screen.events)) {
    for (const action of [...objectsIn(event.do), ...objectsIn(event.else)]) {
      if ((action.type === 'show-block' || action.type === 'hide-block') && typeof action.block === 'string' && action.block) blocks.push(action.block);
    }
  }
  return blocks;
}

// Component versions the instances were written for (migrations start from there). Components
// whose version changed without pending migration are recorded at their new version.
export function syncComponentVersions(project: Project, lock: StateLock): boolean {
  let changed = false;
  // Elabora writes the lock; components that are not a record are rewritten.
  const versions: Record<string, string> = isRecord(lock.components) ? lock.components : {};
  lock.components = versions;
  for (const descriptor of getRegistry(project).values()) {
    if (descriptor.builtin) continue;
    const current = versions[descriptor.id];
    if (current === descriptor.version) continue;
    if (current && pendingMigrations(project, descriptor, lock).length) continue;
    versions[descriptor.id] = descriptor.version;
    changed = true;
  }
  for (const id of Object.keys(versions)) if (!project.components.has(id)) { delete versions[id]; changed = true; }
  if (changed) lock.components = Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)));
  return changed;
}

// Returns the key map for the current project. New entities get the next counter values.
// With dryRun the lock object is not modified.
export function assignKeys(project: Project, lock: StateLock, { dryRun = false }: { dryRun?: boolean } = {}): { keys: StateKeys; added: number; lock: StateLock } {
  const target = dryRun ? structuredClone(lock) : lock;
  const keys: StateKeys = {};
  let added = 0;
  for (const entity of statefulEntities(project)) {
    if (!(entity in target.keys)) { target.keys[entity] = (target.next++).toString(36); added++; }
    keys[entity] = target.keys[entity];
  }
  return { keys, added, lock: target };
}

// Lengths the worst case is built with. The schemas allow far less (500 for a string variable, 2000
// for an object's state); a value that is not a length fails them, and a length above the cap
// exceeds every LMS budget anyway, so the worst case never builds a string of any size.
const LENGTH_CAP = 65536;
const measuredLength = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? Math.min(value, LENGTH_CAP) : undefined);

// What the learner state may hold, by key: the player measures its worst case against the
// suspend_data budget.
export function buildStateModel(project: Project, keys: StateKeys): StateModel {
  const index = planIndex(project.plan);
  const registry = getRegistry(project);
  const model: StateModel = { screens: [], quizzes: [], numerics: [], decisions: [], variables: [], objects: [], toggleableBlocks: [], steppedScreens: [], controls: [] };
  for (const { id } of screenOrder(project)) {
    const key = keys[`screen:${id}`];
    if (!key) continue;
    model.screens.push(key);
    // A screen left part-way saves the step reached: at worst its last step but one.
    const steps = screenSteps(project.screens.get(id)?.data);
    if (steps.length > 1) model.steppedScreens.push({ key, step: steps[steps.length - 2] });
  }
  for (const { block } of iterateBlocks(project)) {
    const props = resolveBlockProps(block, index, registry);
    const behavior = behaviorOf(registry, block.type);
    const key = isActivity(behavior) ? keys[activityEntity(behavior, block.id)] : undefined;
    const optionIds = () => recordsOf(props.options).map((option) => option.id).filter(isText);
    if (behavior === 'quiz' && key) {
      model.quizzes.push({ key, optionIds: optionIds(), maxAttempts: numberOr(props.attempts, 1) });
    } else if (behavior === 'numeric' && key) {
      model.numerics.push({ key, maxAttempts: numberOr(props.attempts, 1) });
    } else if (behavior === 'decision' && key) {
      model.decisions.push({ key, longestOptionId: optionIds().reduce((longest, id) => (id.length > longest.length ? id : longest), '') });
    } else if (behavior === 'object' && key) {
      const manifest = project.objects.get(textOf(props.object))?.manifest;
      const persistMax = manifest?.persistState?.enabled ? (measuredLength(manifest.persistState.maxLength) || 300) : 0;
      model.objects.push({ key, persistMax });
    }
    if (keys[`block:${block.id}`]) model.toggleableBlocks.push(keys[`block:${block.id}`]);
    for (const name of blockControls(project, block).keys()) if (keys[controlEntity(block.id, name)]) model.controls.push(keys[controlEntity(block.id, name)]);
  }
  for (const variable of objectsIn(project.course?.variables)) {
    if (variable.persist === false || !keys[`var:${variable.id}`]) continue;
    model.variables.push({ key: keys[`var:${variable.id}`], type: variable.type, maxLength: measuredLength(variable.maxLength), options: variable.options === undefined ? undefined : listOf(variable.options).filter(isText) });
  }
  return model;
}
