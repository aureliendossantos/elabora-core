import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { projectDataDir } from '@elabora/node/data-dir';
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
  tools call <tool> [dir] [--args '<json>' | --from <arguments.json>|-] [--read-only] [--raw]
                                                      Call the same operation as MCP, with the same validation. Arguments
                                                      default to {}: --args takes them inline, --from from a file (- reads
                                                      stdin). Prints the tool's own JSON (its text when it answers in text);
                                                      images go to files under the course's .elabora/look/, their paths in
                                                      "images". --raw prints the MCP result (content, isError) instead.
                                                      Exit 0 success, 1 refused, 2 bad input`;

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
// result. Diagnostics and rules notes go to stderr; stdout is one document: the tool's JSON (or text),
// or with --raw the MCP result itself.
const call = {
  name: 'tools call',
  async run(argv: readonly string[]) {
    let raw = argv.includes('--raw');
    let root = path.resolve('.');
    try {
      const { callAgentTool } = await import('../agent-tools.ts');
      const { positionals: [name, dir = '.', ...extra], flags } = parseArguments(argv, { from: 'string', args: 'string', json: 'boolean', raw: 'boolean', 'read-only': 'boolean' });
      raw = !!flags.raw;
      if (!name || extra.length) throw new ArgumentError(`Usage: elabora tools call <tool> [dir] [--args '<json>' | --from <arguments.json>|-] [--read-only] [--raw]`);
      if (flags.args !== undefined && flags.from) throw new ArgumentError('Give the arguments with --args or with --from, not both.');
      let args: unknown = {};
      if (flags.args !== undefined || flags.from) {
        try { args = JSON.parse(flags.args ?? fs.readFileSync(flags.from === '-' ? 0 : flags.from!, 'utf8')); }
        catch (error) { throw new ArgumentError(`Cannot read tool arguments: ${errorMessage(error)}`); }
      }
      root = path.resolve(dir);
      const course = fs.existsSync(path.join(root, 'course.json'));
      if (course) {
        const note = flags['read-only'] ? agentRulesNote(root) : syncAgentRules(root);
        if (note) process.stderr.write(`${note}\n`);
      }
      const result = await callAgentTool(name, args, { root, author: detectAuthor() }, { readOnly: flags['read-only'] });
      printResult(result, raw, course ? path.join(projectDataDir(root), 'look') : path.join(os.tmpdir(), 'elabora-tools'), name);
      return result.isError ? 1 : 0;
    } catch (error) {
      printResult(errorResult({ error: errorMessage(error) }), raw);
      return error instanceof ArgumentError ? 2 : 1;
    }
  }
};

// The tool's own answer rather than the MCP envelope (JSON inside text inside JSON): one text is
// printed as the JSON it holds, or as text; images are written to files, and a text with images is
// printed with their paths under "images".
function printResult(result: CallToolResult, raw: boolean, folder?: string, tool = 'tool'): void {
  if (raw) { printJson(result); return; }
  const texts: unknown[] = [];
  const images: string[] = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  for (const item of result.content) {
    if (item.type === 'text') {
      try { texts.push(JSON.parse(item.text)); } catch { texts.push(item.text); }
    } else if (item.type === 'image' && folder) {
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `${tool.replace(/^elabora_/, '')}-${stamp}-${images.length + 1}.${item.mimeType === 'image/jpeg' ? 'jpg' : 'png'}`);
      fs.writeFileSync(file, Buffer.from(item.data, 'base64'));
      images.push(file);
    }
  }
  if (!images.length && texts.length === 1) {
    if (typeof texts[0] === 'string') process.stdout.write(texts[0].endsWith('\n') ? texts[0] : `${texts[0]}\n`);
    else printJson(texts[0]);
    return;
  }
  const [only] = texts;
  if (texts.length === 1 && only && typeof only === 'object' && !Array.isArray(only)) printJson({ ...only, images });
  else printJson({ ...(texts.length === 1 ? { text: only } : texts.length ? { texts } : {}), images });
}

export const toolCommands: CommandGroup = { title: 'Agent operations (shared with MCP)', help: HELP, commands: [skills, guide, list, call], subcommandUsage: { tools: 'Usage: elabora tools skills|guide|list|call …' } };
