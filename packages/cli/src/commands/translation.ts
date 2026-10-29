import { defineCommand, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';
import { translationReady } from '@elabora/core/i18n/translate';

const HELP = `  translate export [dir] --to <lang>                  Create or update the XLIFF 2.0 file: every string, what changed since
  translate status [dir] [--to <lang>]                Translated, to translate and stale units; broken maths or placeholders
  translate build [dir] --to <lang> --out <dir> [--allow-missing] [--json]
                                                      Generate the translated course (then elabora build it as any course)
  translate approve [dir] --to <lang> --by "<name, organisation>" [--reference <ref>]
                                                      Approve the translated plan (human decision, kept with the source)`;

const exportCommand = defineCommand({
  name: 'translate export',
  flags: { to: 'string', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(async () => {
    const { exportTranslation } = await import('@elabora/node/translate');
    if (!flags.to) { console.error('Usage: elabora translate export [dir] --to <lang>'); return 2; }
    const result = exportTranslation(dir, { to: flags.to });
    if (flags.json) { printJson(result); return 0; }
    console.log(`✔ ${result.file}\n  ${result.units} units: ${result.translated} translated, ${result.toTranslate} to translate, ${result.stale} stale (source changed)${result.removed ? `, ${result.removed} removed` : ''}${result.editor ? `; ${result.editor} editor word(s) to translate (authors read them, learners never: they hold nothing back)` : ''}.`);
    return 0;
  }, { json: flags.json })
});

const status = defineCommand({
  name: 'translate status',
  flags: { to: 'string', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(async () => {
    const { translationStatus } = await import('@elabora/node/translate');
    const languages = translationStatus(dir, { to: flags.to });
    const exit = languages.every(translationReady) ? 0 : 1;
    if (flags.json) { printJson(languages); return exit; }
    if (!languages.length) console.log('No translation yet: elabora translate export --to <lang>.');
    for (const language of languages) {
      if (!language.exists) { console.log(`${language.language}: no translations/${language.language}.xlf`); continue; }
      console.log(`${language.language}: ${language.translated}/${language.units} translated, ${language.toTranslate} to translate, ${language.stale} stale${language.removed ? `, ${language.removed} removed` : ''}${language.editor ? ` · ${language.editor} editor word(s) to translate (they hold nothing back)` : ''} · translated plan: ${language.plan}`);
      for (const id of language.details.stale.slice(0, 10)) console.log(`  stale  ${id}`);
      for (const problem of language.problems.slice(0, 10)) console.log(`  ✘ ${problem.id}: ${problem.message}`);
      for (const anchor of language.anchors.toPlace.slice(0, 10)) console.log(`  anchor ${anchor.unit}: place <mrk id="${anchor.id}">…</mrk> on the words that say « ${anchor.word} »`);
    }
    return exit;
  }, { json: flags.json })
});

const buildCommand = defineCommand({
  name: 'translate build',
  flags: { to: 'string', out: 'string', 'allow-missing': 'boolean', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(async () => {
    const { buildTranslation } = await import('@elabora/node/translate');
    if (!flags.to || !flags.out) { console.error('Usage: elabora translate build [dir] --to <lang> --out <dir> [--allow-missing]'); return 2; }
    const result = await buildTranslation(dir, { to: flags.to, out: flags.out, allowMissing: flags['allow-missing'] });
    if (flags.json) { printJson(result); return 0; }
    console.log(`✔ ${result.dir} (${result.language}, ${result.units} units${result.untranslated ? `, ${result.untranslated} left in the source language` : ''}${result.unplaced ? `, ${result.unplaced} word anchor(s) at the start of their line` : ''}; plan ${result.plan === 'approved' ? 'approved' : 'not approved: elabora translate approve'})\nNext: elabora validate ${flags.out} · elabora build ${flags.out}`);
    return 0;
  }, { json: flags.json })
});

const approve = defineCommand({
  name: 'translate approve',
  flags: { to: 'string', by: 'string', reference: 'string', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(async () => {
    const { approveTranslation } = await import('@elabora/node/translate');
    if (!flags.to) { console.error('Usage: elabora translate approve [dir] --to <lang> --by "<name, organisation>"'); return 2; }
    // The core refuses a missing approver, with the message agents expect.
    const approval = approveTranslation(dir, { to: flags.to, by: flags.by ?? '', reference: flags.reference });
    if (flags.json) { printJson(approval); return 0; }
    console.log(`✔ Translated plan (${approval.language}) approved by ${approval.by} on ${approval.date}, ${approval.contentHash.slice(0, 19)}…`);
    return 0;
  }, { json: flags.json })
});

export const translationCommands: CommandGroup = {
  title: 'Translation (one package per language; translations live in the source course, translations/<lang>.xlf)',
  help: HELP,
  commands: [exportCommand, status, buildCommand, approve],
  subcommandUsage: { translate: 'Usage: elabora translate export|status|build|approve …' }
};
