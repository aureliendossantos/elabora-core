import { projectMarkdown } from '@elabora/core/project/markdown';
import { summarizeNotes } from '@elabora/core/format/migrations/index';
import { formatDiagnostic } from '@elabora/core/diagnostics/index';
import { initProject } from '@elabora/node/scaffold';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { validateProject } from '@elabora/core/validate/index';
import { defineCommand, printDiagnostics, printFormatMigration, printJson, reportingFailures, summaryErrors } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  init <dir> --id <id> --title <title> [--lang fr]   Scaffold a course project (course.json, plan.json, AGENTS.md)
       [--audience <who>] [--business-goal <goal>]    What the author already said of it: the plan's audience, business goal and
       [--duration 10-20|5|30+] [--presentation        duration in minutes, the presentation, the LMS, and notes for agents in
       slides|scroll] [--lms a,b] [--notes <text>]    AGENTS.md (the tone, the brand wanted, what is left to the agent)
  validate [dir] [--profile a,b] [--release] [--json] Check format, plan conformity, pedagogy, accessibility, budgets
  project [dir] [--client] [--screen <id>]            Markdown view of the course (agent map, or client review)
  migrate [dir] [--dry-run] [--json]                  Write the course in the current format (older ones are read migrated): one
                                                      change after a backup version, undone by elabora undo
  rename [dir] <old-id> <new-id> [--json]             Rename a section, screen, layer, block or event: its references, the
                                                      screen file and the state lock follow (learner progress keeps its key)
  ignore [dir] <code> <key> [--restore] [--json]      When the author asks: ignore a warning that has a key (elabora validate
                                                      prints it), as « Ignorer » in the editor does (course.json ignored,
                                                      D31); it comes back when what it found changes. --restore: back`;

const init = defineCommand({
  name: 'init',
  flags: { id: 'string', title: 'string', lang: 'string', audience: 'string', 'business-goal': 'string', duration: 'string', presentation: 'string', lms: 'list', notes: 'string' },
  run({ positionals: [dir], flags }) {
    if (!dir || !flags.id || !flags.title) { console.error('Usage: elabora init <dir> --id <id> --title <title> [--lang fr]'); return 2; }
    const duration = flags.duration === undefined ? undefined : durationOf(flags.duration);
    if (duration === null) { console.error('--duration: minutes as 10-20, 5 or 30+'); return 2; }
    if (flags.presentation !== undefined && flags.presentation !== 'slides' && flags.presentation !== 'scroll') { console.error('--presentation: slides or scroll'); return 2; }
    const brief = { audience: flags.audience, businessGoal: flags['business-goal'], duration, presentation: flags.presentation as 'slides' | 'scroll' | undefined, lms: flags.lms, notes: flags.notes };
    const created = initProject(dir, { id: flags.id, title: flags.title, language: flags.lang || 'fr', ...(Object.values(brief).some((value) => value !== undefined) ? { brief } : {}) });
    console.log(`Created ${created.files.join(', ')} in ${created.dir}.\nNext: replace plan.json with the client's validated plan, then run elabora validate.`);
    return 0;
  }
});

// « 10-20 » (a range), « 5 » (one figure), « 30+ » (longer than that), in minutes; null: none of them.
function durationOf(text: string): { min?: number; max?: number } | null {
  const found = /^\s*(\d+)\s*(?:(-|–)\s*(\d+)|(\+))?\s*$/.exec(text);
  if (!found) return null;
  const min = Number(found[1]);
  if (found[4]) return { min };
  return { min, max: found[3] ? Number(found[3]) : min };
}

const validate = defineCommand({
  name: 'validate',
  flags: { profile: 'list', release: 'boolean', json: 'boolean' },
  run({ positionals: [dir = '.'], flags }) {
    const result = validateProject(loadProjectFromDir(dir), { profiles: flags.profile, release: flags.release });
    const { budget } = result.context;
    if (flags.json) printJson({ ok: result.ok, summary: result.summary, budget, diagnostics: result.diagnostics });
    else {
      printDiagnostics(result.diagnostics);
      // Infos stay quiet, except these: the files are not in the format Elabora reads them in, or their
      // theme still overrides their components (D32).
      for (const d of result.diagnostics) if (d.code === 'I_FORMAT_OUTDATED' || d.code === 'I_THEME_CASCADE_OLD') console.log(formatDiagnostic(d));
      const { summary } = result;
      console.log(`\n${result.ok ? '✔' : '✘'} ${summary.errors} error(s), ${summary.warnings} warning(s)${summary.waived ? `, ${summary.waived} waived` : ''}${summary.ignored ? `, ${summary.ignored} ignored by the author` : ''}. suspend_data worst case ${budget?.worstCase ?? '?'} / ${budget?.limit ?? '?'} (${(budget?.profiles || []).join(', ')}).`);
    }
    return result.ok ? 0 : 1;
  }
});

const project = defineCommand({
  name: 'project',
  flags: { client: 'boolean', screen: 'string' },
  run({ positionals: [dir = '.'], flags }) {
    console.log(projectMarkdown(loadProjectFromDir(dir), { audience: flags.client ? 'client' : 'agent', screen: flags.screen }));
    return 0;
  }
});

const migrate = defineCommand({
  name: 'migrate',
  flags: { 'dry-run': 'boolean', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(() => {
    const result = edit.migrateProject(dir, { dryRun: flags['dry-run'] });
    if (flags.json) { printJson(result); return 0; }
    if (result.from === result.to) { console.log(`✔ The course is in ${result.to} already: nothing to migrate.`); return 0; }
    const what = `${result.files.length} file(s), from ${result.from} to ${result.to}`;
    if (result.dryRun) console.log(`Would migrate ${what} (nothing written):`);
    else console.log(`✔ Migrated ${what}: change ${result.change?.seq ?? '?'} (elabora undo reverts it)${result.backup?.version ? `, after backup version ${result.backup.version}` : ''}.`);
    for (const line of summarizeNotes(result.notes)) console.log(`  ${line}`);
    printDiagnostics(result.diagnostics.filter((d) => d.severity === 'error'));
    if (summaryErrors(result.summary)) console.log(`${summaryErrors(result.summary)} error(s) in the course: elabora validate`);
    return 0;
  })
});

const rename = defineCommand({
  name: 'rename',
  flags: { json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const [dir, from, to] = positionals.length > 2 ? positionals : ['.', ...positionals];
    if (!from || !to) { console.error('Usage: elabora rename [dir] <old-id> <new-id>'); return 2; }
    const result = edit.rename(dir, { from, to });
    if (flags.json) { printJson(result); return 0; }
    printFormatMigration(result.formatMigration);
    const { kind, references } = result.renamed;
    console.log(`✔ Renamed ${kind} ${from} to ${to}: ${references} reference(s) and ${result.files.length} file(s) (${result.files.join(', ')}). elabora undo reverts it.`);
    if (result.waivers) console.log(`  ${result.waivers} waiver(s) of the plan named "${from}": they name "${to}" now (the plan's diff shows it).`);
    const touched = new Set(result.files);
    printDiagnostics(result.diagnostics.filter((d) => d.file !== undefined && touched.has(d.file)));
    if (summaryErrors(result.summary)) console.log(`${summaryErrors(result.summary)} error(s) in the course: elabora validate`);
    return 0;
  })
});

const ignore = defineCommand({
  name: 'ignore',
  flags: { restore: 'boolean', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(() => {
    const [dir, code, key] = positionals.length >= 3 ? positionals : ['.', ...positionals];
    if (!code || !key) { console.error('Usage: elabora ignore [dir] <code> <key> [--restore]'); return 2; }
    const result = edit.ignoreFindings(dir, { findings: [{ code, key }], ignored: !flags.restore });
    if (flags.json) { printJson(result); return 0; }
    printFormatMigration(result.formatMigration);
    console.log(flags.restore ? `✔ ${code} ${key} counts again.` : `✔ ${code} ${key} is ignored by the author until what it found changes.`);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

export const projectCommands: CommandGroup = { title: 'Project', help: HELP, commands: [init, validate, project, migrate, rename, ignore] };
