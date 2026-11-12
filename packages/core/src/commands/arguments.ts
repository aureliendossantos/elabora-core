// The arguments of a command as JSON Schema (draft 2020-12), and their TypeScript type read from
// the schema: what a tool may send and what the command reads cannot drift apart. Data only, no
// validator: a caller checks with its own (the MCP server with ajv).

type TypeName = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'null';

// The JSON Schema keywords arguments use; others (pattern, minimum, description…) do not change the type.
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

// The arguments of an input: an object of its properties, each with its JSON Schema type.
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

// A value the command checks against the format's schemas (a block, an event, the theme…): the
// schema only gives its JSON type and the command refuses a result that does not match the format,
// so the argument has the format's type. Nothing is added to the schema.
declare const FORMAT_TYPE: unique symbol;
type FormatTyped<Value> = { readonly [FORMAT_TYPE]?: Value };
export const formatValue = <Value>() => <const Schema extends PropertySchema>(schema: Schema): Schema & FormatTyped<Value> => schema;

// An input: these properties and no others.
export function objectSchema<const Properties extends { readonly [name: string]: PropertySchema }, const Required extends keyof Properties & string = never>(properties: Properties, required: readonly Required[] = []): InputSchema<Properties, Required> {
  return { type: 'object', properties, required, additionalProperties: false };
}

// Shared property schemas.
export const SLUG = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' } as const;
// A voiced line's id: a line's (narration.lines[].id, a dialogue's line) or an answer the learner's voice says,
// "<node>.<option>" (optionLineId), as elabora_voice_estimate lists them.
export const LINE_ID = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}(\\.[a-z][a-z0-9-]{0,47})?$' } as const;
export const PLAN_ID = { type: 'string', pattern: '^[A-Z][A-Z0-9_-]{0,31}$' } as const;
export const LANGUAGE = { type: 'string', pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$', description: 'A BCP 47 tag: en, de, pt-BR.' } as const;
