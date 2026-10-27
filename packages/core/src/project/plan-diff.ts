import type { Plan } from './model.ts';
import { effectiveParts, type PlanCourse } from './plan-order.ts';
import { canonicalJSON } from '../util/json.ts';
import { isRecord, objectsIn } from '../util/values.ts';
import { diffRich, parseRich } from '../plan-document/rich.ts';
import type { RichBlock } from '../plan-document/rich.ts';

// What changed between two plans (docs/decisions.md D52), computed and never written by hand: the
// marks of the app's Sommaire and Cartes, the panel « Modifications », the document's tracked
// changes, `elabora plan diff`. Elements are matched by their plan ids, so a reworded item is the
// same item changed, not one removed and another added; a text or a question keeps its id when it
// moves to another item. Plain data: the app's renderer reads it as it is.

export type PlanElementKind = 'plan' | 'objective' | 'item' | 'text' | 'question' | 'source';

export interface PlanFieldChange {
  // The field, below the element: title, objectives, options/b/text, audience/role…
  field: string;
  before?: unknown; // absent: the field was not there
  after?: unknown; // absent: it is not there any more
  // A text reworded, word by word (diffRich): its words marked deleted and inserted.
  diff?: RichBlock[];
}

export interface PlanChange {
  // Stable across computations: <kind>:<id> (item:ITEM-3, text:TXT-2, plan:businessGoal). A note for
  // the client names its change by this key.
  key: string;
  kind: PlanElementKind;
  id: string; // the plan id, or the plan's field for kind plan
  status: 'added' | 'removed' | 'changed';
  // What the views call it: an item's title, an objective's short name or statement, a text's or
  // a question's first words, a source's title, the plan's field.
  label: string;
  item?: string; // a text or a question: the item that holds it (the one before, when removed)
  fromItem?: string; // a text or a question that went to another item: the one it was in
  // Moved in its list (items in the plan, objectives, sources, a text or a question in its item),
  // its positions from 1: the elements around it that kept their order did not move.
  moved?: { from: number; to: number };
  part?: { from: string | null; to: string | null }; // an item in another part
  fields: PlanFieldChange[];
  // A text the base kept « à l'identique » (verbatim) whose words changed, which was removed or
  // lost its flag: amber in the app, W_PLAN_VERBATIM_CHANGED.
  verbatim?: true;
  // An element added or removed, as it is (added) or was (removed).
  value?: unknown;
}

export interface PlanDiff {
  changes: PlanChange[];
  counts: { added: number; removed: number; changed: number };
}

type Entry = Record<string, unknown> & { id: string };

// The plan's own fields that are compared (its lists are compared element by element; what the
// agent decided and asks while the plan is a draft, and the translation's source, are not content).
const PLAN_FIELDS = ['id', 'title', 'businessGoal', 'audience', 'duration', 'spacing', 'waivers'] as const;
// Fields compared as texts, word by word.
const RICH: Record<PlanElementKind, ReadonlySet<string>> = {
  plan: new Set(['title', 'businessGoal', 'audience/role', 'audience/notes']),
  objective: new Set(['statement', 'short', 'criterion']),
  item: new Set(['title', 'description']),
  text: new Set(['text']),
  question: new Set(['stem', 'feedback/correct', 'feedback/incorrect']),
  source: new Set(['title'])
};

const entries = (list: unknown): Entry[] => objectsIn<Record<string, unknown>>(Array.isArray(list) ? list : []).filter((entry): entry is Entry => typeof entry.id === 'string');
const same = (a: unknown, b: unknown): boolean => canonicalJSON(a) === canonicalJSON(b);
const short = (value: unknown, length = 80): string => {
  const words = typeof value === 'string' ? value.replace(/[*_`$#>\\[\]]/g, '').replace(/\s+/g, ' ').trim() : '';
  return words.length > length ? `${words.slice(0, length - 1).trimEnd()}…` : words;
};

function fieldDiff(kind: PlanElementKind, field: string, before: unknown, after: unknown): PlanFieldChange {
  const change: PlanFieldChange = { field };
  if (before !== undefined) change.before = before;
  if (after !== undefined) change.after = after;
  const isText = (value: unknown) => value === undefined || typeof value === 'string';
  const optionText = kind === 'question' && /^options\/[^/]+\/(text|feedback)$/.test(field);
  if ((RICH[kind].has(field) || optionText) && isText(before) && isText(after)) change.diff = diffRich(parseRich(String(before ?? '')), parseRich(String(after ?? '')));
  if (kind === 'item' && field === 'voiceover') {
    // One paragraph a line: lines reworded in place read word by word.
    const lines = (value: unknown) => objectsIn<Record<string, unknown>>(Array.isArray(value) ? value : []).map((line) => String(line.text ?? '')).join('\n\n');
    change.diff = diffRich(parseRich(lines(before)), parseRich(lines(after)));
  }
  return change;
}

// The fields of an element that differ, nested objects (an audience, a numeric feedback) by their
// own fields, a question's options by their ids.
function fieldChanges(kind: PlanElementKind, before: Record<string, unknown>, after: Record<string, unknown>, skip: ReadonlySet<string>, prefix = ''): PlanFieldChange[] {
  const out: PlanFieldChange[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !skip.has(key));
  const order = (key: string) => { const index = Object.keys(after).indexOf(key); return index < 0 ? Object.keys(before).indexOf(key) + 1000 : index; };
  for (const key of keys.sort((a, b) => order(a) - order(b))) {
    const a = before[key];
    const b = after[key];
    if (same(a, b)) continue;
    const field = `${prefix}${key}`;
    if (kind === 'question' && key === 'options' && !prefix) { out.push(...optionChanges(a, b)); continue; }
    const nested = (kind === 'plan' && (key === 'audience' || key === 'duration')) || (kind === 'question' && key === 'feedback');
    if (nested && isRecord(a) && isRecord(b)) out.push(...fieldChanges(kind, a, b, new Set(), `${field}/`));
    else out.push(fieldDiff(kind, field, a, b));
  }
  return out;
}

function optionChanges(before: unknown, after: unknown): PlanFieldChange[] {
  const a = objectsIn<Record<string, unknown>>(Array.isArray(before) ? before : []);
  const b = objectsIn<Record<string, unknown>>(Array.isArray(after) ? after : []);
  const byId = (list: Record<string, unknown>[]) => new Map(list.map((option) => [String(option.id), option]));
  const was = byId(a);
  const now = byId(b);
  const out: PlanFieldChange[] = [];
  for (const [id, option] of now) {
    const old = was.get(id);
    if (!old) out.push({ field: `options/${id}`, after: option });
    else out.push(...fieldChanges('question', old, option, new Set(['id']), `options/${id}/`));
  }
  for (const [id, option] of was) if (!now.has(id)) out.push({ field: `options/${id}`, before: option });
  const kept = (list: Record<string, unknown>[], other: Map<string, unknown>) => list.map((option) => String(option.id)).filter((id) => other.has(id));
  const order = kept(b, was);
  if (!same(kept(a, now), order)) out.push({ field: 'options/order', before: kept(a, now), after: order });
  return out;
}

// The ids of a list that kept their relative order (the longest common subsequence of the two
// orders): the others moved.
function stayed(before: readonly string[], after: readonly string[]): Set<string> {
  const common = new Set(before.filter((id) => after.includes(id)));
  const a = before.filter((id) => common.has(id));
  const b = after.filter((id) => common.has(id));
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.add(a[i]!); i++; j++; }
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

interface Nested { entry: Entry; item: string; index: number }

// Texts and questions of a plan by id, with their item and their place in it.
function nested(plan: Plan | null, key: 'lockedTexts' | 'questions'): Map<string, Nested> {
  const out = new Map<string, Nested>();
  for (const item of entries(plan?.items)) entries(item[key]).forEach((entry, index) => { if (!out.has(entry.id)) out.set(entry.id, { entry, item: item.id, index }); });
  return out;
}

const labelOf = (kind: PlanElementKind, entry: Record<string, unknown>): string => {
  switch (kind) {
    case 'objective': return short(entry.short) || short(entry.statement);
    case 'item': case 'source': return short(entry.title);
    case 'text': return short(entry.text);
    case 'question': return short(entry.stem);
    default: return '';
  }
};

// The changes of a list of elements (objectives, items, sources), in the order of the current
// plan, each removed element after the one that was before it.
function listChanges(kind: 'objective' | 'item' | 'source', before: Entry[], after: Entry[], skip: ReadonlySet<string>, extra?: (id: string) => Partial<PlanChange> | null): PlanChange[] {
  const was = new Map(before.map((entry, index) => [entry.id, { entry, index }]));
  const now = new Map(after.map((entry, index) => [entry.id, { entry, index }]));
  const kept = stayed(before.map((entry) => entry.id), after.map((entry) => entry.id));
  const byId = new Map<string, PlanChange>();
  for (const [id, { entry, index }] of now) {
    const old = was.get(id);
    const base: PlanChange = { key: `${kind}:${id}`, kind, id, status: old ? 'changed' : 'added', label: labelOf(kind, entry), fields: [] };
    if (!old) { byId.set(id, { ...base, value: entry, ...(extra?.(id) ?? {}) }); continue; }
    base.fields = fieldChanges(kind, old.entry, entry, skip);
    if (!kept.has(id)) base.moved = { from: old.index + 1, to: index + 1 };
    const more = extra?.(id) ?? {};
    const change = { ...base, ...more };
    if (change.fields.length || change.moved || change.part) byId.set(id, change);
  }
  for (const [id, { entry }] of was) if (!now.has(id)) byId.set(id, { key: `${kind}:${id}`, kind, id, status: 'removed', label: labelOf(kind, entry), fields: [], value: entry });
  return withRemoved(before.map((entry) => entry.id), after.map((entry) => entry.id), byId);
}

// Current order, each removed id after the id that was before it (or first).
function withRemoved<T>(before: readonly string[], after: readonly string[], changes: ReadonlyMap<string, T>): T[] {
  const present = new Set(after);
  const following = new Map<string | null, string[]>();
  let previous: string | null = null;
  for (const id of before) {
    if (!present.has(id)) {
      following.set(previous, [...(following.get(previous) ?? []), id]);
    } else previous = id;
  }
  const out: T[] = [];
  const push = (id: string) => { const change = changes.get(id); if (change) out.push(change); };
  for (const id of following.get(null) ?? []) push(id);
  for (const id of after) {
    push(id);
    for (const removed of following.get(id) ?? []) push(removed);
  }
  return out;
}

// What changed from base to current. base null: everything is added (a plan with no version yet).
// course: the project's course (planCourse), which a plan without parts takes its parts from (D50).
// The parts compared are those the items belong to, not the field they are written in: a plan that
// had none and writes each item's part down (the app does, the first time its author moves an item
// or renames a part) changed no item's part, so what counts is an item whose rank changed or whose
// part is not the one it had (an item of a plan without parts had its section's title). A base
// with no parts and no course to take them from has none to compare, and no part is said to change.
export function planDiff(base: Plan | null | undefined, current: Plan | null | undefined, course?: PlanCourse | null): PlanDiff {
  const changes: PlanChange[] = [];
  const a = (isRecord(base) ? base : {}) as Record<string, unknown>;
  const b = (isRecord(current) ? current : {}) as Record<string, unknown>;

  for (const field of PLAN_FIELDS) {
    if (same(a[field], b[field])) continue;
    const status = a[field] === undefined ? 'added' : b[field] === undefined ? 'removed' : 'changed';
    const fields = fieldChanges('plan', { [field]: a[field] }, { [field]: b[field] }, new Set());
    changes.push({ key: `plan:${field}`, kind: 'plan', id: field, status, label: field, fields });
  }

  changes.push(...listChanges('objective', entries(a.objectives), entries(b.objectives), new Set(['id'])));

  // Items, each followed by its texts and questions.
  const partsBefore = effectiveParts(base, course);
  const partsAfter = effectiveParts(current, course);
  const partOf = (parts: Map<string, string> | null, id: string) => (parts ? parts.get(id) || null : null);
  const itemList = listChanges('item', entries(a.items), entries(b.items), new Set(['id', 'part', 'lockedTexts', 'questions']), (id) => {
    if (!partsBefore) return null;
    const from = partOf(partsBefore, id);
    const to = partOf(partsAfter, id);
    return entries(a.items).some((item) => item.id === id) && from !== to ? { part: { from, to } } : null;
  });
  const nestedChanges = (kind: 'text' | 'question', key: 'lockedTexts' | 'questions') => {
    const was = nested(base ?? null, key);
    const now = nested(current ?? null, key);
    const byItem = new Map<string, PlanChange[]>();
    const add = (item: string, change: PlanChange) => byItem.set(item, [...(byItem.get(item) ?? []), change]);
    for (const item of entries(b.items)) {
      const list = entries(item[key]);
      const oldOrder = [...was.values()].filter((entry) => entry.item === item.id).sort((x, y) => x.index - y.index).map((entry) => entry.entry.id);
      const kept = stayed(oldOrder, list.map((entry) => entry.id));
      list.forEach((entry, index) => {
        const old = was.get(entry.id);
        const change: PlanChange = { key: `${kind}:${entry.id}`, kind, id: entry.id, status: old ? 'changed' : 'added', label: labelOf(kind, entry), item: item.id, fields: [] };
        if (!old) { add(item.id, { ...change, value: entry }); return; }
        change.fields = fieldChanges(kind, old.entry, entry, new Set(['id']));
        if (old.item !== item.id) { change.fromItem = old.item; change.moved = { from: old.index + 1, to: index + 1 }; }
        else if (!kept.has(entry.id)) change.moved = { from: old.index + 1, to: index + 1 };
        if (kind === 'text' && old.entry.verbatim === true && change.fields.some((field) => field.field === 'text' || field.field === 'verbatim')) change.verbatim = true;
        if (change.fields.length || change.moved) add(item.id, change);
      });
    }
    for (const [id, old] of was) {
      if (now.has(id)) continue;
      add(old.item, { key: `${kind}:${id}`, kind, id, status: 'removed', label: labelOf(kind, old.entry), item: old.item, fields: [], value: old.entry, ...(kind === 'text' && old.entry.verbatim === true ? { verbatim: true as const } : {}) });
    }
    return byItem;
  };
  const texts = nestedChanges('text', 'lockedTexts');
  const questions = nestedChanges('question', 'questions');
  // Every item's nested changes after it, in the current order with the removed items in place.
  const itemOrder = withRemoved(entries(a.items).map((item) => item.id), entries(b.items).map((item) => item.id), new Map([...entries(a.items), ...entries(b.items)].map((item) => [item.id, item.id])));
  const itemChange = new Map(itemList.map((change) => [change.id, change]));
  for (const id of itemOrder) {
    const change = itemChange.get(id);
    if (change) changes.push(change);
    changes.push(...(texts.get(id) ?? []), ...(questions.get(id) ?? []));
  }

  changes.push(...listChanges('source', entries(a.sources), entries(b.sources), new Set(['id'])));
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const change of changes) counts[change.status]++;
  return { changes, counts };
}

// The plan with one change undone (« Revenir à la V2 »): the element as base has it, in its place
// there. An item keeps its current texts and questions (each is a change of its own); an item
// removed comes back with those of its texts and questions that are nowhere else now. Throws a
// message when the change cannot be undone alone (a text whose item is gone).
export function revertPlanChange(current: Plan, base: Plan | null, key: string): Plan {
  const plan = structuredClone(current) as Plan & Record<string, unknown>;
  const was = (isRecord(base) ? base : {}) as Record<string, unknown>;
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)] as [PlanElementKind, string];
  if (!id) throw new Error(`No change ${key}: a key is <kind>:<id>, as planDiff gives it.`);
  if (kind === 'plan') {
    if (!(PLAN_FIELDS as readonly string[]).includes(id)) throw new Error(`No field ${id} of the plan in its changes.`);
    if (was[id] === undefined) delete plan[id];
    else plan[id] = structuredClone(was[id]);
    return plan;
  }
  // Puts the element of base back into a list of the plan: after the element that was before it in
  // base and is still there (first, otherwise), replacing the current one with the same id.
  const restore = (list: Entry[], baseList: Entry[], keep?: (now: Entry | undefined, old: Entry) => Entry): Entry[] => {
    const old = baseList.find((entry) => entry.id === id);
    const now = list.find((entry) => entry.id === id);
    const rest = list.filter((entry) => entry.id !== id);
    if (!old) return rest;
    const value = keep ? keep(now, structuredClone(old)) : structuredClone(old);
    const before = baseList.slice(0, baseList.indexOf(old)).reverse().find((entry) => rest.some((other) => other.id === entry.id));
    const at = before ? rest.findIndex((entry) => entry.id === before.id) + 1 : 0;
    return [...rest.slice(0, at), value, ...rest.slice(at)];
  };
  const listKey = { objective: 'objectives', item: 'items', source: 'sources' } as const;
  if (kind === 'objective' || kind === 'source' || kind === 'item') {
    const name = listKey[kind];
    const list = entries(plan[name]);
    const baseList = entries(was[name]);
    if (!list.some((entry) => entry.id === id) && !baseList.some((entry) => entry.id === id)) throw new Error(`No ${kind} ${id} in either plan.`);
    if (kind !== 'item') { plan[name] = restore(list, baseList) as never; return plan; }
    // Texts and questions now anywhere in the plan.
    const elsewhere = new Set([...nested(plan, 'lockedTexts').keys(), ...nested(plan, 'questions').keys()]);
    plan.items = restore(list, baseList, (now, old) => {
      if (now) {
        for (const field of ['lockedTexts', 'questions'] as const) {
          if (now[field] === undefined) delete old[field];
          else old[field] = now[field];
        }
        return old;
      }
      for (const field of ['lockedTexts', 'questions'] as const) {
        const kept = entries(old[field]).filter((entry) => !elsewhere.has(entry.id));
        if (kept.length) old[field] = kept;
        else delete old[field];
      }
      return old;
    }) as never;
    return plan;
  }
  if (kind === 'text' || kind === 'question') {
    const field = kind === 'text' ? 'lockedTexts' : 'questions';
    const old = nested(was as Plan, field).get(id);
    const now = nested(plan, field).get(id);
    if (!old && !now) throw new Error(`No ${kind} ${id} in either plan.`);
    const items = entries(plan.items);
    // Out of the item that holds it now.
    if (now) {
      const holder = items.find((item) => item.id === now.item)!;
      const rest = entries(holder[field]).filter((entry) => entry.id !== id);
      if (rest.length) holder[field] = rest;
      else delete holder[field];
    }
    if (old) {
      const target = items.find((item) => item.id === old.item);
      if (!target) throw new Error(`${id} was in ${old.item}, which the plan no longer has: bring ${old.item} back first (item:${old.item}).`);
      const baseItem = entries(was.items).find((item) => item.id === old.item)!;
      target[field] = restore(entries(target[field]), entries(baseItem[field])) as never;
    }
    plan.items = items as never;
    return plan;
  }
  throw new Error(`No change ${key}: the kinds are plan, objective, item, text, question and source.`);
}
