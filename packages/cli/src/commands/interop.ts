import fs from 'node:fs';
import path from 'node:path';
import { loadProjectFromDir } from '@elabora/node/project-reader';
import * as edit from '@elabora/node/edit';
import { defineCommand, printDiagnostics } from './command.ts';
import type { CommandGroup } from './command.ts';

const HELP = `  lesson-md export [dir] [--out <dir>]                Export simple blocks to LESSON.md 1.9 (Slate), with a loss report
  lesson-md import [dir] <lesson.md> --covers ITEM-n [--id <screen-id>] [--section <id>] [--after <screen-id>]`;

const exportCommand = defineCommand({
  name: 'lesson-md export',
  flags: { out: 'string' },
  async run({ positionals: [dir = '.'], flags }) {
    const { exportLessonMd } = await import('@elabora/node/lesson-md');
    const outDir = path.resolve(flags.out || path.join(dir, 'dist', 'lesson-md'));
    const result = exportLessonMd(loadProjectFromDir(dir), outDir);
    console.log(`✔ ${result.files.length} files in ${outDir}\n${result.losses.length} loss(es), listed in elabora-export-losses.json:`);
    for (const loss of result.losses) console.log(`  - ${loss.screen ? `${loss.screen}${loss.block ? `/${loss.block}` : ''}: ` : ''}${loss.loss}`);
    return 0;
  }
});

// A screen id from the lesson's file name ("02-Les réseaux.md" → "les-r-seaux").
const screenIdFrom = (file: string) => path.basename(file, '.md').toLowerCase().replace(/^[0-9]+-/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'imported';

const importCommand = defineCommand({
  name: 'lesson-md import',
  flags: { covers: 'list', id: 'string', section: 'string', after: 'string' },
  async run({ positionals, flags }) {
    const { lessonToScreen } = await import('@elabora/core/interop/lesson-md');
    const dir = positionals.length >= 2 ? positionals[0] : '.';
    const file = positionals.length >= 2 ? positionals[1] : positionals[0];
    if (!file || !flags.covers) { console.error('Usage: elabora lesson-md import [dir] <lesson.md> --covers ITEM-n [--id <screen-id>]'); return 2; }
    const id = flags.id || screenIdFrom(file);
    const lesson = lessonToScreen(fs.readFileSync(file, 'utf8'), { id: /^[a-z]/.test(id) ? id : `s-${id}`, covers: flags.covers, title: undefined });
    for (const asset of lesson.assets.filter((asset: { external?: boolean }) => !asset.external)) {
      const from = path.resolve(path.dirname(file), asset.from);
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(path.join(dir, 'assets', asset.to)), { recursive: true }); fs.copyFileSync(from, path.join(dir, 'assets', asset.to)); }
    }
    const { screen } = lesson;
    const result = edit.createScreen(dir, { id: screen.id, title: screen.title, covers: screen.covers, section: flags.section, after: flags.after, completeWhen: screen.completeWhen, blocks: screen.blocks });
    console.log(`✔ Screen "${screen.id}" created with ${screen.blocks.length} block(s).`);
    for (const loss of lesson.losses) console.log(`  - ${loss}`);
    printDiagnostics(result.diagnostics.filter((d) => d.file === `screens/${screen.id}.json`));
    return 0;
  }
});

export const interopCommands: CommandGroup = {
  title: 'Interoperability',
  help: HELP,
  commands: [exportCommand, importCommand],
  subcommandUsage: { 'lesson-md': 'Usage: elabora lesson-md export|import …' }
};
