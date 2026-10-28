import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type { JsonSchema } from './json-schema.ts';
import type { Block, BuiltinBlock, BuiltinBlockType } from './types.generated.ts';
import { BLOCK_TYPES, LAYOUT_TYPES, FORMAT_VERSION, SCHEMA_VERSION, SCHEMAS } from './schemas.generated.ts';
import type { BuiltinLayoutType, SchemaName } from './schemas.generated.ts';

export type { BuiltinLayoutType, ErrorObject, SchemaName, ValidateFunction };
export { FORMAT_VERSION, SCHEMA_VERSION };
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

// ajv-formats is CommonJS: its default import is module.exports, whose default is the plugin itself.
const addFormats = formats.default;

// Annotation keywords used by editors and agents; validators ignore them.
// x-kind tells templates and editors how to treat a string: text, markdown, tex, asset, token.
const X_KEYWORDS = ['x-ai-instructions', 'x-category', 'x-translatable', 'x-group', 'x-editable-by', 'x-control', 'x-token', 'x-object-id', 'x-asset-type', 'x-plan-locked', 'x-kind', 'x-token-prefix', 'x-item-label', 'x-text-on', 'x-slots'];

// A schema violation, phrased so an agent can fix the value: path is a JSON Pointer in the data.
export interface SchemaError {
  path: string;
  keyword: string;
  message: string;
  schemaPath: string;
}

// multipleOf with decimals (a slider's step of 0.05): 0.6 / 0.05 is 11.999… in floating point, so ajv
// compares the quotient with an integer to this many decimals.
export const MULTIPLE_OF_PRECISION = 9;

let ajv: Ajv2020 | undefined;

export function getAjv(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true, verbose: false, multipleOfPrecision: MULTIPLE_OF_PRECISION });
  addFormats(ajv);
  ajv.addFormat('color', /^#[0-9A-Fa-f]{6}$/);
  ajv.addVocabulary(X_KEYWORDS);
  for (const schema of Object.values(SCHEMAS)) ajv.addSchema(schema);
  return ajv;
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

const validators = new Map<SchemaName, ValidateFunction>();

export function validateSchema(name: SchemaName, data: unknown): SchemaError[] {
  const a = getAjv();
  let v = validators.get(name);
  if (!v) {
    v = a.getSchema(schemaId(name));
    if (!v) throw new Error(`Unknown schema ${name}`);
    validators.set(name, v);
  }
  if (v(data)) return [];
  return simplifyErrors(v.errors || []);
}

// Compile an arbitrary (sub)schema, for manifest-declared props and states. Validators are cached
// by schema text (components are recompiled at every load); the cache is bounded so a long-running
// MCP server does not grow.
let inlineAjv: Ajv2020 | undefined;
const inlineCache = new Map<string, ValidateFunction>();
export function compileInline(schema: JsonSchema | boolean): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = inlineCache.get(key);
  if (cached) return cached;
  if (!inlineAjv || inlineCache.size >= 500) {
    inlineCache.clear();
    inlineAjv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, multipleOfPrecision: MULTIPLE_OF_PRECISION });
    inlineAjv.addFormat('color', /^#[0-9A-Fa-f]{6}$/);
  }
  const v = inlineAjv.compile(schema);
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
