import fs from 'node:fs';
import type { PatchOperation } from '@elabora/format';
import { describePlanVersions, planDiffBetween, planVersionsView, versionLabel, versionNumber } from '@elabora/core/project/plan-versions';
import type { PlanRef } from '@elabora/core/project/plan-versions';
import type { PlanChange } from '@elabora/core/project/plan-diff';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { exportPlanDocument, PLAN_DOCUMENT_FORMATS } from '@elabora/node/plan-document';
import type { PlanDocumentFormat } from '@elabora/node/plan-document';
import { defineCommand, errorMessage, printJson, summaryErrors } from './command.ts';
import type { CommandGroup } from './command.ts';

// The plan and its versions (docs/decisions.md D52): plan.json is the working copy, written at any
// time; a person makes its versions and records the client's validation of one; exporting shows a
// version (the latest by default) and records that it was sent, never making one.

const HELP = `  plan status [dir] [--json]                          The plan's versions (made, sent, validated) and what changed since
  plan write [dir] (--from <plan.json> | --patch <patch.json>)
                                                      Write the plan at any time (the whole plan, or a JSON Patch of it), its
                                                      schema checked first; items moved take their screens along. Agents never
                                                      change a text kept « à l'identique » (verbatim)
  plan text [dir] <TXT-1|block> --text <wording>      Reword a validated text of the plan (by its id, or a block that shows it)
  plan voiceover [dir] <item> (--from <file.txt> | --clear)
                                                      The voice-over of an item, one line per line of the file (« marc: Bonjour… »
                                                      for a speaker); elabora narration from-plan makes it a screen's script
  plan diff [dir] [--from <Vn|validated|latest>] [--to <Vn|current>] [--json]
                                                      What changed in the plan, element by element (by default since the
                                                      validated version, to the working copy)
  plan revert [dir] <key> [--version <Vn>]            Undo one change of the diff (item:ITEM-3, text:TXT-2…): back to the
                                                      validated version (or the one given)
  plan note [dir] <key> (--text <note> | --clear)     A note for the client on a change in no version yet: frozen with the next
                                                      version, a comment in Word
  plan version [dir] [--note <text>]                  A person's: freeze the working copy as the next version (V1, V2…)
  plan approve [dir] [--version <Vn>] --by "<name, organisation>" [--reference <ref>] [--date YYYY-MM-DD]
                                                      A person's: the client validated a version (the latest by default)
  plan export [dir] [--version <Vn|current>] [--format pdf|docx|html] [--out <file>] [--date YYYY-MM-DD] [--json]
                                                      The plan's document, what the client reads, comments and signs: the
                                                      latest version (the working copy without one), its changes since the
                                                      validated version as tracked changes in Word; PDF (default; printed by
                                                      Elabora's or Google Chrome's Chromium), Word or one HTML page, in
                                                      dist/<course>-plan.<format> by default. Records the send on the
                                                      version; never makes one`;

// The screens and sections that followed the plan's items (D50), in a sentence.
const movedLine = (moved: { screens: string[]; sections: string[]; renamed: string[] } | undefined): string => {
  if (!moved) return '';
  const parts = [
    moved.screens.length ? `screen(s) ${moved.screens.join(', ')} moved with their item` : '',
    moved.sections.length ? `section(s) ${moved.sections.join(', ')} moved with their part` : '',
    moved.renamed.length ? `section(s) ${moved.renamed.join(', ')} renamed with their part` : ''
  ].filter(Boolean);
  return parts.length ? ` In course.json, ${parts.join('; ')}.` : '';
};

// [dir] <id>: with two positionals, the first one is the course folder.
const folderAndId = (positionals: readonly string[]) => (positionals.length >= 2 ? { dir: positionals[0]!, id: positionals[1] } : { dir: '.', id: positionals[0] });

const versionsLine = (dir: string): string => `Versions: ${describePlanVersions(planVersionsView(loadProjectFromDir(dir)))}`;

const status = defineCommand({
  name: 'plan status',
  flags: { json: 'boolean' },
  run({ positionals: [dir = '.'], flags }) {
    const project = loadProjectFromDir(dir);
    if (!project.plan) { console.error(`No readable plan.json in ${dir}`); return 1; }
    const view = planVersionsView(project);
    if (flags.json) { printJson(view); return 0; }
    const lines = [`${project.plan.id}: ${describePlanVersions(view)}`];
    for (const version of view.versions) {
      const sends = version.sends.map((send) => `${send.date} (${send.format})`).join(', ');
      lines.push(`  ${version.label}  made ${version.date}${sends ? ` · sent ${sends}` : ''}${version.validation ? ` · validated by ${version.validation.by} on ${version.validation.date}${version.validation.reference ? ` (${version.validation.reference})` : ''}` : ''}${version.note ? ` · « ${version.note} »` : ''}`);
    }
    if (view.verbatimChanged.length) lines.push(`Kept « à l'identique » and changed since the validated version: ${view.verbatimChanged.join(', ')}.`);
    if (view.notes) lines.push(`${view.notes} note(s) for the client wait for the next version.`);
    lines.push(`current hash ${view.current.contentHash ?? '—'}`);
    console.log(lines.join('\n'));
    return 0;
  }
});

const WRITE_USAGE = 'Usage: elabora plan write [dir] (--from <plan.json> | --patch <patch.json>)';

const write = defineCommand({
  name: 'plan write',
  flags: { from: 'string', patch: 'string' },
  run({ positionals: [dir = '.'], flags }) {
    if (!flags.from === !flags.patch) { console.error(WRITE_USAGE); return 2; }
    const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
    const args = flags.from ? { plan: read(flags.from) as Record<string, unknown> } : { patch: read(flags.patch!) as PatchOperation[] };
    const result = edit.writePlan(dir, args);
    const errors = summaryErrors(result.summary);
    console.log(`✔ Plan ${result.plan}: ${result.objectives} objective(s), ${result.items} item(s).${movedLine(result.moved)}${errors ? ` The course has ${errors} error(s): elabora validate .` : ''} ${versionsLine(dir)}.`);
    return 0;
  }
});

const text = defineCommand({
  name: 'plan text',
  flags: { text: 'string' },
  run({ positionals, flags }) {
    const { dir, id } = folderAndId(positionals);
    if (!id || flags.text === undefined) { console.error('Usage: elabora plan text [dir] <TXT-1|block> --text <wording>'); return 2; }
    const isPlanId = /^[A-Z][A-Z0-9_-]*$/.test(id);
    const result = edit.setPlanText(dir, { ...(isPlanId ? { text: id } : { block: id }), markdown: flags.text });
    console.log(result.change ? `✔ ${result.text} reworded in the plan: every block that shows it shows the new wording.` : `${result.text} already says that.`);
    return 0;
  }
});

const voiceover = defineCommand({
  name: 'plan voiceover',
  flags: { from: 'string', clear: 'boolean' },
  run({ positionals, flags }) {
    const { dir, id } = folderAndId(positionals);
    if (!id || (!flags.from === !flags.clear)) { console.error('Usage: elabora plan voiceover [dir] <item> (--from <file.txt> | --clear)'); return 2; }
    const lines = flags.clear ? null : fs.readFileSync(flags.from!, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const speaker = /^([a-z][a-z0-9-]{0,47})\s*:\s+(.+)$/.exec(line);
      return speaker ? { speaker: speaker[1]!, text: speaker[2]! } : { text: line };
    });
    edit.setPlanVoiceover(dir, { item: id, lines });
    console.log(`✔ ${id} ${lines ? `has a voice-over of ${lines.length} line(s)` : 'has no voice-over any more'}. Screens covering it: elabora narration from-plan . <screen>.`);
    return 0;
  }
});

// --from / --to: a version (V2), validated, latest or current.
function planRef(value: string | undefined, fallback: PlanRef): PlanRef | null {
  if (value === undefined) return fallback;
  if (value === 'validated' || value === 'latest' || value === 'current') return value;
  return versionNumber(value);
}

const STATUS_WORDS: Record<PlanChange['status'], string> = { added: 'added', removed: 'removed', changed: 'changed' };

export function changeLine(change: PlanChange): string {
  const parts: string[] = [];
  if (change.moved) parts.push(`moved from ${change.fromItem ? `${change.fromItem}, ` : ''}${change.moved.from} to ${change.moved.to}`);
  if (change.part) parts.push(`part « ${change.part.from ?? '—'} » → « ${change.part.to ?? '—'} »`);
  if (change.fields.length) parts.push(`fields ${change.fields.map((field) => field.field).join(', ')}`);
  if (change.verbatim) parts.push('kept « à l\'identique »');
  return `  ${change.key}  ${STATUS_WORDS[change.status]}${change.label && change.label !== change.id ? ` « ${change.label} »` : ''}${parts.length ? ` (${parts.join('; ')})` : ''}`;
}

const DIFF_USAGE = 'Usage: elabora plan diff [dir] [--from <Vn|validated|latest>] [--to <Vn|current>] [--json]';

const diff = defineCommand({
  name: 'plan diff',
  flags: { from: 'string', to: 'string', json: 'boolean' },
  run({ positionals: [dir = '.'], flags }) {
    const from = planRef(flags.from, 'validated');
    const to = planRef(flags.to, 'current');
    if (from === null || to === null) { console.error(DIFF_USAGE); return 2; }
    let result;
    try { result = planDiffBetween(loadProjectFromDir(dir), { from, to }); } catch (error) { console.error(`✘ ${errorMessage(error)}`); return 1; }
    if (flags.json) { printJson(result); return 0; }
    const name = (version: number | null, end: 'from' | 'to') => (version !== null ? versionLabel(version) : end === 'to' ? 'the working copy' : 'nothing (no version)');
    const { added, removed, changed } = result.counts;
    console.log(`From ${name(result.from, 'from')} to ${name(result.to, 'to')}: ${result.changes.length ? `${result.changes.length} change(s): ${added} added, ${removed} removed, ${changed} changed.` : 'nothing changed.'}`);
    for (const change of result.changes) console.log(changeLine(change));
    return 0;
  }
});

const revert = defineCommand({
  name: 'plan revert',
  flags: { version: 'string' },
  run({ positionals, flags }) {
    const { dir, id } = folderAndId(positionals);
    if (!id) { console.error('Usage: elabora plan revert [dir] <key> [--version <Vn>]'); return 2; }
    const result = edit.revertPlanChange(dir, { key: id, ...(flags.version ? { version: flags.version } : {}) });
    console.log(`✔ ${id} is as in ${result.version} again.${movedLine(result.moved)}`);
    return 0;
  }
});

const note = defineCommand({
  name: 'plan note',
  flags: { text: 'string', clear: 'boolean' },
  run({ positionals, flags }) {
    const { dir, id } = folderAndId(positionals);
    if (!id || (flags.text === undefined) === !flags.clear) { console.error('Usage: elabora plan note [dir] <key> (--text <note> | --clear)'); return 2; }
    const result = edit.setPlanNote(dir, { target: id, text: flags.clear ? null : flags.text! });
    console.log(flags.clear ? `✔ No note on ${id} any more.` : `✔ Note for the client on ${id}: the next version takes it (${result.notes} note(s) waiting).`);
    return 0;
  }
});

const version = defineCommand({
  name: 'plan version',
  flags: { note: 'string', date: 'string' },
  run({ positionals: [dir = '.'], flags }) {
    if (flags.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(flags.date)) { console.error('Usage: elabora plan version [dir] [--note <text>]'); return 2; }
    const result = edit.createPlanVersion(dir, { ...(flags.note ? { note: flags.note } : {}), ...(flags.date ? { date: flags.date } : {}) });
    const dropped = result.droppedNotes.length ? ` Note(s) on changes undone since were dropped: ${result.droppedNotes.join(', ')}.` : '';
    console.log(`✔ ${result.version} made (hash ${result.contentHash}${result.notes ? `, ${result.notes} note(s) for the client` : ''}).${dropped} Send it: elabora plan export . --version ${result.version}; once the client validated it: elabora plan approve . --version ${result.version} --by "<name>".`);
    return 0;
  }
});

const APPROVE_USAGE = 'Usage: elabora plan approve [dir] [--version <Vn>] --by "<name, organisation>" [--reference <ref>] [--date YYYY-MM-DD]';

const approve = defineCommand({
  name: 'plan approve',
  flags: { version: 'string', by: 'string', reference: 'string', date: 'string' },
  run({ positionals: [dir = '.'], flags }) {
    if (!flags.by || (flags.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(flags.date))) { console.error(APPROVE_USAGE); return 2; }
    const result = edit.approvePlan(dir, { by: flags.by, ...(flags.version ? { version: flags.version } : {}), ...(flags.reference ? { reference: flags.reference } : {}), ...(flags.date ? { date: flags.date } : {}) });
    const errors = summaryErrors(result.summary);
    console.log(`✔ ${result.version} validated by ${flags.by}. ${versionsLine(dir)}.${errors ? ` The course still has ${errors} error(s).` : ''}`);
    return 0;
  }
});

const EXPORT_USAGE = 'Usage: elabora plan export [dir] [--version <Vn|current>] [--format pdf|docx|html] [--out <file>] [--date YYYY-MM-DD] [--json]';
const FORMAT_NAMES: Record<PlanDocumentFormat, string> = { pdf: 'PDF', docx: 'Word', html: 'HTML' };

const exportDocument = defineCommand({
  name: 'plan export',
  flags: { version: 'string', format: 'string', out: 'string', date: 'string', json: 'boolean' },
  async run({ positionals: [dir = '.'], flags }) {
    const format = (flags.format ?? 'pdf').toLowerCase() as PlanDocumentFormat;
    const shown = flags.version === undefined || flags.version === 'current' ? flags.version : versionNumber(flags.version);
    if (!PLAN_DOCUMENT_FORMATS.includes(format) || shown === null || (flags.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(flags.date))) { console.error(EXPORT_USAGE); return 2; }
    try {
      const view = planVersionsView(loadProjectFromDir(dir));
      const result = await exportPlanDocument(dir, { format, ...(shown !== undefined ? { version: shown } : {}), ...(flags.out ? { out: flags.out } : {}), ...(flags.date ? { date: flags.date } : {}) });
      if (flags.json) { printJson(result); return 0; }
      const what = result.version ? `${result.version}${result.sent ? ', recorded as sent' : ''}` : view.latest ? 'the working copy' : 'the working copy (no version yet: elabora plan version makes V1)';
      const since = result.version && result.version === (view.latest ? versionLabel(view.latest) : null) && view.current.unversioned ? ` The plan changed since: ${view.current.unversioned} change(s) are in no version (elabora plan version makes the next one).` : '';
      const state = result.state === 'approved' ? '' : result.state === 'modified' ? ' It shows its changes since the validated version.' : ' No version is validated yet: the document says so.';
      console.log(`✔ ${FORMAT_NAMES[format]} written: ${result.file} (${Math.max(1, Math.round(result.bytes / 1024))} KB${result.browser ? `, printed by ${result.browser.engine} ${result.browser.version}` : ''}), showing ${what}.${state}${since}`);
      return 0;
    } catch (error) {
      console.error(`✘ ${errorMessage(error)}`);
      return 1;
    }
  }
});

export const contractCommands: CommandGroup = {
  title: 'Contract (the plan and its versions)',
  help: HELP,
  commands: [status, write, text, voiceover, diff, revert, note, version, approve, exportDocument],
  subcommandUsage: { plan: 'Usage: elabora plan status|write|text|voiceover|diff|revert|note|version|approve|export [dir]' }
};
