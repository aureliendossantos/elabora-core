import fs from 'node:fs';
import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { exportDialogue, DIALOGUE_EXPORT_FORMATS } from '@elabora/node/dialogue-export';
import type { DialogueExportFormat } from '@elabora/node/dialogue-export';
import { findDialogue, dialogueBlocks, projectDialogue } from '@elabora/core/dialogue/project';
import { dialogueScript, formatScript } from '@elabora/core/dialogue/script';
import { playDialogue, formatPlay, dialoguePaths, formatPaths } from '@elabora/core/dialogue/play';
import type { Project } from '@elabora/core/project/model';
import { splitList } from '../arguments.ts';
import { defineCommand, errorMessage, printJson } from './command.ts';
import type { CommandGroup } from './command.ts';

// Dialogues (docs/decisions.md D61): read, played and exported without a preview, by the player's
// own walk. The dialogue itself is a block, edited like any block (elabora_set_dialogue_node writes
// one node whole).

const HELP = `  dialogue show [dir] <block> [--json]                A dialogue block as a script: each node with its lines (name, stage
                                                      direction, line), its options with their quality, points, effects and
                                                      « then … » (where each one goes), their reply and feedback, then the
                                                      endings. Stable text: it also serves diffs
  dialogue play [dir] <block> [--choose b,a,a] [--json]
                                                      « Jouer un chemin »: the path of these choices (option ids, one for each
                                                      decision met, retries included), its lines and notes, the ending, the
                                                      score, the decisions and the duration (the lines' audio, else estimated
                                                      from the text). Exit code 1 when a choice is not offered (it says which
                                                      were)
  dialogue paths [dir] <block> [--limit <n>] [--json]
                                                      Every path: how many, the best and worst score and points, the endings
                                                      reached and never reached, the nodes never reached, and each path with
                                                      its choices, ending, score and duration (2000 paths at most)
  dialogue export [dir] <block> --to html|pdf [--out <file>] [--date YYYY-MM-DD] [--json]
                                                      The dialogue for the client: its map (every node and ending, placed by
                                                      Elabora), then its script, as one page (html) or printed (pdf, by
                                                      Elabora's or Google Chrome's Chromium); dist/<course>-<block>.<format>
                                                      by default`;

function courseAndArguments(positionals: readonly string[]): { dir: string; rest: string[] } {
  const [first, ...rest] = positionals;
  if (first !== undefined && fs.existsSync(path.join(first, 'course.json'))) return { dir: first, rest };
  return { dir: '.', rest: [...positionals] };
}

// The project and the dialogue the arguments name, or the message that says why not.
function dialogueOf(positionals: readonly string[], usage: string): { project: Project; ref: NonNullable<ReturnType<typeof findDialogue>>; dir: string; rest: string[] } | number {
  const { dir, rest: [block, ...rest] } = courseAndArguments(positionals);
  if (!block) { console.error(`Usage: ${usage}`); return 2; }
  if (!fs.existsSync(path.join(dir, 'course.json'))) { console.error(`✘ ${path.resolve(dir)} is not an Elabora course (no course.json).`); return 1; }
  const project = loadProjectFromDir(dir);
  const ref = findDialogue(project, block);
  if (!ref) { console.error(`✘ No dialogue block "${block}" (dialogues: ${dialogueBlocks(project).map((other) => other.id).join(', ') || 'none'}).`); return 1; }
  return { project, ref, dir, rest };
}

const show = defineCommand({
  name: 'dialogue show',
  flags: { json: 'boolean' },
  run({ positionals, flags }) {
    const found = dialogueOf(positionals, 'elabora dialogue show [dir] <block> [--json]');
    if (typeof found === 'number') return found;
    const script = dialogueScript(projectDialogue(found.project, found.ref), { id: found.ref.id, screen: found.ref.screen });
    if (flags.json) printJson(script);
    else console.log(formatScript(script));
    return 0;
  }
});

const play = defineCommand({
  name: 'dialogue play',
  flags: { choose: 'string', json: 'boolean' },
  run({ positionals, flags }) {
    const found = dialogueOf(positionals, 'elabora dialogue play [dir] <block> [--choose b,a,a] [--json]');
    if (typeof found === 'number') return found;
    const report = playDialogue(found.project, found.ref, flags.choose ? splitList(flags.choose) : []);
    if (flags.json) printJson(report);
    else console.log(formatPlay(report));
    return report.ok ? 0 : 1;
  }
});

const paths = defineCommand({
  name: 'dialogue paths',
  flags: { limit: 'string', json: 'boolean' },
  run({ positionals, flags }) {
    const found = dialogueOf(positionals, 'elabora dialogue paths [dir] <block> [--limit <n>] [--json]');
    if (typeof found === 'number') return found;
    const limit = flags.limit === undefined ? undefined : Number(flags.limit);
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) { console.error('--limit is a number of paths (2000 at most by default).'); return 2; }
    const report = dialoguePaths(found.project, found.ref, limit ? { limit } : {});
    if (flags.json) printJson(report);
    else console.log(formatPaths(report));
    return 0;
  }
});

const exportCommand = defineCommand({
  name: 'dialogue export',
  flags: { to: 'string', out: 'string', date: 'string', json: 'boolean' },
  async run({ positionals, flags }) {
    const usage = 'elabora dialogue export [dir] <block> --to html|pdf [--out <file>] [--date YYYY-MM-DD] [--json]';
    if (!flags.to || !DIALOGUE_EXPORT_FORMATS.includes(flags.to as DialogueExportFormat)) { console.error(`Usage: ${usage}`); return 2; }
    if (flags.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) { console.error('--date is a day, YYYY-MM-DD.'); return 2; }
    const found = dialogueOf(positionals, usage);
    if (typeof found === 'number') return found;
    try {
      const result = await exportDialogue(found.dir, { block: found.ref.id, to: flags.to as DialogueExportFormat, ...(flags.out ? { out: path.resolve(flags.out) } : {}), ...(flags.date ? { date: flags.date } : {}) });
      if (flags.json) printJson({ ok: true, ...result });
      else console.log(`✔ ${path.relative(process.cwd(), result.file) || result.file} (${result.format}, ${Math.round(result.bytes / 1024)} KB${result.browser ? `, printed by ${result.browser.engine} ${result.browser.version}` : ''})`);
      return 0;
    } catch (error) {
      if (flags.json) printJson({ ok: false, error: errorMessage(error) });
      else console.error(`✘ ${errorMessage(error)}`);
      return 1;
    }
  }
});

export const dialogueCommands: CommandGroup = {
  title: 'Dialogues (branching conversations held in a block)',
  help: HELP,
  commands: [show, play, paths, exportCommand],
  subcommandUsage: { dialogue: 'Usage: elabora dialogue show|play|paths|export [dir] <block> …' }
};
