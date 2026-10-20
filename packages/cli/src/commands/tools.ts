import fs from 'node:fs';
import path from 'node:path';
import { agentRulesNote, syncAgentRules } from '@elabora/node/agent-rules';
import { detectAuthor } from '@elabora/node/journal/author';
import { ArgumentError, parseArguments } from '../arguments.ts';
import { errorResult } from '../mcp/tool.ts';
import { defineCommand, printJson, errorMessage } from './command.ts';
import type { CommandGroup } from './command.ts';
import { AGENT_GUIDE, agentGuideText } from '../agent-guide.ts';
import { listSkills, readSkill } from '../skills.ts';

const HELP = `  tools skills [<name> [<reference>]] [--json]         List bundled skills, or read one skill/on-demand recipe (no course needed)
  tools guide [--json]                               Agent workflows, transport choices and human decisions (no course needed)
  tools list [<tool>] [--read-only] [--tools <name>,…] [--json]
                                                      Discover agent operations and their JSON input schemas (no course needed)
  tools call <tool> [dir] [--from <arguments.json>|-] [--read-only] [--json]
                                                      Call the same operation as MCP, with the same validation and result.
                                                      Arguments default to {}; - reads JSON from stdin. Always prints one
                                                      JSON tool result (content, isError); exit 0 success, 1 refused, 2 bad input`;

const list = defineCommand({
  name: 'tools list',
  flags: { json: 'boolean', 'read-only': 'boolean', tools: 'list' },
  async run({ positionals, flags }) {
    const { listAgentTools } = await import('../agent-tools.ts');
    if (positionals.length > 1) throw new ArgumentError('tools list takes at most one tool name');
    const tools = listAgentTools({ readOnly: flags['read-only'], tools: flags.tools }).filter((tool) => !positionals[0] || tool.name === positionals[0]);
    if (flags.json) printJson({ tools });
    else for (const tool of tools) console.log(`${tool.name} (${tool.annotations.readOnlyHint ? 'read' : 'write'})\n  ${tool.description}`);
    return tools.length ? 0 : 1;
  }
});

const skills = defineCommand({
  name: 'tools skills',
  flags: { json: 'boolean' },
  run({ positionals, flags }) {
    if (positionals.length > 2) throw new ArgumentError('Usage: elabora tools skills [<name> [<reference>]]');
    const [name, reference] = positionals;
    if (!name) {
      const skills = listSkills();
      if (flags.json) printJson({ skills });
      else for (const skill of skills) console.log(`${skill.name}${skill.references.length ? ` (references: ${skill.references.join(', ')})` : ''}`);
      return 0;
    }
    const content = readSkill(name, reference);
    if (content === null) throw new ArgumentError(`Unknown skill or reference: ${name}${reference ? '/' + reference : ''}`);
    if (flags.json) printJson({ name, ...(reference ? { reference } : {}), content });
    else process.stdout.write(content);
    return 0;
  }
});

const guide = defineCommand({
  name: 'tools guide',
  flags: { json: 'boolean' },
  run({ positionals, flags }) {
    if (positionals.length) throw new ArgumentError('tools guide takes no positional arguments');
    if (flags.json) printJson(AGENT_GUIDE);
    else console.log(agentGuideText());
    return 0;
  }
});

// Parse inside this adapter so malformed flags, input files and JSON also have a machine-readable
// result. Diagnostics and rules notes go to stderr; stdout is always a single JSON document.
const call = {
  name: 'tools call',
  async run(argv: readonly string[]) {
    try {
      const { callAgentTool } = await import('../agent-tools.ts');
      const { positionals: [name, dir = '.', ...extra], flags } = parseArguments(argv, { from: 'string', json: 'boolean', 'read-only': 'boolean' });
      if (!name || extra.length) throw new ArgumentError('Usage: elabora tools call <tool> [dir] [--from <arguments.json>|-] [--read-only]');
      let args: unknown = {};
      if (flags.from) {
        try { args = JSON.parse(fs.readFileSync(flags.from === '-' ? 0 : flags.from, 'utf8')); }
        catch (error) { throw new ArgumentError(`Cannot read tool arguments: ${errorMessage(error)}`); }
      }
      const root = path.resolve(dir);
      if (fs.existsSync(path.join(root, 'course.json'))) {
        const note = flags['read-only'] ? agentRulesNote(root) : syncAgentRules(root);
        if (note) process.stderr.write(`${note}\n`);
      }
      const result = await callAgentTool(name, args, { root, author: detectAuthor() }, { readOnly: flags['read-only'] });
      printJson(result);
      return result.isError ? 1 : 0;
    } catch (error) {
      printJson(errorResult({ error: errorMessage(error) }));
      return error instanceof ArgumentError ? 2 : 1;
    }
  }
};

export const toolCommands: CommandGroup = { title: 'Agent operations (shared with MCP)', help: HELP, commands: [skills, guide, list, call], subcommandUsage: { tools: 'Usage: elabora tools skills|guide|list|call …' } };
