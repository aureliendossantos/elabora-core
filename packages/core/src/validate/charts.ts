// Charts and diagrams (D60): what their schemas cannot say. Items keep unique ids, what names an item
// (highlight, a trend's note, a diagram's beats and labels) finds it, a trend can be drawn, a funnel
// narrows, a diagram parses and leaves colours to the course.

import type { Block } from '../project/model.ts';
import { diagramIds, hasColors, isProblem, parseDiagram } from '../charts/diagram.ts';
import type { CourseCheckContext } from './context.ts';
import { isRecord, list, fieldsOf } from './guards.ts';

// The list of items of each type that has one (by id).
const ITEM_LISTS: Readonly<Record<string, string>> = {
  'key-figures': 'items', bars: 'rows', donut: 'parts', 'before-after': 'items', levels: 'items',
  process: 'items', cycle: 'items', matrix: 'items', milestones: 'items'
};

export function checkChart(ctx: CourseCheckContext, { block, type, path, file }: { block: Block; type: string; path: string; file: string }): void {
  const { reporter } = ctx;
  const props = fieldsOf(block.props);
  const id = block.id;
  const at = (sub: string) => `${path}/props/${sub}`;
  const unknown = (where: string, name: unknown, ids: readonly string[], what: string) => reporter.emit('E_CHART_ITEM_UNKNOWN', { file, path: at(where), target: id, message: `Chart "${id}": ${what} "${String(name)}" is not one of its ${ids.length ? `items (${ids.slice(0, 12).join(', ')}${ids.length > 12 ? '…' : ''})` : 'items: it has none'}.` });

  const listName = ITEM_LISTS[type];
  if (listName) {
    const seen = new Map<string, number>();
    list(props[listName]).forEach((item, index) => {
      const itemId = fieldsOf(item).id;
      if (typeof itemId !== 'string') return;
      if (seen.has(itemId)) reporter.emit('E_CHART_ITEM_DUPLICATE', { file, path: at(`${listName}/${index}/id`), target: id, message: `Chart "${id}": items ${seen.get(itemId)! + 1} and ${index + 1} of ${listName} are both "${itemId}".` });
      else seen.set(itemId, index);
    });
    if (typeof props.highlight === 'string' && !seen.has(props.highlight)) unknown('highlight', props.highlight, [...seen.keys()], 'highlight');
    if (type === 'levels' && props.shape !== 'pyramid') {
      const values = list(props[listName]).map((item) => fieldsOf(item).value);
      const widens = values.findIndex((value, index) => index > 0 && typeof value === 'number' && typeof values[index - 1] === 'number' && value > (values[index - 1] as number));
      if (widens > 0) reporter.emit('W_CHART_ORDER', { file, path: at(`${listName}/${widens}/value`), target: id, message: `Funnel "${id}": stage ${widens + 1} (${String(values[widens])}) holds more than stage ${widens} (${String(values[widens - 1])}).` });
    }
  }

  if (type === 'trend') checkTrend(ctx, block, file, at, unknown);
  if (type === 'diagram') checkDiagram(ctx, block, file, at, unknown);
}

type At = (sub: string) => string;
type Unknown = (where: string, name: unknown, ids: readonly string[], what: string) => void;

function checkTrend(ctx: CourseCheckContext, block: Block, file: string, at: At, unknown: Unknown): void {
  const props = fieldsOf(block.props);
  const id = block.id;
  const data = (where: string, message: string) => ctx.reporter.emit('E_CHART_DATA', { file, path: at(where), target: id, message: `Trend "${id}": ${message}.` });
  const points = list(props.points).map((point) => fieldsOf(point));
  if (points.length < 2) { data('points', 'a line needs at least two points'); return; }
  const xs = points.map((point) => point.x);
  const numeric = xs.every((x) => typeof x === 'number');
  if (!numeric && !xs.every((x) => typeof x === 'string')) { data('points', 'the x of its points are all numbers (years, weeks…) or all words (months, phases), not both'); return; }
  const names = xs.map(String);
  for (let index = 1; index < xs.length; index++) {
    if (numeric && (xs[index] as number) <= (xs[index - 1] as number)) { data(`points/${index}/x`, `x goes ${String(xs[index - 1])} then ${String(xs[index])}: points come in increasing order`); return; }
    if (!numeric && names.indexOf(names[index]) < index) { data(`points/${index}/x`, `two points are "${names[index]}"`); return; }
  }
  const has = (value: unknown) => names.includes(String(value));
  if (isRecord(props.note) && props.note.x !== undefined && !has(props.note.x)) unknown('note/x', props.note.x, names, 'the note\'s x');
  if (props.mode === 'predict') {
    if (!isRecord(props.predict)) { data('mode', 'predict mode needs predict, with from: the x of the last point shown before the learner draws'); return; }
    const from = names.indexOf(String(props.predict.from));
    if (from < 0) unknown('predict/from', props.predict.from, names, 'predict.from');
    else if (from >= names.length - 1) data('predict/from', `predict.from is the last point: the learner would have nothing to draw (from ${names[0]} to ${names[names.length - 2]})`);
  }
}

function checkDiagram(ctx: CourseCheckContext, block: Block, file: string, at: At, unknown: Unknown): void {
  const props = fieldsOf(block.props);
  const id = block.id;
  if (typeof props.mermaid !== 'string') return;
  if (hasColors(props.mermaid)) ctx.reporter.emit('W_DIAGRAM_COLOR', { file, path: at('mermaid'), target: id, message: `Diagram "${id}" writes colours (classDef, style or linkStyle): they are left out.` });
  const parsed = parseDiagram(props.mermaid);
  if (isProblem(parsed)) {
    const where = parsed.line !== undefined ? ` (line ${parsed.line}${parsed.column !== undefined ? `, column ${parsed.column}` : ''})` : '';
    ctx.reporter.emit(parsed.code, { file, path: at('mermaid'), target: id, message: `Diagram "${id}"${where}: ${parsed.message}` });
    return;
  }
  const ids = diagramIds(props.mermaid);
  if ('code' in ids) return;
  if (typeof props.highlight === 'string' && !ids.items.includes(props.highlight)) unknown('highlight', props.highlight, ids.items, 'highlight');
  list(props.beats).forEach((beat, index) => {
    const node = fieldsOf(beat).node;
    if (typeof node === 'string' && !ids.items.includes(node)) unknown(`beats/${index}/node`, node, ids.items, 'the beat\'s node');
  });
  for (const key of Object.keys(fieldsOf(props.labels))) {
    if (!ids.items.includes(key) && !ids.edges.includes(key)) unknown(`labels/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, key, [...ids.items, ...ids.edges], 'the label of');
  }
}
