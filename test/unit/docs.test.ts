import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers.ts';
import { CODES } from '@elabora/core/diagnostics/codes';
import type { CodeInfo } from '@elabora/core/diagnostics/codes';
import { RULES } from '@elabora/core/diagnostics/rules';
import { decisionPages, docsIndex, findPage, headings, readDocs } from '@elabora/cli/docs';
import { listSkills, readSkill } from '@elabora/cli/skills';

// The documentation is read on GitHub, on the site and by agents (elabora docs): one copy, whose map,
// links and anchors must hold, and which the code may cite by path (docs/….md) or by decision (D24).
// CONTRIBUTING.md, Documentation.

const walk = (dir: string, keep: (name: string) => boolean): string[] => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const relative = path.posix.join(dir, entry.name);
  if (entry.isDirectory()) return ['node_modules', 'vendor', 'files', '.git'].includes(entry.name) ? [] : walk(relative, keep);
  return keep(entry.name) ? [relative] : [];
});

const MARKDOWN = [
  ...walk('docs', (name) => name.endsWith('.md')),
  'README.md', 'SPEC.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CHANGELOG.md', 'ai-costs/README.md', 'packages/fonts/README.md',
  'packages/node/templates/course/AGENTS.md',
  ...walk('packages/cli/skills', (name) => name.endsWith('.md'))
];

// Front matter, fenced blocks and code spans are not prose: no links there, and HTML there is text.
function prose(markdown: string): string {
  let fence: string | null = null;
  const lines = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n').filter((line) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (fence === null) fence = marker[0]!; else if (marker[0] === fence) fence = null; return false; }
    return fence === null;
  });
  return lines.join('\n').replace(/(`+)[^\n]*?\1/g, '');
}

test('every docs page is on the map, and the map names only pages that exist', () => {
  const mapped = new Set(docsIndex().map((page) => page.file));
  const pages = [...walk('docs', (name) => name.endsWith('.md')).filter((file) => !file.startsWith('docs/decisions/') && file !== 'docs/index.md'), 'SPEC.md', 'CONTRIBUTING.md', 'CHANGELOG.md'];
  assert.deepEqual(pages.filter((file) => !mapped.has(file)), [], 'pages missing from docs/index.md');
  assert.deepEqual([...mapped].filter((file) => !fs.existsSync(path.join(ROOT, file))), [], 'docs/index.md names pages that do not exist');
  for (const page of docsIndex()) assert.ok(page.description, `${page.file}: no description on the map`);
  const index = fs.readFileSync(path.join(ROOT, 'docs/decisions.md'), 'utf8');
  for (const decision of decisionPages()) assert.ok(index.includes(`](${decision.file.slice('docs/'.length)})`), `${decision.file} is not in docs/decisions.md: npm run docs`);
});

test('docs links resolve', () => {
  const broken: string[] = [];
  const anchors = new Map<string, Set<string>>();
  const anchorsOf = (file: string) => {
    if (!anchors.has(file)) anchors.set(file, new Set(headings(fs.readFileSync(path.join(ROOT, file), 'utf8')).map((h) => h.slug)));
    return anchors.get(file)!;
  };
  for (const file of MARKDOWN) {
    for (const [, target] of prose(fs.readFileSync(path.join(ROOT, file), 'utf8')).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      const [where, anchor] = target.split('#');
      const resolved = where ? path.posix.normalize(path.posix.join(path.posix.dirname(file), decodeURI(where))) : file;
      if (!fs.existsSync(path.join(ROOT, resolved))) { broken.push(`${file}: ${target} (no ${resolved})`); continue; }
      if (anchor && resolved.endsWith('.md') && !anchorsOf(resolved).has(anchor)) broken.push(`${file}: ${target} (no heading #${anchor} in ${resolved})`);
    }
  }
  assert.deepEqual(broken, []);
});

test('the docs paths and the decisions the code names exist', () => {
  const sources = [...walk('packages', (name) => /\.(ts|md|json|css|html)$/.test(name) && !name.endsWith('.generated.ts')), ...walk('scripts', (name) => name.endsWith('.ts')), ...walk('test', (name) => name.endsWith('.ts')), ...MARKDOWN];
  const missing: string[] = [];
  for (const file of sources) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [docs] of text.matchAll(/\bdocs\/[a-z0-9/-]+\.md\b/g)) if (!fs.existsSync(path.join(ROOT, docs))) missing.push(`${file}: ${docs}`);
    for (const [, number] of text.matchAll(/\bD([1-9]\d?)\b/g)) if (!findPage(`D${number}`)) missing.push(`${file}: D${number}`);
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('docs hold no raw HTML: a placeholder such as <id> is in code or escaped, or GitHub and the site lose it', () => {
  const found: string[] = [];
  for (const file of MARKDOWN) {
    for (const [tag] of prose(fs.readFileSync(path.join(ROOT, file), 'utf8')).matchAll(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi)) {
      if (!/^<\/?(br|kbd|sub|sup|details|summary)\b/i.test(tag)) found.push(`${file}: ${tag}`);
    }
  }
  assert.deepEqual(found, []);
});

test('every rule a diagnostic cites is defined', () => {
  const cited = new Set(Object.values<CodeInfo>(CODES).map((code) => code.rule).filter(Boolean));
  assert.deepEqual([...cited].filter((rule) => !(rule! in RULES)), []);
});

test('elabora docs: the map, a page, a long page\'s outline, a section, a decision', () => {
  const map = readDocs({});
  assert.ok(map.ok && map.text.includes('- getting-started: Getting started — '), map.ok ? map.text : map.error);
  const spec = readDocs({ page: 'SPEC.md' });
  assert.ok(spec.ok && spec.text.includes('(spec is') && spec.text.includes('#3-contract-layer-planjson-and-its-versions'), 'a long page comes as its outline');
  const section = readDocs({ page: 'spec', section: '#3-contract-layer-planjson-and-its-versions' });
  assert.ok(section.ok && section.text.startsWith('## 3. Contract layer') && !section.text.includes('\n## 4.'));
  assert.equal(findPage('D24')?.file, 'docs/decisions/D24.md');
  assert.equal(findPage('docs/architecture/media.md')?.id, 'architecture/media');
  assert.equal(readDocs({ page: 'nothing-here' }).ok, false);
  const noSections = readDocs({ page: 'D24', section: 'anything' });
  assert.ok(!noSections.ok && noSections.error.includes('has no sections'), 'a decision has no headings: say to ask for it whole');
});

test('elabora docs serves the bundled skills for hosts without MCP resources (D53)', () => {
  const map = readDocs({});
  assert.ok(map.ok && map.text.includes('## Skills\n- skills: '), 'the map says where the skills are');
  const list = readDocs({ page: 'skills' });
  assert.ok(list.ok && list.text.includes('- skills/elabora-narration: ') && list.text.includes('skills/elabora-narration/voice-and-timing'), list.ok ? list.text : list.error);
  for (const skill of listSkills()) {
    assert.ok(skill.description, `${skill.name}: no description in its front matter`);
    assert.deepEqual(readDocs({ page: `skills/${skill.name}` }), { ok: true, text: readSkill(skill.name)! });
    for (const reference of skill.references) assert.deepEqual(readDocs({ page: `skills/${skill.name}/${reference}` }), { ok: true, text: readSkill(skill.name, reference)! });
  }
  assert.deepEqual(readDocs({ page: 'skills/elabora-narration/references/voice-and-timing' }), readDocs({ page: 'skills/elabora-narration/voice-and-timing' }));
  const section = readDocs({ page: 'skills/elabora-course-authoring', section: 'Short workflow' });
  assert.ok(section.ok && section.text.startsWith('## Short workflow'), section.ok ? section.text : section.error);
  const unknown = readDocs({ page: 'skills/nothing' });
  assert.ok(!unknown.ok && unknown.error.includes('elabora-narration'), 'an unknown skill lists the known ones');
  const noReference = readDocs({ page: 'skills/elabora-narration/nothing' });
  assert.ok(!noReference.ok && noReference.error.includes('voice-and-timing'), 'an unknown reference lists the skill\'s');
  assert.ok(!readDocs({ page: 'skills/../AGENTS' }).ok, 'no way out of skills/');
});
