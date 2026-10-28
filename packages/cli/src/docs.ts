// The documentation of the core, for agents and people who have no checkout at hand: the Markdown of
// docs/ (and SPEC.md, CONTRIBUTING.md, CHANGELOG.md beside it), mapped by docs/index.md. `elabora
// docs` and the MCP tool elabora_docs read it; the site renders the same files; test/unit/docs.test.ts
// checks the map, the links and what the code cites. The app ships these files in the core's layout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSkills, readSkill } from './skills.ts';

// The repository's root: docs/ and SPEC.md sit there, two folders above packages/cli/.
export const DOCS_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface DocPage {
  readonly id: string; // getting-started, spec, architecture/media, decisions/d29
  readonly title: string;
  readonly description: string;
  readonly section: string; // the heading of docs/index.md it is listed under; Decisions for each decision
  readonly file: string; // from the root: docs/getting-started.md, SPEC.md, docs/decisions/D29.md
}

// A page's id from its file: its path under docs/ without .md, a file beside docs/ by its name, in
// lower case (the site's addresses use the same ids).
export function pageId(file: string): string {
  const relative = file.startsWith('docs/') ? file.slice('docs/'.length) : file;
  return relative.replace(/\.md$/, '').toLowerCase().replace(/^decisions\/d0*(\d+)$/, 'decisions/d$1');
}

// The map: each `- [Title](file): description` of docs/index.md, under its `## Section`.
export function docsIndex(root = DOCS_ROOT): DocPage[] {
  const pages: DocPage[] = [];
  let section = '';
  for (const line of fs.readFileSync(path.join(root, 'docs/index.md'), 'utf8').split('\n')) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) { section = heading[1].trim(); continue; }
    const entry = /^- \[([^\]]+)\]\(([^)#]+\.md)\)(?::\s*(.*))?$/.exec(line);
    if (!entry) continue;
    const file = path.posix.normalize(path.posix.join('docs', entry[2]));
    pages.push({ id: pageId(file), title: entry[1], description: entry[3]?.trim() ?? '', section, file });
  }
  return pages;
}

// The decisions, from their first line: « # D29. Title (date) ».
export function decisionPages(root = DOCS_ROOT): DocPage[] {
  const dir = path.join(root, 'docs/decisions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => /^D\d+\.md$/.test(name)).sort().map((name) => {
    const head = /^# (D\d+)\. (.*)$/m.exec(fs.readFileSync(path.join(dir, name), 'utf8'));
    const file = `docs/decisions/${name}`;
    return { id: pageId(file), title: head ? `${head[1]}. ${head[2]}` : name, description: '', section: 'Decisions', file };
  });
}

export const allPages = (root = DOCS_ROOT): DocPage[] => [...docsIndex(root), ...decisionPages(root)];

// A page by its id, its file, its name (spec, SPEC.md, media) or a decision's number (D29, d029).
export function findPage(query: string, root = DOCS_ROOT): DocPage | null {
  const pages = allPages(root);
  const wanted = query.trim().replace(/^\.?\/+/, '').replace(/\.md$/i, '').toLowerCase();
  const decision = /^(?:decisions\/)?d0*(\d+)$/.exec(wanted);
  if (decision) return pages.find((page) => page.id === `decisions/d${decision[1]}`) ?? null;
  return pages.find((page) => page.id === wanted || pageId(page.file) === pageId(`${wanted}.md`) || page.file.toLowerCase().replace(/\.md$/, '') === wanted)
    ?? pages.find((page) => page.id.split('/').pop() === wanted)
    ?? null;
}

// Headings and their anchors, as GitHub and the site make them: lower case, punctuation dropped,
// spaces as hyphens, a number after a repeated one. Fenced code is not read.
export function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
}

export interface Heading { readonly depth: number; readonly text: string; readonly slug: string; readonly line: number }

export function headings(markdown: string): Heading[] {
  const found: Heading[] = [];
  const seen = new Map<string, number>();
  let fence: string | null = null;
  markdown.split('\n').forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) { if (fence === null) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null; return; }
    if (fence !== null) return;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) return;
    const text = heading[2];
    const base = slugify(text.replace(/`/g, ''));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.push({ depth: heading[1].length, text, slug: count ? `${base}-${count}` : base, line: index });
  });
  return found;
}

// One section: its heading and everything under it, down to the next heading of its level or above.
// Found by its anchor or its words (« Steps », « steps », « #steps »).
export function docSection(markdown: string, query: string): string | null {
  const all = headings(markdown);
  const wanted = query.trim().replace(/^#/, '');
  const slug = slugify(wanted.replace(/`/g, ''));
  const start = all.find((h) => h.slug === wanted || h.slug === slug) ?? all.find((h) => slugify(h.text.replace(/`/g, '')).includes(slug));
  if (!start) return null;
  const end = all.find((h) => h.line > start.line && h.depth <= start.depth);
  const lines = markdown.split('\n');
  return lines.slice(start.line, end ? end.line : lines.length).join('\n').trim();
}

// What a long page holds: its sections as an indented list with their anchors.
export function docOutline(markdown: string): string {
  return headings(markdown).filter((h) => h.depth > 1 && h.depth <= 3).map((h) => `${'  '.repeat(h.depth - 2)}- ${h.text} (#${h.slug})`).join('\n');
}

// Pages longer than this are given as their opening and their outline unless a section is asked:
// about 6,000 tokens.
export const WHOLE_PAGE_LIMIT = 24_000;

export interface DocsRequest { page?: string; section?: string; full?: boolean; search?: string }

// A long page is given as its opening and its outline (a section asked for, or all of it with full).
function servePage(id: string, markdown: string, { section, full }: Pick<DocsRequest, 'section' | 'full'>): { ok: true; text: string } | { ok: false; error: string } {
  if (section) {
    const text = docSection(markdown, section);
    if (text) return { ok: true, text };
    const outline = docOutline(markdown);
    return { ok: false, error: outline ? `No section « ${section} » in ${id}. Its sections:\n${outline}` : `${id} has no sections (${Math.round(markdown.length / 1000)} kB): ask for it without section.` };
  }
  if (full || markdown.length <= WHOLE_PAGE_LIMIT) return { ok: true, text: markdown };
  const firstSection = headings(markdown).find((h) => h.depth > 1);
  const opening = markdown.split('\n').slice(0, firstSection ? firstSection.line : undefined).join('\n').trim();
  return { ok: true, text: `${opening}\n\n(${id} is ${Math.round(markdown.length / 1000)} kB: here are its sections. Ask for one with section, or for the whole page with full.)\n\n${docOutline(markdown)}` };
}

// The bundled skills ride on the same operation: a host that gives the model tools but not MCP
// resources reads them as skills (the list), skills/<name> or skills/<name>/<reference> (D53).
const SKILL_PAGE = /^skills(?:\/([a-z0-9-]+)(?:\/(?:references\/)?([a-z0-9-]+))?)?$/;

function readSkillPage(page: string, request: DocsRequest): { ok: true; text: string } | { ok: false; error: string } | null {
  const match = SKILL_PAGE.exec(page.trim().replace(/^\.?\/+/, '').replace(/\.md$/i, '').toLowerCase());
  if (!match) return null;
  const [, name, reference] = match;
  const skills = listSkills();
  if (!name) return { ok: true, text: skills.map((skill) => `- skills/${skill.name}: ${skill.description}${skill.references.length ? ` References: ${skill.references.map((entry) => `skills/${skill.name}/${entry}`).join(', ')}.` : ''}`).join('\n') };
  const content = readSkill(name, reference);
  if (content === null) {
    const known = skills.find((skill) => skill.name === name);
    return { ok: false, error: !known ? `No skill « ${name} ». Skills: ${skills.map((skill) => skill.name).join(', ')}.` : `No reference « ${reference} » in skills/${name}.${known.references.length ? ` References: ${known.references.join(', ')}.` : ' It has none.'}` };
  }
  return servePage(`skills/${name}${reference ? `/${reference}` : ''}`, content, request);
}

// Searching the pages, the decisions and the skills: the sections that hold every word asked for
// (the most matches first), each with its page, its anchor and the line where the words are, to
// read with page and section.
const STOP_WORDS = new Set(['the', 'an', 'of', 'to', 'from', 'one', 'in', 'on', 'at', 'and', 'or', 'is', 'are', 'it', 'its', 'what', 'how', 'when', 'which', 'with', 'for', 'by', 'do', 'does', 'can', 'next', 'other', 'another', 'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'ou', 'en', 'au', 'aux', 'est']);
export interface DocHit { page: string; section: string; heading: string; line: string; score: number }
export function searchDocs(query: string, root = DOCS_ROOT, limit = 8): DocHit[] {
  // A plural finds its singular (persists, persist).
  const words = query.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter((word) => word.length > 1 && !STOP_WORDS.has(word)).map((word) => (word.length > 4 ? word.replace(/(?<!s)s$/, '') : word));
  if (!words.length) return [];
  const sources: { page: string; markdown: string }[] = allPages(root).map((entry) => ({ page: entry.id, markdown: fs.readFileSync(path.join(root, entry.file), 'utf8') }));
  for (const skill of listSkills()) for (const reference of [undefined, ...skill.references]) {
    const markdown = readSkill(skill.name, reference);
    if (markdown) sources.push({ page: `skills/${skill.name}${reference ? `/${reference}` : ''}`, markdown });
  }
  const hits: DocHit[] = [];
  for (const { page, markdown } of sources) {
    const lines = markdown.split('\n');
    const all = headings(markdown);
    const starts = [{ depth: 1, text: '(top)', slug: '', line: 0 }, ...all.filter((h) => h.line > 0)];
    for (const [index, start] of starts.entries()) {
      const end = starts.slice(index + 1).find((next) => next.depth <= Math.max(start.depth, 2))?.line ?? lines.length;
      const body = lines.slice(start.line, Math.min(end, starts[index + 1]?.line ?? lines.length));
      const text = body.join('\n').toLowerCase();
      if (!words.every((word) => text.includes(word))) continue;
      // A few occurrences of each word count (a long table holds them all), the words in the
      // heading and the words side by side as asked count more.
      const near = query.toLowerCase().replace(/\s+/g, ' ').trim();
      const score = words.reduce((sum, word) => sum + Math.min(3, text.split(word).length - 1), 0) + 4 * words.filter((word) => start.text.toLowerCase().includes(word)).length + (text.includes(near) ? 12 : 0);
      const where = body.find((line) => words.filter((word) => line.toLowerCase().includes(word)).length === Math.max(...body.map((candidate) => words.filter((word) => candidate.toLowerCase().includes(word)).length))) ?? '';
      hits.push({ page, section: start.slug, heading: start.text, line: where.trim().replace(/\s+/g, ' ').slice(0, 220), score });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// What `elabora docs` prints and elabora_docs returns: the map, a page, a long page's outline, a section.
export function readDocs(request: DocsRequest, root = DOCS_ROOT): { ok: true; text: string } | { ok: false; error: string } {
  const { page } = request;
  if (request.search !== undefined) {
    const hits = searchDocs(request.search, root);
    if (!hits.length) return { ok: false, error: `Nothing in the documentation holds every word of « ${request.search} ». Fewer words, or elabora docs (no page) for the map.` };
    return { ok: true, text: [`${hits.length} section(s) for « ${request.search} »; read one with elabora docs <page> --section <anchor> (elabora_docs { page, section }):`, ...hits.map((hit) => `- ${hit.page}${hit.section ? `#${hit.section}` : ''} — ${hit.heading}: ${hit.line}`)].join('\n') };
  }
  const skill = page ? readSkillPage(page, request) : null;
  if (skill) return skill;
  if (!fs.existsSync(path.join(root, 'docs/index.md'))) return { ok: false, error: `The documentation is not installed with this Elabora (no docs/index.md in ${root}).` };
  if (!page) {
    const sections = new Map<string, DocPage[]>();
    for (const entry of docsIndex(root)) sections.set(entry.section, [...(sections.get(entry.section) ?? []), entry]);
    const lines = ['# Elabora core documentation', '', 'Ask for a page by its id (elabora docs <id>, or elabora_docs { page }); a decision by its number (D29). Long pages come as their outline: then ask for a section.'];
    for (const [title, entries] of sections) lines.push('', `## ${title}`, ...entries.map((entry) => `- ${entry.id}: ${entry.title}${entry.description ? ` — ${entry.description}` : ''}`));
    lines.push('', '## Skills', '- skills: the task guidance bundled for course agents (authoring, design, narration, translation…): this page lists them, skills/<name> reads one, skills/<name>/<reference> its detailed recipe.');
    return { ok: true, text: lines.join('\n') };
  }
  const found = findPage(page, root);
  if (!found) {
    const words = page.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const near = allPages(root).filter((entry) => words.some((word) => entry.id.includes(word) || entry.title.toLowerCase().includes(word))).slice(0, 8).map((entry) => entry.id);
    return { ok: false, error: `No page « ${page} ».${near.length ? ` Maybe: ${near.join(', ')}.` : ''} elabora docs (no page) lists them.` };
  }
  return servePage(found.id, fs.readFileSync(path.join(root, found.file), 'utf8'), request);
}
