import fs from 'node:fs';
import { agentRulesNote, syncAgentRules } from '@elabora/node/agent-rules';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Author } from '@elabora/core/ops/types';
import { ELABORA_VERSION } from '@elabora/node/bundles';
import { detectAuthor } from '@elabora/node/journal/author';
import { agentTools, listAgentTools, callAgentTool } from './agent-tools.ts';
import { errorResult, objectSchema, textResult } from './mcp/tool.ts';
import type { ToolOptions } from './agent-tools.ts';
import { allPages, docsIndex, DOCS_ROOT } from './docs.ts';
import { listSkills, readSkill } from './skills.ts';
export { TOOLS } from './agent-tools.ts';
const INSTRUCTIONS = `Read the course's AGENTS.md and its author notes: these contain the universal constraints, human approvals and a task-to-skill map. Start with elabora_overview, the plan and sources relevant to the request.

Skills are elabora://skills/<name> resources; load only those relevant to the task. For deeper authoring/design recipes, read elabora://skills/<name>/references/<reference>. Without resources, elabora_docs { page: "skills/<name>[/<reference>]" } serves the same text. elabora_agent_guide explains the operations and transports; elabora_docs supplies the format.

Write the plan with elabora_write_plan, even after a validation, and tell the author what changed (elabora_plan_diff); no tool creates or validates a plan version: those are the author's. Preserve verbatim texts, reference validated texts/questions and cover plan items. Keep permanent ids, use native blocks/components first and import media through Elabora tools. Sources may hold personal data: quote only what the module needs. Read diagnostics, validate and inspect visuals. Author approvals and publishing remain human actions. Before a paid voice, read elabora-narration: the tools refuse a spend the author has not approved.

Use only tools exposed by this connection; CLI/file tools are alternatives when the host has them. Running a stdio server in a shell does not connect your agent.`;

// Outside a course, the server offers what needs none (the documentation, the skills, the app's
// library) and says how to reach one: a host plugin starts it wherever its session opens.
const NO_COURSE = `Only the documentation, the skills and the app's library are offered here. elabora_projects_list gives the author's courses and their folders. To work on one, this server must be started on its folder: open the session in that folder (a host that starts Elabora where the session opens, as its Claude Code and Codex plugins do), or add the folder to Elabora's settings in the host (its Claude extension). With a shell, elabora tools call <tool> <folder> --args '<json>' runs any operation on a course. Do not change the author's agent configuration yourself.`;

const isCourse = (dir: string) => fs.existsSync(path.join(dir, 'course.json'));

// The courses a server serves: each folder given that is a course, else the courses directly in it
// (a folder of modules, the app's library). A folder that is gone or unreadable is skipped and said,
// so that one course deleted does not stop a host from reaching the others; when it is the only
// folder given, that is an error. `found`: the courses met inside a folder, not named themselves.
export interface ServedCourses { courses: string[]; found: string[]; missing: string[] }
export function servedCourses(dirs: readonly string[]): ServedCourses {
  const courses: string[] = [];
  const found: string[] = [];
  const missing: string[] = [];
  for (const dir of dirs.map((each) => path.resolve(each))) {
    if (isCourse(dir)) { courses.push(dir); continue; }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const course = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && isCourse(course)) { courses.push(course); found.push(course); }
      }
    } catch {
      missing.push(dir);
    }
  }
  if (dirs.length === 1 && missing.length) throw new Error(`${missing[0]} is not a folder this server can read`);
  return { courses: [...new Set(courses)], found, missing };
}

interface ServedCourse { name: string; folder: string; id: string | null; title: string | null }

// Several courses: each is named by its course id (the folder's name when it has none), with -2, -3…
// when two share it.
function nameCourses(folders: readonly string[]): ServedCourse[] {
  const taken = new Map<string, number>();
  return folders.map((folder) => {
    let info: { id?: unknown; title?: unknown } = {};
    try { info = JSON.parse(fs.readFileSync(path.join(folder, 'course.json'), 'utf8')); } catch { /* validate says why */ }
    const id = typeof info.id === 'string' ? info.id : null;
    const base = id ?? path.basename(folder);
    const seen = (taken.get(base) ?? 0) + 1;
    taken.set(base, seen);
    return { name: seen === 1 ? base : `${base}-${seen}`, folder, id, title: typeof info.title === 'string' ? info.title : null };
  });
}

// dirs: the course folder, or several folders (each a course or a folder of courses).
export function createMcpServer(dirs: string | readonly string[], options: ToolOptions = {}): Server {
  const { readOnly = false } = options;
  // Validate host configuration before updating course rules; use one selection for list/call.
  agentTools(options);
  const { courses: folders, found, missing } = servedCourses(typeof dirs === 'string' ? [dirs] : dirs);
  const served = nameCourses(folders);
  const mode = served.length === 0 ? 'none' : served.length === 1 ? 'one' : 'several';
  // Outside a course, only the tools that need none.
  const anywhere = agentTools({ readOnly, ...(options.tools === undefined ? {} : { tools: options.tools }) }).filter((tool) => tool.anywhere).map((tool) => tool.name);
  const selection: ToolOptions = { readOnly, ...(mode === 'none' ? { tools: anywhere } : options.tools === undefined ? {} : { tools: [...options.tools] }) };
  const byName = new Map(agentTools(selection).map((tool) => [tool.name, tool]));
  const COURSE = { type: 'string', description: 'The course to work on: its name, as this server\'s instructions and elabora_courses give it.' } as const;
  const tools = listAgentTools(selection).map((tool) => mode !== 'several' || byName.get(tool.name)!.anywhere ? tool
    : { ...tool, inputSchema: { ...tool.inputSchema, properties: { course: COURSE, ...tool.inputSchema.properties }, required: ['course', ...tool.inputSchema.required] } });
  if (mode === 'several') tools.unshift({ name: 'elabora_courses', description: 'The courses this server serves: the name every course operation takes as course, the course id, title and folder.', inputSchema: objectSchema({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } });

  // The course's rules for agents, brought up to date when nobody edited them (agent-rules.ts, D34);
  // a read-only server writes nothing, and only says what it finds. A course met inside a folder is
  // brought up to date only when an operation first works on it: a session opened in a folder of
  // modules does not rewrite them all.
  const pending = new Set(readOnly ? [] : found);
  const notes = served.map((course) => {
    const note = readOnly || pending.has(course.folder) ? agentRulesNote(course.folder) : syncAgentRules(course.folder);
    return note && mode === 'several' ? `${course.name}: ${note}` : note;
  }).filter((note): note is string => !!note);
  const settle = (folder: string) => {
    if (!pending.delete(folder)) return;
    const note = syncAgentRules(folder);
    if (note) process.stderr.write(`${note}\n`);
  };
  const gone = missing.length ? `Not found, so not served: ${missing.join(', ')}.` : '';
  // Said to the agent too, in the server's instructions: a host keeps a server's stderr in its logs.
  for (const note of [...notes, gone]) if (note) process.stderr.write(`${note}\n`);
  const scope = mode === 'one' ? `Elabora MCP server, scoped to one course: ${served[0]!.folder}.`
    : mode === 'none' ? `Elabora MCP server, started outside a course: ${typeof dirs === 'string' ? path.resolve(dirs) : dirs.map((dir) => path.resolve(dir)).join(', ')} holds no Elabora course (a folder with course.json). ${NO_COURSE}`
    : `Elabora MCP server, serving ${served.length} courses: every course operation takes course, its name below. Each course has its own AGENTS.md and author notes: read those of the course you work on before editing it.\n${served.map((course) => `- ${course.name}: ${course.title ?? '(no title)'} (${course.folder})`).join('\n')}`;
  const instructions = [scope, INSTRUCTIONS, ...notes, gone].filter(Boolean).join('\n\n');
  const server = new Server({ name: 'elabora', version: ELABORA_VERSION }, { capabilities: { tools: {}, resources: {} }, instructions });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    // Who writes: ELABORA_AUTHOR when the host names its agent (Elabora's own chat says « claude »,
    // not the adapter's client name), else the name its MCP client gives.
    const client = server.getClientVersion()?.name;
    // An agent's name only: a shell's ELABORA_AUTHOR=human inherited by the server does not make the agent a person.
    const named = process.env.ELABORA_AUTHOR?.trim() ? detectAuthor() : null;
    const author: Author = named?.kind === 'agent' ? named : client ? { kind: 'agent', name: client } : { kind: 'agent' };
    if (mode === 'several' && name === 'elabora_courses') return textResult(served);
    const tool = byName.get(name);
    if (mode !== 'several' || !tool || tool.anywhere) {
      if (mode === 'one' && tool && !tool.anywhere) settle(served[0]!.folder);
      return callAgentTool(name, args, { root: served[0]?.folder ?? process.cwd(), author }, selection);
    }
    const { course: wanted, ...rest } = args;
    const course = served.find((each) => each.name === wanted || each.folder === (typeof wanted === 'string' ? path.resolve(wanted) : null));
    if (!course) return errorResult({ error: `${wanted === undefined ? 'No course given' : `No course ${JSON.stringify(wanted)} here`}: course is one of ${served.map((each) => each.name).join(', ')}.` });
    settle(course.folder);
    return callAgentTool(name, rest, { root: course.folder, author }, selection);
  });

  // Resources: the courses' AGENTS.md, the skills shipped with Elabora and its documentation's pages
  // (docs.ts; the tool elabora_docs gives the same pages a section at a time). The decisions are
  // read by address (elabora://docs/decisions/d29), not listed: the map lists their index.
  const docsShipped = fs.existsSync(path.join(DOCS_ROOT, 'docs/index.md'));
  const docPages = docsShipped ? allPages() : [];
  const listedPages = docsShipped ? docsIndex() : [];
  const skills = listSkills();
  const rules = new Map(served.filter((course) => fs.existsSync(path.join(course.folder, 'AGENTS.md')))
    .map((course) => [mode === 'one' ? 'elabora://course/AGENTS.md' : `elabora://course/${course.name}/AGENTS.md`, course]));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...[...rules].map(([uri, course]) => ({ uri, name: mode === 'one' ? 'Course rules for agents' : `Course rules for agents: ${course.name}`, mimeType: 'text/markdown' })),
      ...skills.flatMap(({ name, references }) => [
        { uri: `elabora://skills/${name}`, name: `Skill ${name}`, mimeType: 'text/markdown' },
        ...references.map((reference) => ({ uri: `elabora://skills/${name}/references/${reference}`, name: `Skill reference ${name}/${reference}`, mimeType: 'text/markdown' }))
      ]),
      ...listedPages.map((page) => ({ uri: `elabora://docs/${page.id}`, name: `Docs: ${page.title}`, ...(page.description ? { description: page.description } : {}), mimeType: 'text/markdown' }))
    ]
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    let file: string | null = null;
    const course = rules.get(uri);
    if (course) file = path.join(course.folder, 'AGENTS.md');
    const skill = /^elabora:\/\/skills\/([a-z0-9-]+)(?:\/references\/([a-z0-9-]+))?$/.exec(uri);
    if (skill) {
      const content = readSkill(skill[1], skill[2]);
      if (content !== null) return { contents: [{ uri, mimeType: 'text/markdown', text: content }] };
    }
    const doc = /^elabora:\/\/docs\/(.+)$/.exec(uri);
    const page = doc && docPages.find((entry) => entry.id === doc[1]);
    if (page) file = path.join(DOCS_ROOT, page.file);
    if (!file) throw new Error(`Unknown resource ${uri}`);
    return { contents: [{ uri, mimeType: 'text/markdown', text: fs.readFileSync(file, 'utf8') }] };
  });
  return server;
}

export async function startMcpServer(dirs: string | readonly string[], options?: ToolOptions): Promise<Server> {
  const server = createMcpServer(dirs, options);
  await server.connect(new StdioServerTransport());
  return server;
}
