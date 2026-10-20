// @elabora/format: the course format as data (JSON Schemas), as types and as a schema registry.
export {
  FORMAT,
  SCHEMA_VERSION,
  SCHEMA_BASE,
  BLOCK_TYPES,
  isBuiltinBlockType,
  isBuiltinBlock,
  getAjv,
  getSchema,
  schemaId,
  validateSchema,
  compileInline,
  derefSchema,
  simplifyErrors
} from './schemas.ts';
export type { SchemaName, SchemaError, ErrorObject, ValidateFunction } from './schemas.ts';
export type { JsonSchema } from './json-schema.ts';
export type * from './types.generated.ts';
