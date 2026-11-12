// node scripts/validation-profile.ts [--screens 200] [--runs 10]
//
// Where the time of a project's validation goes, on an example of the core made bigger as a room's
// trial makes it (coffee-in-brief's screens duplicated by the core, delivered as cmi5): loading,
// creating the context, then each check, in Node. A measure, in no test suite.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { loadProject } from '@elabora/core/project/load';
import type { ProjectFiles } from '@elabora/core/project/files';
import { executeCommand } from '@elabora/core/commands/execute';
import { duplicateScreen } from '@elabora/core/commands/screens';
import { textFile } from '@elabora/core/ops/json';
import type { Files } from '@elabora/core/ops/types';
import { COURSE_CHECKS, FILE_CHECKS, createValidationContext, validateProject } from '@elabora/core/validate/index';
import { hasCourse, startRun } from '@elabora/core/validate/context';
import { readProjectFiles } from '@elabora/node/project-reader';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { screens: { type: 'string', default: '200' }, runs: { type: 'string', default: '10' } } });
const SCREENS = Number(values.screens);
const RUNS = Number(values.runs);

export function largeExample(screens: number): Files {
  let files: Files = readProjectFiles(path.join(ROOT, 'examples/coffee-in-brief')).files as Files;
  const ids = () => [...files.keys()].filter((p) => p.startsWith('screens/') && p.endsWith('.json')).map((p) => p.slice(8, -5));
  if (screens > ids().length) {
    const course = JSON.parse((files.get('course.json') as { text: string }).text);
    course.delivery = { ...(course.delivery ?? {}), format: 'cmi5' };
    files = new Map(files).set('course.json', textFile('course.json', `${JSON.stringify(course, null, 2)}\n`));
  }
  for (let k = 0; ids().length < screens; k++) {
    const originals = ids().filter((id) => !id.includes('-d'));
    const id = originals[k % originals.length]!;
    files = executeCommand(files as ProjectFiles, 'duplicate_screen', (context) => duplicateScreen(context, { id, newId: `${id}-d${k + 1}`, title: null } as never)).after;
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = largeExample(SCREENS) as ProjectFiles;
  const times = new Map<string, number[]>();
  const add = (name: string, ms: number) => times.set(name, [...(times.get(name) ?? []), ms]);
  for (let run = 0; run < RUNS + 2; run++) {
    const warm = run < 2;
    let t = performance.now();
    const project = loadProject(files);
    if (!warm) add('loadProject', performance.now() - t);
    t = performance.now();
    validateProject(project);
    if (!warm) add('validateProject (all)', performance.now() - t);
    t = performance.now();
    const context = createValidationContext(project);
    if (!warm) add('createValidationContext', performance.now() - t);
    const ctx = startRun(context);
    const each = (checks: typeof FILE_CHECKS | typeof COURSE_CHECKS, c: typeof ctx) => {
      for (const check of checks) {
        const start = performance.now();
        if (check.scope === 'project') check.run(c as never);
        else if (check.screens === 'all') for (const [id, entry] of c.project.screens) check.run(c as never, (c.screens.get(id) ?? { ...entry, id }) as never);
        else for (const screen of c.screens.values()) check.run(c as never, screen as never);
        if (!warm) add(`${check.scope} ${check.name}`, performance.now() - start);
      }
    };
    each(FILE_CHECKS, ctx);
    if (hasCourse(ctx)) each(COURSE_CHECKS, ctx);
  }
  const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
  const rows = [...times].map(([name, list]) => [name, median(list)] as const).sort((a, b) => b[1] - a[1]);
  console.log(`${SCREENS} screens, ${files.size} files, median of ${RUNS} runs (ms):`);
  for (const [name, ms] of rows) if (ms >= 0.05) console.log(`  ${ms.toFixed(2).padStart(8)}  ${name}`);
}
