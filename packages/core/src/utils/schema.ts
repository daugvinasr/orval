import type { OpenApiReferenceObject, OpenApiSchemaObject } from '../types';

// OpenAPI's SchemaObject carries an `[key: string]: any` index signature, which
// makes every property access `any`. These accessors restore the declared type
// once per field instead of at each access site.

/** JSON Schema type names orval branches on. */
export type SchemaTypeName =
  | 'array'
  | 'boolean'
  | 'integer'
  | 'null'
  | 'number'
  | 'object'
  | 'string';

const getSchemaType = (s: OpenApiSchemaObject) =>
  s.type as SchemaTypeName | SchemaTypeName[] | undefined;

/** True when `schema.type` is, or unions in, any of `types`. */
export const hasSchemaType = (
  schema: OpenApiSchemaObject,
  ...types: SchemaTypeName[]
): boolean => {
  const type = getSchemaType(schema);
  if (type === undefined) {
    return false;
  }
  return Array.isArray(type)
    ? type.some((variant) => types.includes(variant))
    : types.includes(type);
};

type SubSchemas = (OpenApiSchemaObject | OpenApiReferenceObject)[] | undefined;

/**
 * `oneOf`/`anyOf` variants. The generated TypeScript type is a union, so which
 * variant a value takes — and therefore which keys it carries — is not known
 * until runtime.
 */
export const getSchemaVariants = (s: OpenApiSchemaObject): SubSchemas =>
  (s.oneOf ?? s.anyOf) as SubSchemas;

/** `allOf` members. Every member contributes its properties, so keys are known. */
export const getSchemaAllOf = (s: OpenApiSchemaObject): SubSchemas =>
  s.allOf as SubSchemas;

/** Any composition, whether its keys are known ahead of time or not. */
export const getSchemaCombined = (s: OpenApiSchemaObject): SubSchemas =>
  getSchemaVariants(s) ?? getSchemaAllOf(s);

export const getSchemaItems = (s: OpenApiSchemaObject) =>
  s.items as OpenApiSchemaObject | OpenApiReferenceObject | undefined;

export const getSchemaRequired = (s: OpenApiSchemaObject) =>
  s.required as string[] | undefined;

export const getSchemaProperties = (s: OpenApiSchemaObject) =>
  s.properties as
    | Record<string, OpenApiSchemaObject | OpenApiReferenceObject>
    | undefined;

export const getSchemaAdditionalProperties = (s: OpenApiSchemaObject) =>
  s.additionalProperties as
    | OpenApiSchemaObject
    | OpenApiReferenceObject
    | boolean
    | undefined;
