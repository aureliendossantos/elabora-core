import { validateSchema, type SchemaName } from '@elabora/format';
import type { Files } from '../ops/types.ts';
import { parseJSON } from '../util/json.ts';
import type { CommandDiagnostic } from './context.ts';

// The schema a project JSON file follows, or null for files without one.
export function schemaFor(path: string): SchemaName | null {
  if (path === 'course.json') return 'course';
  if (path === 'plan.json') return 'plan';
  if (path.startsWith('screens/')) return 'screen';
  if (path.endsWith('object.manifest.json')) return 'object-manifest';
  if (path.endsWith('object.tests.json')) return 'object-tests';
  if (/^plan-versions\/V[1-9]\d*\.json$/.test(path)) return 'plan-version';
  if (path === 'plan-versions/notes.json') return 'plan-notes';
  if (/^components\/[^/]+\/component\.json$/.test(path)) return 'component';
  return null;
}

// Schema problems of the given files once changed: an edit whose result does not match the
// schema is refused before anything is written.
export function schemaProblems(files: Files, paths: Iterable<string>): CommandDiagnostic[] {
  const problems: CommandDiagnostic[] = [];
  for (const path of paths) {
    const name = schemaFor(path);
    const file = files.get(path);
    if (!name || file?.kind !== 'text') continue;
    const parsed = parseJSON(file.text);
    if (parsed.error !== undefined) {
      problems.push({ code: 'E_JSON_PARSE', severity: 'error', file: path, message: parsed.error });
      continue;
    }
    for (const error of validateSchema(name, parsed.value)) {
      problems.push({ code: 'E_SCHEMA', severity: 'error', file: path, path: error.path, message: `${error.path || '/'}: ${error.message} (schema ${name})` });
    }
  }
  return problems;
}
