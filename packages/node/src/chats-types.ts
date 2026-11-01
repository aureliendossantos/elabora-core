import type { Author } from '@elabora/core/ops/types';
import type { ActivityFamily } from './activity-types.ts';

// Elabora's chat as the core reads it (chats.ts): no Node here, the app's window imports these types.

// A line of a transcript, .elabora/chats/<chat>.jsonl. The app writes it (its ChatEntry: user,
// reply, tool, refused, usage, turn-end…), turns numbered 1, 2… in the conversation; the core reads
// what it needs and adds one type of its own, detour.
export interface ChatLine {
  type: string;
  at: string;
  [key: string]: unknown;
}

// The lines the core reads, with the fields it needs.
export interface UserLine extends ChatLine { type: 'user'; turn: number; text: string; mark?: string } // mark: the journal's mark that opened the turn
export interface RefusedLine extends ChatLine { type: 'refused'; turn: number; tool: string; path?: string; command?: string }
export interface TurnEndLine extends ChatLine { type: 'turn-end'; turn: number; reason: string; batch: string | null; cost: number | null; tokens?: { input: number; output: number } }
// The Elabora operation that followed a refusal, written by the course's MCP server.
export interface DetourLine extends ChatLine { type: 'detour'; mark?: string; op: string; family: ActivityFamily; after: string }

// The host refused one of the agent's own tools (recordRefusal).
export interface Refusal {
  chat: string;
  mark?: string;      // the turn's mark in the journal
  tool: string;       // the agent's own tool: edit, write, bash…
  path?: string;      // the file it aimed at, absolute or relative to the course
  command?: string;   // for a shell, the command: only its program (node, sed) is kept
  author: Author;
}

export interface TurnSummary {
  chat: string;
  turn: number;            // in the conversation
  mark?: string;           // the journal's mark: the turn's batch
  at: string;
  request?: string;
  agent?: string;
  refusals: { tool: string; path?: string; command?: string; need: string }[];
  detours: { op: string; family: string; after: string }[];
  changes: number;
  undone: boolean;         // everything it wrote was undone (false when it wrote nothing)
  reason?: string;         // how it ended (turn-end: end, cancelled, refused, error, limit); none: not ended
  tokens?: number;         // input and output
  succeeded: boolean;      // it ended normally and what it wrote stands
}

export interface ChatsReport {
  turns: TurnSummary[];    // oldest first
  refused: number;         // turns with at least one refusal
  share: number;           // refused / turns (0 without turns)
  needs: { need: string; refusals: number; turns: number }[]; // most frequent first
  // Turns with a refusal against the others: how often they succeed, what they cost on average.
  withRefusal: { succeeded: number | null; tokens: number | null };
  without: { succeeded: number | null; tokens: number | null };
  // The study's threshold: a turn in five hitting a refusal, or one need behind most refusals
  // (and more than one turn), and it is time to open that need with an Elabora tool.
  verdict: 'too-few-turns' | 'keep' | 'open-a-tool';
  reasons: string[];
}
