import tty from 'node:tty';
import type { Author } from '@elabora/core/ops/types';

const KINDS = new Set<Author['kind']>(['human', 'agent', 'external', 'system']);

// Who is writing through the CLI. ELABORA_AUTHOR wins: a kind ("human", "agent:codex") or a bare
// agent name ("codex"). Claude Code sets CLAUDECODE in the shells it runs, Codex (the CLI and the
// desktop app, since February 2026) CODEX_THREAD_ID. A CLI whose stdin is not a terminal is driven
// by a program, in practice an agent. Otherwise a human typed it.
export function detectAuthor(env: Readonly<Record<string, string | undefined>> = process.env, stdinIsTerminal: boolean = tty.isatty(0)): Author {
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
