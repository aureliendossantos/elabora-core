import type { Course, CourseSection, Plan, Project } from './model.ts';
import { isRecord, objectsIn } from '../util/values.ts';

// The course follows its plan (docs/decisions.md D50). The plan's numbers are those of the screens
// that cover its items, so when items change order or part (a draft patched with a move, a plan
// written whole in another order, a change undone back to a version), the screens follow them:
// - a section whose screens each cover one item, all of one part, belongs to that part: it moves
//   with the part, and takes the part's new title when the part is renamed from the section's own;
// - a screen that covers a single item moves with it: after the screens of the item before it in the
//   same part, else before those of the item after it in the same part, else after the item before;
// - a screen that covers several items, or none, stays where it is, and so does the last screen of a
//   section (a section never ends empty);
// - in a plan without parts, sections never move: the screens do, after those of the item before.
// Nothing moves while the items keep their order and their parts.

export interface PlanOrderFollowed {
  course: Course;
  screens: string[]; // the screens moved, in the course's new order
  sections: string[]; // the sections moved with their part
  renamed: string[]; // the sections renamed with their part
}

type Item = { id: string; part?: unknown };
const itemsOf = (plan: Plan | null | undefined): Item[] => objectsIn<Record<string, unknown>>(plan?.items).filter((item) => typeof item.id === 'string') as Item[];

// Each item's part: its own, else the part of the item before it; null for a plan without parts.
export function itemParts(plan: Plan | null | undefined): Map<string, string> | null {
  const items = itemsOf(plan);
  if (!items.some((item) => typeof item.part === 'string' && item.part.trim())) return null;
  const parts = new Map<string, string>();
  let current = '';
  for (const item of items) {
    if (typeof item.part === 'string' && item.part.trim()) current = item.part.trim();
    parts.set(item.id, current);
  }
  return parts;
}

// A plan without parts takes them from the course (the app shows them so, and writes them into the
// plan the first time its author moves an item or renames a part): each item's part is the title of
// the section that holds its first screen, else the part of the item before it.
function sectionParts(course: Course, covers: ReadonlyMap<string, readonly string[]>, plan: Plan | null | undefined): Map<string, string> | null {
  if (!Array.isArray(course.sections)) return null;
  const titled = new Map<string, string>();
  for (const section of course.sections) {
    if (!isRecord(section) || !Array.isArray(section.screens) || typeof section.title !== 'string' || !section.title.trim()) continue;
    for (const screen of section.screens) for (const item of covers.get(String(screen)) ?? []) if (!titled.has(item)) titled.set(item, section.title.trim());
  }
  if (!titled.size) return null;
  const parts = new Map<string, string>();
  let current = '';
  for (const item of itemsOf(plan)) {
    current = titled.get(item.id) ?? current;
    parts.set(item.id, current);
  }
  return parts;
}

// What a plan without parts takes its parts from: the course's sections and the plan items each of
// its screens covers (screens/<id>.json covers).
export interface PlanCourse {
  course: Course;
  covers: ReadonlyMap<string, readonly string[]>;
}

// The items each screen covers, by screen id.
export function screenCovers(project: Pick<Project, 'screens'>): Map<string, string[]> {
  return new Map([...project.screens].map(([id, entry]) => [id, Array.isArray(entry.data?.covers) ? entry.data.covers.filter((item): item is string => typeof item === 'string') : []]));
}

// The course of a project, for the parts of a plan that has none; null without a course.
export function planCourse(project: Partial<Pick<Project, 'course' | 'screens'>>): PlanCourse | null {
  return project.course && project.screens ? { course: project.course, covers: screenCovers({ screens: project.screens }) } : null;
}

// Each item's part as the plan reads: its own, else the part of the item before it, and in a plan
// without parts the title of its section in the course (D50), null when the course says nothing
// either. The part an item belongs to, not the field it is written in: an item that says what its
// section called it did not change part.
export function effectiveParts(plan: Plan | null | undefined, course: PlanCourse | null | undefined): Map<string, string> | null {
  return itemParts(plan) ?? (course ? sectionParts(course.course, course.covers, plan) : null);
}

// covers: each screen's plan items (screens/<id>.json covers).
export function followPlanOrder(course: Course, covers: ReadonlyMap<string, readonly string[]>, before: Plan | null | undefined, after: Plan): PlanOrderFollowed | null {
  const oldItems = itemsOf(before).map((item) => item.id);
  const newItems = itemsOf(after).map((item) => item.id);
  const index = new Map(newItems.map((id, at) => [id, at]));
  const kept = new Set(oldItems);
  const oldCommon = oldItems.filter((id) => index.has(id));
  const newCommon = newItems.filter((id) => kept.has(id));
  const oldParts = itemParts(before) ?? (itemParts(after) ? sectionParts(course, covers, before) : null);
  const parts = itemParts(after);
  const reordered = newCommon.some((id, at) => id !== oldCommon[at]);
  const regrouped = newCommon.some((id) => (oldParts?.get(id) ?? null) !== (parts?.get(id) ?? null));
  if (!reordered && !regrouped) return null;
  if (!Array.isArray(course.sections) || !course.sections.every((section) => isRecord(section) && Array.isArray(section.screens))) return null;

  const next = structuredClone(course);
  const sections = next.sections as CourseSection[];
  const coveredBy = (screen: string): string[] => [...new Set((covers.get(screen) ?? []).filter((item) => index.has(item)))];
  // The item a screen moves with: the only item of the plan it covers.
  const itemOf = (screen: string): string | null => {
    const known = coveredBy(screen);
    return known.length === 1 ? known[0]! : null;
  };
  const partOf = (item: string): string | null => parts?.get(item) ?? null;

  // 1. Sections that belong to a part (their screens cover items of that part only) follow the
  // parts, in the slots they hold. A plan without parts moves no section.
  const owned = sections.map((section, slot) => {
    if (!parts) return null;
    const covered = section.screens.map(coveredBy);
    if (!covered.length || covered.some((items) => !items.length)) return null;
    const items = [...new Set(covered.flat())];
    if (new Set(items.map(partOf)).size !== 1) return null;
    return { slot, section, key: Math.min(...items.map((item) => index.get(item)!)), items };
  }).filter((entry) => entry !== null);
  const sorted = [...owned].sort((a, b) => a.key - b.key || a.slot - b.slot);
  const movedSections: string[] = [];
  sorted.forEach((entry, at) => {
    const slot = owned[at]!.slot;
    if (entry.slot !== slot) movedSections.push(String(entry.section.id));
    sections[slot] = entry.section;
  });
  // A part renamed renames its section, when the section was called as the part was (items moved into
  // a part that already was do not rename theirs: two sections would have one title).
  const renamed: string[] = [];
  if (parts && oldParts) {
    const oldNames = new Set(oldParts.values());
    for (const entry of owned) {
      const was = new Set(entry.items.map((item) => oldParts.get(item) ?? null));
      const now = partOf(entry.items[0]!);
      const old = [...was][0];
      if (was.size === 1 && old && now && old !== now && !oldNames.has(now) && entry.section.title === old) { entry.section.title = now; renamed.push(String(entry.section.id)); }
    }
  }

  // 2. Screens that cover one item follow it. A section's part: the one called as the section is,
  // else the part most of its screens' items belong to, an item that stayed in its part counting twice
  // as much as one that changed part (the first part on a tie).
  const sectionPart = new Map<CourseSection, string | null>(sections.map((section) => {
    const count = new Map<string, number>();
    for (const screen of section.screens) {
      const item = itemOf(screen);
      const label = item ? partOf(item) : null;
      if (label !== null) count.set(label, (count.get(label) ?? 0) + (oldParts?.get(item!) === label ? 2 : 1));
    }
    let best: string | null = null;
    for (const [label, n] of count) if (best === null || n > count.get(best)!) best = label;
    const titled = typeof section.title === 'string' ? section.title.trim() : '';
    return [section, titled && count.has(titled) ? titled : best];
  }));
  // Every screen that covers items of the plan, at the place of its first item; one that covers
  // several stays where it is, as a landmark the others keep their order around.
  type Place = { screen: string; item: string; key: number; section: CourseSection; shared: boolean };
  const flat = (): Place[] => sections.flatMap((section) => section.screens.flatMap((screen) => {
    const items = coveredBy(screen).sort((a, b) => index.get(a)! - index.get(b)!);
    return items.length ? [{ screen, item: items[0]!, key: index.get(items[0]!)!, section, shared: items.length > 1 }] : [];
  }));
  const places = flat();
  // A screen in the section of another part moves; of the others, the longest run in the plan's
  // order stays, landmarks first.
  const misplaced = (place: Place) => !place.shared && parts !== null && sectionPart.get(place.section) !== null && sectionPart.get(place.section) !== partOf(place.item);
  const candidates = places.filter((place) => !misplaced(place));
  const stay = new Set(longestRun(candidates.map((place) => ({ key: place.key, weight: place.shared ? candidates.length + 1 : 1 }))).map((at) => candidates[at]!.screen));
  // A section never ends empty: its last screen stays (course.json needs a screen in every section).
  const left = new Map(sections.map((section) => [section, section.screens.length]));
  const moving = places.filter((place) => !place.shared && !stay.has(place.screen)).filter((place) => {
    if (left.get(place.section)! <= 1) return false;
    left.set(place.section, left.get(place.section)! - 1);
    return true;
  }).sort((a, b) => a.key - b.key);
  for (const place of moving) place.section.screens.splice(place.section.screens.indexOf(place.screen), 1);
  for (const place of moving) {
    const now = flat();
    const before = [...now].reverse().find((other) => other.key <= place.key);
    const after = now.find((other) => other.key > place.key);
    const label = partOf(place.item);
    const into = (other: Place, offset: 0 | 1) => other.section.screens.splice(other.section.screens.indexOf(other.screen) + offset, 0, place.screen);
    if (before && partOf(before.item) === label) into(before, 1);
    else if (after && partOf(after.item) === label) into(after, 0);
    else if (before) into(before, 1);
    else if (after) into(after, 0);
    else place.section.screens.push(place.screen);
  }
  if (!moving.length && !movedSections.length && !renamed.length) return null;
  const order = sections.flatMap((section) => section.screens);
  return { course: next, screens: moving.map((place) => place.screen).sort((a, b) => order.indexOf(a) - order.indexOf(b)), sections: movedSections, renamed };
}

// The positions of a heaviest run of non-decreasing keys, in order (a few hundred screens at most).
function longestRun(entries: readonly { key: number; weight: number }[]): number[] {
  const best = entries.map((entry) => entry.weight);
  const previous = new Array<number>(entries.length).fill(-1);
  for (let at = 0; at < entries.length; at++) {
    for (let before = 0; before < at; before++) {
      if (entries[before]!.key <= entries[at]!.key && best[before]! + entries[at]!.weight > best[at]!) { best[at] = best[before]! + entries[at]!.weight; previous[at] = before; }
    }
  }
  let end = -1;
  // On a tie, the run that ends first: the screens of the items that moved later go.
  for (let at = 0; at < entries.length; at++) if (end < 0 || best[at]! > best[end]!) end = at;
  const run: number[] = [];
  for (let at = end; at >= 0; at = previous[at]!) run.unshift(at);
  return run;
}
