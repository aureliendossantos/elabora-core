import fs from 'node:fs';
import path from 'node:path';
import * as edit from '@elabora/node/edit';
import { defineCommand, printDiagnostics, printJson } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  object new [dir] <id> [--title <t>] [--objectives OBJ-1,OBJ-2]
  object test [dir] <id> [--update-snapshots] [--browser chromium|electron|chrome|msedge|playwright|firefox|webkit] [--only <test name>] [--force]
                                                      Gates 2–6 of the free-object contract (result kept in object.gates.json);
                                                      an object unchanged since its last run here is not run again (--force runs it)
  object replay [dir] <id> [--test <name>] [--block <id>] [--size 1600x900] [--out sheet.png] [--json]
                                                      Replay a test of object.tests.json in the built course, on the page that
                                                      places the object, in real time: a contact sheet of its snapshot steps,
                                                      and its expectations checked`;

const USAGE = 'Usage: elabora object new|test|replay [dir] <id>';

// [dir] <id>: with two positionals, the first one is the course folder.
const folderAndId = (positionals: readonly string[]) => (positionals.length >= 2 ? { dir: positionals[0], id: positionals[1] } : { dir: '.', id: positionals[0] });

const create = defineCommand({
  name: 'object new',
  flags: { title: 'string', objectives: 'list' },
  run({ positionals, flags }) {
    const { dir, id } = folderAndId(positionals);
    if (!id) { console.error(USAGE); return 2; }
    const result = edit.createObject(dir, { id, title: flags.title || id, objectives: flags.objectives || [] });
    console.log(`Created ${result.files.join(', ')}.\nNext: write the manifest (props, state, events), then tests, then code. Place it with a free-object block.`);
    return 0;
  }
});

const test = defineCommand({
  name: 'object test',
  flags: { 'update-snapshots': 'boolean', browser: 'string', only: 'string', force: 'boolean', json: 'boolean' },
  async run({ positionals, flags }) {
    const { dir, id } = folderAndId(positionals);
    if (!id) { console.error(USAGE); return 2; }
    const { testObject } = await import('@elabora/node/objects/test');
    const result = await testObject(dir, id, { updateSnapshots: flags['update-snapshots'], browser: flags.browser || 'chromium', only: flags.only || null, force: flags.force });
    if (flags.json) printJson(result);
    else if (result.reused) console.log(`${result.ok ? '✔' : '✘'} ${id} — unchanged since ${result.reused.at}, not run again: ${Object.entries(result.gates).filter((entry) => typeof entry[1] === 'string').map(([gate, status]) => `${gate} ${status}`).join(', ')}.${result.ok ? '' : `\n${result.diagnostics.filter((d) => d.severity === 'error').map((d) => `  ${d.code} ${d.message}`).join('\n')}`}\n  --force runs it again.`);
    else {
      printDiagnostics(result.diagnostics);
      for (const [gate, status] of Object.entries(result.gates)) if (typeof status === 'string') console.log(`gate ${gate.padEnd(14)} ${status}`);
      const performance = result.gates.perf;
      if (performance?.bootMs != null) console.log(`boot           ${performance.bootMs} ms (median of ${(performance.bootSamples ?? []).length})`);
      if (result.snapshots?.removed.length) console.log(`snapshots      removed, no test names their state any more: ${result.snapshots.removed.join(', ')}`);
      if (result.snapshots?.kept.length) console.log(`snapshots      kept for other browsers and systems, whose runs compare with them: ${result.snapshots.kept.join(', ')}`);
      console.log(`\n${result.ok ? '✔' : '✘'} ${id}${flags.only ? ` (only tests matching "${flags.only}": not recorded)` : ` — recorded in objects/${id}/object.gates.json`}`);
    }
    return result.ok ? 0 : 1;
  }
});

const replay = defineCommand({
  name: 'object replay',
  flags: { test: 'string', block: 'string', size: 'string', out: 'string', json: 'boolean' },
  async run({ positionals, flags }) {
    const { dir, id } = folderAndId(positionals);
    if (!id) { console.error(USAGE); return 2; }
    const [width, height] = (flags.size || '1600x900').split('x').map(Number);
    const { replayObject } = await import('@elabora/node/preview');
    const result = await replayObject(dir, id, { test: flags.test, block: flags.block, width: width || 1600, height: height || 900 });
    if (result.error !== undefined) {
      if (result.diagnostics) printDiagnostics(result.diagnostics, { json: flags.json });
      console.error(`✘ ${result.error}`);
      return 1;
    }
    const file = path.resolve(flags.out || `${id}-replay.png`);
    fs.writeFileSync(file, result.png);
    if (flags.json) printJson({ ok: result.ok, object: result.object, block: result.block, screen: result.screen, test: result.test, frames: result.frames.map((frame) => frame.name), failures: result.failures, skipped: result.skipped, consoleErrors: result.consoleErrors, file });
    else {
      for (const failure of result.failures) console.log(`  ✘ ${failure}`);
      for (const note of result.skipped) console.log(`  · ${note}`);
      if (result.consoleErrors.length) console.log(`  console errors:\n    ${result.consoleErrors.join('\n    ')}`);
      console.log(`${result.ok ? '✔' : '✘'} "${result.test}" replayed on ${result.screen} (${result.block}): ${result.frames.length} frame(s) in ${file}`);
    }
    return result.ok ? 0 : 1;
  }
});

export const objectCommands: CommandGroup = {
  title: 'Free objects',
  help: HELP,
  commands: [create, test, replay],
  subcommandUsage: { object: USAGE }
};
