import fs from 'node:fs';
import path from 'node:path';
import { listGenerators } from '@elabora/core/project/generators';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import { commandContext, upgradeThemeCascade } from '@elabora/core/commands/index';
import * as edit from '@elabora/node/edit';
import type { UpdatePlayerArgs } from '@elabora/core/commands/index';
import { playerReport } from '../mcp/player-tools.ts';
import { ArgumentError } from '../arguments.ts';
import { defineCommand, printDiagnostics, printFormatMigration, printJson, reportingFailures } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  assets [dir] [--only <name>] [--sheet <file.png>]   Run generators/*.mjs: regenerate figures from code, theme tokens and plan.
                                                      --sheet: a contact sheet of what they wrote, on the course's surface colour
  theme upgrade [dir] [--dry-run] [--json]            Put the theme's rules under the components (theme.cascade
                                                      components-over-theme, D32), the course's look kept: what the theme
                                                      sets on properties components also set goes into @layer overrides.
                                                      One undoable change
  player [dir] [--enable <items>] [--disable <items>] [--move <item:bar[:index]>] [--set <item.option=value>]
         [--position <bar=window|page>] [--token <player.name=value>] [--logo <asset|none>] [--reset]
         [--link-terms [<ids>]] [--add-resource <file>…] [--title <t>] [--description <d>]
         [--target scorm12|web] [--json]
                                                      The learner's player (D58): its two bars of items (logo, title, progress,
                                                      spacer, outline, controls, resources, glossary, credits, display,
                                                      language, previous, next, exit), what shows and why not, its tokens and
                                                      findings. With changes: one undoable change. The spacer is one per bar,
                                                      always on: --move spacer:top:3 says where the start of the line ends.
                                                      --set controls.speeds=0.75-1.5, outline.label=section,
                                                      controls.transcript=false, logo.plate=true, progress.parts=false,
                                                      progress.percent=false, glossary.linkTerms=false;
                                                      --token player.top.background=#FFFFFF (=default removes it).
                                                      --link-terms links the glossary's terms (all, or the ids given) the
                                                      first time each is in each screen. --add-resource copies any file into
                                                      assets/resources/ and adds it to the resources, titled by --title,
                                                      else the PDF's own title, else its name (one undoable change each).
                                                      Resources, glossary, credits: elabora tools call elabora_player .
                                                      --from <arguments.json>`;

const assets = defineCommand({
  name: 'assets',
  flags: { only: 'string', sheet: 'string' },
  async run({ positionals: [dir = '.'], flags }) {
    const { runGenerators } = await import('@elabora/node/generators');
    const project = loadProjectFromDir(dir);
    if (!listGenerators(project).length) { console.log('No generators/*.mjs in this course.'); return 0; }
    const { results } = await runGenerators(dir, { course: project.course, plan: project.plan, only: flags.only });
    for (const generator of results) console.log(generator.error !== undefined ? `✘ ${generator.generator}: ${generator.error}` : `✔ ${generator.generator} → ${generator.outputs.length} asset(s): ${generator.outputs.join(', ')}`);
    if (flags.sheet) {
      const { assetsSheet } = await import('@elabora/node/assets-sheet');
      const groups = results.flatMap((generator) => (generator.error === undefined ? [{ generator: generator.generator, description: generator.description ?? undefined, outputs: generator.outputs }] : []));
      const surface = project.course?.theme?.tokens?.['color.surface'];
      const file = path.resolve(flags.sheet);
      fs.writeFileSync(file, await assetsSheet(dir, groups, { surface: typeof surface === 'string' ? surface : undefined }));
      console.log(`✔ Contact sheet: ${file}`);
    }
    return results.some((generator) => generator.error) ? 1 : 0;
  }
});

const themeUpgrade = defineCommand({
  name: 'theme upgrade',
  flags: { 'dry-run': 'boolean', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(() => {
    const result = flags['dry-run']
      ? { ...upgradeThemeCascade(commandContext(loadProjectFromDir(dir).files)).result, change: null, formatMigration: undefined, diagnostics: [] }
      : edit.upgradeThemeCascade(dir);
    if (flags.json) { printJson(result); return 0; }
    printFormatMigration(result.formatMigration);
    if (!result.upgraded) { console.log(`✔ The theme already comes before the components (theme.cascade ${result.to}): nothing to do.`); return 0; }
    const verb = flags['dry-run'] ? 'Would put' : 'Put';
    console.log(`✔ ${verb} the theme under the components (theme.cascade ${result.to}), the course's look kept.`);
    if (result.moved) {
      console.log(`  ${result.moved} declaration(s) of ${result.rules.length} rule(s) ${flags['dry-run'] ? 'would go' : 'went'} into @layer overrides, as components set the same properties (${result.families.join(', ')}).`);
      console.log('  Move out of that block the rules that are course-wide defaults (components then give them their own values), and check with elabora look and elabora fit, which name a component rule the theme still overrides (W_STYLE_COMPONENT_OVERRIDDEN).');
    } else console.log('  No rule of the theme sets a property the components set: nothing moved.');
    printDiagnostics(result.diagnostics.filter((d) => d.severity === 'error'));
    if (result.change) console.log(`  Undo: elabora undo --change ${result.change.seq}`);
    return 0;
  })
});

// --set item.option=value: true, false, null (back to the default) or text.
function optionChanges(values: readonly string[] = []): UpdatePlayerArgs['options'] {
  const options: Record<string, Record<string, unknown>> = {};
  for (const value of values) {
    const match = /^(logo|outline|progress|glossary|controls)\.([A-Za-z]+)=(.*)$/.exec(value);
    if (!match) throw new ArgumentError(`--set ${value}: write item.option=value (controls.speeds=0.75-2, outline.label=section, logo.alt=Hélios, logo.plate=true, progress.parts=false, glossary.linkTerms=false)`);
    const [, item, option, raw] = match;
    options[item] = { ...options[item], [option]: raw === 'true' ? true : raw === 'false' ? false : raw === 'null' || raw === 'default' ? null : raw };
  }
  return Object.keys(options).length ? options as UpdatePlayerArgs['options'] : undefined;
}

// --move item:bar[:index], the index a whole number from 0.
function parseMove(value: string): NonNullable<UpdatePlayerArgs['move']>[number] {
  const [item, bar, index, ...rest] = value.split(':');
  if (!item || !bar || rest.length || (index !== undefined && !/^\d+$/.test(index))) throw new ArgumentError(`--move ${value}: write item:bar or item:bar:index, the index a whole number from 0 (outline:top, next:bottom:0)`);
  return { item, bar, ...(index !== undefined ? { index: Number(index) } : {}) } as NonNullable<UpdatePlayerArgs['move']>[number];
}

const player = defineCommand({
  name: 'player',
  flags: { enable: 'list', disable: 'list', move: 'list', set: 'list', position: 'list', token: 'list', logo: 'string', reset: 'boolean', 'link-terms': 'optional', 'add-resource': 'list', title: 'string', description: 'string', target: 'string', json: 'boolean' },
  run: ({ positionals: [dir = '.'], flags }) => reportingFailures(() => {
    const target = flags.target === 'web' ? 'web' : 'scorm12';
    const options = optionChanges(flags.set) ?? {};
    if (flags.logo) options.logo = { ...options.logo, asset: flags.logo === 'none' ? null : flags.logo };
    const changes: UpdatePlayerArgs = {
      ...(flags.enable ? { enable: flags.enable as UpdatePlayerArgs['enable'] } : {}),
      ...(flags.disable || flags.logo === 'none' ? { disable: [...(flags.disable ?? []), ...(flags.logo === 'none' ? ['logo'] : [])] as UpdatePlayerArgs['disable'] } : {}),
      ...(flags.logo && flags.logo !== 'none' ? { enable: [...(flags.enable ?? []), 'logo'] as UpdatePlayerArgs['enable'] } : {}),
      ...(flags.move ? { move: flags.move.map(parseMove) } : {}),
      ...(Object.keys(options).length ? { options } : {}),
      ...(flags.position ? { position: Object.fromEntries(flags.position.map((value) => value.split('='))) } : {}),
      ...(flags.token ? { tokens: Object.fromEntries(flags.token.map((value) => { const [name, raw = ''] = value.split('='); return [name, raw === 'default' || raw === '' ? null : /^\d+$/.test(raw) ? Number(raw) : raw]; })) } : {}),
      ...(flags.reset ? { reset: true } : {}),
      ...(flags['link-terms'] ? { linkTerms: flags['link-terms'] === true ? true : flags['link-terms'].split(',').map((id) => id.trim()).filter(Boolean) } : {})
    };
    // Files added to the resources first, one change each.
    const files = flags['add-resource'] ?? [];
    if ((flags.title || flags.description) && files.length !== 1) throw new ArgumentError('--title and --description go with one --add-resource file.');
    const added = files.map((file) => edit.addResource(dir, { path: file, ...(flags.title ? { title: flags.title } : {}), ...(flags.description ? { description: flags.description } : {}) }));
    const edited = Object.keys(changes).length ? edit.updatePlayer(dir, changes) : null;
    const report = playerReport(dir, target);
    if (flags.json) { printJson(edited || added.length ? { added: added.map(({ change, resource, path, reused }) => ({ change, resource, path, reused })), ...(edited ? { change: edited.change, linked: edited.linked, unlinked: edited.unlinked, translations: edited.translations } : {}), player: report } : report); return 0; }
    for (const resource of added) console.log(`✔ Added the resource « ${resource.resource.title} » (${resource.path}${resource.reused ? ', already in the course' : ''}). Undo: elabora undo --change ${resource.change?.seq ?? '?'}`);
    if (edited) {
      printFormatMigration(edited.formatMigration);
      console.log(`✔ Changed the player: ${edited.changed.join(', ')}. Undo: elabora undo --change ${edited.change?.seq ?? '?'}`);
      for (const link of edited.unlinked) console.log(`  ${link.screen}: « ${link.text} » no longer links to glossary:${link.term} (removed)`);
      for (const link of edited.linked) console.log(`  ${link.screen}: « ${link.text} » → glossary:${link.term}`);
      for (const translation of edited.translations) {
        const unlinked = translation.unlinked?.length ? `${translation.unlinked.length} translated text${translation.unlinked.length === 1 ? '' : 's'} unlinked too` : '';
        const linked = translation.linked.length ? `${translation.linked.length} translated text${translation.linked.length === 1 ? '' : 's'} linked too` : '';
        const stale = translation.stale.length ? `${translation.stale.length} to translate again (${translation.stale.join(', ')})` : '';
        console.log(`  ${translation.language}: ${[unlinked, linked, stale].filter(Boolean).join('; ')}`);
      }
    }
    for (const name of ['top', 'bottom'] as const) {
      const bar = report[name];
      console.log(`${name === 'top' ? 'Top' : 'Bottom'} bar${bar.position === 'page' ? (name === 'top' ? ' (scrolls with the page)' : ' (at the end of the page)') : ''}${bar.shown ? '' : ': removed, nothing to show'}`);
      for (const item of bar.items) {
        const options = Object.entries(item.options).filter(([, value]) => value !== null && value !== '').map(([key, value]) => `${key} ${value}`).join(', ');
        console.log(`  ${item.shows ? '✔' : item.enabled ? '○' : '·'} ${item.id}${item.why ? ` — ${item.why}` : ''}${options ? `  (${options})` : ''}`);
      }
    }
    if (report.unused.length) console.log(`Not in a bar: ${report.unused.join(', ')}`);
    console.log(`Tokens: ${Object.entries(report.tokens).map(([key, token]) => `${key} ${token.value}${token.set ? '' : ' (default)'}`).join(' · ')}`);
    printDiagnostics(report.findings);
    return 0;
  })
});

export const designCommands: CommandGroup = { title: 'Design', help: HELP, commands: [assets, themeUpgrade, player], subcommandUsage: { theme: 'Usage: elabora theme upgrade [dir] [--dry-run] [--json]' } };
