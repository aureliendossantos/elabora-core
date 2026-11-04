import fs from 'node:fs';
import path from 'node:path';
import { ELABORA_VERSION } from '@elabora/node/bundles';
import { ArgumentError, editDistance } from './arguments.ts';
import { detectAuthor } from '@elabora/node/journal/author';
import { COMMAND_ACTIVITY, commandPlace, withActivity } from './activity.ts';
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
// The commands closest to a mistyped word: same first letters, the word inside, or one or two
// letters off (valdate, lok).
function nearCommands(word: string): string[] {
  const names = [...COMMANDS.keys()];
  const close = (name: string) => { const first = name.split(' ')[0]; return first !== word && editDistance(word, first) <= (word.length > 5 ? 2 : 1); };
  return names.filter((name) => name.startsWith(word.slice(0, 3)) || name.includes(word) || close(name)).slice(0, 6);
}
const orList = (items: readonly string[]) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}` : items[0]);
const SEE_HELP = 'Run elabora help to see every command.';

const HELP = `elabora ${ELABORA_VERSION} — turns a course folder into a SCORM 1.2 package for your LMS

A course is plain files in an open format: agents write them, people review them, elabora checks and builds them.

Usage: elabora <command> [options]
       elabora <command> --help     show one command's options

Start here (in a checkout of elabora-core)
  elabora validate examples/canal-locks               Check a sample course
  elabora build examples/canal-locks                  Make its SCORM 1.2 package in examples/canal-locks/dist/
  elabora preview examples/canal-locks                Open it in a browser; pages reload when its files change
  elabora init my-course --id my-course --title "My course" --lang en
                                                      Create your own course, then check it with elabora validate my-course

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
  // elabora help validate: as elabora validate --help.
  if (word === 'help' && subcommand !== undefined && subcommand !== '--help') return main([...argv.slice(1), '--help']);
  if (word === undefined || word === 'help' || word === '--help') { console.log(HELP); return 0; }
  if (word === 'version' || word === '--version') { console.log(ELABORA_VERSION); return 0; }
  if (argv.includes('--help')) {
    // A command: its own usage; a group's word (object, plan…): the group.
    const named = COMMANDS.get(`${word} ${subcommand}`) ?? (subcommand === '--help' || !GROUP_OF_WORD.get(word)?.commands.some((command) => command.name.startsWith(`${word} `)) ? COMMANDS.get(word) : undefined);
    if (named) { console.log(`${commandUsage(named.group, named.command.name)}\n${SEE_HELP}`); return 0; }
    const group = GROUP_OF_WORD.get(word);
    console.log(group ? section(group) : HELP);
    return 0;
  }
  if (word.startsWith('--')) { console.error(`Unknown option ${word}: put the command first (elabora validate --json).\n${SEE_HELP}`); return 2; }
  const found = COMMANDS.get(`${word} ${subcommand}`) ?? COMMANDS.get(word);
  if (!found) {
    const usage = SUBCOMMAND_USAGE.get(word);
    if (usage) { console.error(usage); return 2; }
    const near = nearCommands(word);
    console.error(`Unknown command "${word}".${near.length ? ` Did you mean ${orList(near)}?` : ''}\n${SEE_HELP}`);
    return 2;
  }
  const { command, group } = found;
  const args = argv.slice(command.name.split(' ').length);
  // A command run in a course brings its rules for agents up to date when nobody edited them, and
  // says when they come from a newer Elabora (agent-rules.ts, D34). On stderr: outputs stay as they are.
  // The course it runs in, once: for its rules and for what an agent does there.
  const family = COMMAND_ACTIVITY[command.name];
  const dir = !OWN_RULES.has(command.name.split(' ')[0]) || family ? courseDirOf(args) : null;
  if (!OWN_RULES.has(command.name.split(' ')[0])) {
    if (dir) {
      const { syncAgentRules } = await import('@elabora/node/agent-rules');
      const note = syncAgentRules(dir);
      if (note) console.error(note);
    }
  }
  try {
    // An agent at work in a course: what it does, for the app to say it (activity.ts).
    if (!family || !dir) return await command.run(args);
    return await withActivity(dir, command.name, family, detectAuthor(), commandPlace(command.name, args), () => command.run(args), (code) => code === 0 || code === null);
  } catch (error) {
    if (!(error instanceof ArgumentError)) throw error;
    console.error(`${error.message} for "elabora ${command.name}".${error.hint ? ` ${error.hint}` : ''}\n\nUsage:\n${commandUsage(group, command.name)}\n${SEE_HELP}`);
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
