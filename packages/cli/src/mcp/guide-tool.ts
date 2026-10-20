import { AGENT_GUIDE } from '../agent-guide.ts';
import { defineTool, objectSchema, textResult } from './tool.ts';

export const agentGuideTool = defineTool({
  name: 'elabora_agent_guide',
  readOnly: true,
  description: 'How to work on a course in this host: MCP/CLI/file choices, complete authoring, translation, design, narration, delivery and review workflows, tool names and human decisions. Read when starting or when unsure which operation to use. The CLI equivalent is elabora tools guide --json (no course needed). Only call tools this connection actually exposes.',
  inputSchema: objectSchema({}),
  handler: () => textResult(AGENT_GUIDE)
});
