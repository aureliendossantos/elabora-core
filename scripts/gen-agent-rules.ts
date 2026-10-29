// Appends a revision to packages/node/templates/agents-revisions.json when the course AGENTS.md
// template changed (docs/decisions.md D34): the history lets Elabora tell a course's AGENTS.md it wrote
// and nobody edited, which it updates, from one an author or agent edited, which it leaves. Run by
// pnpm run gen; a unit test checks that the last revision is the template.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'packages/node/templates/course/AGENTS.md');
const HISTORY = path.join(ROOT, 'packages/node/templates/agents-revisions.json');

if (import.meta.main) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(TEMPLATE, 'utf8')).digest('hex').slice(0, 16);
  const history = JSON.parse(fs.readFileSync(HISTORY, 'utf8')) as { revisions: { revision: number; sha: string; date: string }[] };
  const last = history.revisions.at(-1);
  if (last?.sha !== sha) {
    history.revisions = history.revisions.filter((entry) => entry.sha !== sha);
    history.revisions.push({ revision: (last?.revision ?? 0) + 1, sha, date: new Date().toISOString().slice(0, 10) });
    fs.writeFileSync(HISTORY, `${JSON.stringify(history, null, 2)}\n`);
  }
  console.log(path.relative(ROOT, HISTORY));
  // The examples, the module templates and the test courses in the current format carry the current rules and their CLAUDE.md (tests run
  // commands in copies of them: rules that Elabora would bring up to date there would be written by
  // every test).
  // Courses in an older format (the fixtures of older formats) keep theirs: a migration updates them.
  const { agentRulesState, agentsFile, CLAUDE_FILE, CLAUDE_TEXT } = await import('../packages/node/src/agent-rules.ts');
  const { FORMAT } = await import('../packages/format/src/schemas.ts');
  const fixtures = `test/fixtures/format-${FORMAT.split('/')[1]}`;
  const courses = [...['examples', 'templates'].flatMap((folder) => fs.readdirSync(path.join(ROOT, folder)).map((name) => path.join(folder, name))), ...fs.readdirSync(path.join(ROOT, fixtures)).map((name) => path.join(fixtures, name))];
  for (const course of courses.sort()) {
    const file = path.join(ROOT, course, 'AGENTS.md');
    if (!fs.existsSync(file)) continue;
    try { if (JSON.parse(fs.readFileSync(path.join(ROOT, course, 'course.json'), 'utf8')).format !== FORMAT) continue; } catch { continue; }
    const state = agentRulesState(fs.readFileSync(file, 'utf8'));
    if (state.status === 'outdated') { fs.writeFileSync(file, agentsFile(state.notes)); console.log(path.relative(ROOT, file)); }
    // And the CLAUDE.md beside it, which Elabora would write there too.
    const claude = path.join(ROOT, course, CLAUDE_FILE);
    if (!fs.existsSync(claude)) { fs.writeFileSync(claude, CLAUDE_TEXT); console.log(path.relative(ROOT, claude)); }
  }
}
