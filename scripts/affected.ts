// What a session's change asks to test: the files it changed, against main (committed or not), read
// against a map written by hand (test/groups.ts here, scripts/test-groups.ts in the app): each group
// names the files it watches and the heavy checks that cover them. A session runs the checks of the
// groups its files touch, the changed tests themselves and a small smoke set; the whole suite runs
// on main once per batch (the app's pnpm run test:batch).
//
// A file of shared code (the map's `wide` list), or one no group names, widens the selection to the
// map's `wide` checks and says that only the batch run covers the rest. Kept free of dependencies:
// the app imports this file from its sibling elabora-core, as it does heavy-slots.ts.
import { execFileSync } from 'node:child_process';

export interface Group {
  /** What the group is, in the log. */
  name: string;
  /** Files it watches: paths from the repository's root, * within a folder, ** across folders. */
  files: string[];
  /** Its checks (try: scripts without « try: », e2e or matrix files, as the runner names them). */
  checks: string[];
}

export interface TestMap {
  /** Run on every change that has a check to run. */
  smoke: string[];
  /** Shared code: a change there widens the selection to `wideChecks`. */
  wide: string[];
  wideChecks: string[];
  /** Files that ask for no heavy check (documents, notes, the unit tests, which always run). */
  none: string[];
  groups: Group[];
  /** The heavy check a changed test file is, or null when it is no heavy check. */
  testOf(file: string): string | null;
}

export interface Selection {
  changed: string[];
  checks: string[];
  /** Why each check runs. */
  why: Record<string, string[]>;
  /** Files no group names (they widened the selection). */
  unknown: string[];
  /** Whether shared code changed: only the batch run covers everything. */
  widened: boolean;
}

const pattern = (glob: string): RegExp => new RegExp(`^${glob.split('**').map((part) => part.split('*').map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
export const matches = (file: string, globs: string[]): boolean => globs.some((glob) => pattern(glob).test(file));

/** The files changed against base's merge base, committed or not (renamed: both names). */
export function changedFiles(repo: string, base = 'origin/main'): string[] {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const since = git('merge-base', base, 'HEAD').trim();
  const files = new Set<string>();
  for (const line of git('diff', '--name-only', since).split('\n')) if (line) files.add(line);
  for (const line of git('ls-files', '--others', '--exclude-standard').split('\n')) if (line) files.add(line);
  return [...files].sort();
}

export function select(changed: string[], map: TestMap): Selection {
  const why: Record<string, string[]> = {};
  const add = (check: string, reason: string) => { (why[check] ??= []).push(reason); };
  const unknown: string[] = [];
  let widened = false;
  for (const file of changed) {
    const test = map.testOf(file);
    if (test) { add(test, `${file} changed`); continue; }
    if (matches(file, map.none)) continue;
    if (matches(file, map.wide)) { widened = true; for (const check of map.wideChecks) add(check, `shared code: ${file}`); continue; }
    const groups = map.groups.filter((group) => matches(file, group.files));
    for (const group of groups) for (const check of group.checks) add(check, `${group.name}: ${file}`);
    if (!groups.length) { unknown.push(file); widened = true; for (const check of map.wideChecks) add(check, `no group names ${file}`); }
  }
  if (Object.keys(why).length) for (const check of map.smoke) add(check, 'smoke');
  return { changed, checks: Object.keys(why).sort(), why, unknown, widened };
}

/** What runs and why, what does not, as the session's log says it. */
export function describe(selection: Selection, all: string[]): string {
  const lines = [`${selection.changed.length} file(s) changed against main.`];
  if (!selection.checks.length) lines.push('No heavy check asked for: the typecheck and the unit tests only.');
  for (const check of selection.checks) lines.push(`  run  ${check}: ${[...new Set(selection.why[check])].slice(0, 3).join('; ')}${selection.why[check]!.length > 3 ? ` (+${selection.why[check]!.length - 3})` : ''}`);
  const left = all.filter((check) => !selection.checks.includes(check));
  if (left.length) lines.push(`  not run (${left.length}): ${left.join(', ')}`);
  if (selection.unknown.length) lines.push(`  no group names ${selection.unknown.join(', ')}: add it to the map.`);
  if (selection.widened) lines.push('Shared code changed: the batch run on main covers the rest.');
  return lines.join('\n');
}

/** Checks the map: every name it gives is a check, and every check is in a group. */
export function mapProblems(map: TestMap, all: string[]): string[] {
  const problems: string[] = [];
  const named = [...map.smoke, ...map.wideChecks, ...map.groups.flatMap((group) => group.checks)];
  for (const name of new Set(named)) if (!all.includes(name)) problems.push(`the map names ${name}, which is no check`);
  for (const check of all) if (!map.groups.some((group) => group.checks.includes(check))) problems.push(`no group runs ${check}`);
  return problems;
}
