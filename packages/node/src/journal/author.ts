import tty from 'node:tty';
import type { Author } from '@elabora/core/ops/types';

const KINDS = new Set<Author['kind']>(['human', 'agent', 'external', 'system']);

// A conversation of Elabora's chat: its id names its transcript (.elabora/chats/<id>.jsonl).
export const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

// The conversation an agent works in, when Elabora's chat started it (ELABORA_CHAT, given to its
// MCP server): its changes join the conversation's turn.
export function chatFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const chat = env.ELABORA_CHAT?.trim();
  return chat && CHAT_ID.test(chat) ? chat : undefined;
}

// Who is writing through the CLI. ELABORA_AUTHOR wins: a kind ("human", "agent:codex") or a bare
// agent name ("codex"). Claude Code sets CLAUDECODE in the shells it runs, Codex (the CLI and the
// desktop app, since February 2026) CODEX_THREAD_ID. A CLI whose stdin is not a terminal is driven
// by a program, in practice an agent. Otherwise a human typed it.
export function detectAuthor(env: Readonly<Record<string, string | undefined>> = process.env, stdinIsTerminal: boolean = tty.isatty(0)): Author {
  const author = baseAuthor(env, stdinIsTerminal);
  const chat = author.kind === 'agent' ? chatFromEnv(env) : undefined;
  return chat ? { ...author, chat } : author;
}

function baseAuthor(env: Readonly<Record<string, string | undefined>>, stdinIsTerminal: boolean): Author {
  const named = env.ELABORA_AUTHOR?.trim();
  if (named) {
    const colon = named.indexOf(':');
    const kind = (colon < 0 ? named : named.slice(0, colon)) as Author['kind'];
    const name = colon < 0 ? '' : named.slice(colon + 1).trim();
    if (KINDS.has(kind)) return name ? { kind, name } : { kind };
    return { kind: 'agent', name: named };
  }
  if (env.CLAUDECODE && env.CLAUDECODE !== '0') return { kind: 'agent', name: 'claude-code' };
  if (env.CODEX_THREAD_ID) return { kind: 'agent', name: 'codex' };
  if (!stdinIsTerminal) return { kind: 'agent' };
  return { kind: 'human' };
}
