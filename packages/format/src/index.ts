// @elabora/format: the course format as data (JSON Schemas), as types and as a schema registry.
export {
  FORMAT,
  FORMAT_VERSION,
  SCHEMA_VERSION,
  SCHEMA_BASE,
  BLOCK_TYPES,
  isBuiltinBlockType,
  LAYOUT_TYPES,
  isBuiltinLayoutType,
  isBuiltinType,
  isBuiltinBlock,
  getAjv,
  MULTIPLE_OF_PRECISION,
  getSchema,
  schemaId,
  validateSchema,
  compileInline,
  derefSchema,
  simplifyErrors
} from './schemas.ts';
export type { SchemaName, SchemaError, ErrorObject, ValidateFunction, BuiltinLayoutType } from './schemas.ts';
export type { JsonSchema } from './json-schema.ts';
export type * from './types.generated.ts';
