// Dialogue blocks (D61): what their schema cannot say. Targets and ids hold, speakers exist,
// conditions and effects name what the dialogue has, actions stay presentation, cues fall in their
// line; then the writing (options, lines, the score's data, endings that cover every score) and the
// graph (what no path reaches, loops without a way out, trees that never join, the decisions cap).

import type { DialogueData, DialogueLineData, DialogueCondition, DialogueAction } from '@elabora/player/dialogue/types';
import { isSoundLineData } from '@elabora/player/dialogue/types';
import { explorePaths } from '@elabora/player/dialogue/paths';
import { MAX_DECISIONS } from '@elabora/player/dialogue/walk';
import { dialogueData } from '../dialogue/data.ts';
import { courseEnv } from '../dialogue/project.ts';
import { dialogueEdges, reachableNodes, nodesReachingEnd } from '../dialogue/graph.ts';
import { narrationWords, findPhrase } from '../narration/words.ts';
import { withoutDirections } from '../narration/directions.ts';
import { screenSteps } from '../narration/narration.ts';
import { voiceLinesOf, trackLabel } from '../narration/voice-lines.ts';
import { screenBlocks } from '../project/load.ts';
import { readText, hasFile } from '../project/files.ts';
import { resolveTokens } from './theme.ts';
import { rootOf } from '../components/registry.ts';
import { characterManifest, characterProblems, characterInline } from '../dialogue/character.ts';
import type { Block } from '../project/model.ts';
import type { CourseCheckContext, ScreenFile } from './context.ts';
import { fieldsOf, list, hasId, isRecord } from './guards.ts';

// Actions a dialogue may run on its screen: they change what it shows, never the course's state.
export const PRESENTATION_ACTIONS: ReadonlySet<string> = new Set(['show-block', 'hide-block', 'show-layer', 'hide-layer', 'play-media', 'pause-media', 'set-object-props', 'reveal-step', 'play-sound', 'stop-sound']);
// A bubble reads at a glance.
export const LINE_MAX = 280;
// The longest option at most this many times the shortest.
export const OPTIONS_SPREAD = 2.5;
export const OPTIONS_MAX = 4;
// Decisions in a row that branch without joining.
export const TREE_MAX = 3;

export function checkDialogues(ctx: CourseCheckContext, screen: ScreenFile): void {
  const { registry } = ctx;
  const { file, data } = screen;
  // Line ids are unique in the screen, every track counted (E_NARRATION_LINE_DUPLICATE): the voice
  // lines are checked with the narration (checkScreenNarration); a dialogue's narrations without a
  // voice (no speaker) are not voice lines, and are checked here against them all.
  const lineIds = new Map<string, string>();
  for (const { line, track } of voiceLinesOf(data, screen.id, ctx.project)) if (!lineIds.has(line.id)) lineIds.set(line.id, trackLabel(track));
  for (const { block, path } of screenBlocks(data, file)) {
    if (!block || rootOf(registry, block.type) !== 'dialogue') continue;
    checkDialogue(ctx, screen, block, path, lineIds);
  }
}

function checkDialogue(ctx: CourseCheckContext, screen: ScreenFile, block: Block, path: string, lineIds: Map<string, string>): void {
  const { reporter, project, course, planIndex } = ctx;
  const { id: screenId, file, data: screenData } = screen;
  const props = fieldsOf(block.props);
  const id = block.id;
  const emit = (code: string, at: string, message: string, extra: Record<string, unknown> = {}) => reporter.emit(code, { file, path: `${path}/props${at}`, target: id, message: `Dialogue "${id}": ${message}`, ...extra });
  const data: DialogueData = dialogueData(props, { course, env: courseEnv(project) });
  const nodeIds = new Set(data.nodes.map((node) => node.id));
  const endingIds = new Set(data.endings.map((ending) => ending.id));
  const varTypes = new Map(data.vars.map((variable) => [variable.id, typeof variable.default]));
  const speakers = new Map(list(course.speakers).filter((speaker) => speaker && typeof speaker.id === 'string').map((speaker) => [speaker.id, speaker]));
  const local = new Set<string>();
  for (const { block: other } of screenBlocks(screenData, file)) if (other?.id) local.add(other.id);
  const layers = new Set(list(screenData.layers).map((layer) => layer?.id));
  const steps = new Set(screenSteps(screenData));
  const listed = (values: Iterable<string>) => [...values].slice(0, 12).join(', ') || 'none';

  // ── ids ──
  const duplicates = (values: readonly { id: string }[], at: (index: number) => string, what: string) => {
    const seen = new Map<string, number>();
    values.forEach((value, index) => {
      if (!value.id) return;
      if (seen.has(value.id)) emit('E_DIALOGUE_DUPLICATE_ID', at(index), `${what} ${seen.get(value.id)! + 1} and ${index + 1} are both "${value.id}".`);
      else seen.set(value.id, index);
    });
  };
  duplicates(data.nodes, (index) => `/nodes/${index}/id`, 'nodes');
  duplicates(data.endings, (index) => `/endings/${index}/id`, 'endings');
  duplicates(data.vars, (index) => `/vars/${index}/id`, 'variables');
  data.nodes.forEach((node, index) => duplicates(node.options, (optionIndex) => `/nodes/${index}/options/${optionIndex}/id`, `options of node "${node.id}"`));

  // ── speakers and looks ──
  const speakerKnown = (speaker: string | undefined, at: string, what: string) => {
    if (speaker !== undefined && !speakers.has(speaker)) emit('E_DIALOGUE_SPEAKER', at, `${what} names speaker "${speaker}", which course.json speakers does not have (speakers: ${listed(speakers.keys())}).`);
  };
  speakerKnown(data.learner ?? undefined, '/learner', 'learner');
  list(fieldsOf(props.scene).cast).forEach((member, index) => speakerKnown(fieldsOf(member).speaker as string | undefined, `/scene/cast/${index}/speaker`, 'the cast'));
  const looks = new Map<string, { expressions: Set<string> | null; gestures: Set<string> | null }>();
  const lookOf = (speaker: string) => {
    if (!looks.has(speaker)) looks.set(speaker, declaredLook(ctx, fieldsOf(speakers.get(speaker)?.look)));
    return looks.get(speaker)!;
  };

  // ── conditions, effects, actions ──
  const condition = (value: DialogueCondition, at: string) => {
    if ('chosen' in value) {
      const [node, option] = value.chosen.split('.');
      const found = data.nodes.find((candidate) => candidate.id === node);
      if (!found) emit('E_DIALOGUE_CONDITION', `${at}/chosen`, `chosen names node "${node}", which the dialogue does not have.`);
      else if (!found.options.some((candidate) => candidate.id === option)) emit('E_DIALOGUE_CONDITION', `${at}/chosen`, `chosen names option "${option}" of "${node}", which has ${listed(found.options.map((candidate) => candidate.id))}.`);
    } else if ('seen' in value) {
      if (!nodeIds.has(value.seen)) emit('E_DIALOGUE_CONDITION', `${at}/seen`, `seen names node "${value.seen}", which the dialogue does not have.`);
    } else if ('var' in value) {
      const type = varTypes.get(value.var);
      if (!type) emit('E_DIALOGUE_CONDITION', `${at}/var`, `var "${value.var}" is not a variable of the dialogue (vars: ${listed(varTypes.keys())}).`);
      else if (typeof value.value !== type) emit('E_DIALOGUE_CONDITION', `${at}/value`, `var "${value.var}" is a ${type}, compared with ${JSON.stringify(value.value)}.`);
      else if (['gt', 'gte', 'lt', 'lte'].includes(value.op) && type !== 'number') emit('E_DIALOGUE_CONDITION', `${at}/op`, `${value.op} needs a number variable; "${value.var}" is a ${type}.`);
    } else if ('variable' in value) {
      const variable = ctx.variables.get(value.variable);
      if (!variable) emit('E_DIALOGUE_CONDITION', `${at}/variable`, `variable "${value.variable}" is not a variable of the course.`);
      else if (['gt', 'gte', 'lt', 'lte'].includes(value.op) && variable.type !== 'number') emit('E_DIALOGUE_CONDITION', `${at}/op`, `${value.op} needs a number variable; "${value.variable}" is ${variable.type}.`);
    }
  };
  const conditions = (values: readonly DialogueCondition[] | undefined, at: string) => (values ?? []).forEach((value, index) => condition(value, `${at}/${index}`));
  const actions = (values: readonly DialogueAction[] | undefined, at: string) => (values ?? []).forEach((action, index) => {
    const where = `${at}/${index}`;
    if (!PRESENTATION_ACTIONS.has(action.type)) { emit('E_DIALOGUE_ACTION', `${where}/type`, `${action.type} is not an action a dialogue may run (${[...PRESENTATION_ACTIONS].join(', ')}).`); return; }
    if (['show-block', 'hide-block', 'set-object-props', 'play-media', 'pause-media'].includes(action.type) && !hasId(local, action.block)) reporter.emit('E_ACTION_TARGET', { file, path: `${path}/props${where}/block`, target: id, message: `Dialogue "${id}": ${action.type} names no block "${action.block ?? ''}" of screen "${screenId}".` });
    if ((action.type === 'show-layer' || (action.type === 'hide-layer' && action.layer !== undefined)) && !hasId(layers, action.layer)) reporter.emit('E_ACTION_TARGET', { file, path: `${path}/props${where}/layer`, target: id, message: `Dialogue "${id}": ${action.type} names no layer "${action.layer ?? ''}" of screen "${screenId}".` });
    if (action.type === 'reveal-step' && !hasId(steps, action.step)) reporter.emit('E_ACTION_TARGET', { file, path: `${path}/props${where}/step`, target: id, message: `Dialogue "${id}": reveal-step ${action.step ?? ''}, a step screen "${screenId}" does not have.` });
  });

  // ── lines ──
  const line = (value: DialogueLineData, at: string) => {
    if (value.id && value.speaker === undefined) {
      const where = lineIds.get(value.id);
      if (where) reporter.emit('E_NARRATION_LINE_DUPLICATE', { file, path: `${path}/props${at}/id`, target: screenId, details: { screen: screenId, line: value.id }, message: `Screen "${screenId}" has two lines "${value.id}": in ${where} and in dialogue "${id}" (ids are unique in the screen, every track counted).` });
      else lineIds.set(value.id, `dialogue "${id}"`);
    }
    speakerKnown(value.speaker, `${at}/speaker`, `line "${value.id}"`);
    const shown = withoutDirections(value.text);
    if (shown.length > LINE_MAX) emit('W_DIALOGUE_LINE_LONG', `${at}/text`, `line "${value.id}" has ${shown.length} characters (a bubble reads at a glance: under ${LINE_MAX}).`, { measured: shown.length, limit: LINE_MAX });
    const words = narrationWords(value.text, course.language);
    (value.cues ?? []).forEach((cue, index) => {
      const where = `${at}/cues/${index}`;
      if (cue.at.line !== undefined && cue.at.line !== value.id) emit('E_DIALOGUE_CUE', `${where}/at/line`, `a cue of line "${value.id}" names line "${cue.at.line}": a cue falls in its own line.`);
      else if (cue.at.word !== undefined && !findPhrase(words, cue.at.word, { occurrence: cue.at.occurrence ?? 1, language: course.language })) emit('E_DIALOGUE_CUE', `${where}/at/word`, `line "${value.id}" does not say « ${cue.at.word} »${(cue.at.occurrence ?? 1) > 1 ? ` ${cue.at.occurrence} times` : ''}.`);
      actions(cue.do, `${where}/do`);
      if (value.speaker && speakers.has(value.speaker)) {
        const look = lookOf(value.speaker);
        if (cue.gesture && look.gestures && !look.gestures.has(cue.gesture)) emit('W_DIALOGUE_LOOK', `${where}/gesture`, `${value.speaker} has no gesture "${cue.gesture}" (gestures: ${listed(look.gestures)}).`);
        if (cue.expression && look.expressions && !look.expressions.has(cue.expression)) emit('W_DIALOGUE_LOOK', `${where}/expression`, `${value.speaker} has no expression "${cue.expression}" (expressions: ${listed(look.expressions)}).`);
      }
    });
    if (value.expression && value.speaker && speakers.has(value.speaker)) {
      const look = lookOf(value.speaker);
      if (look.expressions && !look.expressions.has(value.expression)) emit('W_DIALOGUE_LOOK', `${at}/expression`, `${value.speaker} has no expression "${value.expression}" (expressions: ${listed(look.expressions)}).`);
    }
    conditions(value.if, `${at}/if`);
  };

  // ── nodes ──
  const objective = (value: string | undefined, at: string) => {
    if (value !== undefined && project.plan && !hasId(planIndex.objectives, value)) reporter.emit('E_PLAN_REFERENCE', { file, path: `${path}/props${at}`, target: id, message: `Dialogue "${id}" names unknown objective "${value}".` });
  };
  const target = (value: string | undefined, at: string, what: string) => {
    if (value !== undefined && !nodeIds.has(value)) emit('E_DIALOGUE_TARGET', at, `${what} goes to node "${value}", which the dialogue does not have (nodes: ${listed(nodeIds)}).`);
  };
  const ending = (value: true | string | undefined, at: string, what: string) => {
    if (typeof value === 'string' && !endingIds.has(value)) emit('E_DIALOGUE_TARGET', at, `${what} ends on "${value}", which is not one of its endings (${listed(endingIds)}).`);
  };
  if (typeof props.start === 'string') target(props.start, '/start', 'start');
  let anyPoints = false;
  data.nodes.forEach((node, index) => {
    const at = `/nodes/${index}`;
    objective(node.objective, `${at}/objective`);
    list(fieldsOf(fieldsOf(list(props.nodes)[index]).scene).cast).forEach((member, castIndex) => speakerKnown(fieldsOf(member).speaker as string | undefined, `${at}/scene/cast/${castIndex}/speaker`, `the cast of node "${node.id}"`));
    node.lines.forEach((value, lineIndex) => (isSoundLineData(value) ? conditions(value.if, `${at}/lines/${lineIndex}/if`) : line(value, `${at}/lines/${lineIndex}`)));
    if (typeof node.next === 'string') target(node.next, `${at}/next`, `node "${node.id}"`);
    else if (Array.isArray(node.next)) {
      node.next.forEach((entry, caseIndex) => { target(entry.go, `${at}/next/${caseIndex}/go`, `node "${node.id}"`); conditions(entry.if, `${at}/next/${caseIndex}/if`); });
      if (node.next.every((entry) => entry.if?.length) && node.end === undefined) {
        const fall = data.nodes[index + 1]?.id;
        emit('E_DIALOGUE_DEAD_END', `${at}/next`, `when none of the next cases of node "${node.id}" holds, it has nowhere said to go (the walk would fall to ${fall ? `"${fall}"` : 'the end'}): end the cases with one without if.`);
      }
    }
    ending(node.end, `${at}/end`, `node "${node.id}"`);
    const shown = node.options.filter((option) => !option.fallback);
    if (shown.length > OPTIONS_MAX) emit('W_DIALOGUE_OPTIONS_MANY', `${at}/options`, `node "${node.id}" offers ${shown.length} options.`, { measured: shown.length, limit: OPTIONS_MAX });
    const lengths = shown.map((option) => (option.label ?? option.text ?? '').length).filter((length) => length > 0);
    if (lengths.length > 1 && Math.max(...lengths) > OPTIONS_SPREAD * Math.min(...lengths)) {
      const longest = shown.reduce((best, option) => ((option.label ?? option.text ?? '').length > (best.label ?? best.text ?? '').length ? option : best));
      emit('W_DIALOGUE_OPTIONS_UNEVEN', `${at}/options`, `in node "${node.id}", option ${longest.id} has ${Math.max(...lengths)} characters, the shortest ${Math.min(...lengths)}.`, { measured: Math.round((Math.max(...lengths) / Math.min(...lengths)) * 10) / 10, limit: OPTIONS_SPREAD });
    }
    node.options.forEach((option, optionIndex) => {
      const where = `${at}/options/${optionIndex}`;
      objective(option.objective, `${where}/objective`);
      const text = option.text ?? '';
      if (text.length > LINE_MAX) emit('W_DIALOGUE_LINE_LONG', `${where}/text`, `option ${option.id} of "${node.id}" has ${text.length} characters.`, { measured: text.length, limit: LINE_MAX });
      target(option.next, `${where}/next`, `option ${option.id} of "${node.id}"`);
      ending(option.end, `${where}/end`, `option ${option.id} of "${node.id}"`);
      for (const [name, value] of Object.entries(option.set ?? {})) {
        const type = varTypes.get(name);
        if (!type) emit('E_DIALOGUE_VAR', `${where}/set/${name}`, `option ${option.id} of "${node.id}" sets "${name}", which is not a variable of the dialogue (vars: ${listed(varTypes.keys())}).`);
        else if (typeof value !== type) emit('E_DIALOGUE_VAR', `${where}/set/${name}`, `"${name}" is a ${type}; option ${option.id} sets it to ${JSON.stringify(value)}.`);
      }
      for (const name of Object.keys(option.add ?? {})) {
        const type = varTypes.get(name);
        if (!type) emit('E_DIALOGUE_VAR', `${where}/add/${name}`, `option ${option.id} of "${node.id}" adds to "${name}", which is not a variable of the dialogue (vars: ${listed(varTypes.keys())}).`);
        else if (type !== 'number') emit('E_DIALOGUE_VAR', `${where}/add/${name}`, `add needs a number variable; "${name}" is a ${type}.`);
      }
      actions(option.do, `${where}/do`);
      option.reply.forEach((value, lineIndex) => (isSoundLineData(value) ? conditions(value.if, `${where}/reply/${lineIndex}/if`) : line(value, `${where}/reply/${lineIndex}`)));
      conditions(option.if, `${where}/if`);
      if (option.points) anyPoints = true;
      if (data.scoring === 'quality' && !option.fallback && !option.quality) emit('W_DIALOGUE_SCORE_MISSING', `${where}`, `option ${option.id} of "${node.id}" has no quality (good, ok or bad), which scoring quality counts.`);
    });
  });
  if (data.scoring === 'points' && !anyPoints && data.nodes.some((node) => node.options.length)) emit('W_DIALOGUE_SCORE_MISSING', '/scoring', 'scoring points, but no option has points.');
  data.endings.forEach((value, index) => {
    conditions(value.if, `/endings/${index}/if`);
    if (data.scoring === 'ending' && value.score === undefined) emit('W_DIALOGUE_SCORE_MISSING', `/endings/${index}`, `ending "${value.id}" has no score, which scoring ending counts.`);
  });
  if (data.scoring === 'ending' && !data.endings.length) emit('W_DIALOGUE_SCORE_MISSING', '/scoring', 'scoring ending, but the dialogue has no endings to score.');
  if (data.endings.length && data.endings.every((value) => value.if?.length)) {
    const gap = scoreGap(data);
    emit('W_DIALOGUE_ENDINGS_UNCOVERED', '/endings', gap ? `no ending holds for a score ${gap}: the dialogue would end without title.` : 'every ending has a condition: when none holds, the dialogue ends without title.');
  }
  if (data.mode === 'practice' && (data.revisit === 'none' || data.revisit === 'retry')) emit('W_DIALOGUE_NO_RETURN', '/revisit', `practice with revisit ${data.revisit}: once the first run ends, the learner cannot see the other consequences.`);

  // ── the graph ──
  if (!data.nodes.length) return;
  const edges = dialogueEdges(data);
  const jumps = screenJumps(screenData, id);
  const reached = reachableNodes(data, edges, jumps);
  data.nodes.forEach((node, index) => { if (node.id && !reached.has(node.id)) emit('W_DIALOGUE_UNREACHABLE', `/nodes/${index}`, `no path reaches node "${node.id}".`); });
  const reaching = nodesReachingEnd(edges, data.nodes.map((node) => node.id));
  const trapped = [...reached].filter((node) => !reaching.has(node));
  if (trapped.length) emit('W_DIALOGUE_LOOP', `/nodes/${data.nodes.findIndex((node) => node.id === trapped[0])}`, `from ${trapped.length > 1 ? `nodes ${trapped.join(', ')}` : `node "${trapped[0]}"`}, no path reaches an end.`);
  const depth = treeDepth(data, edges, jumps);
  if (depth > TREE_MAX) emit('W_DIALOGUE_TREE', '/nodes', `${depth} decisions in a row branch without joining.`, { measured: depth, limit: TREE_MAX });
  const exploration = explorePaths(data, { env: courseEnv(project) });
  if (exploration.capped) emit('W_DIALOGUE_DECISION_CAP', '/nodes', `a path stops at the decisions cap (${MAX_DECISIONS}) or in a loop of nodes without options.`, { limit: MAX_DECISIONS });
  // Endings no path reaches: told by the paths themselves when they could all be walked and no
  // condition reads the course's variables (whose values change while learners play).
  if (exploration.complete && !JSON.stringify(props).includes('"variable"')) {
    data.endings.forEach((value, index) => { if (!exploration.endings.has(value.id)) emit('W_DIALOGUE_UNREACHABLE', `/endings/${index}`, `no path reaches ending "${value.id}".`); });
  }
}

// The nodes goto-dialogue actions of the screen's events send this dialogue to.
function screenJumps(screen: ScreenFile['data'], block: string): string[] {
  const out: string[] = [];
  for (const event of list(screen.events)) {
    for (const action of [...list(event?.do), ...list(event?.else)]) {
      const fields = fieldsOf(action);
      if (fields.type === 'goto-dialogue' && fields.block === block && typeof fields.node === 'string') out.push(fields.node);
    }
  }
  return out;
}

// The most decisions in a row that branch (options going to two places or more) without the paths
// joining (each place reached from that decision only), from the start or a node a jump reaches.
function treeDepth(data: DialogueData, edges: ReturnType<typeof dialogueEdges>, jumps: readonly string[]): number {
  const incoming = new Map<string, Set<string>>();
  for (const edge of edges) if (edge.to !== null && edge.to !== edge.from) { if (!incoming.has(edge.to)) incoming.set(edge.to, new Set()); incoming.get(edge.to)!.add(edge.from); }
  const memo = new Map<string, number>();
  const depth = (node: string, trail: Set<string>): number => {
    if (memo.has(node)) return memo.get(node)!;
    if (trail.has(node)) return 0;
    trail.add(node);
    const out = edges.filter((edge) => edge.from === node && edge.to !== node);
    const targets = new Set(out.map((edge) => edge.to ?? `end:${String(edge.end)}`));
    const branching = data.nodes.find((candidate) => candidate.id === node)?.options.length && targets.size > 1;
    let best = 0;
    for (const edge of out) if (edge.to !== null && (incoming.get(edge.to)?.size ?? 0) <= 1) best = Math.max(best, depth(edge.to, trail));
    trail.delete(node);
    const value = (branching ? 1 : 0) + best;
    memo.set(node, value);
    return value;
  };
  return Math.max(0, ...[data.start, ...jumps].map((start) => depth(start, new Set())));
}

// The scores no ending covers, when every ending is chosen by score alone (« from 40 to 60 »);
// null when the conditions read anything else.
function scoreGap(data: DialogueData): string | null {
  const ranges: [number, number][] = [];
  for (const ending of data.endings) {
    let low = 0;
    let high = 100;
    for (const value of ending.if ?? []) {
      if (!('score' in value)) return null;
      const { op, value: bound } = value.score;
      if (op === 'gte') low = Math.max(low, bound);
      else if (op === 'gt') low = Math.max(low, bound + 1e-9);
      else if (op === 'lte') high = Math.min(high, bound);
      else if (op === 'lt') high = Math.min(high, bound - 1e-9);
      else if (op === 'eq') { low = Math.max(low, bound); high = Math.min(high, bound); }
      else return null;
    }
    if (low <= high) ranges.push([low, high]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let started = false;
  for (const [low, high] of ranges) {
    if (low > covered + 1e-6 && (started || low > 0)) return `from ${round(covered)} to ${round(low)}`;
    covered = Math.max(covered, high);
    started = true;
  }
  if (!started) return 'from 0 to 100';
  return covered < 100 - 1e-6 ? `from ${round(covered)} to 100` : null;
}
const round = (value: number) => Math.round(value * 10) / 10;

// The expressions and gestures a character's look declares (null: it declares none, nothing to check):
// its SVG's manifest (data-expressions, data-gestures), or its pictures' expressions.
function declaredLook(ctx: CourseCheckContext, look: Record<string, unknown>): { expressions: Set<string> | null; gestures: Set<string> | null } {
  if (typeof look.svg === 'string') {
    const source = readText(ctx.project.files, `assets/${look.svg}`);
    const manifest = source === null ? null : characterManifest(source);
    if (!manifest) return { expressions: null, gestures: null };
    const root = /<svg\b[^>]*>/i.exec(source ?? '')?.[0] ?? '';
    return {
      expressions: /\sdata-expressions\s*=/.test(root) ? new Set(manifest.expressions) : null,
      gestures: /\sdata-gestures\s*=/.test(root) ? new Set(Object.keys(manifest.gestures)) : null
    };
  }
  if (isRecord(look.expressions) || typeof look.portrait === 'string') return { expressions: new Set(Object.keys(fieldsOf(look.expressions))), gestures: new Set() };
  return { expressions: null, gestures: null };
}

// The characters' looks and colours (course.json speakers, D61): their files are in assets/, their
// colour is a token of the theme.
export function checkSpeakerLooks(ctx: CourseCheckContext): void {
  const { reporter, project, course } = ctx;
  const tokens = resolveTokens(course);
  list(course.speakers).forEach((speaker, index) => {
    if (!speaker) return;
    const at = `/speakers/${index}`;
    const look = fieldsOf(speaker.look);
    const files: [string, unknown][] = [['svg', look.svg], ['portrait', look.portrait], ...Object.entries(fieldsOf(look.expressions)).map(([name, file]): [string, unknown] => [`expressions/${name}`, file])];
    for (const [where, file] of files) {
      if (typeof file === 'string' && !hasFile(project.files, `assets/${file}`)) reporter.emit('E_ASSET_MISSING', { file: 'course.json', path: `${at}/look/${where}`, target: speaker.id, message: `Speaker "${speaker.id}": assets/${file} not found.` });
    }
    // A character drawn as an SVG follows the convention (docs/dialogues.md, characters).
    const source = typeof look.svg === 'string' ? readText(project.files, `assets/${look.svg}`) : null;
    if (source !== null) {
      const where = { file: 'course.json', path: `${at}/look/svg`, target: speaker.id };
      for (const problem of characterProblems(source)) {
        reporter.emit(problem.kind === 'convention' ? 'W_CHARACTER_CONVENTION' : 'W_CHARACTER_CONTENT', { ...where, message: `Character "${speaker.id}" (assets/${look.svg}): ${problem.message}.` });
      }
      const removed = characterInline(source, speaker.id)?.removed ?? [];
      if (removed.length) reporter.emit('W_SVG_INLINE_SANITIZED', { ...where, measured: removed.length, message: `assets/${look.svg}, the character "${speaker.id}", lost what is not safe in the page: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}.` });
    }
    if (typeof speaker.color === 'string' && tokens[speaker.color] === undefined) reporter.emit('E_UNKNOWN_REFERENCE', { file: 'course.json', path: `${at}/color`, target: speaker.id, message: `Speaker "${speaker.id}": no theme token "${speaker.color}" (a colour token such as color.accent, or one of theme.custom).` });
  });
}
