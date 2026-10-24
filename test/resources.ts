import type { TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyExample } from './helpers.ts';

// Register ownership as soon as a resource exists. Dependants close before their files, even
// after an assertion fails; one failed disposer must not prevent the others from running.
function createResources(context: TestContext) {
  const disposers: (() => unknown)[] = [];
  context.after(async () => {
    const failures: unknown[] = [];
    for (const dispose of disposers.reverse()) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Test resource cleanup failed');
  });
  function own<T>(value: T, dispose: (value: T) => unknown): T {
    disposers.push(() => dispose(value));
    return value;
  }
  const folder = (dir: string) => own(dir, value => fs.rmSync(value, { recursive: true, force: true }));
  return {
    own,
    copyExample: (source?: string) => folder(copyExample(source)),
    tempDir: (prefix = 'elabora-test-') => folder(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  };
}

const owned = new WeakMap<TestContext, ReturnType<typeof createResources>>();
export function resources(context: TestContext): ReturnType<typeof createResources> {
  if (!owned.has(context)) owned.set(context, createResources(context));
  return owned.get(context)!;
}
