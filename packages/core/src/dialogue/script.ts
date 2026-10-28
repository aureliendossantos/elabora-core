// A dialogue read as a script (D61): the name, the stage direction, the line; under each option,
// where it goes in a few words, its quality and its note. One model for `elabora dialogue show` (a
// stable text that also serves diffs), the client's export (dialogue/document.ts) and LESSON.md.

import type { DialogueData, DialogueLineItem, DialogueNodeData, DialogueOptionData, DialogueCondition, DialogueAction, DialogueCueData } from '@elabora/player/dialogue/types';
import { isSoundLineData } from '@elabora/player/dialogue/types';
import { lineDirections, withoutDirections } from '../narration/directions.ts';

export interface ScriptLine {
  id: string;
  // The speaker's name (null: a narration).
  who: string | null;
  role: 'character' | 'learner' | 'narration';
  // The stage directions (else the expression), in parentheses after the name.
  direction: string | null;
  text: string;
  cues: string[];
  condition: string | null;
}

export interface ScriptOption {
  letter: string;
  id: string;
  text: string;
  label: string | null;
  quality: string | null;
  points: number;
  // retry, once, fallback, and the effects on the dialogue's variables and the screen.
  marks: string[];
  then: string;
  reply: ScriptLine[];
  feedback: string | null;
  condition: string | null;
}

export interface ScriptNode {
  number: number;
  id: string;
  title: string | null;
  final: boolean;
  objective: string | null;
  lines: ScriptLine[];
  prompt: string | null;
  options: ScriptOption[];
  // Where the node goes after its lines (or where options without their own way go).
  then: string;
}

export interface ScriptEnding {
  id: string;
  title: string | null;
  text: string | null;
  condition: string | null;
  score: number | null;
}

export interface DialogueScript {
  id: string;
  screen: string;
  title: string;
  learner: string;
  settings: string[];
  vars: string[];
  nodes: ScriptNode[];
  endings: ScriptEnding[];
}

const SYMBOL: Record<string, string> = { eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤' };

// The words of the script around the course's own: English for agents (elabora dialogue show), the
// course's language in the client's export (French or English).
export interface ScriptWords {
  you: string;
  end: string;
  endChosen: string;
  endNamed: (title: string) => string;
  sameOptions: string;
  otherwise: string;
  when: (conditions: string) => string;
  and: string;
  unknown: (id: string) => string;
  chose: (ref: string) => string;
  after: (node: string) => string;
  courseVariable: (name: string) => string;
  score: string;
  retry: string;
  once: string;
  fallback: string;
  greyed: string;
  objective: (id: string) => string;
  narration: string;
  // A sound line (D67): « sound sonnerie ».
  sound: (id: string) => string;
}

export const SCRIPT_WORDS: Readonly<Record<'en' | 'fr', ScriptWords>> = {
  en: {
    you: 'You', end: 'the end', endChosen: 'the end (its conditions choose)', endNamed: (title) => `the end « ${title} »`, sameOptions: 'the same options again',
    otherwise: 'otherwise', when: (conditions) => `if ${conditions}`, and: ' and ', unknown: (id) => `${id} (unknown)`, chose: (ref) => `chose ${ref}`, after: (node) => `after ${node}`,
    courseVariable: (name) => `course variable ${name}`, score: 'score', retry: 'retry', once: 'once', fallback: 'fallback (taken by itself when nothing else can be chosen)', greyed: 'greyed when unavailable',
    objective: (id) => `objective ${id}`, narration: 'narration', sound: (id) => `sound ${id}`
  },
  fr: {
    you: 'Vous', end: 'la fin', endChosen: 'la fin (selon ses conditions)', endNamed: (title) => `la fin « ${title} »`, sameOptions: 'les mêmes options à nouveau',
    otherwise: 'sinon', when: (conditions) => `si ${conditions}`, and: ' et ', unknown: (id) => `${id} (inconnu)`, chose: (ref) => `a choisi ${ref}`, after: (node) => `après ${node}`,
    courseVariable: (name) => `variable du module ${name}`, score: 'score', retry: 'réessayer', once: 'une seule fois', fallback: 'repli (pris d\'office quand rien d\'autre n\'est possible)', greyed: 'grisée si indisponible',
    objective: (id) => `objectif ${id}`, narration: 'narration', sound: (id) => `son ${id}`
  }
};
export const scriptWords = (language: string | undefined): ScriptWords => (/^fr\b/i.test(language ?? '') ? SCRIPT_WORDS.fr : SCRIPT_WORDS.en);
// « Vous choisissez », « You choose »: a learner named in the second person (the default « You »,
// an author's « Vous ») takes its verb; a named character takes the third person.
export function choosesVerb(learner: string, language: 'fr' | 'en' = 'en'): string {
  const second = /^(vous|you)$/i.test(learner.trim());
  return language === 'fr' ? (second ? 'choisissez' : 'choisit') : (second ? 'choose' : 'chooses');
}

export const letterOf = (index: number): string => String.fromCharCode(65 + (index % 26));
const signed = (value: number): string => (value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0');
const quoted = (value: unknown): string => (typeof value === 'string' ? `« ${value} »` : String(value));

export function describeCondition(condition: DialogueCondition, words: ScriptWords = SCRIPT_WORDS.en): string {
  if ('chosen' in condition) return words.chose(condition.chosen);
  if ('seen' in condition) return words.after(condition.seen);
  if ('var' in condition) return `${condition.var} ${SYMBOL[condition.op] ?? condition.op} ${quoted(condition.value)}`;
  if ('variable' in condition) return `${words.courseVariable(condition.variable)} ${SYMBOL[condition.op] ?? condition.op} ${quoted(condition.value)}`;
  if ('score' in condition) return `${words.score} ${SYMBOL[condition.score.op] ?? condition.score.op} ${condition.score.value}`;
  return '?';
}
export const describeConditions = (conditions: readonly DialogueCondition[] | undefined, words: ScriptWords = SCRIPT_WORDS.en): string | null => (conditions?.length ? conditions.map((condition) => describeCondition(condition, words)).join(words.and) : null);

export const describeAction = (action: DialogueAction): string => [action.type, action.block ?? action.layer ?? (action.step !== undefined ? `step ${action.step}` : '')].filter(Boolean).join(' ') + (action.props ? ` ${JSON.stringify(action.props)}` : '');

function describeCue(cue: DialogueCueData): string {
  const at = cue.at.word ? `« ${cue.at.word} »${cue.at.occurrence && cue.at.occurrence > 1 ? ` #${cue.at.occurrence}` : ''}` : 'the line';
  const when = `at ${at}${cue.at.edge === 'end' ? ' (end)' : ''}${cue.at.offset ? ` ${cue.at.offset > 0 ? '+' : ''}${cue.at.offset}s` : ''}`;
  const what = [cue.gesture ? `gesture ${cue.gesture}` : '', cue.expression ? `expression ${cue.expression}` : '', ...(cue.do ?? []).map(describeAction)].filter(Boolean).join(', ');
  return `${when}: ${what}`;
}

export function dialogueScript(data: DialogueData, { id, screen, words = SCRIPT_WORDS.en }: { id: string; screen: string; words?: ScriptWords }): DialogueScript {
  const numbers = new Map(data.nodes.map((node, index) => [node.id, index + 1]));
  const nodeName = (target: string): string => {
    const node = data.nodes.find((candidate) => candidate.id === target);
    return node ? `${numbers.get(target)} ${node.title ?? node.id}` : words.unknown(target);
  };
  const endName = (end: true | string): string => {
    if (end === true) return data.endings.length ? words.endChosen : words.end;
    const ending = data.endings.find((candidate) => candidate.id === end);
    return ending ? words.endNamed(ending.title ?? ending.id) : words.unknown(end);
  };
  const conditionsText = (conditions: readonly DialogueCondition[] | undefined) => describeConditions(conditions, words);
  const learnerName = data.learner ? data.speakers[data.learner]?.name ?? data.learner : words.you;
  const line = (value: DialogueLineItem): ScriptLine => {
    // A sound: a narration that names it, its caption as its text.
    if (isSoundLineData(value)) return { id: value.id, who: null, role: 'narration', direction: words.sound(value.sound), text: value.caption ?? '', cues: [], condition: conditionsText(value.if) };
    const speaker = value.speaker ? data.speakers[value.speaker] : undefined;
    const narration = !value.speaker || speaker?.narrator === true;
    // The stage directions as written (« inquiet, au téléphone »), else the expression.
    const directions = lineDirections(value.text).map((direction) => direction.text);
    const parts = directions.length ? directions : value.expression ? [value.expression] : [];
    return {
      id: value.id, who: value.speaker ? speaker?.name ?? value.speaker : null,
      role: narration ? 'narration' : value.speaker === data.learner ? 'learner' : 'character',
      direction: parts.length ? parts.join(', ') : null, text: withoutDirections(value.text),
      cues: (value.cues ?? []).map(describeCue), condition: conditionsText(value.if)
    };
  };
  const wayOut = (node: DialogueNodeData, index: number): string => {
    if (typeof node.next === 'string') return nodeName(node.next);
    const fallthrough = node.end !== undefined ? endName(node.end) : data.nodes[index + 1] ? nodeName(data.nodes[index + 1].id) : words.end;
    if (Array.isArray(node.next)) {
      const cases = node.next.map((entry) => (entry.if?.length ? `${words.when(conditionsText(entry.if) ?? '')}, ${nodeName(entry.go)}` : nodeName(entry.go)));
      const open = node.next.every((entry) => entry.if?.length);
      return `${cases.join(`; ${words.otherwise} `)}${open ? `; ${words.otherwise} ${fallthrough}` : ''}`;
    }
    return fallthrough;
  };
  const option = (value: DialogueOptionData, index: number, node: DialogueNodeData, common: string): ScriptOption => {
    const marks: string[] = [];
    if (value.retry && data.revisit !== 'none') marks.push(words.retry);
    if (value.once) marks.push(words.once);
    if (value.fallback) marks.push(words.fallback);
    if (value.unavailable === 'disable' && (value.if?.length || value.once)) marks.push(`${words.greyed}${value.unavailableText ? ` (« ${value.unavailableText} »)` : ''}`);
    for (const [name, set] of Object.entries(value.set ?? {})) marks.push(`${name} = ${quoted(set)}`);
    for (const [name, by] of Object.entries(value.add ?? {})) marks.push(`${name} ${signed(by)}`);
    for (const action of value.do ?? []) marks.push(describeAction(action));
    if (value.objective) marks.push(words.objective(value.objective));
    const then = value.retry && data.revisit !== 'none' ? words.sameOptions : value.next !== undefined ? nodeName(value.next) : value.end !== undefined ? endName(value.end) : common;
    return {
      letter: letterOf(index), id: value.id, text: value.text ?? '', label: value.label && value.label !== value.text ? value.label : null,
      quality: value.quality ?? null, points: value.points || 0, marks, then,
      reply: value.reply.map(line), feedback: value.feedback ?? null, condition: conditionsText(value.if)
    };
  };
  const settings = [
    data.mode, `revisit ${data.revisit}`, `feedback ${data.feedback}`, `scoring ${data.scoring}`,
    ...(data.scoring !== 'none' && data.weight !== 1 ? [`weight ${data.weight}`] : []), `style ${data.style}`,
    ...(data.objective ? [`objective ${data.objective}`] : []), ...(data.begins !== 'auto' ? [`begins ${data.begins}`] : []),
    ...(data.pace !== 'auto' ? [`pace ${data.pace}`] : []), ...(data.debrief ? [] : ['no debrief'])
  ];
  return {
    id, screen, title: data.title, learner: learnerName, settings,
    vars: data.vars.map((variable) => `${variable.id} = ${quoted(variable.default)}`),
    nodes: data.nodes.map((node, index) => {
      const common = wayOut(node, index);
      return {
        number: index + 1, id: node.id, title: node.title ?? null, final: node.final === true, objective: node.objective ?? null,
        lines: node.lines.map(line), prompt: node.prompt ?? null,
        options: node.options.map((value, optionIndex) => option(value, optionIndex, node, common)), then: common
      };
    }),
    endings: data.endings.map((ending) => ({ id: ending.id, title: ending.title ?? null, text: ending.text ?? null, condition: conditionsText(ending.if), score: ending.score ?? null }))
  };
}

const lineText = (value: ScriptLine, indent: string): string[] => {
  const who = value.role === 'narration' ? `(${[value.who, value.direction].filter(Boolean).join(', ') || 'narration'})` : `${value.who ?? '?'}${value.direction ? ` (${value.direction})` : ''}:`;
  return [
    `${indent}${value.condition ? `[if ${value.condition}] ` : ''}${who} ${value.text}`,
    ...value.cues.map((cue) => `${indent}  ↳ ${cue}`)
  ];
};

// The script as text: stable (the same dialogue, the same text), so that it also serves diffs.
export function formatScript(script: DialogueScript): string {
  const out: string[] = [];
  out.push(`${script.title}  (dialogue ${script.id}, screen ${script.screen})`);
  out.push(`${script.settings.join(' · ')} · the learner plays ${script.learner}`);
  if (script.vars.length) out.push(`variables: ${script.vars.join(', ')}`);
  for (const node of script.nodes) {
    out.push('');
    out.push(`${node.number}. ${node.title ?? node.id}${node.title ? `  [${node.id}]` : ''}${node.final ? '  — final decision' : ''}${node.objective ? `  (${node.objective})` : ''}`);
    for (const value of node.lines) out.push(...lineText(value, '   '));
    if (node.options.length) {
      out.push(`   ${script.learner} ${choosesVerb(script.learner)}:${node.prompt ? ` ${node.prompt}` : ''}`);
      for (const option of node.options) {
        const head = [option.quality, option.points ? signed(option.points) : '', ...option.marks].filter(Boolean).join(', ');
        out.push(`   ${option.letter} [${option.id}]${option.condition ? ` [if ${option.condition}]` : ''} « ${option.text || '…'} »${option.label ? ` (button: ${option.label})` : ''}${head ? `  ${head}` : ''}`);
        for (const value of option.reply) out.push(...lineText(value, '      '));
        if (option.feedback) out.push(`      Feedback: ${option.feedback.replace(/\s*\n\s*/g, ' ')}`);
        out.push(`      then ${option.then}`);
      }
      if (node.options.some((option) => option.then === node.then)) out.push(`   (options without a way of their own: then ${node.then})`);
    } else out.push(`   then ${node.then}`);
  }
  if (script.endings.length) {
    out.push('');
    out.push('Endings');
    for (const ending of script.endings) out.push(`   ${ending.id} « ${ending.title ?? ending.id} »${ending.score !== null ? `  score ${ending.score}` : ''}${ending.condition ? `  if ${ending.condition}` : '  (otherwise)'}${ending.text ? `\n      ${ending.text.replace(/\s*\n\s*/g, ' ')}` : ''}`);
  }
  return out.join('\n');
}

// The script in Markdown, in the course's words (LESSON.md, the client's project view).
export function scriptMarkdown(script: DialogueScript, words: ScriptWords = SCRIPT_WORDS.en): string {
  const line = (value: ScriptLine) => (value.role === 'narration' ? `*${value.text}*` : `**${value.who ?? '?'}**${value.direction ? ` (${value.direction})` : ''} : ${value.text}`);
  const out: string[] = [`**${script.title}**`];
  for (const node of script.nodes) {
    out.push('', `${node.number}. **${node.title ?? node.id}**`);
    for (const value of node.lines) out.push('', line(value));
    if (node.options.length) {
      if (node.prompt) out.push('', `*${node.prompt}*`);
      out.push('');
      for (const option of node.options) {
        out.push(`- ${option.letter}. « ${option.text} »${option.quality ? ` (${option.quality})` : ''} → ${option.then}`);
        for (const value of option.reply) out.push(`  - ${line(value)}`);
        if (option.feedback) out.push(`  - ${option.feedback.replace(/\s*\n\s*/g, ' ')}`);
      }
    } else out.push('', `→ ${node.then}`);
  }
  if (script.endings.length) {
    out.push('');
    for (const ending of script.endings) out.push(`- **${ending.title ?? ending.id}**${ending.condition ? ` (${words.when(ending.condition)})` : ''}${ending.text ? ` : ${ending.text.replace(/\s*\n\s*/g, ' ')}` : ''}`);
  }
  return out.join('\n');
}
