import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Author, ChangeLike } from '@elabora/core/ops/types';
import { summarizeBatches } from '@elabora/core/ops/batch';
import { projectDataDir } from './data-dir.ts';
import { CHAT_ID } from './journal/author.ts';
import { readJournal } from './journal/journal.ts';
import { recordActivity } from './activity.ts';
import type { ActivityFamily } from './activity-types.ts';
import type { ChatLine, ChatsReport, DetourLine, Refusal, RefusedLine, TurnEndLine, TurnSummary, UserLine } from './chats-types.ts';

export type { ChatLine, ChatsReport, DetourLine, Refusal, RefusedLine, TurnEndLine, TurnSummary, UserLine } from './chats-types.ts';

// Elabora's chat, what the core does with it (reports/chat-agentique, phase 2).
// - A turn is a mark of the journal with its chat (appendMark): the batch of everything the
//   conversation's agent writes during it is named after the mark (journal/journal.ts).
// - The conversation's transcript, .elabora/chats/<chat>.jsonl, is the app's (its ChatEntry: the
//   requests, the replies, the tools refused, the turns' ends). The core reads it, and adds one line
//   type: detour, the Elabora operation the agent ran after a refusal.
// - A refusal (the host said no to one of the agent's own tools: a file edit, a shell) is said in the
//   activity at once (recordRefusal), with the tool and its target, never any content.
// elabora history --chats sums the turns up, to see whether agents suffer from writing through
// Elabora's tools only (the founder's choice 6).

export const CHATS_DIR = 'chats';

const checkChat = (chat: string): string => {
  if (!CHAT_ID.test(chat)) throw new Error(`Not a chat id: ${JSON.stringify(chat)} (letters, digits, - and _, at most 64)`);
  return chat;
};
export const chatsDir = (root: string): string => path.join(projectDataDir(root), CHATS_DIR);
export const chatPath = (root: string, chat: string): string => path.join(chatsDir(root), `${checkChat(chat)}.jsonl`);
// A refusal waiting for the operation the agent runs next (its detour).
const pendingPath = (root: string, chat: string): string => path.join(chatsDir(root), `${checkChat(chat)}.refused`);

// Appends a line to a conversation's transcript (at: now by default). One short write per line: the
// app and the course's MCP server append to the same file without tearing lines.
export function appendChat(root: string, chat: string, line: Omit<ChatLine, 'at'> & { at?: string }): ChatLine {
  const file = chatPath(root, chat);
  const written = { ...line, at: line.at ?? new Date().toISOString() } as ChatLine;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(written)}\n`);
  return written;
}

// A conversation's lines, oldest first (a torn line is skipped). None when it does not exist.
export function readChat(root: string, chat: string): ChatLine[] {
  let text: string;
  try {
    text = fs.readFileSync(chatPath(root, chat), 'utf8');
  } catch {
    return [];
  }
  const lines: ChatLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as ChatLine;
      if (line && typeof line.type === 'string' && typeof line.at === 'string') lines.push(line);
    } catch {
      // A torn line.
    }
  }
  return lines;
}

// The course's conversations, the last written first.
export function listChats(root: string): { chat: string; modified: string }[] {
  let names: string[];
  try {
    names = fs.readdirSync(chatsDir(root));
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.jsonl') && CHAT_ID.test(name.slice(0, -6))).flatMap((name) => {
    try {
      return [{ chat: name.slice(0, -6), modified: fs.statSync(path.join(chatsDir(root), name)).mtime.toISOString() }];
    } catch {
      return []; // deleted meanwhile
    }
  }).sort((a, b) => b.modified.localeCompare(a.modified));
}

// The target of a refused tool in the activity: relative to the course when inside it; of a file
// outside it, its name only (the author's folders stay out of the course's data).
function targetPath(root: string, target: string | undefined): { path?: string; outside?: true } {
  if (!target?.trim()) return {};
  const absolute = path.resolve(root, target.trim());
  const relative = path.relative(path.resolve(root), absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? { path: relative.split(path.sep).join('/') } : { path: path.basename(absolute), outside: true };
}

// The program a shell command runs, nothing of its arguments.
export function commandProgram(command: string | undefined): string | undefined {
  const first = command?.trim().split(/\s+/)[0];
  if (!first) return undefined;
  return path.basename(first).slice(0, 40);
}

// The host refused one of the agent's own tools: said in the activity at once (family refused), and
// kept for the next Elabora operation of the conversation, its detour. The transcript's own line is
// the host's. Never fails: a refusal is reported as a courtesy, the conversation goes on.
export function recordRefusal(root: string, refusal: Refusal): void {
  try {
    const chat = checkChat(refusal.chat);
    const command = commandProgram(refusal.command);
    recordActivity(root, {
      at: new Date().toISOString(), id: randomUUID(), phase: 'end', op: refusal.tool, family: 'refused', author: { ...refusal.author, chat },
      ...targetPath(root, refusal.path), ...(command ? { command } : {}), ok: false
    });
    fs.mkdirSync(chatsDir(root), { recursive: true });
    fs.writeFileSync(pendingPath(root, chat), JSON.stringify({ mark: refusal.mark, tool: refusal.tool }));
  } catch {
    // Reported as a courtesy.
  }
}

// An agent of the chat starts an Elabora operation: the detour of a refusal waiting for one, a line
// of the transcript. The first operation after a refusal takes it, the others find none. Never fails.
export function noteDetour(root: string, author: Author, op: string, family: ActivityFamily): void {
  if (!author.chat || !CHAT_ID.test(author.chat)) return;
  try {
    const file = pendingPath(root, author.chat);
    if (!fs.existsSync(file)) return;
    const pending = JSON.parse(fs.readFileSync(file, 'utf8')) as { mark?: string; tool?: string };
    fs.unlinkSync(file); // another operation that took it first makes this throw: it is its detour
    appendChat(root, author.chat, { type: 'detour', ...(pending.mark ? { mark: pending.mark } : {}), op, family, after: pending.tool ?? '' });
  } catch {
    // Reported as a courtesy.
  }
}

// ── the summary ──────────────────────────────────────────────────────

export const MIN_TURNS = 5;
export const REFUSED_SHARE = 0.2;

// What a refusal needed, by the shape of its target: generators/*.mjs, *.css, $ node.
// path: relative to the course, or absolute outside it (as the app's transcript writes it).
export function refusalNeed(refusal: { tool: string; path?: string; command?: string }): string {
  if (refusal.path) {
    if (path.isAbsolute(refusal.path) || refusal.path.startsWith('..')) return 'outside the course';
    const parts = refusal.path.split('/');
    const ext = path.extname(refusal.path);
    const name = ext ? `*${ext}` : parts[parts.length - 1]!;
    return parts.length > 1 ? `${parts[0]}/${name}` : name;
  }
  if (refusal.command) return `$ ${refusal.command}`;
  return refusal.tool;
}

const average = (values: number[]): number | null => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

// One turn (its number in the conversation), as the chat shows it when it ends: its batch, its
// refusals and detours. null when the transcript does not know it.
export function turnSummary(root: string, chat: string, turn: number): TurnSummary | null {
  return collectTurns(root, [chat]).find((each) => each.turn === turn) ?? null;
}

// Every turn of the course's conversations, and what refusals say about writing through Elabora's tools only.
export function summarizeChats(root: string): ChatsReport {
  return report(collectTurns(root, listChats(root).map(({ chat }) => chat)));
}

// The turns of these conversations, oldest first: from their transcripts, joined to the journal by
// each turn's mark (its batch: the changes, whether they were undone, the agent).
function collectTurns(root: string, chats: readonly string[]): TurnSummary[] {
  const journal = readJournal(root);
  const batches = new Map(summarizeBatches(journal).map((batch) => [batch.id, batch]));
  const writers = new Map<string, string>();
  for (const entry of journal) if (entry.type !== 'mark' && (entry as ChangeLike).author.chat && (entry as ChangeLike).author.name) writers.set(entry.batch, (entry as ChangeLike).author.name!);
  const list: TurnSummary[] = [];
  for (const chat of chats) {
    const turns = new Map<number, TurnSummary>();
    const turnOf = (number: number, at: string): TurnSummary => {
      let turn = turns.get(number);
      if (!turn) {
        turn = { chat, turn: number, at, refusals: [], detours: [], changes: 0, undone: false, succeeded: false };
        turns.set(number, turn);
      }
      return turn;
    };
    let current: TurnSummary | undefined;
    for (const line of readChat(root, chat)) {
      if (line.type === 'user' && typeof line.turn === 'number') {
        const user = line as UserLine;
        current = turnOf(user.turn, user.at);
        current.at = user.at;
        current.request = user.text;
        if (typeof user.mark === 'string') current.mark = user.mark;
      } else if (line.type === 'refused' && typeof line.turn === 'number') {
        const refused = line as RefusedLine;
        const command = commandProgram(refused.command);
        turnOf(refused.turn, refused.at).refusals.push({ tool: refused.tool, ...(refused.path ? { path: refused.path } : {}), ...(command ? { command } : {}), need: refusalNeed({ ...refused, command }) });
      } else if (line.type === 'turn-end' && typeof line.turn === 'number') {
        const end = line as TurnEndLine;
        const turn = turnOf(end.turn, end.at);
        turn.reason = end.reason;
        if (!turn.mark && end.batch) turn.mark = end.batch;
        const tokens = (end.tokens?.input ?? 0) + (end.tokens?.output ?? 0);
        if (tokens > 0) turn.tokens = tokens;
      } else if (line.type === 'detour') {
        // The turn of its mark, else the turn under way when it was written.
        const detour = line as DetourLine;
        const turn = (detour.mark ? [...turns.values()].find((each) => each.mark === detour.mark) : undefined) ?? current;
        turn?.detours.push({ op: detour.op, family: detour.family, after: detour.after });
      }
    }
    for (const turn of turns.values()) {
      const batch = turn.mark ? batches.get(turn.mark) : undefined;
      if (batch) {
        turn.changes = batch.changes.length;
        turn.undone = batch.undone;
      }
      if (turn.mark && writers.has(turn.mark)) turn.agent = writers.get(turn.mark);
      turn.succeeded = turn.reason === 'end' && !turn.undone;
      list.push(turn);
    }
  }
  return list.sort((a, b) => a.at.localeCompare(b.at));
}

function report(list: TurnSummary[]): ChatsReport {
  const refusedTurns = list.filter((turn) => turn.refusals.length);
  const others = list.filter((turn) => !turn.refusals.length);
  const needs = new Map<string, { need: string; refusals: number; turns: Set<string> }>();
  for (const turn of refusedTurns) for (const refusal of turn.refusals) {
    const need = needs.get(refusal.need) ?? { need: refusal.need, refusals: 0, turns: new Set<string>() };
    need.refusals++;
    need.turns.add(`${turn.chat}#${turn.turn}`);
    needs.set(refusal.need, need);
  }
  const needList = [...needs.values()].map(({ need, refusals, turns: seen }) => ({ need, refusals, turns: seen.size })).sort((a, b) => b.refusals - a.refusals || b.turns - a.turns);
  const totalRefusals = needList.reduce((sum, need) => sum + need.refusals, 0);
  const share = list.length ? refusedTurns.length / list.length : 0;
  const ended = (group: TurnSummary[]) => group.filter((turn) => turn.reason !== undefined);
  const rate = (group: TurnSummary[]) => (ended(group).length ? ended(group).filter((turn) => turn.succeeded).length / ended(group).length : null);
  const tokens = (group: TurnSummary[]) => average(group.flatMap((turn) => (turn.tokens === undefined ? [] : [turn.tokens])));

  const reasons: string[] = [];
  if (list.length && share >= REFUSED_SHARE) reasons.push(`${refusedTurns.length} turn(s) in ${list.length} hit a refusal (the threshold: one in five)`);
  const top = needList[0];
  if (top && top.turns > 1 && top.refusals * 2 > totalRefusals) reasons.push(`${top.refusals} of ${totalRefusals} refusal(s), in ${top.turns} turns, needed ${top.need}`);
  return {
    turns: list, refused: refusedTurns.length, share, needs: needList,
    withRefusal: { succeeded: rate(refusedTurns), tokens: tokens(refusedTurns) },
    without: { succeeded: rate(others), tokens: tokens(others) },
    verdict: list.length < MIN_TURNS ? 'too-few-turns' : reasons.length ? 'open-a-tool' : 'keep',
    reasons
  };
}
