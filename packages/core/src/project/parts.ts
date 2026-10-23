import { isTimedLayer } from '../narration/timeline.ts';
import type { Block, Project, Variable } from './model.ts';
import { screenBlocks, screenOrder } from './load.ts';
import { behaviorOf, getRegistry } from '../components/registry.ts';
import { blockControls } from '../components/controls.ts';
import { isRecord } from '../util/values.ts';

// What the events of a screen can name, for editors that offer only what the validator accepts
// (validate/events.ts): its blocks with what each one triggers or takes (the controls a click
// names, a decision's options, a free object's events and settings), its layers and steps; the
// course's screens and variables.

export interface ScreenParts {
  screen: string;
  blocks: BlockPart[]; // in the screen's order, then its layers'
  // timed: the layer has a timeline of its own (D62); narration: its lines, which its events' cues name.
  layers: { id: string; title: string; timed?: true; narration?: { seek: 'seen' | 'free' | 'none'; lines: { id: string; speaker: string | null; text: string }[] } }[];
  steps: number[]; // the steps its blocks and its narration lines carry (1: shown from the start)
  screens: { id: string; title: string }[]; // in the course's order
  variables: Variable[];
  // Its narration (docs/decisions.md D24): the lines a timeline cue names (timeline.reached), in
  // the order they are spoken, with their step and speaker; null when the screen is not narrated.
  narration: { advance: 'learner' | 'auto' | 'next-screen'; seek: 'seen' | 'free' | 'none'; lines: { id: string; speaker: string | null; step: number; text: string }[] } | null;
}

export interface BlockPart {
  id: string;
  type: string;
  layer: string | null; // the layer it sits in
  behavior: string | null; // quiz, numeric, decision, object… (null: content)
  // Names of its buttons, tabs and disclosures ('' for an unnamed button): what a click names; a
  // block without controls cannot be clicked.
  controls: string[];
  options?: { id: string; label: string }[]; // a decision's
  object?: ObjectPart; // a free object's
}

export interface ObjectPart {
  id: string;
  title: string;
  events: { name: string; description: string; fields: string[] }[]; // what it may signal, and the payload fields a trigger can filter on
  props: ObjectPropPart[]; // the settings an event may change (set-object-props), authors' simple ones
}

export interface ObjectPropPart {
  name: string;
  title: string;
  type: 'string' | 'number' | 'integer' | 'boolean';
  enum?: (string | number)[];
  enumLabels?: Record<string, string>; // how its values read (the block's props.enumLabels over the manifest's x-enum-labels)
  minimum?: number;
  maximum?: number;
  default: unknown;
}

export function screenParts(project: Project, screenId: string): ScreenParts | null {
  const screen = project.screens.get(screenId)?.data;
  if (!screen) return null;
  const registry = getRegistry(project);
  const blocks: BlockPart[] = [];
  const steps = new Set<number>();
  for (const { block, layer } of screenBlocks(screen)) {
    if (typeof block.id !== 'string' || typeof block.type !== 'string') continue;
    if (!layer) steps.add(typeof block.step === 'number' ? block.step : 1);
    const behavior = behaviorOf(registry, block.type);
    const part: BlockPart = { id: block.id, type: block.type, layer: layer?.id ?? null, behavior, controls: [...blockControls(project, block).keys()] };
    if (behavior === 'decision') part.options = decisionOptions(block);
    if (behavior === 'object') {
      const object = objectPart(project, block);
      if (object) part.object = object;
    }
    blocks.push(part);
  }
  const titles = new Map([...project.screens.values()].map(({ data }) => [data.id, typeof data.title === 'string' ? data.title : data.id]));
  const lines = (Array.isArray(screen.narration?.lines) ? screen.narration.lines : []).filter(isRecord);
  for (const line of lines) steps.add(typeof line.step === 'number' ? line.step : 1);
  return {
    screen: screenId,
    blocks,
    layers: (Array.isArray(screen.layers) ? screen.layers : []).filter(isRecord).map((layer) => {
      const lines = isRecord(layer.narration) && Array.isArray(layer.narration.lines) ? layer.narration.lines.filter(isRecord) : [];
      return {
        id: String(layer.id), title: typeof layer.title === 'string' ? layer.title : String(layer.id),
        ...(isTimedLayer(project, screen, String(layer.id)) ? { timed: true as const } : {}),
        ...(lines.length ? { narration: { seek: (isRecord(layer.narration) && layer.narration.seek) || project.course?.narration?.seek || 'seen', lines: lines.map((line) => ({ id: String(line.id), speaker: typeof line.speaker === 'string' ? line.speaker : null, text: typeof line.text === 'string' ? line.text : '' })) } } : {})
      };
    }),
    steps: [...steps].sort((a, b) => a - b),
    screens: screenOrder(project).map(({ id }) => ({ id, title: titles.get(id) ?? id })),
    variables: (Array.isArray(project.course?.variables) ? project.course.variables : []).filter(isRecord),
    narration: screen.narration ? {
      advance: screen.narration.advance || project.course?.narration?.advance || 'learner', seek: screen.narration.seek || project.course?.narration?.seek || 'seen',
      lines: lines.map((line) => ({ id: String(line.id), speaker: typeof line.speaker === 'string' ? line.speaker : null, step: typeof line.step === 'number' ? line.step : 1, text: typeof line.text === 'string' ? line.text : '' }))
    } : null
  };
}

function decisionOptions(block: Block): { id: string; label: string }[] {
  const options = isRecord(block.props) && Array.isArray(block.props.options) ? block.props.options : [];
  return options.filter(isRecord).filter((option) => typeof option.id === 'string').map((option) => ({ id: String(option.id), label: typeof option.label === 'string' ? option.label : String(option.id) }));
}

function objectPart(project: Project, block: Block): ObjectPart | null {
  const id = isRecord(block.props) ? block.props.object : undefined;
  const manifest = typeof id === 'string' ? project.objects.get(id)?.manifest : null;
  if (!manifest || typeof id !== 'string') return null;
  const events = (Array.isArray(manifest.events) ? manifest.events : []).filter(isRecord).map((event) => ({
    name: String(event.name),
    description: typeof event.description === 'string' ? event.description : '',
    fields: isRecord(event.payload) && isRecord(event.payload.properties) ? Object.keys(event.payload.properties) : []
  }));
  const declared = isRecord(manifest.props) && isRecord(manifest.props.properties) ? manifest.props.properties : {};
  const ownLabels = isRecord(block.props) && isRecord(block.props.enumLabels) ? block.props.enumLabels : {};
  const props: ObjectPropPart[] = [];
  for (const [name, schema] of Object.entries(declared)) {
    if (!isRecord(schema) || schema['x-editable-by'] === 'developer') continue;
    const type = schema.type;
    if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') continue;
    if (schema.format === 'color') continue;
    const own = ownLabels[name];
    const labels = Object.entries({ ...(isRecord(schema['x-enum-labels']) ? schema['x-enum-labels'] : {}), ...(isRecord(own) ? own : {}) }).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    props.push({
      name, title: typeof schema.title === 'string' ? schema.title : name, type, default: schema.default,
      ...(Array.isArray(schema.enum) ? { enum: schema.enum.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number') } : {}),
      ...(Array.isArray(schema.enum) && labels.length ? { enumLabels: Object.fromEntries(labels) } : {}),
      ...(typeof schema.minimum === 'number' ? { minimum: schema.minimum } : {}),
      ...(typeof schema.maximum === 'number' ? { maximum: schema.maximum } : {})
    });
  }
  return { id, title: typeof manifest.title === 'string' ? manifest.title : id, events, props };
}
