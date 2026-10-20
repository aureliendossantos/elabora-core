// Public API of @elabora/cli: the command line and the MCP server, for embedding them.
export { main } from './main.ts';
export type { ExitCode } from './commands/command.ts';
export { createMcpServer, startMcpServer, TOOLS } from './mcp.ts';
export { listAgentTools, callAgentTool } from './agent-tools.ts';
export type { ToolOptions } from './agent-tools.ts';
export { AGENT_GUIDE, agentGuideText } from './agent-guide.ts';
export type { Tool, ToolContext } from './mcp/tool.ts';
