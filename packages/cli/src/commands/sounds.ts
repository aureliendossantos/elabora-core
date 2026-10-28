import fs from 'node:fs';
import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { courseSounds } from '@elabora/core/sounds/sounds';
import { searchLibrary, SOUND_CATEGORIES } from '@elabora/node/sounds/library';
import type { LibrarySound } from '@elabora/node/sounds/library';
import { searchOpenverse } from '@elabora/node/sounds/openverse';
import type { OpenverseSound } from '@elabora/node/sounds/openverse';
import { addSound } from '@elabora/node/sounds/add';
import { estimateSound, generateSound } from '@elabora/node/sounds/generate';
import { ArgumentError } from '../arguments.ts';
import { defineCommand, printDiagnostics, printFormatMigration, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  sound search [dir] <words…> [--source library|openverse] [--category <c>] [--kind effect|ambience] [--max-duration <s>] [--json]
                                                      Sounds to add: Elabora's library « Sons courants » (CC0, offline,
                                                      the default), or Freesound and Wikimedia Commons through Openverse
                                                      (no account; CC0, public domain and CC BY only)
  sound add [dir] <library id | openverse:<id> | file> [--id <id>] [--trim <start>:<end>] [--fade <s>] [--loop]
            [--caption "<text>"] [--license <id> --author <name> --title <t> --url <https://…>]
                                                      Copy a sound into assets/sounds/<id> with its sidecar (source,
                                                      author, licence); a file needs --license (own: the author's)
  sound list [dir] [--json]                           The course's sounds: licence, credit, where each is used
  sound generate [dir] "<description>" [--duration <s>] [--loop] [--influence 0-1] [--id <id>] [--caption "<text>"]
                 [--estimate] [--spend <percent>] [--json]
                                                      Make a sound effect with ElevenLabs (the author's key): from 1 %
                                                      of the monthly quota, ask the author, then --spend`;

const seconds = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const number = Number(value.replace(',', '.'));
  if (!Number.isFinite(number) || number < 0) throw new ArgumentError(`--${flag} takes seconds (not ${value})`);
  return number;
};
const isCourse = (dir: string | undefined) => dir !== undefined && fs.existsSync(path.join(dir, 'course.json'));
const courseLanguage = (dir: string): string => { try { return String(JSON.parse(fs.readFileSync(path.join(dir, 'course.json'), 'utf8')).language || 'fr'); } catch { return 'fr'; } };
const length = (value: number | null) => (value === null ? '?' : `${value.toFixed(1)} s`);

const search = defineCommand({
  name: 'sound search',
  flags: { source: 'string', category: 'string', kind: 'string', 'max-duration': 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const words = (isCourse(positionals[0]) ? positionals.slice(1) : positionals).join(' ').trim();
    const source = flags.source ?? 'library';
    if (source !== 'library' && source !== 'openverse') throw new ArgumentError('--source is library or openverse');
    if (flags.category && !(SOUND_CATEGORIES as readonly string[]).includes(flags.category)) throw new ArgumentError(`--category is one of ${SOUND_CATEGORIES.join(', ')}`);
    if (flags.kind && flags.kind !== 'effect' && flags.kind !== 'ambience') throw new ArgumentError('--kind is effect or ambience');
    const maxDuration = seconds(flags['max-duration'], 'max-duration');
    if (source === 'openverse') {
      if (!words) throw new ArgumentError('Say what to look for (elabora sound search "phone ring" --source openverse)');
      const found = await searchOpenverse(words, { maxDuration });
      if (flags.json) { printJson({ source, sounds: found }); return 0; }
      printOpenverse(found);
      return 0;
    }
    const found = searchLibrary(words, { category: flags.category, kind: flags.kind as 'effect' | 'ambience' | undefined, maxDuration });
    if (flags.json) { printJson({ source, sounds: found }); return 0; }
    printLibrary(found, words);
    return 0;
  })
});

function printLibrary(found: LibrarySound[], words: string) {
  if (!found.length) { console.log(`Nothing in the library for « ${words} »: try other words, --source openverse, or elabora sound generate.`); return; }
  console.log(`« Sons courants », Elabora's library (CC0 or public domain: no credit owed):\n`);
  for (const sound of found) console.log(`  ${sound.id.padEnd(26)}${length(sound.duration).padEnd(9)}${sound.kind === 'ambience' ? 'ambience (loops)' : sound.category}\n  ${''.padEnd(26)}${sound.title.fr} — ${sound.title.en}${sound.caption?.fr ? `\n  ${''.padEnd(26)}caption: « ${sound.caption.fr} »` : ''}`);
  console.log(`\n${found.length} sound${found.length === 1 ? '' : 's'}. elabora sound add [dir] <id> [--trim start:end] [--caption "…"]`);
}

function printOpenverse(found: OpenverseSound[]) {
  console.log('Freesound and Wikimedia Commons, searched through Openverse (CC0, public domain and CC BY only):\n');
  if (!found.length) { console.log('  Nothing found: try other words, or elabora sound generate.'); return; }
  for (const sound of found) console.log(`  ${sound.id}\n    ${sound.title} — ${sound.author || 'unknown author'}, ${sound.license}, ${length(sound.duration)}, ${sound.source}\n    ${sound.url}`);
  console.log(`\n${found.length} sound${found.length === 1 ? '' : 's'}. A CC BY sound is credited in « IA et crédits » by itself. elabora sound add [dir] openverse:<id> [--trim start:end]`);
}

const add = defineCommand({
  name: 'sound add',
  flags: { id: 'string', trim: 'string', fade: 'string', loop: 'boolean', caption: 'string', license: 'string', author: 'string', title: 'string', url: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const [first, second, ...extra] = positionals;
    const dir = second !== undefined ? first : '.';
    const from = second ?? first;
    if (!from || extra.length) throw new ArgumentError('Usage: elabora sound add [dir] <library id | openverse:<id> | file> [--id <id>] [--trim <start>:<end>] …');
    const trim = flags.trim ? /^(\d+(?:[.,]\d+)?):(\d+(?:[.,]\d+)?)$/.exec(flags.trim) : null;
    if (flags.trim && (!trim || Number(trim[2].replace(',', '.')) <= Number(trim[1].replace(',', '.')))) throw new ArgumentError('--trim takes start:end in seconds (0.4:3.2)');
    if (flags.url && !/^https:\/\//.test(flags.url)) throw new ArgumentError('--url is an https:// address');
    const result = await addSound(dir, {
      from, ...(flags.id ? { id: flags.id } : {}), ...(trim ? { trim: { start: Number(trim[1].replace(',', '.')), end: Number(trim[2].replace(',', '.')) } } : {}),
      ...(flags.fade ? { fade: seconds(flags.fade, 'fade') } : {}), ...(flags.loop ? { loop: true } : {}),
      ...(flags.caption ? { caption: { [courseLanguage(dir)]: flags.caption } } : {}),
      ...(flags.license ? { license: flags.license } : {}), ...(flags.author ? { author: flags.author } : {}), ...(flags.title ? { title: flags.title } : {}), ...(flags.url ? { url: flags.url } : {})
    });
    if (flags.json) { printJson(result); return 0; }
    printFormatMigration(result.formatMigration);
    console.log(result.reused ? `✔ The sound is already in the course as "${result.id}" (${result.path}): nothing copied.` : `✔ "${result.id}": ${result.path} (${result.duration.toFixed(1)} s, ${result.license}) and its sidecar.`);
    console.log(`  Play it: a sound line { "id": "…", "sound": "${result.id}", "caption": "…" } in a narration or a dialogue, an action { "type": "play-sound", "sound": "${result.id}" }, or a background track in course.json sounds.background.`);
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

const list = defineCommand({
  name: 'sound list',
  flags: { json: 'boolean' },
  run({ positionals: [dir = '.'], flags }) {
    const sounds = courseSounds(loadProjectFromDir(dir));
    if (flags.json) { printJson({ sounds }); return 0; }
    if (!sounds.length) { console.log('No sound in the course. elabora sound search "<words>" finds some.'); return 0; }
    for (const sound of sounds) {
      const problem = !sound.path ? '✘ not in assets/sounds/' : !sound.licence.ok ? `✘ licence ${sound.license ?? 'unknown'}: cannot ship` : '';
      console.log(`  ${sound.id.padEnd(26)}${length(sound.duration).padEnd(9)}${(sound.license ?? '—').padEnd(12)}${sound.generated ? 'generated ' : ''}${sound.loop ? 'loops ' : ''}${problem}`);
      if (sound.credit) console.log(`  ${''.padEnd(26)}credit: ${sound.credit}`);
      for (const use of sound.uses) console.log(`  ${''.padEnd(26)}${use.kind}: ${use.file}#${use.path}`);
      if (!sound.uses.length) console.log(`  ${''.padEnd(26)}not used`);
    }
    return 0;
  }
});

const generate = defineCommand({
  name: 'sound generate',
  flags: { duration: 'string', loop: 'boolean', influence: 'string', id: 'string', caption: 'string', estimate: 'boolean', spend: 'string', json: 'boolean' },
  run: ({ positionals, flags }) => reportingFailures(async () => {
    const dir = isCourse(positionals[0]) && positionals.length > 1 ? positionals[0] : '.';
    const prompt = (dir === positionals[0] ? positionals.slice(1) : positionals).join(' ').trim();
    if (!prompt) throw new ArgumentError('Describe the sound: elabora sound generate [dir] "a desk phone rings twice, close" --duration 3');
    const duration = seconds(flags.duration, 'duration');
    const influence = seconds(flags.influence, 'influence');
    if (influence !== undefined && influence > 1) throw new ArgumentError('--influence is from 0 to 1');
    if (flags.estimate) {
      const estimate = await estimateSound({ duration });
      if (flags.json) { printJson(estimate); return 0; }
      console.log(estimate.percent === null ? `About ${estimate.credits} credits (the quota could not be read).` : `~${estimate.percent} % of the author's monthly quota${estimate.needsApproval ? ': ask the author, then --spend ' + estimate.percent : ' (under 1 %: no approval needed)'}.`);
      return 0;
    }
    const spend = flags.spend === undefined ? undefined : Number(flags.spend.replace(',', '.').replace('%', ''));
    if (spend !== undefined && !Number.isFinite(spend)) throw new ArgumentError('--spend takes the percent the author approved (2, or 0.5)');
    const result = await generateSound(dir, { prompt, ...(duration !== undefined ? { duration } : {}), ...(flags.loop ? { loop: true } : {}), ...(influence !== undefined ? { influence } : {}), ...(flags.id ? { id: flags.id } : {}), ...(flags.caption ? { caption: { [courseLanguage(dir)]: flags.caption } } : {}), ...(spend !== undefined ? { approvedPercent: spend } : {}) });
    if (flags.json) { printJson(result); return 0; }
    console.log(`✔ "${result.id}": ${result.path} (${result.duration.toFixed(1)} s, made with ElevenLabs${result.cached ? ', from this computer\'s cache: free' : result.percent !== null ? `, ~${result.percent} % of the monthly quota` : ''}).`);
    printDiagnostics(result.diagnostics.filter((d) => d.file?.startsWith('assets/sounds/')));
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

export const soundCommands: CommandGroup = {
  title: 'Sounds',
  help: HELP,
  commands: [search, add, list, generate],
  subcommandUsage: { sound: 'Usage: elabora sound search|add|list|generate …' }
};
