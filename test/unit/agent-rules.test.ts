import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { agentRulesState, agentsFile, currentRules, updateAgentRules } from '@elabora/node/agent-rules';
import { initProject } from '@elabora/node/scaffold';
import * as edit from '@elabora/node/edit';
import { ROOT, copyExample } from '../helpers.ts';

// A course's rules for agents follow the Elabora that runs (docs/decisions.md D34).
const BIN = path.join(ROOT, 'bin/elabora.js');
const elabora = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const marked = (revision: number, rules: string, notes = '\n## Notes for this course\nAudience : étudiants de licence.\n') => `<!-- elabora:rules revision=${revision} sha256=${sha(rules)} · … -->\n${rules.slice(0, -1)}\n<!-- elabora:rules end -->\n${notes}`;

test('the rules history ends with the template, and the examples carry it (npm run gen)', () => {
  const history = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/node/templates/agents-revisions.json'), 'utf8')).revisions;
  const { text, revision } = currentRules();
  assert.equal(history.at(-1).sha, sha(text), 'the template changed: run npm run gen');
  assert.equal(history.at(-1).revision, revision);
  const courses = [...fs.readdirSync(path.join(ROOT, 'examples')).map((name) => path.join('examples', name)), path.join('test/fixtures/format-0.1/diagnostic-reseau')];
  for (const course of courses) {
    const file = path.join(ROOT, course, 'AGENTS.md');
    if (fs.existsSync(file)) assert.equal(agentRulesState(fs.readFileSync(file, 'utf8')).status, 'current', course);
  }
});

test('rules nobody edited are brought up to date with the notes kept; edited ones are left and said; a newer Elabora\'s are said', () => {
  const dir = copyExample();
  const old = marked(0, '# Old rules\n1. Never edit plan.json.\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), old);
  // The history's commands leave them: a bare elabora undo undoes the author's last change.
  assert.equal(elabora(['history', dir]).stderr, '');
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), old);
  assert.deepEqual(agentRulesState(old), { status: 'outdated', revision: 0, notes: '\n## Notes for this course\nAudience : étudiants de licence.\n' });
  // Any command run in the course updates them, as a system change, and says so on stderr.
  const run = elabora(['validate', dir]);
  assert.match(run.stderr, /^AGENTS\.md: the rules for agents brought up to date \(revision 0 → \d+; change \d+\)\.\n$/);
  const updated = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  assert.equal(updated, agentsFile('\n## Notes for this course\nAudience : étudiants de licence.\n'));
  assert.equal(agentRulesState(updated).status, 'current');
  assert.equal(elabora(['validate', dir]).stderr, '', 'current: nothing to say');
  // elabora undo gives the old rules back.
  assert.ok(edit.undo(dir).change);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), old);

  // Edited by someone: left as it is, said, replaced only with --force (the notes kept).
  const edited = old.replace('Never edit plan.json.', 'Never edit plan.json, except in draft.');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), edited);
  assert.equal(agentRulesState(edited).status, 'edited');
  assert.match(elabora(['validate', dir]).stderr, /rules for agents were edited, and are older than this elabora command's/);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), edited);
  assert.equal(updateAgentRules(dir).updated, false);
  assert.ok(updateAgentRules(dir, { force: true }).updated);
  assert.match(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), /elabora:rules end -->\n\n## Notes for this course\nAudience : étudiants de licence\.\n$/);

  // From a newer Elabora: this one says its commands may be missing, and writes nothing.
  const newer = marked(currentRules().revision + 1, '# Newer rules\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), newer);
  assert.match(elabora(['validate', dir]).stderr, /AGENTS\.md holds the rules of a newer Elabora \(revision \d+\) than this elabora/);
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), newer);
});

test('an AGENTS.md copied whole from a template before the markers is recognised; one Elabora did not write is left', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elabora-rules-'));
  try {
    const dir = path.join(root, 'c');
    initProject(dir, { id: 'essai', title: 'Essai' });
    assert.equal(agentRulesState(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).status, 'current', 'elabora init writes the current rules');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), currentRules().text);
    assert.equal(agentRulesState(currentRules().text).status, 'outdated');
    assert.ok(updateAgentRules(dir).updated);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Mes règles\n');
    assert.equal(agentRulesState('# Mes règles\n').status, 'custom');
    assert.equal(updateAgentRules(dir).updated, false);
    assert.match(elabora(['rules', dir]).stdout, /was not written by Elabora: elabora rules update --force replaces it/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The rules the 17 October split lost and the 19 October review restored, one short line each.
test('the course rules keep the plan, review, privacy and capture rules the split had dropped', () => {
  const template = currentRules().text;
  assert.match(template, /After a validation keep writing the plan, then tell the author what changed \(`elabora plan diff` \/ `elabora_plan_diff`\)/);
  assert.match(template, /A change of substance[^.]*is the author's call/);
  assert.match(template, /never a Playwright script of your own/);
  assert.match(template, /`elabora look`, `elabora preview` or `elabora screenshot`/);
  assert.match(template, /may hold personal data: quote only what the module needs/);
  assert.doesNotMatch(template, /after client validation/i, 'ambiguous: validation does not stop the agent writing the plan');
  assert.doesNotMatch(template, /repository-root/, 'an author\'s course folder has no repository root');
});

test('course entrypoint stays short and routes optional skills without altering author notes', () => {
  const template = currentRules().text;
  assert.ok(template.trim().split(/\s+/).length < 950, 'AGENTS.md should not be a cookbook');
  assert.match(template, /elabora tools skills/);
  assert.match(template, /elabora-narration/);
  assert.match(template, /elabora_docs \{ page: "skills\/<name>" \}/, 'a host without MCP resources reads skills through elabora_docs');
  const notes = "\n## Notes for this course\nKeep the author's words here.\n";
  assert.ok(agentsFile(notes).endsWith(notes));
});
