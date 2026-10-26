import fs from 'node:fs';
import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { findBlock } from '@elabora/core/commands/context';
import type { EditResult } from '@elabora/node/edit';
import { defineCommand, printDiagnostics, printFormatMigration, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  component list [dir]                                Block types of the course: built-in and components/<id>/
  component new [dir] <id> [--title <t>] [--level block|screen]
  component fork [dir] <parent> <id> [--title <t>]    Fork a component (built-in or course); the fork remembers its parent
  component preview [dir] <id> [--width 375] [--out file.png]   Specimen of its examples, rendered
  component migrate [dir] [<id>] [--from <version>]   Run migrations.mjs steps on every instance (all or nothing)
  component add [dir] <id> --library <dir> [--as <id>] [--upgrade] [--force]   Copy (or upgrade) a library component
  component publish [dir] <id> --library <dir>        Copy a course component into a library
  block duplicate [dir] <block> [--id <new id>]       Copy a block (and the blocks of its slots)
  block detach [dir] <block>                          Replace a component instance by its native fallback
  convert [dir] <screen> <block> --to <type>[:<presentation>] [--dry-run] [--lang fr] [--json]
                                                      « Transformer en… »: the block as another type or presentation, its id,
                                                      items and translations kept; without --to, the possible targets`;

// The course folder is optional before the arguments a command needs: with more positionals than
// that, the first one is the folder.
function folderAndArguments(positionals: readonly string[], needed: number): { dir: string; rest: readonly string[] } {
  return positionals.length > needed ? { dir: positionals[0], rest: positionals.slice(1) } : { dir: '.', rest: positionals };
}

// Findings on the files just written; the rest of the course is summed up (elabora validate).
function reportEdit(result: EditResult & { component?: string }, message: string): number {
  printFormatMigration(result.formatMigration);
  console.log(`✔ ${message}`);
  const touched = new Set(result.files);
  const own = result.diagnostics.filter((d) => (d.file !== undefined && touched.has(d.file)) || (result.component && 'target' in d && d.target === result.component));
  printDiagnostics(own);
  const others = result.diagnostics.filter((d) => d.severity === 'error' && !own.includes(d)).length;
  if (others) console.log(`${others} error(s) elsewhere in the course: elabora validate`);
  return 0;
}

const list = defineCommand({
  name: 'component list',
  flags: {},
  run: ({ positionals: [dir = '.'] }) => reportingFailures(async () => {
    const project = loadProjectFromDir(dir);
    const { getRegistry } = await import('@elabora/core/components/registry');
    for (const d of getRegistry(project).values()) console.log(`${d.id.padEnd(22)} ${d.builtin ? 'built-in ' : `${d.version.padEnd(9)}`}${d.level === 'screen' ? 'layout   ' : 'block    '}${d.behavior ? `${d.behavior.padEnd(9)}` : '         '}${d.parent ? `fork of ${d.parent} · ` : ''}${d.title}`);
    return 0;
  })
});

const create = defineCommand({
  name: 'component new',
  flags: { title: 'string', level: 'string' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const { dir, rest: [id] } = folderAndArguments(positionals, 1);
    const level = flags.level || 'block';
    if (level !== 'block' && level !== 'screen') { console.error('✘ --level is block or screen'); return 2; }
    const result = edit.createComponent(dir, { id, title: flags.title || id, level });
    return reportEdit(result, `Created ${result.files.join(', ')}. Write the props, template and fallback, then: elabora component preview ${id}`);
  })
});

const fork = defineCommand({
  name: 'component fork',
  flags: { title: 'string' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const { dir, rest: [parent, id] } = folderAndArguments(positionals, 2);
    const result = edit.forkComponent(dir, { component: parent, id, title: flags.title });
    return reportEdit(result, `Forked ${parent} into components/${id}/ (template copied; props, slots and styles inherited).`);
  })
});

const preview = defineCommand({
  name: 'component preview',
  flags: { width: 'string', out: 'string' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const { previewComponent } = await import('@elabora/node/preview');
    const { dir, rest: [id] } = folderAndArguments(positionals, 1);
    const width = Number(flags.width) || 1280;
    const result = await previewComponent(dir, { id, width });
    if (!result.ok) { if (result.diagnostics) printDiagnostics(result.diagnostics); else console.error(result.error); return 1; }
    const file = path.resolve(flags.out || `${id}-${width}.png`);
    fs.writeFileSync(file, result.png);
    console.log(`✔ ${file} (${result.count} instance(s))${result.consoleErrors.length ? `\nconsole errors:\n  ${result.consoleErrors.join('\n  ')}` : ''}`);
    return 0;
  })
});

const migrate = defineCommand({
  name: 'component migrate',
  flags: { from: 'string' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    // One positional is the course folder when it holds a course.json, else the component id.
    const [first] = positionals;
    const firstIsCourse = !!first && fs.existsSync(path.join(first, 'course.json'));
    const dir = positionals.length > 1 || firstIsCourse ? first : '.';
    const [id] = positionals.length > 1 ? positionals.slice(1) : fs.existsSync(path.join(first || '.', 'course.json')) ? [] : positionals;
    const result = await edit.migrateComponents(dir, { component: id, from: flags.from });
    if ('message' in result) { console.log(result.message); return 0; }
    for (const component of result.components) console.log(`✔ ${component.id} ${component.from} → ${component.to} (steps ${component.steps.join(', ')})`);
    console.log(`  ${result.migrated.length} instance(s) migrated. Undo with elabora undo.`);
    return 0;
  })
});

const add = defineCommand({
  name: 'component add',
  flags: { library: 'string', as: 'string', upgrade: 'boolean', force: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const { dir, rest: [id] } = folderAndArguments(positionals, 1);
    if (!flags.library) { console.error('Usage: elabora component add [dir] <id> --library <dir> [--as <id>] [--upgrade] [--force]'); return 2; }
    const result = edit.addLibraryComponent(dir, { library: flags.library, component: id, as: flags.as, upgrade: flags.upgrade, force: flags.force });
    return reportEdit(result, `${flags.upgrade ? 'Upgraded' : 'Added'} ${result.component} ${result.from ? `${result.from} → ` : ''}${result.to} from library ${result.library}.${flags.upgrade ? ' Run elabora component migrate if the props changed.' : ''}`);
  })
});

const publish = defineCommand({
  name: 'component publish',
  flags: { library: 'string' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const { dir, rest: [id] } = folderAndArguments(positionals, 1);
    if (!flags.library) { console.error('Usage: elabora component publish [dir] <id> --library <dir>'); return 2; }
    const result = edit.publishComponent(dir, { library: flags.library, component: id });
    return reportEdit(result, `Published ${result.component} ${result.version} to library ${result.library}.`);
  })
});

const duplicate = defineCommand({
  name: 'block duplicate',
  flags: { id: 'string' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const { dir, rest: [block] } = folderAndArguments(positionals, 1);
    const result = edit.duplicateBlock(dir, { block, id: flags.id });
    const renamed = Object.entries(result.renamed);
    console.log(`✔ ${block} → ${result.block} on screen ${result.screen}${renamed.length > 1 ? ` (${renamed.map(([from, to]) => `${from}→${to}`).join(', ')})` : ''}`);
    return 0;
  })
});

const detach = defineCommand({
  name: 'block detach',
  flags: {},
  run: ({ positionals }) => reportingFailures(() => {
    const { dir, rest: [block] } = folderAndArguments(positionals, 1);
    const result = edit.detachBlock(dir, { block });
    console.log(`✔ ${block} replaced by ${result.blocks.join(', ')}`);
    return 0;
  })
});

// « Transformer en… » (D63): accordion:cards, steps, sort:pairs… Without --to, the targets and the refused ones.
const convert = defineCommand({
  name: 'convert',
  flags: { to: 'string', 'dry-run': 'boolean', lang: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const { dir, rest: [screen, block] } = folderAndArguments(positionals, 2);
    if (!screen || !block) { console.error('Usage: elabora convert [dir] <screen> <block> --to <type>[:<presentation>] [--dry-run]'); return 2; }
    const project = loadProjectFromDir(dir);
    if (!project.screens.has(screen)) { console.error(`✘ No screen "${screen}"`); return 1; }
    const place = findBlock(project, block);
    if (place.screenId !== screen) { console.error(`✘ Block "${block}" is on screen "${place.screenId}", not "${screen}"`); return 1; }
    const [type, presentation] = (flags.to ?? '').split(':');
    const result = edit.convertBlock(dir, { block, ...(type ? { to: { type, ...(presentation ? { presentation } : {}) } } : {}), ...(flags['dry-run'] ? { dryRun: true } : {}), ...(flags.lang ? { language: flags.lang } : {}) });
    if (flags.json) { printJson(result); return 0; }
    const name = (to: { type: string; presentation?: string }) => `${to.type}${to.presentation ? `:${to.presentation}` : ''}`;
    const sentences = (entry: { kept?: string; lost?: string; added?: string }) => [entry.kept, entry.lost, entry.added].filter(Boolean).join(' ');
    if (result.targets) {
      console.log(`${block} (${name(result.from)}) converts into:`);
      for (const target of result.targets) console.log(`  ${name(target.to).padEnd(22)} ${sentences(target)}`);
      for (const refused of result.refused ?? []) console.log(`  ${name(refused.to).padEnd(22)} ✘ ${refused.reason}`);
      if (!result.targets.length && !result.refused?.length) console.log('  nothing: this block has no other form.');
      return 0;
    }
    const line = `${block}: ${name(result.from)} → ${name(result.to!)}. ${sentences(result)}`;
    if (result.dryRun) { console.log(`Dry run, nothing written. ${line}`); return 0; }
    return reportEdit(result, `${line}${result.translations ? ` ${result.translations} translation unit(s) followed their text.` : ''}`);
  })
});

export const componentCommands: CommandGroup = {
  title: 'Components',
  help: HELP,
  commands: [list, create, fork, preview, migrate, add, publish, duplicate, detach, convert],
  subcommandUsage: {
    component: 'Usage: elabora component list|new|fork|preview|migrate|add|publish …',
    block: 'Usage: elabora block duplicate|detach [dir] <block>'
  }
};
