import fs from 'node:fs';
import path from 'node:path';
import * as looks from '@elabora/node/look-client';
import { defineCommand, errorMessage, printJson } from './command.ts';
import { startLookServer } from '../look-server.ts';
import { styleConflictDiagnostics } from '@elabora/node/style-cascade';
import { formatDiagnostic } from '@elabora/core/diagnostics/index';
import { motionText } from '@elabora/node/motion-report';

// elabora look: a client of the project's look server (@elabora/node look-client.ts), which it starts in
// the background when none answers (look-server.ts). Agents run it after every edit: it imports
// nothing heavy, and bin/elabora.ts runs it without loading the rest of the command line. The help is
// in build-and-test.ts.

export const look = defineCommand({
  name: 'look',
  flags: { screen: 'list', size: 'list', state: 'string', step: 'string', layer: 'string', at: 'string', sheet: 'boolean', scroll: 'list', block: 'string', scale: 'string', act: 'repeat', viewport: 'boolean', motion: 'boolean', language: 'string', out: 'string', 'out-dir': 'string', json: 'boolean', url: 'boolean', stop: 'boolean', serve: 'boolean', idle: 'string' },
  async run({ positionals: [dir = '.'], flags }) {
    const root = path.resolve(dir);
    if (!fs.existsSync(path.join(root, 'course.json'))) { console.error(`${root} is not an Elabora course (no course.json).`); return 2; }
    if (flags.serve) return serveLooks(root, Number(flags.idle) * 1000 || undefined);
    if (flags.stop) { console.log(await looks.stopLookServer(root) ? '✔ Look server stopped.' : 'No look server runs for this course.'); return 0; }
    const start = () => startLookServer(root);
    if (flags.url) { console.log((await looks.ensureLookServer(root, start)).url); return 0; }
    if (flags.state !== undefined && flags.state !== 'initial' && flags.state !== 'answered') { console.error(`--state is initial or answered (not "${flags.state}").`); return 2; }
    if (flags.scale !== undefined && flags.scale !== '1' && flags.scale !== '2') { console.error(`--scale is 1 or 2 (not "${flags.scale}").`); return 2; }
    if (flags.scale && !flags.block) { console.error('--scale draws a close-up again at twice its size: give --block.'); return 2; }
    for (const action of flags.act ?? []) {
      const parsed = looks.parseLookAction(action);
      if ('error' in parsed) { console.error(parsed.error); return 2; }
    }
    if (flags.act?.length && !flags.block) { console.error('--act drives the free object of a block: give --block <id>.'); return 2; }
    const sizes: [number, number][] = [];
    for (const size of flags.size || ['1600x900']) {
      const [width, height] = size.split('x').map(Number);
      if (!(width >= 320 && height >= 320)) { console.error(`--size is <width>x<height> in px, from 320 (not "${size}").`); return 2; }
      sizes.push([width, height]);
    }
    let screens: (string | undefined)[] = flags.screen || [undefined];
    if (screens[0] === 'all') {
      const [{ loadProjectFromDir }, { screenOrder }] = await Promise.all([import('@elabora/node/project-reader'), import('@elabora/core/project/load')]);
      screens = screenOrder(loadProjectFromDir(root)).map((entry) => entry.id);
    }
    const many = screens.length * sizes.length > 1;
    if (many && flags.out) { console.error('--out names one image: give --out-dir for several screens or sizes.'); return 2; }
    const outDir = path.resolve(flags['out-dir'] || looks.lookFolder(root));
    const step = flags.step ? Number(flags.step) : undefined;
    const results: unknown[] = [];
    let failed = false;
    for (const screen of screens) for (const [width, height] of sizes) {
      // The extension of --out, else JPEG (PNG for a close-up).
      const type = flags.out ? (/\.png$/i.test(flags.out) ? 'png' : 'jpeg') : undefined;
      const { result } = await looks.lookThroughServer(root, {
        screen, width, height, state: flags.state === 'answered' ? 'answered' : 'initial', step, layer: flags.layer, ...(flags.at ? { at: flags.at } : {}), ...(flags.sheet ? { sheet: true } : {}), language: flags.language, full: !flags.viewport, motion: flags.motion, type,
        ...(flags.scroll?.length ? { scroll: flags.scroll } : {}), ...(flags.block ? { block: flags.block } : {}), ...(flags.scale ? { scale: flags.scale === '2' ? 2 : 1 } : {}), ...(flags.act?.length ? { act: flags.act } : {})
      }, { start });
      if (!result.ok) {
        failed = true;
        if (flags.json) results.push({ ok: false, screen, width, height, error: result.error });
        else console.log(`✘ ${screen ?? '(screen)'} ${width}×${height}: ${result.error}`);
        continue;
      }
      const name = `${result.screen}-${width}x${height}${result.state !== 'initial' ? `-${result.state}` : ''}${step ? `-step${step}` : ''}${result.layer ? `-${result.layer}` : ''}${flags.at ? `-at-${flags.at.replace(':', '-')}` : ''}${flags.scroll?.length ? `-scroll-${flags.scroll.join('-').replace(/%/g, 'pct')}` : ''}${flags.block ? `-${flags.block}` : ''}${flags.scale === '2' ? '@2x' : ''}${flags.act?.length ? '-act' : ''}${flags.sheet ? '-sheet' : ''}.${result.type === 'png' ? 'png' : 'jpg'}`;
      const file = flags.out ? path.resolve(flags.out) : path.join(outDir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, result.image);
      const { image, ...facts } = result;
      if (flags.json) { results.push({ ...facts, file }); continue; }
      const room = result.presentation === 'slides' ? (result.page.overflow ? `the slide scrolls by ${result.page.overflow} px` : 'the slide fits') : `${result.page.windows <= 1 ? 'one window' : `${result.page.windows} windows`} long`;
      const objects = result.objects.length ? `; ${result.objects.length} free object(s)${result.objects.some((object) => object.failed) ? `, failed: ${result.objects.filter((object) => object.failed).map((object) => object.block).join(', ')}` : ''}${result.started ? `, ${result.started} (re)started` : ', kept running'}` : '';
      if (result.scrolled && result.scrolled.length > 1) console.log(`✔ ${file}  ${(result.ms / 1000).toFixed(2)} s — down the page:\n    ${result.scrolled.map((stop) => stop.label).join('\n    ')}`);
      else if (result.marks) console.log(`✔ ${file}  ${(result.ms / 1000).toFixed(2)} s — ${result.marks.length} marks:\n    ${result.marks.map((mark) => mark.label).join('\n    ')}`);
      else console.log(`✔ ${file}  ${(result.ms / 1000).toFixed(2)} s — ${room}${objects}${result.consoleErrors.length ? `\n  console errors:\n    ${result.consoleErrors.join('\n    ')}` : ''}`);
      if (result.clip) console.log(`  close-up of ${flags.block}: ${result.clip.width}×${result.clip.height} px of the page at ${result.clip.x},${result.clip.y}, ×${result.clip.scale}`);
      if (result.act) console.log(`  after ${result.act.actions.join(', ')}: state ${JSON.stringify(result.act.state)}${result.act.events.length ? `; events ${result.act.events.map((event) => `${event.name} ${JSON.stringify(event.payload)}`).join(', ')}` : '; no event'}`);
      if (result.motion) for (const line of motionText(result.motion)) console.log(`  ${line}`);
      for (const finding of styleConflictDiagnostics([{ screen: result.screen, conflicts: result.styles ?? [] }])) console.log(`  ${formatDiagnostic(finding)}`);
    }
    if (flags.json) printJson(results);
    return failed ? 1 : 0;
  }
});

// The look server itself (look --serve, started in the background by the first look): until it is
// stopped or idle.
async function serveLooks(root: string, idleMs: number | undefined): Promise<number> {
  const { serveLooks: serve } = await import('@elabora/node/look');
  let server;
  try {
    server = await serve(root, { idleMs });
  } catch (error) {
    console.error(errorMessage(error));
    return 0;
  }
  console.log(`${new Date().toISOString()} look server for ${root} at ${server.info.base} (process ${process.pid})`);
  const stop = () => void server.stop();
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await server.closed;
  console.log(`${new Date().toISOString()} stopped`);
  // Nothing should be left running; a socket kept alive would keep the process.
  setTimeout(() => process.exit(0), 2000).unref();
  return 0;
}
