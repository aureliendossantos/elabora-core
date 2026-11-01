import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Author, ChangeLike, MarkEntry } from '@elabora/core/ops/types';
import { summarizeBatches } from '@elabora/core/ops/batch';
import { projectDataDir } from './data-dir.ts';
import { CHAT_ID } from './journal/author.ts';
import { readJournal } from './journal/journal.ts';
import { recordActivity } from './activity.ts';
import type { ActivityFamily } from './activity-types.ts';
import type { ChatLine, ChatsReport, DetourLine, EndLine, Refusal, RefusedLine, TurnEnd, TurnSummary } from './chats-types.ts';

export type { ChatLine, ChatsReport, DetourLine, EndLine, Refusal, RefusalHow, RefusedLine, TurnEnd, TurnSummary, TurnUsage } from './chats-types.ts';

// Elabora's chat, what the core keeps of it (reports/chat-agentique, phase 2). A conversation is a
// transcript, .elabora/chats/<chat>.jsonl in the course's data folder: one line per event, kept as
// long as the course. The app writes its own lines there (the requests, the answers, the steps), of
// its own types; the core writes and reads three:
//   refused  the agent tried one of its own tools the chat does not allow (a file edit, a shell):
//            the tool and its target, never any content
//   detour   the Elabora operation it ran next, in the same conversation
//   end      a turn ended: why, and what it cost in tokens
// A turn is a mark of the journal with its chat (appendMark): its id is the turn's, and the batch
// of everything the agent wrote during it. elabora history --chats sums it up per turn, to see
// whether agents suffer from writing through Elabora's tools only (the founder's choice 6).

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
  return names.filter((name) => name.endsWith('.jsonl') && CHAT_ID.test(name.slice(0, -6)))
    .map((name) => ({ chat: name.slice(0, -6), modified: fs.statSync(path.join(chatsDir(root), name)).mtime.toISOString() }))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

// The target of a refused tool as the summary keeps it: relative to the course when inside it.
function targetPath(root: string, target: string | undefined): string | undefined {
  if (!target?.trim()) return undefined;
  const absolute = path.resolve(root, target.trim());
  const relative = path.relative(path.resolve(root), absolute);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : absolute;
}

// The program a shell command runs, nothing of its arguments.
function program(command: string | undefined): string | undefined {
  const first = command?.trim().split(/\s+/)[0];
  if (!first) return undefined;
  return path.basename(first).slice(0, 40);
}

// The host refused one of the agent's own tools: said in the activity (the window can tell it at
// once) and kept in the transcript; the next Elabora operation of the conversation is its detour.
// Never fails: a refusal is reported as a courtesy, the conversation goes on.
export function recordRefusal(root: string, refusal: Refusal): void {
  try {
    const chat = checkChat(refusal.chat);
    const target = targetPath(root, refusal.path);
    const command = program(refusal.command);
    const author: Author = { ...refusal.author, chat };
    const where = { ...(target ? { path: target } : {}), ...(command ? { command } : {}) };
    recordActivity(root, { at: new Date().toISOString(), id: randomUUID(), phase: 'end', op: refusal.tool, family: 'refused', author, ...where, ok: false });
    appendChat(root, chat, { type: 'refused', ...(refusal.turn ? { turn: refusal.turn } : {}), tool: refusal.tool, ...where, how: refusal.how, author });
    fs.writeFileSync(pendingPath(root, chat), JSON.stringify({ turn: refusal.turn, tool: refusal.tool }));
  } catch {
    // Reported as a courtesy.
  }
}

// An agent of the chat starts an Elabora operation: the detour of a refusal waiting for one. The
// first operation after a refusal takes it, the others find none. Never fails.
export function noteDetour(root: string, author: Author, op: string, family: ActivityFamily): void {
  if (!author.chat || !CHAT_ID.test(author.chat)) return;
  try {
    const file = pendingPath(root, author.chat);
    if (!fs.existsSync(file)) return;
    const pending = JSON.parse(fs.readFileSync(file, 'utf8')) as { turn?: string; tool?: string };
    fs.unlinkSync(file); // another operation that took it first makes this throw: it is its detour
    appendChat(root, author.chat, { type: 'detour', ...(pending.turn ? { turn: pending.turn } : {}), op, family, after: pending.tool ?? '' });
  } catch {
    // Reported as a courtesy.
  }
}

// A turn ended (the host has session/prompt's answer): its reason and its cost. A refusal no
// operation followed had no detour.
export function recordTurnEnd(root: string, end: TurnEnd): EndLine {
  const line = appendChat(root, end.chat, {
    type: 'end', turn: end.turn, stopReason: end.stopReason,
    ...(end.usage ? { usage: end.usage } : {}), ...(end.context ? { context: end.context } : {}), ...(end.cost ? { cost: end.cost } : {})
  }) as EndLine;
  fs.rmSync(pendingPath(root, end.chat), { force: true });
  return line;
}

// ── the summary ──────────────────────────────────────────────────────

export const MIN_TURNS = 5;
export const REFUSED_SHARE = 0.2;

// What a refusal needed, by the shape of its target: generators/*.mjs, *.css, $ node.
export function refusalNeed(refusal: { tool: string; path?: string; command?: string }): string {
  if (refusal.path) {
    if (path.isAbsolute(refusal.path)) return 'outside the course';
    const parts = refusal.path.split('/');
    const ext = path.extname(refusal.path);
    const name = ext ? `*${ext}` : parts[parts.length - 1]!;
    return parts.length > 1 ? `${parts[0]}/${name}` : name;
  }
  if (refusal.command) return `$ ${refusal.command}`;
  return refusal.tool;
}

const average = (values: number[]): number | null => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

// Every turn of the course's conversations, from the journal (the marks, the batches) and the transcripts.
export function summarizeChats(root: string): ChatsReport {
  const journal = readJournal(root);
  const batches = new Map(summarizeBatches(journal).map((batch) => [batch.id, batch]));
  const marks = new Map(journal.filter((entry): entry is MarkEntry => entry.type === 'mark' && !!entry.chat).map((mark) => [mark.id, mark]));
  const writers = new Map<string, string>();
  for (const entry of journal) if (entry.type !== 'mark' && marks.has(entry.batch) && (entry as ChangeLike).author.name) writers.set(entry.batch, (entry as ChangeLike).author.name!);
  const turns = new Map<string, TurnSummary>();
  const turnOf = (id: string, chat: string, at: string): TurnSummary => {
    let turn = turns.get(id);
    if (!turn) {
      const mark = marks.get(id);
      const batch = batches.get(id);
      turn = {
        turn: id, chat, at: mark?.at ?? at, ...(mark ? { request: mark.request } : {}), ...(writers.has(id) ? { agent: writers.get(id) } : {}),
        refusals: [], detours: [], changes: batch?.changes.length ?? 0, undone: batch?.undone ?? false, succeeded: false
      };
      turns.set(id, turn);
    }
    return turn;
  };
  for (const mark of marks.values()) turnOf(mark.id, mark.chat!, mark.at);
  for (const { chat } of listChats(root)) {
    for (const line of readChat(root, chat)) {
      if (!line.turn) continue;
      if (line.type === 'refused') {
        const refused = line as RefusedLine;
        turnOf(line.turn, chat, line.at).refusals.push({ tool: refused.tool, ...(refused.path ? { path: refused.path } : {}), ...(refused.command ? { command: refused.command } : {}), how: refused.how, need: refusalNeed(refused) });
      } else if (line.type === 'detour') {
        const detour = line as DetourLine;
        turnOf(line.turn, chat, line.at).detours.push({ op: detour.op, family: detour.family, after: detour.after });
      } else if (line.type === 'end') {
        const end = line as EndLine;
        const turn = turnOf(line.turn, chat, line.at);
        turn.stopReason = end.stopReason;
        const tokens = (end.usage?.inputTokens ?? 0) + (end.usage?.outputTokens ?? 0);
        if (end.usage && tokens > 0) turn.tokens = tokens;
      }
    }
  }
  const list = [...turns.values()].sort((a, b) => a.at.localeCompare(b.at));
  for (const turn of list) turn.succeeded = turn.stopReason === 'end_turn' && !turn.undone;

  const refusedTurns = list.filter((turn) => turn.refusals.length);
  const others = list.filter((turn) => !turn.refusals.length);
  const needs = new Map<string, { need: string; refusals: number; turns: Set<string> }>();
  for (const turn of refusedTurns) for (const refusal of turn.refusals) {
    const need = needs.get(refusal.need) ?? { need: refusal.need, refusals: 0, turns: new Set<string>() };
    need.refusals++;
    need.turns.add(turn.turn);
    needs.set(refusal.need, need);
  }
  const needList = [...needs.values()].map(({ need, refusals, turns: seen }) => ({ need, refusals, turns: seen.size })).sort((a, b) => b.refusals - a.refusals || b.turns - a.turns);
  const totalRefusals = needList.reduce((sum, need) => sum + need.refusals, 0);
  const share = list.length ? refusedTurns.length / list.length : 0;
  const ended = (group: TurnSummary[]) => group.filter((turn) => turn.stopReason !== undefined);
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
