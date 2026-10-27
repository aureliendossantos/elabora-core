import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Author } from '@elabora/core/ops/types';
import type { EditResult } from '@elabora/node/edit';

// An MCP tool: its public interface (name, description, input schema, hints) and its handler. The
// type of the handler's arguments follows from the input schema, which ajv checks before the
// handler runs: what agents may send and what the handler reads cannot drift apart.

type TypeName = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

// The JSON Schema keywords tool inputs use; others (pattern, minimum, description…) do not change the type.
export interface PropertySchema {
  readonly type?: TypeName | readonly TypeName[];
  readonly enum?: readonly unknown[];
  readonly properties?: { readonly [name: string]: PropertySchema };
  readonly required?: readonly string[];
  readonly items?: PropertySchema;
  readonly [keyword: string]: unknown;
}

export interface InputSchema<Properties extends { readonly [name: string]: PropertySchema } = { readonly [name: string]: PropertySchema }, Required extends string = string> {
  readonly type: 'object';
  readonly properties: Properties;
  readonly required: readonly Required[];
  readonly additionalProperties: false;
}

// The arguments of a tool input: an object of its properties, each with its JSON Schema type.
type Simplify<T> = { [Key in keyof T]: T[Key] } & {};
type ObjectOf<Properties, Required> = Simplify<
  { -readonly [Key in keyof Properties as Key extends Required ? Key : never]: ValueOf<Properties[Key]> } &
  { -readonly [Key in keyof Properties as Key extends Required ? never : Key]?: ValueOf<Properties[Key]> }
>;
type ValueOfType<Name, Schema> =
  Name extends 'string' ? string
  : Name extends 'integer' | 'number' ? number
  : Name extends 'boolean' ? boolean
  : Name extends 'null' ? null
  : Name extends 'array' ? (Schema extends { readonly items: infer Items } ? ValueOf<Items>[] : unknown[])
  : Name extends 'object' ? (Schema extends { readonly properties: infer Properties } ? ObjectOf<Properties, Schema extends { readonly required: readonly (infer Key)[] } ? Key : never> : Record<string, unknown>)
  : never;
type ValueOf<Schema> =
  Schema extends FormatTyped<infer Value> ? (unknown extends Value ? JsonValueOf<Schema> : Exclude<Value, undefined>) : JsonValueOf<Schema>;
type JsonValueOf<Schema> =
  Schema extends { readonly enum: readonly (infer Value)[] } ? Value
  : Schema extends { readonly type: infer Name } ? ValueOfType<Name extends readonly (infer Each)[] ? Each : Name, Schema>
  : unknown;
export type ArgumentsOf<Schema> = ValueOf<Schema>;

// A value an edit checks against the format's schemas (a block, an event, the theme…): ajv only
// checks its JSON type here and the edit refuses a result that does not match the format, so the
// argument has the format's type. Nothing is added to the schema.
declare const FORMAT_TYPE: unique symbol;
type FormatTyped<Value> = { readonly [FORMAT_TYPE]?: Value };
export const formatValue = <Value>() => <const Schema extends PropertySchema>(schema: Schema): Schema & FormatTyped<Value> => schema;

// The input of a tool: these properties and no others.
export function objectSchema<const Properties extends { readonly [name: string]: PropertySchema }, const Required extends keyof Properties & string = never>(properties: Properties, required: readonly Required[] = []): InputSchema<Properties, Required> {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const SLUG = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' } as const;
export const PLAN_ID = { type: 'string', pattern: '^[A-Z][A-Z0-9_-]{0,31}$' } as const;
export const LANGUAGE = { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$', description: 'A BCP 47 tag: en, de, pt-BR.' } as const;
export const PROFILES = { type: 'array', items: { type: 'string' }, description: 'LMS profile ids (elabora_list_profiles). Default: course.json delivery.lms, else ["unknown"]: no LMS chosen, the strictest values, and package limits only warn.' } as const;

export interface ToolContext {
  root: string; // the course folder the server is scoped to
  author: Author; // who writes: the agent, by the name its MCP client gives
}

export interface ToolDefinition<Schema extends InputSchema> {
  name: string;
  description: string;
  readOnly?: boolean; // reads the course, changes nothing (also idempotent)
  destructive?: boolean; // deletes content
  openWorld?: boolean; // reaches a service outside this computer (Elabora's hosting)
  inputSchema: Schema;
  handler(args: ArgumentsOf<Schema>, context: ToolContext): CallToolResult | Promise<CallToolResult>;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly openWorld: boolean;
  readonly inputSchema: InputSchema;
  // Checks the arguments against the input schema, then runs the handler.
  call(args: unknown, context: ToolContext): Promise<CallToolResult>;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

export function defineTool<Schema extends InputSchema>(definition: ToolDefinition<Schema>): Tool {
  let validate: ValidateFunction<ArgumentsOf<Schema>> | undefined;
  return {
    name: definition.name,
    description: definition.description,
    readOnly: !!definition.readOnly,
    destructive: !!definition.destructive,
    openWorld: !!definition.openWorld,
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
const EDIT_FIELDS = new Set(['screen', 'block', 'blocks', 'layer', 'event', 'replaced', 'units', 'language', 'skipped', 'object', 'waivers', 'section', 'component', 'renamed', 'migrated', 'components', 'from', 'to', 'library', 'version', 'formatMigration', 'font', 'tokens', 'notes', 'origin', 'captions', 'line', 'audio', 'sidecar', 'linked', 'unlinked', 'translations', 'node', 'added', 'kept', 'lost', 'progress', 'dryRun', 'targets', 'refused']);
export const agentFindings = <D extends { severity: string; ignored?: boolean }>(diagnostics: readonly D[]): D[] => diagnostics.filter((d) => d.severity !== 'info' && !d.ignored);
export const editPayload = (result: EditResult): Record<string, unknown> => ({
  ok: true, op: result.op, undo: result.undo, change: result.change, files: result.files, summary: result.summary,
  diagnostics: agentFindings(result.diagnostics),
  ...Object.fromEntries(Object.entries(result).filter(([key]) => EDIT_FIELDS.has(key)))
});
export const editResult = (result: EditResult): CallToolResult => textResult(editPayload(result));
