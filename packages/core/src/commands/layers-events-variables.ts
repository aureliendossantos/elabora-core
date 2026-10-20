import type { Block, Course, Event, Screen, ScreenLayer, Variable } from '../project/model.ts';
import { CommandError, Draft, allIds, freshId, listIn, screenFile, type CommandContext, type CommandOutput } from './context.ts';
import { isRecord } from '../util/values.ts';

type NoResult = CommandOutput<Record<string, never>>;

// Replaces the element with the same id, or adds it last.
function upsert<T extends { id: string }>(list: T[], element: T): void {
  const i = list.findIndex((x) => isRecord(x) && x.id === element.id);
  if (i >= 0) list[i] = element;
  else list.push(element);
}

function editScreen(context: CommandContext, screenId: string, change: (screen: Screen, file: string) => void): NoResult {
  const draft = new Draft(context.files);
  const screen = draft.json<Screen>(screenFile(screenId));
  change(screen, screenFile(screenId));
  draft.writeJson(screenFile(screenId), screen);
  return { files: draft.files(), result: {} };
}

// Without an id, the layer or event is new and gets a free one (<screen>-layer, <screen>-event,
// then -2, -3…), returned as layer or event. The blocks of a layer without an id get one too
// (<layer>-<type>).
export interface UpsertLayerArgs {
  screen: string;
  layer: Omit<ScreenLayer, 'id' | 'blocks'> & { id?: string; blocks: (Omit<Block, 'id'> & { id?: string })[] };
}

export function upsertLayer(context: CommandContext, { screen, layer }: UpsertLayerArgs): CommandOutput<{ layer: string }> {
  const ids = allIds(context.project());
  const id = layer.id || freshId(ids, `${screen}-layer`);
  const blocks = (Array.isArray(layer.blocks) ? layer.blocks : []).map((block) => (isRecord(block) && !block.id ? { ...block, id: freshId(ids, `${id}-${block.type}`) } : block));
  const out = editScreen(context, screen, (s, file) => upsert(listIn<ScreenLayer>(s, 'layers', file, { create: true }), { ...layer, id, blocks } as ScreenLayer));
  return { ...out, result: { layer: id } };
}

export function removeLayer(context: CommandContext, { screen, id }: { screen: string; id: string }): NoResult {
  return editScreen(context, screen, (s, file) => {
    s.layers = listIn<ScreenLayer>(s, 'layers', file, { create: true }).filter((l) => !(isRecord(l) && l.id === id));
    if (!s.layers.length) delete s.layers;
  });
}

export interface UpsertEventArgs {
  screen: string;
  event: Omit<Event, 'id'> & { id?: string };
}

export function upsertEvent(context: CommandContext, { screen, event }: UpsertEventArgs): CommandOutput<{ event: string }> {
  const id = event.id || freshId(allIds(context.project()), `${screen}-event`);
  const out = editScreen(context, screen, (s, file) => upsert(listIn<Event>(s, 'events', file, { create: true }), { ...event, id } as Event));
  return { ...out, result: { event: id } };
}

export function removeEvent(context: CommandContext, { screen, id }: { screen: string; id: string }): NoResult {
  return editScreen(context, screen, (s, file) => {
    s.events = listIn<Event>(s, 'events', file, { create: true }).filter((e) => !(isRecord(e) && e.id === id));
    if (!s.events.length) delete s.events;
  });
}

export function upsertVariable(context: CommandContext, { variable }: { variable: Variable }): NoResult {
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  upsert(listIn<Variable>(course, 'variables', 'course.json', { create: true }), variable);
  draft.writeJson('course.json', course);
  return { files: draft.files(), result: {} };
}

// A variable no event reads or writes any more; one still used is refused, with where.
export function removeVariable(context: CommandContext, { id }: { id: string }): NoResult {
  const project = context.project();
  const uses: string[] = [];
  for (const { data } of project.screens.values()) {
    for (const event of Array.isArray(data.events) ? data.events : []) {
      if (!isRecord(event)) continue;
      const actions = [...(Array.isArray(event.do) ? event.do : []), ...(Array.isArray(event.else) ? event.else : [])];
      const conditions = Array.isArray(event.if) ? event.if : [];
      if (event.on?.variable === id || conditions.some((c) => isRecord(c) && c.variable === id) || actions.some((a) => isRecord(a) && a.variable === id)) uses.push(`${data.id}/${event.id}`);
    }
  }
  if (uses.length) throw new CommandError(`Variable "${id}" is used by event${uses.length > 1 ? 's' : ''} ${uses.join(', ')}`);
  const draft = new Draft(context.files);
  const course = draft.json<Course>('course.json');
  const variables = listIn<Variable>(course, 'variables', 'course.json', { create: true });
  if (!variables.some((v) => isRecord(v) && v.id === id)) throw new CommandError(`No variable "${id}"`);
  course.variables = variables.filter((v) => !(isRecord(v) && v.id === id));
  if (!course.variables.length) delete course.variables;
  draft.writeJson('course.json', course);
  return { files: draft.files(), result: {} };
}
