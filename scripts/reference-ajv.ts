// Ajv, the reference the format's validators are generated from and compared with (D80). The core
// never runs it: Ajv writes its validators with `new Function`, which a Cloudflare Worker forbids.
// It generates validators.generated.ts (scripts/gen-format.ts) and is the other side of the
// differential tests.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Options } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { MULTIPLE_OF_PRECISION } from '@elabora/format/validator-runtime';
import type { JsonSchema } from '@elabora/format/json-schema';

// ajv-formats is CommonJS: its default import is module.exports, whose default is the plugin itself.
const addFormats = formats.default;

// Annotation keywords used by editors and agents; validators ignore them.
// x-kind tells templates and editors how to treat a string: text, markdown, tex, asset, token.
// x-group names a setting's section in the inspector.
export const X_KEYWORDS = ['x-ai-instructions', 'x-category', 'x-translatable', 'x-group', 'x-editable-by', 'x-control', 'x-token', 'x-object-id', 'x-asset-type', 'x-plan-locked', 'x-kind', 'x-token-prefix', 'x-item-label', 'x-text-on', 'x-slots'];

// The format's own schemas, strict: how they are compiled to validators.generated.ts.
export function registryAjv(schemas: Iterable<JsonSchema>, options: Options = {}): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true, verbose: false, multipleOfPrecision: MULTIPLE_OF_PRECISION, ...options });
  addFormats(ajv);
  ajv.addFormat('color', /^#[0-9A-Fa-f]{6}$/);
  ajv.addVocabulary(X_KEYWORDS);
  for (const schema of schemas) ajv.addSchema(schema);
  return ajv;
}

// The schemas of components and objects, compiled at run time by compileInline: not strict.
export function inlineAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true, multipleOfPrecision: MULTIPLE_OF_PRECISION });
  ajv.addFormat('color', /^#[0-9A-Fa-f]{6}$/);
  return ajv;
}

// Ajv's own validator of schemas (the 2020-12 meta-schema), as compileInline's "schema is invalid" error uses it.
export function metaAjv(options: Options = {}): Ajv2020 {
  return new Ajv2020({ strict: false, allErrors: true, validateSchema: false, ...options });
}
