import { CODES } from '@elabora/core/diagnostics/codes';
import fs from 'node:fs';
import path from 'node:path';
import { ArgumentError } from '../arguments.ts';
import { defineCommand, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  mcp [dir…] [--read-only] [--tools <name>,…]          MCP server on stdio for a course folder; several folders, or a folder
                                                      of courses, give a course argument to each operation; outside a
                                                      course, only the docs, skills and library. --tools: only the named
                                                      agent tools (unknown names are refused)
  codes [--json]                                      Catalogue of diagnostic codes
  docs [<page>] [--section <heading>] [--full]        The documentation as Markdown, without a checkout: the map of pages,
                                                      a page (D29: a decision; a long one as its outline), or one section
  rules [dir] [--json]                                The rules for agents of this elabora (what a course's AGENTS.md
                                                      holds between its markers), and where the course's stand
  rules update [dir] [--force] [--json]               Bring the course's AGENTS.md rules up to date (done by itself
                                                      while nobody edits them); --force replaces edited ones, the
                                                      notes after « elabora:rules end » kept. One undoable change`;

const mcp = defineCommand({
  name: 'mcp',
  flags: { 'read-only': 'boolean', tools: 'list' },
  async run({ positionals, flags }) {
    const { startMcpServer } = await import('../mcp.ts');
    await startMcpServer(positionals.length > 1 ? positionals : positionals[0] ?? '.', { readOnly: flags['read-only'], tools: flags.tools });
    return null; // keeps running
  }
});

const codes = defineCommand({
  name: 'codes',
  flags: { json: 'boolean' },
  run({ flags }) {
    if (flags.json) printJson(CODES);
    else for (const [code, info] of Object.entries(CODES)) console.log(`${code.padEnd(34)} ${info.severity.padEnd(8)} ${info.title}`);
    return 0;
  }
});

const docs = defineCommand({
  name: 'docs',
  flags: { section: 'string', full: 'boolean', search: 'string' },
  async run({ positionals, flags }) {
    const { readDocs } = await import('../docs.ts');
    if (positionals.length > 1) throw new ArgumentError('docs takes at most one page');
    const result = readDocs({ page: positionals[0], section: flags.section, full: flags.full, search: flags.search });
    if (!result.ok) { console.error(result.error); return 1; }
    console.log(result.text);
    return 0;
  }
});

const rules = defineCommand({
  name: 'rules',
  flags: { json: 'boolean' },
  async run({ positionals: [dir = '.'], flags }) {
    const { agentRulesState, currentRules, AGENTS_FILE } = await import('@elabora/node/agent-rules');
    const file = path.join(dir, AGENTS_FILE);
    const state = fs.existsSync(path.join(dir, 'course.json')) ? agentRulesState(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) : null;
    const current = currentRules();
    if (flags.json) { printJson({ revision: current.revision, course: state, rules: current.text }); return 0; }
    process.stdout.write(current.text);
    const said: Record<string, string> = {
      current: 'the course\'s AGENTS.md holds these rules.',
      outdated: 'the course\'s AGENTS.md holds older rules nobody edited: Elabora updates them (elabora rules update).',
      edited: 'the course\'s AGENTS.md rules were edited: Elabora leaves them; elabora rules update --force puts these back (the notes after « elabora:rules end » are kept; elabora undo reverts it).',
      newer: 'the course\'s AGENTS.md holds the rules of a newer Elabora: the commands it names may be missing from this elabora.',
      missing: 'the course has no AGENTS.md: elabora rules update --force writes one.',
      custom: 'the course\'s AGENTS.md was not written by Elabora: elabora rules update --force replaces it (elabora undo reverts it).'
    };
    if (state) console.log(`\n<!-- elabora rules revision ${current.revision}${'revision' in state ? `; the course's: ${state.revision}` : ''}: ${said[state.status]} -->`);
    return 0;
  }
});

const rulesUpdate = defineCommand({
  name: 'rules update',
  flags: { force: 'boolean', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(async () => {
    const { updateAgentRules } = await import('@elabora/node/agent-rules');
    const result = updateAgentRules(dir, { force: flags.force });
    if (flags.json) { printJson(result); return 0; }
    if (!result.updated) console.log(`✔ AGENTS.md: nothing to update (rules revision ${result.to}${result.from !== null && result.from !== result.to ? `; the course's are revision ${result.from}, edited: --force replaces them` : ''}).`);
    else console.log(`✔ ${[result.rules ? `AGENTS.md: rules revision ${result.from ?? '(not Elabora\'s)'} → ${result.to}` : null, result.claude ? 'CLAUDE.md written (@AGENTS.md: Claude reads the rules)' : null].filter(Boolean).join('; ')}. Undo: elabora undo --change ${result.change?.seq}`);
    return 0;
  })
});

export const agentCommands: CommandGroup = { title: 'Agents', help: HELP, commands: [mcp, codes, docs, rules, rulesUpdate] };
