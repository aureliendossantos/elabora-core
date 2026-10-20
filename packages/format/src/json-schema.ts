// A JSON Schema (draft 2020-12) object, as the format schemas, component props and free-object
// manifests write them. The keywords Elabora uses are typed loosely enough that the schema files,
// imported as JSON, match it as they are; any other keyword (x-* annotations…) is unknown.
export interface JsonSchema {
  $schema?: string;
  $id?: string;
  $ref?: string;
  $defs?: { [name: string]: JsonSchema | boolean };
  $comment?: string;
  title?: string;
  description?: string;
  default?: unknown;
  examples?: unknown[];
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: { [name: string]: JsonSchema | boolean };
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  patternProperties?: { [pattern: string]: JsonSchema | boolean };
  propertyNames?: JsonSchema | boolean;
  minProperties?: number;
  maxProperties?: number;
  items?: JsonSchema | boolean;
  prefixItems?: (JsonSchema | boolean)[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  allOf?: (JsonSchema | boolean)[];
  anyOf?: (JsonSchema | boolean)[];
  oneOf?: (JsonSchema | boolean)[];
  not?: JsonSchema | boolean;
  if?: JsonSchema | boolean;
  then?: JsonSchema | boolean;
  else?: JsonSchema | boolean;
  [keyword: string]: unknown;
}
