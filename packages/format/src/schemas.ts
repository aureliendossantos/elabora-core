import type { JsonSchema } from './json-schema.ts';
import type { Block, BuiltinBlock, BuiltinBlockType } from './types.generated.ts';
import { BLOCK_TYPES, LAYOUT_TYPES, FORMAT_VERSION, SCHEMA_VERSION, SCHEMAS } from './schemas.generated.ts';
import type { BuiltinLayoutType, SchemaName } from './schemas.generated.ts';
import { VALIDATORS } from './validators.generated.ts';
import { compileInterpreted } from './inline-schema.ts';
import { MULTIPLE_OF_PRECISION } from './validator-runtime.ts';
import type { ErrorObject, ValidateFunction } from './validator-runtime.ts';

export type { BuiltinLayoutType, ErrorObject, SchemaName, ValidateFunction };
export { FORMAT_VERSION, MULTIPLE_OF_PRECISION, SCHEMA_VERSION };
// What a course declares (course.json format): its major and minor version. The schemas have a
// patch version of their own (SCHEMA_VERSION, D64): additive changes publish a new one.
export const FORMAT = `elabora/${FORMAT_VERSION}` as const;
export const SCHEMA_BASE = `https://elabora.studio/schemas/${SCHEMA_VERSION}/` as const;

// Built-in block types (the native catalogue). Course components (components/<id>/) add more.
export { BLOCK_TYPES };
const builtinTypes: ReadonlySet<string> = new Set(BLOCK_TYPES);

export function isBuiltinBlockType(type: unknown): type is BuiltinBlockType {
  return typeof type === 'string' && builtinTypes.has(type);
}

// Built-in screen layouts (layouts/<id>.schema.json): a screen's layout names one of them or a
// screen-level course component.
export { LAYOUT_TYPES };
const builtinLayouts: ReadonlySet<string> = new Set(LAYOUT_TYPES);

export function isBuiltinLayoutType(type: unknown): type is BuiltinLayoutType {
  return typeof type === 'string' && builtinLayouts.has(type);
}

// A name Elabora ships, as a block type or a screen layout: course components cannot take it.
export const isBuiltinType = (type: unknown): boolean => isBuiltinBlockType(type) || isBuiltinLayoutType(type);

// The type of a block selects the schema of its props, so a block that passed validation with a
// built-in type has the props of that type.
export function isBuiltinBlock(block: Block): block is BuiltinBlock {
  return isBuiltinBlockType(block.type);
}

// A schema violation, phrased so an agent can fix the value: path is a JSON Pointer in the data.
export interface SchemaError {
  path: string;
  keyword: string;
  message: string;
  schemaPath: string;
}

// name: 'course' | 'plan' | 'screen' | 'blocks/quiz' | 'object-manifest' …; undefined for other names.
export function getSchema(name: SchemaName): JsonSchema;
export function getSchema(name: string): JsonSchema | undefined;
export function getSchema(name: string): JsonSchema | undefined {
  return Object.hasOwn(SCHEMAS, name) ? SCHEMAS[name as SchemaName] : undefined;
}

export function schemaId(name: SchemaName): string {
  return `${SCHEMA_BASE}${name}.schema.json`;
}

// Validates data against one of the format's schemas: the validators were compiled when `pnpm run gen`
// ran (D80), so nothing here generates code and the same function runs in Node, a browser and a Worker.
export function validateSchema(name: SchemaName, data: unknown): SchemaError[] {
  const validate: ValidateFunction | undefined = Object.hasOwn(VALIDATORS, name) ? VALIDATORS[name] : undefined;
  if (!validate) throw new Error(`Unknown schema ${name}`);
  if (validate(data)) return [];
  return simplifyErrors(validate.errors || []);
}

// Compile an arbitrary (sub)schema, for manifest-declared props and states, with the interpreter of
// inline-schema.ts. Validators are cached by schema text (components are recompiled at every load); the
// cache is bounded so a long-running MCP server does not grow. A schema that is invalid, or uses a
// keyword the interpreter does not know, throws an Error that says why.
const inlineCache = new Map<string, ValidateFunction>();
export function compileInline(schema: JsonSchema | boolean): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = inlineCache.get(key);
  if (cached) return cached;
  if (inlineCache.size >= 500) inlineCache.clear();
  const v = compileInterpreted(schema);
  inlineCache.set(key, v);
  return v;
}

// A schema with the shared definitions inlined (no $ref to defs.schema.json, no $id): what
// components merge, templates navigate and agents read.
export function derefSchema(schema: JsonSchema): JsonSchema {
  const defs = SCHEMAS.defs.$defs ?? {};
  const shared = (ref: string) => defs[ref.split('/').pop() ?? ''];
  // The schema's own definitions (a dialogue's line, node, option…), inlined too; a definition that
  // contains itself keeps its $ref there.
  const local = (schema.$defs ?? {}) as Record<string, unknown>;
  const expanding = new Set<string>();
  // A $ref with fields beside it: the fields win, the properties of both are kept (a dialogue's sound
  // line: the shared sound line's, and its own if).
  const join = (base: unknown, own: unknown): object => {
    const a = base as JsonSchema;
    const b = own as JsonSchema;
    return { ...a, ...b, ...(a.properties && b.properties ? { properties: { ...a.properties, ...b.properties } } : {}) };
  };
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== 'object') return s;
    const { $ref, ...rest } = s as JsonSchema;
    if (typeof $ref === 'string' && /defs\.schema\.json#\/\$defs\//.test($ref)) return join(walk(shared($ref)), walk(rest));
    if (typeof $ref === 'string' && $ref.startsWith('#/$defs/') && shared($ref)) return join(walk(shared($ref)), walk(rest));
    const name = typeof $ref === 'string' && $ref.startsWith('#/$defs/') ? $ref.slice(8) : null;
    if (name !== null && Object.hasOwn(local, name) && !expanding.has(name)) {
      expanding.add(name);
      const inlined = join(walk(local[name]), walk(rest));
      expanding.delete(name);
      return inlined;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s)) if (k !== '$schema' && k !== '$id') out[k] = walk(v);
    return out;
  };
  return walk(schema) as JsonSchema;
}

// Ajv reports `if`/`allOf` wrappers next to the real cause; keep the actionable errors only
// and phrase them so an agent can fix the value without reading Ajv documentation.
export function simplifyErrors(errors: ErrorObject[]): SchemaError[] {
  const out: SchemaError[] = [];
  const seen = new Set<string>();
  for (const e of errors) {
    if (e.keyword === 'if' || e.keyword === 'allOf') continue;
    let msg = e.message || 'invalid';
    if (e.keyword === 'additionalProperties') msg = `unknown property "${e.params.additionalProperty}" (not allowed by the schema)`;
    else if (e.keyword === 'unevaluatedProperties') msg = `unknown property "${e.params.unevaluatedProperty}" (not allowed by the schema)`;
    else if (e.keyword === 'enum') msg = `must be one of ${JSON.stringify(e.params.allowedValues)}`;
    else if (e.keyword === 'const') msg = `must be ${JSON.stringify(e.params.allowedValue)}`;
    else if (e.keyword === 'required') msg = `missing required property "${e.params.missingProperty}"`;
    else if (e.keyword === 'pattern') msg = `does not match the expected pattern ${e.params.pattern}`;
    const key = `${e.instancePath}|${msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: e.instancePath, keyword: e.keyword, message: msg, schemaPath: e.schemaPath });
  }
  return out;
}
