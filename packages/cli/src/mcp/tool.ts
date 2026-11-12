import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { MULTIPLE_OF_PRECISION } from '@elabora/format';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Author } from '@elabora/core/ops/types';
import type { EditResult } from '@elabora/node/edit';
import type { ArgumentsOf, InputSchema } from '@elabora/core/commands/arguments';
import { NAMED_COMMANDS, type CommandName } from '@elabora/core/commands/table';

// An MCP tool: its public interface (name, description, input schema, hints) and its handler. The
// type of the handler's arguments follows from the input schema (@elabora/core/commands/arguments),
// which ajv checks before the handler runs: what agents may send and what the handler reads cannot
// drift apart.
export { formatValue, objectSchema, SLUG, LINE_ID, PLAN_ID, LANGUAGE, type ArgumentsOf, type InputSchema, type PropertySchema } from '@elabora/core/commands/arguments';

// A tool that is a command of the core's table (D84), its arguments as they are: its description,
// its schema and its hint come from the table, which the tools of a project in the cloud share.
export function fromCommand<const Name extends CommandName>(name: Name): { description: string; inputSchema: (typeof NAMED_COMMANDS)[Name]['args']; destructive: boolean } {
  const entry = NAMED_COMMANDS[name];
  return { description: entry.description, inputSchema: entry.args, destructive: 'destructive' in entry && entry.destructive === true };
}

export const PROFILES = { type: 'array', items: { type: 'string' }, description: 'LMS profile ids (elabora_list_profiles). Default: course.json delivery.lms, else ["unknown"]: no LMS chosen, the strictest values, and package limits only warn.' } as const;

export interface ToolContext {
  root: string; // the course folder the server is scoped to
  author: Author; // who writes: the agent, by the name its MCP client gives
  // The name the server serves a course folder under (a project just added to the library), null when
  // it does not serve it.
  courseName?: (folder: string) => string | null;
}

export interface ToolDefinition<Schema extends InputSchema> {
  name: string;
  description: string;
  readOnly?: boolean; // reads the course, changes nothing (also idempotent)
  destructive?: boolean; // deletes content
  openWorld?: boolean; // reaches a service outside this computer (Elabora's hosting)
  anywhere?: boolean; // needs no course: a server started outside one offers it (mcp.ts)
  inputSchema: Schema;
  handler(args: ArgumentsOf<Schema>, context: ToolContext): CallToolResult | Promise<CallToolResult>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly openWorld: boolean;
  readonly anywhere: boolean;
  readonly inputSchema: InputSchema;
  // Checks the arguments against the input schema, then runs the handler.
  call(args: unknown, context: ToolContext): Promise<CallToolResult>;
}

const ajv = new Ajv2020({ allErrors: true, strict: false, multipleOfPrecision: MULTIPLE_OF_PRECISION });

export function defineTool<Schema extends InputSchema>(definition: ToolDefinition<Schema>): Tool {
  let validate: ValidateFunction<ArgumentsOf<Schema>> | undefined;
  return {
    name: definition.name,
    description: definition.description,
    readOnly: !!definition.readOnly,
    destructive: !!definition.destructive,
    openWorld: !!definition.openWorld,
    anywhere: !!definition.anywhere,
    inputSchema: definition.inputSchema,
    async call(args, context) {
      validate ??= ajv.compile<ArgumentsOf<Schema>>(definition.inputSchema);
      if (!validate(args)) return errorResult({ error: 'Invalid arguments', details: (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`) });
      return definition.handler(args, context);
    }
  };
}

// Results: text, or JSON with a one-space indent (compact, still readable).
export const textResult = (value: unknown): CallToolResult => ({
  ...(typeof value === 'object' && value !== null && 'ok' in value && value.ok === false ? { isError: true } : {}),
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }]
});
export const errorResult = (value: unknown): CallToolResult => ({ isError: true, ...textResult(value) });
export const imageResult = (image: Buffer, text: string, mimeType = 'image/png'): CallToolResult => ({ content: [{ type: 'image', data: image.toString('base64'), mimeType }, { type: 'text', text }] });

// What an edit returns to agents: the change (for elabora_undo), the files written and the findings
// that matter (no info, none the author ignored: D31).
const EDIT_FIELDS = new Set(['screen', 'block', 'blocks', 'layer', 'event', 'replaced', 'units', 'language', 'skipped', 'object', 'waivers', 'section', 'component', 'renamed', 'migrated', 'components', 'from', 'to', 'library', 'version', 'formatMigration', 'font', 'tokens', 'notes', 'origin', 'captions', 'line', 'audio', 'sidecar', 'linked', 'unlinked', 'translations', 'node', 'added', 'kept', 'lost', 'progress', 'dryRun', 'targets', 'refused', 'removed']);
export const agentFindings = <D extends { severity: string; ignored?: boolean }>(diagnostics: readonly D[]): D[] => diagnostics.filter((d) => d.severity !== 'info' && !d.ignored);
export const editPayload = (result: EditResult): Record<string, unknown> => ({
  ok: true, op: result.op, undo: result.undo, change: result.change, files: result.files, summary: result.summary,
  diagnostics: agentFindings(result.diagnostics),
  ...Object.fromEntries(Object.entries(result).filter(([key]) => EDIT_FIELDS.has(key)))
});
export const editResult = (result: EditResult): CallToolResult => textResult(editPayload(result));
