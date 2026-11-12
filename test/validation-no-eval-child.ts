// Run by test/unit/validation-no-eval.test.ts with --disallow-code-generation-from-strings, the V8 switch
// that makes `eval` and `new Function` throw as they do in a Cloudflare Worker. It validates the sample
// courses and prints what validateProject found.
import { createProjectFiles } from '@elabora/core/project/files';
import { loadProject } from '@elabora/core/project/load';
import { validateProject } from '@elabora/core/validate/index';
import { exampleNames, snapshotOfExample } from './validation-corpus.ts';

try {
  new Function('return 1');
  console.log(JSON.stringify({ flagIgnored: true }));
  process.exit(0);
} catch { /* the switch bites */ }

const found: Record<string, unknown> = {};
for (const name of exampleNames()) {
  const result = validateProject(loadProject(createProjectFiles(snapshotOfExample(name)), { root: '' }));
  found[name] = { ok: result.ok, summary: result.summary, diagnostics: result.diagnostics };
}
console.log(JSON.stringify(found));
