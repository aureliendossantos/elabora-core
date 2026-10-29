import fs from 'node:fs';
import path from 'node:path';
import { ELABORA_VERSION } from '@elabora/node/bundles';
import { ArgumentError } from './arguments.ts';
import type { Command, CommandGroup, ExitCode } from './commands/command.ts';
import { projectCommands } from './commands/project.ts';
import { historyCommands } from './commands/history.ts';
import { buildAndTestCommands } from './commands/build-and-test.ts';
import { designCommands } from './commands/design.ts';
import { fontCommands } from './commands/fonts.ts';
import { soundCommands } from './commands/sounds.ts';
import { componentCommands } from './commands/components.ts';
import { objectCommands } from './commands/objects.ts';
import { contractCommands } from './commands/contract.ts';
import { translationCommands } from './commands/translation.ts';
import { interopCommands } from './commands/interop.ts';
import { agentCommands } from './commands/agents.ts';
import { toolCommands } from './commands/tools.ts';
import { projectLibraryCommands } from './commands/projects.ts';
import { mediaCommands } from './commands/media.ts';
import { narrationCommands } from './commands/narration.ts';
import { voiceCommands } from './commands/voice.ts';
import { dialogueCommands } from './commands/dialogue.ts';
import { downloadCommands } from './commands/downloads.ts';
import { sourceCommands } from './commands/sources.ts';
import { accountCommands, publishCommands } from './commands/cloud.ts';

// The command groups, in the order of the help. A group module owns its section of the help and
// its commands; adding a group (media, backups…) is adding it here. docs/cli.md is written from them.
export const GROUPS: readonly CommandGroup[] = [projectCommands, projectLibraryCommands, historyCommands, sourceCommands, mediaCommands, narrationCommands, voiceCommands, soundCommands, dialogueCommands, downloadCommands, buildAndTestCommands, accountCommands, publishCommands, designCommands, fontCommands, componentCommands, objectCommands, contractCommands, translationCommands, interopCommands, agentCommands, toolCommands];

const section = (group: CommandGroup) => `${group.title}\n${group.help}`;

// A command's own lines of its group's help: its usage line and the lines under it, down to the next
// command (an agent that mistyped an option needs those, not the whole group).
export function commandUsage(group: CommandGroup, name: string): string {
  const lines = group.help.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`  ${name} `) || line === `  ${name}`);
  if (start < 0) return section(group);
  const end = lines.findIndex((line, index) => index > start && /^ {2}[a-z]/.test(line));
  return lines.slice(start, end < 0 ? lines.length : end).join('\n');
}
// Every command, for a word that is none of them.
const commandList = () => `Commands: ${[...new Set(GROUPS.flatMap((group) => group.commands.map((command) => command.name)))].join(', ')}.\nelabora --help prints the reference, elabora <command> --help its group.`;

const HELP = `elabora ${ELABORA_VERSION} — open e-learning format, SCORM 1.2 compiler and checks for AI agents

Usage: elabora <command> [options]

${GROUPS.map(section).join('\n\n')}
`;

// Commands by name ("validate", "component new"), and groups by the first word of their commands.
const COMMANDS = new Map<string, { command: Command; group: CommandGroup }>();
const GROUP_OF_WORD = new Map<string, CommandGroup>();
const SUBCOMMAND_USAGE = new Map<string, string>();
for (const group of GROUPS) {
  for (const command of group.commands) {
    COMMANDS.set(command.name, { command, group });
    GROUP_OF_WORD.set(command.name.split(' ')[0], group);
  }
  for (const [word, usage] of Object.entries(group.subcommandUsage || {})) SUBCOMMAND_USAGE.set(word, usage);
}

export async function main(argv: readonly string[]): Promise<ExitCode> {
  const [word, subcommand] = argv;
  if (word === undefined || word === 'help' || word === '--help') { console.log(HELP); return 0; }
  if (word === 'version' || word === '--version') { console.log(ELABORA_VERSION); return 0; }
  if (argv.includes('--help')) {
    // A command: its own usage; a group's word (object, plan…): the group.
    const named = COMMANDS.get(`${word} ${subcommand}`) ?? (subcommand === '--help' || !GROUP_OF_WORD.get(word)?.commands.some((command) => command.name.startsWith(`${word} `)) ? COMMANDS.get(word) : undefined);
    if (named) { console.log(`${commandUsage(named.group, named.command.name)}\n(elabora help: every command)`); return 0; }
    const group = GROUP_OF_WORD.get(word);
    console.log(group ? section(group) : HELP);
    return 0;
  }
  if (word.startsWith('--')) { console.error(`Unknown option ${word}: the command comes first.\n${commandList()}`); return 2; }
  const found = COMMANDS.get(`${word} ${subcommand}`) ?? COMMANDS.get(word);
  if (!found) {
    const usage = SUBCOMMAND_USAGE.get(word);
    if (usage) { console.error(usage); return 2; }
    const near = [...COMMANDS.keys()].filter((name) => name.startsWith(word.slice(0, 3)) || name.includes(word)).slice(0, 6);
    console.error(`Unknown command "${word}".${near.length ? ` Maybe: ${near.join(', ')}.` : ''}\n${commandList()}`);
    return 2;
  }
  const { command, group } = found;
  const args = argv.slice(command.name.split(' ').length);
  // A command run in a course brings its rules for agents up to date when nobody edited them, and
  // says when they come from a newer Elabora (agent-rules.ts, D34). On stderr: outputs stay as they are.
  if (!OWN_RULES.has(command.name.split(' ')[0])) {
    const dir = courseDirOf(args);
    if (dir) {
      const { syncAgentRules } = await import('@elabora/node/agent-rules');
      const note = syncAgentRules(dir);
      if (note) console.error(note);
    }
  }
  try {
    return await command.run(args);
  } catch (error) {
    if (!(error instanceof ArgumentError)) throw error;
    console.error(`${error.message} for "elabora ${command.name}".\n\nUsage:\n${commandUsage(group, command.name)}\n(elabora help: every command)`);
    return 2;
  }
}

// Commands that do not run in a course, or see to its rules themselves (migrate writes the format
// first; mcp when its server starts), and the history's (undo, redo, history): a bare elabora undo
// undoes the author's last change, not a rules update written just before it.
const OWN_RULES = new Set(['account', 'docs', 'init', 'templates', 'projects', 'import', 'export', 'migrate', 'mcp', 'tools', 'rules', 'profiles', 'codes', 'inspect', 'diff', 'undo', 'redo', 'history']);

// The course a command runs in: an argument that is a course folder (a flag's value may come first:
// « elabora look --screen intro ../B »), else the current folder when no argument names a folder.
function courseDirOf(args: readonly string[]): string | null {
  const isCourse = (dir: string) => fs.existsSync(path.join(dir, 'course.json'));
  const words = args.filter((arg) => !arg.startsWith('-'));
  const course = words.find(isCourse);
  if (course) return course;
  const folder = words.some((word) => { try { return fs.statSync(word).isDirectory(); } catch { return false; } });
  return !folder && isCourse('.') ? '.' : null;
}
