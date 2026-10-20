import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CommandError, Draft } from '@elabora/core/commands/index';
import { textFile } from '@elabora/core/project/files';
import { FORMAT } from '@elabora/format';
import { fileURLToPath } from 'node:url';
import { runCommand, type EditOptions, type EditResult } from './edit/executor.ts';

// ── The rules a course gives its agents (docs/decisions.md D34) ───────
// A course's AGENTS.md holds the rules of the Elabora that wrote it, between two markers, then the
// author's notes, which Elabora never touches:
//   <!-- elabora:rules revision=29 sha256=<16 hex> … -->
//   # AGENTS.md — Elabora course project … (packages/node/templates/course/AGENTS.md)
//   <!-- elabora:rules end -->
//   ## Notes for this course …
// The marker records which revision of the rules the block is and a fingerprint of its text, so
// that Elabora can tell rules nobody edited, which it brings up to date when a newer Elabora meets them
// (the app opening the course, an MCP server starting, a elabora command run in it), from rules an
// author or an agent edited, which it leaves and reports. An Elabora older than the rules says so
// (they may name commands it lacks). AGENTS.md files written before the markers are recognised by
// their whole text, a revision of the template (templates/agents-revisions.json).

export interface AgentRulesRevision { revision: number; sha: string; date: string }

const TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../templates');
const TEMPLATE = path.join(TEMPLATES_DIR, 'course', 'AGENTS.md');
const HISTORY = path.join(TEMPLATES_DIR, 'agents-revisions.json');
export const AGENTS_FILE = 'AGENTS.md';
// A file with Windows line ends (git's autocrlf) is read too (its rules then count as edited: their
// fingerprint is of the text Elabora wrote).
const START = /^<!-- elabora:rules revision=(\d+) sha256=([0-9a-f]{16})[^\r\n]*-->\r?\n/;
const END = '\n<!-- elabora:rules end -->\n';
const ANY_END = /\r?\n<!-- elabora:rules end -->\r?\n/g;
// Where the rules end: the end marker under either name, with its length.
function rulesEnd(text: string, from: number): { at: number; length: number } {
  ANY_END.lastIndex = from;
  const found = ANY_END.exec(text);
  return found ? { at: found.index, length: found[0].length } : { at: -1, length: 0 };
}
const NOTES = '\n## Notes for this course\n<!-- What agents should know about this course: its audience, its voice, decisions taken. Elabora never changes this part. -->\n';

// The notes of a new course: what the author said as they created it (D51), in their words.
export const courseNotes = (text?: string): string => (text?.trim() ? `${NOTES}\n${text.trim()}\n` : NOTES);

const fingerprint = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

let cached: { text: string; revision: number; revisions: AgentRulesRevision[] } | null = null;
// The rules of this Elabora: the template's text and its revision.
export function currentRules(): { text: string; revision: number; sha: string } {
  if (!cached) {
    const text = fs.readFileSync(TEMPLATE, 'utf8');
    const revisions = (JSON.parse(fs.readFileSync(HISTORY, 'utf8')) as { revisions: AgentRulesRevision[] }).revisions;
    const sha = fingerprint(text);
    const known = revisions.find((entry) => entry.sha === sha);
    // A template edited without npm run gen counts as a revision after the last one.
    cached = { text, revisions, revision: known?.revision ?? (revisions.at(-1)?.revision ?? 0) + 1 };
  }
  return { text: cached.text, revision: cached.revision, sha: fingerprint(cached.text) };
}

const revisionOf = (sha: string): number | null => (currentRules(), cached!.revisions.find((entry) => entry.sha === sha)?.revision ?? null);

// AGENTS.md as Elabora writes it: the rules between their markers, then the notes (kept as they were).
export function agentsFile(notes: string = NOTES): string {
  const { text, revision, sha } = currentRules();
  return `<!-- elabora:rules revision=${revision} sha256=${sha} · Elabora keeps the rules down to « elabora:rules end » up to date while nobody edits them; write your own notes after it. -->\n${text.endsWith('\n') ? text.slice(0, -1) : text}${END}${notes}`;
}

export type AgentRulesState =
  | { status: 'current'; revision: number }
  // Written by an earlier Elabora and not edited since: updated without asking.
  | { status: 'outdated'; revision: number; notes: string }
  // Edited by someone: left as it is; elabora rules update --force replaces the rules (undoable).
  | { status: 'edited'; revision: number | null; current: boolean }
  // Written by a newer Elabora than this one.
  | { status: 'newer'; revision: number }
  // No AGENTS.md, or one Elabora did not write.
  | { status: 'missing' }
  | { status: 'custom' };

export function agentRulesState(text: string | null): AgentRulesState {
  if (text === null) return { status: 'missing' };
  const current = currentRules();
  const start = START.exec(text);
  if (!start) {
    // Before the markers: AGENTS.md was the template, copied whole.
    const revision = revisionOf(fingerprint(text));
    return revision === null ? { status: 'custom' } : { status: 'outdated', revision, notes: NOTES };
  }
  const revision = Number(start[1]);
  const { at: end, length } = rulesEnd(text, start[0].length);
  if (end < 0) return { status: 'edited', revision, current: revision === current.revision };
  const block = text.slice(start[0].length, end);
  const edited = fingerprint(`${block}\n`) !== start[2];
  if (revision > current.revision) return { status: 'newer', revision };
  if (edited) return { status: 'edited', revision, current: revision === current.revision };
  if (revision === current.revision && start[2] === current.sha) return { status: 'current', revision };
  return { status: 'outdated', revision, notes: text.slice(end + length) };
}

export interface AgentRulesUpdate extends EditResult {
  updated: boolean;
  from: number | null; // the revision the course had (null: an AGENTS.md Elabora did not write, or none)
  to: number;
}

// Brings a course's rules up to date when nobody edited them (force: whatever they are, the notes
// kept when there are markers), as one system change that elabora undo reverts.
export function updateAgentRules(dir: string, { force = false, ...options }: EditOptions & { force?: boolean } = {}): AgentRulesUpdate {
  const { revision } = currentRules();
  let from: number | null = null;
  const result = runCommand(path.resolve(dir), {
    name: 'update_agent_rules', args: { to: revision, ...(force ? { force } : {}) },
    run: (context) => {
      const draft = new Draft(context.files);
      const text = draft.text(AGENTS_FILE);
      const state = agentRulesState(text);
      from = 'revision' in state ? state.revision : null;
      if (state.status === 'outdated') draft.writeFile(AGENTS_FILE, textFile(agentsFile(state.notes)));
      else if (force && state.status !== 'current') {
        if (state.status === 'newer') throw new CommandError(`AGENTS.md holds the rules of a newer Elabora (revision ${state.revision}; this one has ${revision}): use that Elabora.`);
        const end = text === null ? { at: -1, length: 0 } : rulesEnd(text, 0);
        draft.writeFile(AGENTS_FILE, textFile(agentsFile(text !== null && START.test(text) && end.at >= 0 ? text.slice(end.at + end.length) : NOTES)));
      } else return { files: context.files, result: {} };
      return { files: draft.files(), result: {} };
    }
  }, { ...options, author: { kind: 'system' } });
  return { ...result, updated: result.change !== null, from, to: revision };
}

// The rules of a course in this Elabora's format (null: none, or another format, whose migration or a
// newer Elabora comes first).
function courseRules(root: string): AgentRulesState | null {
  let text: string;
  try { text = fs.readFileSync(path.join(root, AGENTS_FILE), 'utf8'); } catch { return null; }
  try { if ((JSON.parse(fs.readFileSync(path.join(root, 'course.json'), 'utf8')) as { format?: unknown }).format !== FORMAT) return null; } catch { return null; }
  return agentRulesState(text);
}

// What a read-only look at a course says about its rules, writing nothing.
export function agentRulesNote(dir: string): string | null {
  const state = courseRules(path.resolve(dir));
  if (state?.status === 'outdated') return `AGENTS.md holds older rules for agents (revision ${state.revision} < ${currentRules().revision}), which Elabora brings up to date when it writes in the course (elabora rules update).`;
  return state ? stateNote(state) : null;
}

// What a command run in a course says about its rules, and updates when nobody edited them: null
// when there is nothing to say. Never throws (a locked project, a read-only folder: next time).
export function syncAgentRules(dir: string, options: EditOptions = {}): string | null {
  const root = path.resolve(dir);
  const state = courseRules(root);
  if (!state) return null;
  const note = stateNote(state);
  if (note || state.status !== 'outdated') return note;
  try {
    const result = updateAgentRules(root, options);
    return result.updated ? `AGENTS.md: the rules for agents brought up to date (revision ${result.from ?? '?'} → ${result.to}; change ${result.change?.seq ?? '?'}).` : null;
  } catch {
    return null;
  }
}

function stateNote(state: AgentRulesState): string | null {
  const { revision } = currentRules();
  if (state.status === 'newer') return `AGENTS.md holds the rules of a newer Elabora (revision ${state.revision}) than this elabora command (revision ${revision}): the commands it names may be missing here. Use the elabora command of the app that opened the course last (Elabora › Réglages shows where), or update this one.`;
  if (state.status === 'edited' && !state.current) return `AGENTS.md's rules for agents were edited, and are older than this elabora command's (revision ${state.revision ?? '?'} < ${revision}): elabora rules prints the current ones; elabora rules update --force replaces them (your notes after « elabora:rules end » are kept; elabora undo reverts it).`;
  return null;
}
