// A dialogue's progress in the suspend data (D61): one string per dialogue, under the dialogue's key.
//
//   "p|r|e|f", empty fields at the end left out:
//   p  the current path: its entries joined by ".", each option by its key in elabora.lock.json
//      (base 36), a first choice replaced by a return with "~" after its key, a jump as ">node";
//   r  the scored run, the same way, only when it differs from p ("-" for an empty one);
//   e  the options explored, a bit field: bit n is the option whose place in keys.bits is n, six bits
//      a character in A–Z a–z 0–9 - _ (the first character holds bits 0 to 5), trailing zeros left out;
//   f  the endings found, the same way (keys.endings).
//
// "3.b~.c" : options 3 then c, b replaced. About 2 characters a decision. The compiler measures the
// worst case with worstCaseDialogue. The strings this module writes are saved by LMSs: the encoding
// must never change for a given progress.

import type { DialogueData, DialogueKeys } from './types.ts';
import type { DialogueProgress } from './run.ts';
import { MAX_DECISIONS } from './walk.ts';

const BITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function encodeEntries(entries: readonly string[], keys: DialogueKeys): string {
  const parts: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('>')) { parts.push(entry); continue; }
    const replaced = entry.endsWith('~');
    const key = keys.choices[replaced ? entry.slice(0, -1) : entry];
    // An option without key (a block compiled without its keys) cannot be saved: the path stops.
    if (key === undefined) break;
    parts.push(`${key}${replaced ? '~' : ''}`);
  }
  return parts.join('.');
}

function encodeBits(ids: readonly string[], places: Record<string, number>): string {
  const bits: number[] = [];
  for (const id of ids) {
    const place = places[id];
    if (place === undefined || place < 0) continue;
    const char = Math.floor(place / 6);
    while (bits.length <= char) bits.push(0);
    bits[char] |= 1 << (place % 6);
  }
  while (bits.length && bits[bits.length - 1] === 0) bits.pop();
  return bits.map((value) => BITS[value]).join('');
}

function decodeBits(text: string, places: Record<string, number>): string[] {
  const set = new Set<number>();
  [...text].forEach((char, index) => {
    const value = BITS.indexOf(char);
    if (value < 0) return;
    for (let bit = 0; bit < 6; bit++) if (value & (1 << bit)) set.add(index * 6 + bit);
  });
  return Object.keys(places).filter((id) => set.has(places[id]));
}

export function encodeDialogueProgress(progress: DialogueProgress, keys: DialogueKeys): string {
  const path = encodeEntries(progress.path, keys);
  const scored = progress.scored === null ? '' : encodeEntries(progress.scored, keys) || '-';
  const fields = [path, scored === path ? '' : scored, encodeBits(progress.explored, keys.bits), encodeBits(progress.endings, keys.endings)];
  while (fields.length > 1 && fields[fields.length - 1] === '') fields.pop();
  return fields.join('|');
}

// Saved text from the LMS: what cannot be read is left out. A key no option has any more (an option
// removed, or renamed with its node) is kept as "?key": replaying the path stops there.
export function decodeDialogueProgress(text: string, keys: DialogueKeys): DialogueProgress {
  const progress: DialogueProgress = { path: [], scored: null, explored: [], endings: [] };
  if (typeof text !== 'string' || !text) return progress;
  const refOf = new Map(Object.entries(keys.choices).map(([ref, key]) => [key, ref]));
  const entries = (field: string): string[] => (field ? field.split('.').filter(Boolean).map((part) => {
    if (part.startsWith('>')) return part;
    const replaced = part.endsWith('~');
    const key = replaced ? part.slice(0, -1) : part;
    const ref = refOf.get(key);
    return ref === undefined ? `?${key}` : `${ref}${replaced ? '~' : ''}`;
  }) : []);
  const [path = '', scored = '', explored = '', endings = ''] = text.split('|');
  progress.path = entries(path);
  progress.scored = scored === '' ? null : scored === '-' ? [] : entries(scored);
  progress.explored = decodeBits(explored, keys.bits);
  progress.endings = decodeBits(endings, keys.endings);
  return progress;
}

// The longest string the dialogue's progress may take, made of its longest keys: each field at its
// longest (a path of as many decisions as the graph allows, MAX_DECISIONS with a loop, each with its
// retries, a replaced first choice and a jump; every option explored, every ending found). The
// compiler puts it in the worst-case learner state (state-codec.ts) to measure the suspend data.
export function worstCaseDialogue(data: Pick<DialogueData, 'nodes' | 'start' | 'keys'>): string {
  const longestKey = Object.values(data.keys.choices).reduce((longest, key) => Math.max(longest, key.length), 1);
  const longestNode = data.nodes.reduce((longest, node) => Math.max(longest, node.id.length), 1);
  const perDecision = (node: { options: { retry?: boolean }[] }) => (node.options.filter((option) => option.retry).length + 2) * (longestKey + 2);
  const decisionNodes = data.nodes.filter((node) => node.options.length);
  const widest = decisionNodes.reduce((widest, node) => Math.max(widest, perDecision(node)), 0);
  const decisions = Math.min(MAX_DECISIONS, longestDecisionChain(data));
  // A jump before each decision, and one more.
  const length = decisions * (widest + longestNode + 2) + longestNode + 1;
  const path = 'x'.repeat(Math.max(0, length - 1));
  const bits = (places: Record<string, number>) => '_'.repeat(Math.ceil((Math.max(-1, ...Object.values(places)) + 1) / 6));
  return [path, path, bits(data.keys.bits), bits(data.keys.endings)].join('|');
}

// The most decisions a path may meet: the longest chain of decision nodes on the graph, or the cap
// when a loop holds one (a node may also be reached by a jump: every node counts as a start).
export function longestDecisionChain(data: Pick<DialogueData, 'nodes'>): number {
  const index = new Map(data.nodes.map((node, i) => [node.id, i]));
  const targets = (i: number): number[] => {
    const node = data.nodes[i];
    const out = new Set<number>();
    const add = (id: string | undefined) => { const found = id === undefined ? undefined : index.get(id); if (found !== undefined) out.add(found); };
    for (const option of node.options) add(option.next);
    if (typeof node.next === 'string') add(node.next);
    else if (Array.isArray(node.next)) for (const entry of node.next) add(entry.go);
    if (node.end === undefined && i + 1 < data.nodes.length && (node.next === undefined || Array.isArray(node.next))) out.add(i + 1);
    return [...out];
  };
  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  let loop = false;
  const longest = (i: number): number => {
    if (memo.has(i)) return memo.get(i)!;
    if (visiting.has(i)) { loop = true; return 0; }
    visiting.add(i);
    const own = data.nodes[i].options.length ? 1 : 0;
    let best = 0;
    for (const target of targets(i)) best = Math.max(best, longest(target));
    visiting.delete(i);
    memo.set(i, own + best);
    return own + best;
  };
  let best = 0;
  for (let i = 0; i < data.nodes.length; i++) best = Math.max(best, longest(i));
  return loop && data.nodes.some((node) => node.options.length) ? MAX_DECISIONS : best;
}
