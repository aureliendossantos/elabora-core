import type { Author } from '@elabora/core/ops/types';
import type { ActivityFamily } from './activity-types.ts';

// Elabora's chat as the core keeps it (chats.ts writes and reads it): no Node here, the app's window
// imports these types.

// A line of a transcript: its type, when, the turn it belongs to, and the rest as its writer wants.
export interface ChatLine {
  type: string;
  at: string;
  turn?: string;
  [key: string]: unknown;
}

export type RefusalHow = 'permission' | 'config'; // the host said no to a request, or the agent's configuration forbids the tool

export interface Refusal {
  chat: string;
  turn?: string;
  tool: string;       // the agent's own tool: edit, write, bash…
  path?: string;      // the file it aimed at (relative to the course when inside it)
  command?: string;   // for a shell, the program only (node, sed): never its arguments
  how: RefusalHow;
  author: Author;
}

export interface RefusedLine extends ChatLine { type: 'refused'; tool: string; path?: string; command?: string; how: RefusalHow; author: Author }
export interface DetourLine extends ChatLine { type: 'detour'; op: string; family: ActivityFamily; after: string }

// What a turn cost, as ACP gives it: session/prompt's usage, the last usage_update's context and cost.
export interface TurnUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; thoughtTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number }
export interface TurnEnd {
  chat: string;
  turn: string;
  stopReason: string; // end_turn, cancelled, refusal, max_tokens, max_turn_requests, or the host's own (error…)
  usage?: TurnUsage;
  context?: { used: number; size: number };
  cost?: { amount: number; currency: string };
}
export interface EndLine extends ChatLine { type: 'end'; turn: string; stopReason: string; usage?: TurnUsage; context?: { used: number; size: number }; cost?: { amount: number; currency: string } }

export interface TurnSummary {
  turn: string;
  chat: string;
  at: string;
  request?: string;        // from the journal's mark (gone after 30 days)
  agent?: string;
  refusals: { tool: string; path?: string; command?: string; how: RefusalHow; need: string }[];
  detours: { op: string; family: string; after: string }[];
  changes: number;
  undone: boolean;         // everything it wrote was undone (false when it wrote nothing)
  stopReason?: string;     // none: the turn did not end, or the app did not say
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
