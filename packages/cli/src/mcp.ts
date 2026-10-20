import fs from 'node:fs';
import { agentRulesNote, syncAgentRules } from '@elabora/node/agent-rules';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Author } from '@elabora/core/ops/types';
import { ELABORA_VERSION } from '@elabora/node/bundles';
import { listAgentTools, callAgentTool } from './agent-tools.ts';
import type { ToolOptions } from './agent-tools.ts';
import { allPages, docsIndex, DOCS_ROOT } from './docs.ts';
import { listSkills, readSkill } from './skills.ts';
export { TOOLS } from './agent-tools.ts';
const INSTRUCTIONS = `Elabora MCP server, scoped to one course. Read the course's AGENTS.md and its author notes: these contain the universal constraints, human approvals and a task-to-skill map. Start with elabora_overview, the plan and sources relevant to the request.

Skills are elabora://skills/<name> resources; load only those relevant to the task. For deeper authoring/design recipes, read elabora://skills/<name>/references/<reference>. Without resources, elabora_docs { page: "skills/<name>[/<reference>]" } serves the same text. elabora_agent_guide explains the operations and transports; elabora_docs supplies the format.

Write the plan with elabora_write_plan, even after a validation, and tell the author what changed (elabora_plan_diff); no tool creates or validates a plan version: those are the author's. Preserve verbatim texts, reference validated texts/questions and cover plan items. Keep permanent ids, use native blocks/components first and import media through Elabora tools. Sources may hold personal data: quote only what the module needs. Read diagnostics, validate and inspect visuals. Author approvals and publishing remain human actions. Before a paid voice, read elabora-narration: the tools refuse a spend the author has not approved.

Use only tools exposed by this connection; CLI/file tools are alternatives when the host has them. Running a stdio server in a shell does not connect your agent.`;

export function createMcpServer(dir: string, options: ToolOptions = {}): Server {
  const { readOnly = false } = options;
  const selection: ToolOptions = { readOnly, ...(options.tools === undefined ? {} : { tools: [...options.tools] }) };
  // Validate host configuration before updating course rules; use one selection for list/call.
  const tools = listAgentTools(selection);
  const root = path.resolve(dir);
  if (!fs.existsSync(path.join(root, 'course.json'))) throw new Error(`${root} is not an Elabora course (no course.json)`);
  // The course's rules for agents, brought up to date when nobody edited them (agent-rules.ts, D34);
  // a read-only server writes nothing, and only says what it finds.
  const rulesNote = readOnly ? agentRulesNote(root) : syncAgentRules(root);
  if (rulesNote) process.stderr.write(`${rulesNote}\n`);
  const server = new Server({ name: 'elabora', version: ELABORA_VERSION }, { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const client = server.getClientVersion()?.name;
    const author: Author = client ? { kind: 'agent', name: client } : { kind: 'agent' };
    return callAgentTool(name, args, { root, author }, selection);
  });

  // Resources: the course AGENTS.md, the skills shipped with Elabora and its documentation's pages
  // (docs.ts; the tool elabora_docs gives the same pages a section at a time). The decisions are
  // read by address (elabora://docs/decisions/d29), not listed: the map lists their index.
  const docsShipped = fs.existsSync(path.join(DOCS_ROOT, 'docs/index.md'));
  const docPages = docsShipped ? allPages() : [];
  const listedPages = docsShipped ? docsIndex() : [];
  const skills = listSkills();
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      ...(fs.existsSync(path.join(root, 'AGENTS.md')) ? [{ uri: 'elabora://course/AGENTS.md', name: 'Course rules for agents', mimeType: 'text/markdown' }] : []),
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
    if (uri === 'elabora://course/AGENTS.md') file = path.join(root, 'AGENTS.md');
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

export async function startMcpServer(dir: string, options?: ToolOptions): Promise<Server> {
  const server = createMcpServer(dir, options);
  await server.connect(new StdioServerTransport());
  return server;
}
