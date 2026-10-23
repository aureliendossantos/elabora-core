import { variableValueError } from './structure.ts';
import { objectPropErrors, textContrasts, TEXT_CONTRAST } from './object-props.ts';
import { resolveTokens } from './theme.ts';
import { instanceBehavior, hooksOf } from '../components/registry.ts';
import { isPredict } from '../charts/predict.ts';
import type { ComponentDescriptor } from '../components/registry.ts';
import { blockControls, CONTROL_HOOKS } from '../components/controls.ts';
import { screenBlocks } from '../project/load.ts';
import type { Action, Block, Trigger } from '../project/model.ts';
import type { CourseCheckContext, ScreenFile } from './context.ts';
import { list, fieldsOf, byId, hasId } from './guards.ts';
import { screenSteps } from '../narration/narration.ts';
import { isTimedScreen, isTimedLayer, lineTimelines } from '../narration/timeline.ts';

// What each trigger needs from its target block: a behaviour (forks included) or a control.
const TRIGGER_TARGET: Readonly<Record<string, { test: (component: ComponentDescriptor, block: Block) => boolean; what: string }>> = {
  click: { test: (component) => CONTROL_HOOKS.some((hook) => hooksOf(component).has(hook)), what: 'button (or a component with data-t-click buttons, tabs or disclosures)' },
  // A trend in predict mode is submitted when the learner reveals the line (D60).
  'quiz.submitted': { test: (component, block) => component.behavior === 'quiz' || component.behavior === 'numeric' || isPredict(component.root, fieldsOf(block.props)), what: 'quiz, numeric or predicting trend block' },
  'decision.selected': { test: (component) => component.behavior === 'decision', what: 'decision block' },
  'object.event': { test: (component) => component.behavior === 'object', what: 'free-object block' },
  'dialogue.started': { test: (component) => component.behavior === 'dialogue', what: 'dialogue block' },
  'dialogue.node': { test: (component) => component.behavior === 'dialogue', what: 'dialogue block' },
  'dialogue.line': { test: (component) => component.behavior === 'dialogue', what: 'dialogue block' },
  'dialogue.chosen': { test: (component) => component.behavior === 'dialogue', what: 'dialogue block' },
  'dialogue.ended': { test: (component) => component.behavior === 'dialogue', what: 'dialogue block' }
};
const ORDER_OPERATORS = ['gt', 'gte', 'lt', 'lte'];
// Behaviours that make a block an activity a step can wait for (screen.steps opens "answered").
const STEP_ACTIVITIES = new Set(['quiz', 'numeric', 'decision', 'dialogue', 'object', 'predict']);

const controlNames = (controls: Map<string, unknown>) => [...controls.keys()].map((name) => name || '(unnamed)').join(', ');

// Events: triggers point at the right kind of element of the same screen, actions at valid targets,
// values match variable types, free-object events are declared in the manifest. Conditions on
// visited controls may name a block of any screen (context.lastBlocks).
export function checkEvents(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { project, reporter, registry, variables } = ctx;
  const { id: screenId, file, data } = screen;
  const local = new Map<string, Block>();
  for (const { block } of screenBlocks(data, file)) if (block !== null && block !== undefined) local.set(block.id, block);
  const layers = new Set(list(data.layers).map((layer) => layer?.id));
  const shownLayers = new Set<string | undefined>();
  // The steps of the screen: its blocks' and its narration lines'.
  const steps = new Set(screenSteps(data));
  const events = list(data.events);
  const lines = new Set(list(data.narration?.lines).map((line) => line?.id));
  const narrated = lines.size > 0;
  // Timed: narrated, or blocks and cues timed in seconds.
  const timed = isTimedScreen(project, data);
  // The timeline of each line on one (null: the screen's, else a layer's: D62).
  const timelines = lineTimelines(data);
  const layerLines = (layer: string) => [...timelines].filter(([, own]) => own === layer).map(([line]) => line);
  // A timeline action or trigger that names a layer needs that layer, with a timeline of its own.
  const timedLayer = (layer: unknown, path: string, what: string, eventId: string): boolean => {
    if (layer === undefined) return true;
    if (!hasId(layers, layer)) { reporter.emit('E_EVENT_TARGET', { file, path, target: eventId, message: `${what}: no layer "${String(layer)}" on screen "${screenId}".` }); return false; }
    if (!isTimedLayer(project, data, String(layer))) { reporter.emit('E_TIMELINE_CUE', { file, path, target: eventId, message: `${what}: layer "${String(layer)}" of screen "${screenId}" has no timeline (no narration, no timed block).` }); return false; }
    return true;
  };
  // Sounds and videos the learner plays (a loop never ends).
  const playable = (block: Block | undefined) => !!block && (block.type === 'audio' || (block.type === 'video' && !fieldsOf(block.props).loop));

  events.forEach((event, eventIndex) => {
    if (event === null || event === undefined) return;
    const base = `/events/${eventIndex}`;
    const on: Partial<Trigger> = event.on || {};
    const trigger = on.type !== undefined && Object.hasOwn(TRIGGER_TARGET, on.type) ? TRIGGER_TARGET[on.type] : undefined;
    if (trigger) {
      const block = byId(local, on.target);
      const component = block && registry.get(block.type);
      if (!block) reporter.emit('E_EVENT_TARGET', { file, path: `${base}/on/target`, target: event.id, message: `Event "${event.id}": no block "${on.target}" on screen "${screenId}".` });
      else if (!component || !trigger.test(component, block)) reporter.emit('E_EVENT_TARGET', { file, path: `${base}/on/target`, target: event.id, message: `Event "${event.id}": ${on.type} needs a ${trigger.what}, "${on.target}" is a ${block.type}.` });
      else if (on.type === 'click' && on.name !== undefined && !blockControls(project, block).has(on.name)) {
        reporter.emit('E_EVENT_TARGET', { file, path: `${base}/on/name`, target: event.id, message: `Event "${event.id}": ${block.type} "${block.id}" has no control named "${on.name}" (controls: ${controlNames(blockControls(project, block)) || 'none'}).` });
      } else if (on.type === 'decision.selected' && on.option && !list(fieldsOf(block.props).options).some((option) => fieldsOf(option).id === on.option)) {
        reporter.emit('E_EVENT_TARGET', { file, path: `${base}/on/option`, target: event.id, message: `Event "${event.id}": decision "${block.id}" has no option "${on.option}".` });
      } else if (on.type !== undefined && on.type.startsWith('dialogue.')) {
        const problem = dialogueFilterProblem(block, on);
        if (problem) reporter.emit('E_EVENT_TARGET', { file, path: `${base}/on/${problem.field}`, target: event.id, message: `Event "${event.id}": ${problem.message}` });
      } else if (on.type === 'object.event') {
        const manifest = byId(project.objects, fieldsOf(block.props).object)?.manifest;
        const declared = list(manifest?.events);
        if (manifest && !declared.some((objectEvent) => objectEvent?.name === on.name)) {
          reporter.emit('E_OBJECT_EVENT_UNDECLARED', { file, path: `${base}/on/name`, target: event.id, message: `Event "${event.id}": object ${manifest.id} declares ${declared.map((objectEvent) => objectEvent?.name).join(', ') || 'no events'}, not "${on.name}".` });
        }
      }
    } else if (on.type === 'layer.closed') {
      if (!hasId(layers, on.target)) reporter.emit('E_EVENT_TARGET', { file, path: `${base}/on/target`, target: event.id, message: `Event "${event.id}": no layer "${on.target}" on screen "${screenId}".` });
    } else if (on.type === 'variable.changed') {
      if (!hasId(variables, on.variable)) reporter.emit('E_UNKNOWN_REFERENCE', { file, path: `${base}/on/variable`, target: event.id, message: `Event "${event.id}": unknown variable "${on.variable}".` });
    } else if ((on.type === 'timeline.reached' || on.type === 'timeline.ended') && on.layer !== undefined) {
      // A layer's timeline (D62): its end, a line it says, or seconds from its opening.
      const byLine = on.type === 'timeline.reached' && typeof on.at?.line === 'string';
      if (timedLayer(on.layer, `${base}/on/layer`, `Event "${event.id}": ${on.type}`, event.id) && byLine) {
        const own = timelines.get(on.at!.line!);
        if (own === undefined) reporter.emit('E_TIMELINE_CUE', { file, path: `${base}/on/at/line`, target: event.id, message: `Event "${event.id}": no narration line "${on.at?.line}" on layer "${on.layer}" of screen "${screenId}" (lines: ${layerLines(on.layer).join(', ') || 'none'}).` });
        else if (own !== on.layer) reporter.emit('E_TIMELINE_ANCHOR_TRACK', { file, path: `${base}/on/at/line`, target: event.id, message: `Event "${event.id}": line "${on.at?.line}" is said on ${own === null ? 'the screen\'s timeline' : `the timeline of layer "${own}"`}, not on that of layer "${on.layer}" (its layer).` });
      }
    } else if (on.type === 'timeline.reached' || on.type === 'timeline.ended') {
      // A cue in seconds times a screen without narration; a line needs a narration (the screen's,
      // or a layer's, whose timeline it then names).
      const byLine = on.type === 'timeline.reached' && typeof on.at?.line === 'string';
      const ownTimeline = byLine ? timelines.get(on.at!.line!) : undefined;
      if (byLine && ownTimeline === undefined) reporter.emit('E_TIMELINE_CUE', { file, path: narrated || timelines.size ? `${base}/on/at/line` : `${base}/on/type`, target: event.id, message: timelines.size ? `Event "${event.id}": no narration line "${on.at?.line}" on screen "${screenId}" (lines: ${[...timelines.keys()].join(', ')}).` : `Event "${event.id}": ${on.type} at line "${on.at?.line}" on screen "${screenId}", which has no narration.` });
      else if (!byLine && !timed) reporter.emit('E_TIMELINE_CUE', { file, path: `${base}/on/type`, target: event.id, message: `Event "${event.id}": ${on.type} on screen "${screenId}", which has no timeline (no narration, no timed block).` });
    } else if (on.type === 'media.ended') {
      const block = byId(local, on.target);
      if (!block) reporter.emit('E_EVENT_TARGET', { file, path: `${base}/on/target`, target: event.id, message: `Event "${event.id}": no block "${on.target}" on screen "${screenId}".` });
      else if (!playable(block)) reporter.emit('E_EVENT_TARGET', { file, path: `${base}/on/target`, target: event.id, message: `Event "${event.id}": media.ended needs an audio block or a video that is not a loop, "${on.target}" is a ${block.type}${block.type === 'video' ? ' in a loop' : ''}.` });
    }

    list(event.if).forEach((condition, conditionIndex) => {
      if (condition === null || condition === undefined) return;
      const at = `${base}/if/${conditionIndex}`;
      if (condition.dialogue !== undefined) {
        const block = ctx.lastBlocks.get(condition.dialogue);
        if (!block || registry.get(block.type)?.behavior !== 'dialogue') { reporter.emit('E_UNKNOWN_REFERENCE', { file, path: `${at}/dialogue`, target: event.id, message: `Condition on "${condition.dialogue}", which is not a dialogue block of the course.` }); return; }
        const problem = dialogueFilterProblem(block, { ending: condition.ending, chosen: condition.chosen });
        if (problem) reporter.emit('E_UNKNOWN_REFERENCE', { file, path: `${at}/${problem.field}`, target: event.id, message: `Condition on dialogue "${block.id}": ${problem.message}` });
        return;
      }
      if (condition.visited !== undefined) {
        const block = ctx.lastBlocks.get(condition.visited);
        const controls = block ? blockControls(project, block) : new Map<string, unknown>();
        if (!block) reporter.emit('E_UNKNOWN_REFERENCE', { file, path: `${at}/visited`, target: event.id, message: `Condition on unknown block "${condition.visited}".` });
        else if (!controls.size) reporter.emit('E_VISITED_TARGET', { file, path: `${at}/visited`, target: event.id, message: `visited: ${block.type} "${block.id}" has no button, tab or disclosure the learner could use.` });
        else if (condition.name !== undefined && !controls.has(condition.name)) reporter.emit('E_VISITED_TARGET', { file, path: `${at}/name`, target: event.id, message: `visited: ${block.type} "${block.id}" has no control named "${condition.name}" (controls: ${controlNames(controls)}).` });
        return;
      }
      const variable = byId(variables, condition.variable);
      if (!variable) { reporter.emit('E_UNKNOWN_REFERENCE', { file, path: `${at}/variable`, target: event.id, message: `Condition on unknown variable "${condition.variable}".` }); return; }
      const error = variableValueError({ ...variable, minimum: undefined, maximum: undefined, maxLength: undefined }, condition.value);
      if (error) reporter.emit('E_VARIABLE_TYPE', { file, path: `${at}/value`, target: event.id, message: `Condition on "${condition.variable}": ${error}.` });
      if (condition.op !== undefined && ORDER_OPERATORS.includes(condition.op) && variable.type !== 'number') reporter.emit('E_VARIABLE_TYPE', { file, path: `${at}/op`, target: event.id, message: `Operator ${condition.op} needs a number variable; "${condition.variable}" is ${variable.type}.` });
    });

    const checkAction = (action: Action, at: string) => {
      switch (action.type) {
        case 'go-to':
          if (action.screen !== 'next' && action.screen !== 'previous' && !hasId(ctx.screens, action.screen)) reporter.emit('E_ACTION_TARGET', { file, path: `${at}/screen`, target: event.id, message: `go-to: no screen "${action.screen}" in the course.` });
          break;
        case 'show-layer':
        case 'hide-layer':
          // hide-layer without a layer closes the one open on top: the screen needs a layer.
          if (action.type === 'hide-layer' && action.layer === undefined) {
            if (!layers.size) reporter.emit('E_ACTION_TARGET', { file, path: at, target: event.id, message: `hide-layer: screen "${screenId}" has no layer to close.` });
            break;
          }
          if (!hasId(layers, action.layer)) reporter.emit('E_ACTION_TARGET', { file, path: `${at}/layer`, target: event.id, message: `${action.type}: no layer "${action.layer}" on screen "${screenId}".` });
          if (action.type === 'show-layer') shownLayers.add(action.layer);
          break;
        case 'show-block':
        case 'hide-block':
          if (!hasId(local, action.block)) reporter.emit('E_ACTION_TARGET', { file, path: `${at}/block`, target: event.id, message: `${action.type}: no block "${action.block}" on screen "${screenId}".` });
          break;
        case 'reveal-step':
          if (!hasId(steps, action.step)) reporter.emit('E_ACTION_TARGET', { file, path: `${at}/step`, target: event.id, message: `reveal-step: no block${narrated ? ' or narration line' : ''} of screen "${screenId}" has step ${action.step} (steps: ${[...steps].sort((x, y) => x - y).join(', ')}).` });
          break;
        case 'pause-timeline':
        case 'play-timeline':
        case 'seek-timeline': {
          // A layer's timeline (D62): named by layer, or by a line its narration says (seek-timeline).
          const toLine = action.type === 'seek-timeline' && typeof action.to?.line === 'string' ? action.to.line : undefined;
          const lineTimeline = toLine !== undefined ? timelines.get(toLine) : undefined;
          if (action.layer !== undefined) {
            if (!timedLayer(action.layer, `${at}/layer`, action.type, event.id) || toLine === undefined) break;
            if (lineTimeline === undefined) reporter.emit('E_TIMELINE_CUE', { file, path: `${at}/to/line`, target: event.id, message: `seek-timeline: no narration line "${toLine}" on layer "${action.layer}" of screen "${screenId}" (lines: ${layerLines(action.layer).join(', ') || 'none'}).` });
            else if (lineTimeline !== action.layer) reporter.emit('E_TIMELINE_ANCHOR_TRACK', { file, path: `${at}/to/line`, target: event.id, message: `seek-timeline: line "${toLine}" is said on ${lineTimeline === null ? 'the screen\'s timeline' : `the timeline of layer "${lineTimeline}"`}, not on that of layer "${action.layer}" (its layer).` });
            break;
          }
          if (toLine !== undefined && lineTimeline !== undefined && lineTimeline !== null) break;
          if (!timed) reporter.emit('E_TIMELINE_CUE', { file, path: `${at}/type`, target: event.id, message: `${action.type}: screen "${screenId}" has no timeline (no narration, no timed block).` });
          else if (toLine !== undefined && !hasId(lines, toLine)) reporter.emit('E_TIMELINE_CUE', { file, path: `${at}/to/line`, target: event.id, message: `seek-timeline: no narration line "${toLine}" on screen "${screenId}" (lines: ${[...lines].join(', ') || 'none'}).` });
          break;
        }
        case 'start-dialogue':
        case 'goto-dialogue':
        case 'restart-dialogue': {
          const block = byId(local, action.block);
          if (!block || registry.get(block.type)?.behavior !== 'dialogue') { reporter.emit('E_ACTION_TARGET', { file, path: `${at}/block`, target: event.id, message: `${action.type}: "${action.block}" is not a dialogue block of screen "${screenId}".` }); break; }
          if (action.type === 'goto-dialogue' && !list(fieldsOf(block.props).nodes).some((node) => fieldsOf(node).id === action.node)) reporter.emit('E_ACTION_TARGET', { file, path: `${at}/node`, target: event.id, message: `goto-dialogue: dialogue "${block.id}" has no node "${action.node}".` });
          break;
        }
        case 'play-media':
        case 'pause-media': {
          const block = byId(local, action.block);
          if (!playable(block)) reporter.emit('E_ACTION_TARGET', { file, path: `${at}/block`, target: event.id, message: `${action.type}: "${action.block}" is not an audio block or a video (not a loop) of screen "${screenId}".` });
          break;
        }
        case 'set-variable':
        case 'increment-variable': {
          const variable = byId(variables, action.variable);
          if (!variable) { reporter.emit('E_UNKNOWN_REFERENCE', { file, path: `${at}/variable`, target: event.id, message: `${action.type}: unknown variable "${action.variable}".` }); break; }
          if (action.type === 'set-variable') {
            const error = variableValueError(variable, action.value);
            if (error) reporter.emit('E_VARIABLE_TYPE', { file, path: `${at}/value`, target: event.id, message: `set-variable "${action.variable}": ${error}.` });
          } else if (variable.type !== 'number') reporter.emit('E_VARIABLE_TYPE', { file, path: `${at}/variable`, target: event.id, message: `increment-variable needs a number variable; "${action.variable}" is ${variable.type}.` });
          // A cue fires again each time playback crosses it: counting there counts replays.
          if (action.type === 'increment-variable' && (on.type === 'timeline.reached' || on.type === 'timeline.ended')) reporter.emit('W_TIMED_INCREMENT', { file, path: at, target: event.id, message: `Event "${event.id}": increment-variable on ${on.type} counts each time the learner replays the passage.` });
          break;
        }
        case 'set-object-props': {
          const block = byId(local, action.block);
          if (!block || registry.get(block.type)?.behavior !== 'object') { reporter.emit('E_ACTION_TARGET', { file, path: `${at}/block`, target: event.id, message: `set-object-props: "${action.block}" is not a free-object block of screen "${screenId}".` }); break; }
          const manifest = byId(project.objects, fieldsOf(block.props).object)?.manifest;
          if (!manifest) break;
          for (const error of objectPropErrors(manifest, action.props || {})) reporter.emit('E_OBJECT_PROP_VALUE', { file, path: `${at}/props${error.path}`, target: event.id, message: `set-object-props: ${error.message}.` });
          // Text colours the action changes, over the block's values.
          const changed = fieldsOf(action.props);
          for (const found of textContrasts(manifest, { ...fieldsOf(fieldsOf(block.props).props), ...changed }, resolveTokens(ctx.course))) {
            const set = Object.hasOwn(changed, found.prop) ? found.prop : Object.hasOwn(changed, found.on) ? found.on : null;
            if (set && found.ratio !== null) reporter.emit('E_OBJECT_TEXT_CONTRAST', { file, path: `${at}/props/${set}`, target: event.id, measured: found.ratio, limit: TEXT_CONTRAST, message: `set-object-props: ${found.message}.` });
          }
          break;
        }
      }
    };
    list(event.do).forEach((action, i) => { if (action !== null && action !== undefined) checkAction(action, `${base}/do/${i}`); });
    list(event.else).forEach((action, i) => { if (action !== null && action !== undefined) checkAction(action, `${base}/else/${i}`); });
    // An event being written (its trigger chosen, its actions not yet) is valid but does nothing.
    if (Array.isArray(event.do) && !event.do.length && !list(event.else).length) reporter.emit('W_EVENT_NO_ACTION', { file, path: `${base}/do`, target: event.id, message: `Event "${event.id}" has no action: it does nothing.` });
  });

  // Step settings (screen.steps): only for steps of the screen after the first (shown from the
  // start); a step that opens once answered needs an activity above it.
  const firstStep = Math.min(...steps);
  const flat = (blocks: readonly (Block | null | undefined)[] | undefined): Block[] => list(blocks).flatMap((block) => (block === null || block === undefined ? [] : [block, ...flat(block.blocks)]));
  const activityBefore = (step: number) => list(data.blocks).some((block) => block !== null && block !== undefined && (block.step || 1) < step
    && flat([block]).some((inner) => hasId(STEP_ACTIVITIES, instanceBehavior(registry, inner))));
  const opensAnswered = new Set<number>();
  for (const [key, value] of Object.entries(fieldsOf(data.steps))) {
    const step = Number(key);
    if (!steps.has(step) || step === firstStep) {
      reporter.emit('W_STEP_SETTING_UNUSED', { file, path: `/steps/${key}`, target: screenId, message: steps.has(step) ? `Step ${step} is the first step of "${screenId}": it is shown from the start, its settings are not used.` : `"${screenId}" has no block of step ${step}: its settings are not used.` });
      continue;
    }
    if (fieldsOf(value).opens !== 'answered') continue;
    if (activityBefore(step)) opensAnswered.add(step);
    else reporter.emit('E_STEP_UNREACHABLE', { file, path: `/steps/${key}/opens`, target: screenId, message: `Step ${step} of "${screenId}" opens once the activities above it are answered, but no activity comes before it: the learner would never see it.` });
  }

  // Steps that Continue does not reveal need a reveal-step that reaches them (or to open once answered).
  if (data.continueRevealsSteps === false) {
    const reach = Math.max(0, ...events.flatMap((event) => (event === null || event === undefined ? [] : [...list(event.do), ...list(event.else)])).filter((action) => action?.type === 'reveal-step').map((action) => Number(action.step)));
    const unreached = [...steps].filter((step) => step > firstStep && step > reach && !opensAnswered.has(step)).sort((a, b) => a - b);
    if (unreached.length) reporter.emit('E_STEP_UNREACHABLE', { file, path: '/continueRevealsSteps', target: screenId, message: `Continue does not reveal the steps of "${screenId}" and no reveal-step action reaches step ${unreached.join(', ')}: the learner would never see ${unreached.length > 1 ? 'them' : 'it'}.` });
  }

  // Dialogues open layers too (their options' and cues' actions, D61).
  for (const block of local.values()) if (registry.get(block.type)?.behavior === 'dialogue') for (const layer of dialogueLayers(block)) shownLayers.add(layer);
  list(data.layers).forEach((layer, i) => {
    if (layer === null || layer === undefined) return;
    if (!shownLayers.has(layer.id)) reporter.emit('W_UNREACHABLE_LAYER', { file, path: `/layers/${i}`, target: layer.id, message: `Layer "${layer.id}" is never shown by a show-layer action.` });
  });
}

// What a dialogue trigger or condition filters on, checked against the dialogue: its nodes, options,
// lines and endings (D61).
function dialogueFilterProblem(block: Block, filter: { node?: string; option?: string; line?: string; ending?: string; chosen?: string }): { field: string; message: string } | null {
  const props = fieldsOf(block.props);
  const nodes = list(props.nodes).map(fieldsOf);
  const node = (id: unknown) => nodes.find((candidate) => candidate.id === id);
  if (filter.node !== undefined && !node(filter.node)) return { field: 'node', message: `dialogue "${block.id}" has no node "${filter.node}".` };
  if (filter.option !== undefined) {
    const holders = filter.node !== undefined ? [node(filter.node)!] : nodes;
    if (!holders.some((holder) => list(holder.options).some((option) => fieldsOf(option).id === filter.option))) return { field: 'option', message: `dialogue "${block.id}" has no option "${filter.option}"${filter.node !== undefined ? ` in node "${filter.node}"` : ''}.` };
  }
  if (filter.line !== undefined) {
    const lines = nodes.flatMap((holder) => [...list(holder.lines), ...list(holder.options).flatMap((option) => list(fieldsOf(option).reply))]).map((line) => fieldsOf(line).id);
    if (!lines.includes(filter.line)) return { field: 'line', message: `dialogue "${block.id}" has no line "${filter.line}".` };
  }
  if (filter.ending !== undefined && !list(props.endings).some((ending) => fieldsOf(ending).id === filter.ending)) return { field: 'ending', message: `dialogue "${block.id}" has no ending "${filter.ending}".` };
  if (filter.chosen !== undefined) {
    const [nodeId, option] = filter.chosen.split('.');
    if (!list(node(nodeId)?.options).some((candidate) => fieldsOf(candidate).id === option)) return { field: 'chosen', message: `dialogue "${block.id}" has no option "${filter.chosen}" (node.option).` };
  }
  return null;
}

// The layers a dialogue's options and cues open.
function dialogueLayers(block: Block): string[] {
  const out: string[] = [];
  const actions = (value: unknown) => { for (const action of list(value)) { const fields = fieldsOf(action); if (fields.type === 'show-layer' && typeof fields.layer === 'string') out.push(fields.layer); } };
  const lines = (value: unknown) => { for (const line of list(value)) for (const cue of list(fieldsOf(line).cues)) actions(fieldsOf(cue).do); };
  for (const node of list(fieldsOf(block.props).nodes)) {
    lines(fieldsOf(node).lines);
    for (const option of list(fieldsOf(node).options)) { actions(fieldsOf(option).do); lines(fieldsOf(option).reply); }
  }
  return out;
}
