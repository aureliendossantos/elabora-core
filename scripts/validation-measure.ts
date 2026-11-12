// node scripts/validation-measure.ts [--runs 15]
//
// A room's validation of a change (D86), before and after: the whole project validated after the
// change (validateProject, as a room did) against the validation kept change by change
// (revalidate from the head's). At 7 and 200 screens (coffee-in-brief, made bigger as a room's trial
// makes it), for a block's text (screens only), a field of course.json (everything runs again), and
// the first change after a room wakes (its head validated whole, then the change). The two are
// measured in turn in one process, so that the machine's load weighs on both. In no test suite.
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { loadProject } from '@elabora/core/project/load';
import type { ProjectFiles } from '@elabora/core/project/files';
import { executeCommand } from '@elabora/core/commands/execute';
import { updateBlock, updateCourseSettings } from '@elabora/core/commands/index';
import { acceptChange } from '@elabora/core/sync/server';
import { validateProject } from '@elabora/core/validate/index';
import { newErrors, revalidate, validationState, errorCounts } from '@elabora/core/validate/incremental';
import { largeExample } from './validation-profile.ts';

const { values } = parseArgs({ options: { runs: { type: 'string', default: '15' } } });
const RUNS = Number(values.runs);
const median = (list: number[]) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]!;
const time = (run: () => unknown) => { const start = performance.now(); run(); return performance.now() - start; };

const results: Record<string, string>[] = [];
for (const screens of [7, 200]) {
  const head = largeExample(screens) as ProjectFiles;
  const project = loadProject(head);
  const [screenId, entry] = [...project.screens].find(([, e]) => e.data.blocks.some((b) => b.type === 'text'))!;
  const block = entry.data.blocks.find((b) => b.type === 'text')!.id;
  const changes = {
    'a block\'s text': executeCommand(head, 'update_block', (c) => updateBlock(c, { block, props: { markdown: 'One field changed.' } })).after as ProjectFiles,
    'course.json\'s title': executeCommand(head, 'update_course', (c) => updateCourseSettings(c, { title: 'One field changed' })).after as ProjectFiles
  };
  const kept = validationState(head);
  const wholeErrors = (files: ProjectFiles) => errorCounts(validateProject(loadProject(files)));
  for (const [label, after] of Object.entries(changes)) {
    const before: number[] = [];
    const now: number[] = [];
    const woken: number[] = [];
    for (let run = 0; run < RUNS + 2; run++) {
      const b = time(() => wholeErrors(after));
      const a = time(() => newErrors(kept, revalidate(kept, after)));
      const w = time(() => { const state = validationState(head); newErrors(state, revalidate(state, after)); });
      if (run >= 2) { before.push(b); now.push(a); woken.push(w); }
    }
    const step = revalidate(kept, after).ran;
    results.push({ screens: String(screens), change: label, 'whole (ms)': median(before).toFixed(1), 'kept (ms)': median(now).toFixed(1), 'after a wake (ms)': median(woken).toFixed(1), 'checked again': step.full ? 'everything' : `${step.screens} screen(s), project checks: ${step.projectChecks}` });
  }
  // The room's placing of a change end to end: acceptChange with the validation kept.
  const after = changes['a block\'s text'];
  const submission = { id: 'm1', base: 0, at: '2026-11-12T08:00:00.000Z', author: { kind: 'human' as const, name: 'Ada' }, ops: executeCommand(head, 'update_block', (c) => updateBlock(c, { block, props: { markdown: 'One field changed.' } })).ops, inverse: [] as never[] };
  submission.inverse = executeCommand(head, 'update_block', (c) => updateBlock(c, { block, props: { markdown: 'One field changed.' } })).inverse as never[];
  const placed: number[] = [];
  for (let run = 0; run < RUNS + 2; run++) {
    const t = time(() => acceptChange({ head: 0, files: head, log: [] }, submission, { validate: (files) => { const next = revalidate(kept, files as ProjectFiles); return newErrors(kept, next).length ? 'new errors' : null; } }));
    if (run >= 2) placed.push(t);
  }
  results.push({ screens: String(screens), change: `${screenId}: acceptChange + validation kept`, 'whole (ms)': '', 'kept (ms)': median(placed).toFixed(1), 'after a wake (ms)': '', 'checked again': '' });
  void after;
}
console.table(results);
