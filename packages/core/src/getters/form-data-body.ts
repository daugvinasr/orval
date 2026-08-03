import { keyword } from 'esutils';

import { resolveObject } from '../resolvers/object';
import { resolveRef } from '../resolvers/ref';
import {
  type ContextSpec,
  FormDataArrayHandling,
  type GeneratorImport,
  type OpenApiEncodingObject,
  type OpenApiReferenceObject,
  type OpenApiSchemaObject,
} from '../types';
import { camel } from '../utils';
import { isReference } from '../utils/assertion';
import { getFormDataFieldFileType } from '../utils/content-type';
import {
  getSchemaAdditionalProperties,
  getSchemaAllOf,
  getSchemaCombined,
  getSchemaItems,
  getSchemaProperties,
  getSchemaRequired,
  getSchemaVariants,
  hasSchemaType,
} from '../utils/schema';

const resolveSchema = (
  schema: OpenApiSchemaObject | OpenApiReferenceObject,
  context: ContextSpec,
) => resolveRef<OpenApiSchemaObject>(schema, context);

/**
 * Shape of the wire keys a form field expands into.
 *
 * - `flat` — no expansion: objects collapse to a single JSON value and array
 *   elements repeat under one key.
 * - `dot` — orval's `arrayHandling: 'explode'` shape (`metadata.shipping.city`).
 * - `bracket` — OpenAPI's `style: deepObject` (`metadata[shipping][city]`).
 */
type KeyStyle = 'flat' | 'dot' | 'bracket';

/** Builds the wire key for a nested form-data field. */
const joinKey = (path: string, key: string, style: KeyStyle): string => {
  if (!path) {
    return key;
  }
  return style === 'bracket' ? `${path}[${key}]` : `${path}.${key}`;
};

/** Everything a form-data emitter needs that does not vary field to field. */
interface FormDataTarget {
  /** Name of the generated `FormData` / `URLSearchParams` variable. */
  variableName: string;
  /**
   * url-encoded bodies are `URLSearchParams`: string values only, so the
   * File/Blob/Buffer handling multipart needs does not apply (#1624).
   */
  isUrlEncoded: boolean;
  context: ContextSpec;
  isRequestBodyOptional: boolean;
  /**
   * Key shape for the body's top-level properties. `arrayHandling: 'explode'`
   * opts every field into dotted expansion; otherwise fields stay flat unless
   * their `encoding` entry asks for deepObject.
   */
  rootKeyStyle: KeyStyle;
}

interface AppendOpaqueEntriesOptions {
  target: FormDataTarget;
  /** Runtime expression for the object whose entries are appended. */
  valueExpression: string;
  /**
   * Template-literal body for the key each entry lands under, or `undefined`
   * to use the entry's own key unprefixed.
   */
  keyPath?: string;
  /** Keys the caller appends itself and which this sweep must not duplicate. */
  excludedKeys: string[];
}

/**
 * Emits a runtime `Object.entries` sweep for an object whose *value shape* is
 * unknown at generation time — `additionalProperties: true`, or a
 * `oneOf`/`anyOf` body whose variants the generated union erases. Values are
 * dispatched on at runtime because there is no schema to dispatch on.
 *
 * When the value shape *is* declared, {@link serializeValue} handles it instead
 * and nested keys expand properly.
 */
function appendOpaqueEntries({
  target: { variableName, isUrlEncoded },
  valueExpression,
  keyPath,
  excludedKeys,
}: AppendOpaqueEntriesOptions): string {
  const entryKey = keyPath ? `\`${keyPath}[\${key}]\`` : 'key';
  const itemKey = keyPath ? `\`${keyPath}[\${key}][\${i}]\`` : 'key';
  // Nested entries are bracketed per deepObject, so their array elements are
  // indexed to match the shape declared properties get. An unprefixed sweep
  // repeats the bare key instead (`tags=a&tags=b`) and needs no index.
  const itemParams = keyPath ? '(v, i)' : 'v';

  const skipExcludedKeys = excludedKeys.length
    ? `  if ([${excludedKeys.map((key) => JSON.stringify(key)).join(', ')}].includes(key)) return;\n`
    : '';

  const appendCoerced = (key: string, value: string) =>
    `${variableName}.append(${key}, typeof ${value} === 'object' ? JSON.stringify(${value}) : String(${value}));`;

  const appendValue = isUrlEncoded
    ? `    if (Array.isArray(value)) {
      value.forEach(${itemParams} => {
        ${appendCoerced(itemKey, 'v')}
      });
    } else if (typeof value === 'object') {
      ${variableName}.append(${entryKey}, JSON.stringify(value));
    } else {
      ${variableName}.append(${entryKey}, String(value));
    }
`
    : `    if ((typeof File !== 'undefined' && value instanceof File) || value instanceof Blob) {
      ${variableName}.append(${entryKey}, value);
    } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
      ${variableName}.append(${entryKey}, new Blob([Uint8Array.from(value)]));
    } else if (Array.isArray(value)) {
      value.forEach(${itemParams} => {
        if ((typeof File !== 'undefined' && v instanceof File) || v instanceof Blob) {
          ${variableName}.append(${itemKey}, v);
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) {
          ${variableName}.append(${itemKey}, new Blob([Uint8Array.from(v)]));
        } else {
          ${appendCoerced(itemKey, 'v')}
        }
      });
    } else if (typeof value === 'object') {
      ${variableName}.append(${entryKey}, JSON.stringify(value));
    } else {
      ${variableName}.append(${entryKey}, String(value));
    }
`;

  return `Object.entries(${valueExpression} ?? {}).forEach(([key, value]) => {
${skipExcludedKeys}  if (value !== undefined && value !== null) {
${appendValue}  }
});\n`;
}

interface AppendMappedEntriesOptions {
  target: FormDataTarget;
  /** Schema every entry's value conforms to (`additionalProperties`). */
  valueSchema: OpenApiSchemaObject;
  valueExpression: string;
  keyPath: string;
  /** Keys the caller appends itself and which this sweep must not duplicate. */
  excludedKeys: string[];
  depth: number;
}

/**
 * Emits a runtime `Object.entries` sweep for a map whose value schema *is*
 * declared. Only the key is unknown, so each value is serialized from its
 * schema — a map of objects expands to `attributes[key][city]` rather than
 * collapsing to JSON.
 */
function appendMappedEntries({
  target,
  valueSchema,
  valueExpression,
  keyPath,
  excludedKeys,
  depth,
}: AppendMappedEntriesOptions): string {
  const skipExcludedKeys = excludedKeys.length
    ? `  if ([${excludedKeys.map((key) => JSON.stringify(key)).join(', ')}].includes(key)) return;\n`
    : '';

  // The entry value is named rather than destructured as `value` so an array
  // entry's own `forEach(value => …)` parameter does not shadow it.
  const entry = serializeValue({
    target,
    schema: valueSchema,
    value: 'entryValue',
    iterable: 'entryValue',
    keyPath: `${keyPath}[\${key}]`,
    style: 'bracket',
    depth: depth + 1,
  });

  return `Object.entries(${valueExpression} ?? {}).forEach(([key, entryValue]) => {
${skipExcludedKeys}  if (entryValue !== undefined && entryValue !== null) {
    ${entry}  }
});\n`;
}

/** Runtime expression coercing one array element to a form-data value. */
const getArrayItemExpression = (
  itemSchema: OpenApiSchemaObject | undefined,
): string => {
  if (!itemSchema) {
    return 'value';
  }
  if (hasSchemaType(itemSchema, 'object', 'array')) {
    return 'JSON.stringify(value)';
  }
  if (hasSchemaType(itemSchema, 'number', 'integer', 'boolean')) {
    return 'value.toString()';
  }
  return 'value';
};

/**
 * Types the schema's `oneOf`/`anyOf`/`allOf` members resolve to. A property can
 * declare its shape purely through composition (`oneOf: [integer, null]`), in
 * which case `type` is absent and these are all there is to branch on.
 */
const getCombinedTypes = (
  schema: OpenApiSchemaObject,
  context: ContextSpec,
): string[] =>
  getSchemaCombined(schema)?.map(
    (member) => resolveObject({ schema: member, combined: true, context }).type,
  ) ?? [];

interface SerializeObjectOptions {
  target: FormDataTarget;
  schema: OpenApiSchemaObject;
  /** Runtime expression for the object being written. */
  valueExpression: string;
  keyPath: string;
  style: KeyStyle;
  /** Depth of the property owning this object, not of the object itself. */
  depth: number;
}

/**
 * Writes one object-typed form-data field, whether it arrived as a named
 * property or as an array element. Declared keys recurse; keys that only exist
 * at runtime are swept up from `additionalProperties`.
 */
function serializeObject({
  target,
  schema,
  valueExpression,
  keyPath,
  style,
  depth,
}: SerializeObjectOptions): string {
  if (style === 'flat') {
    return `${target.variableName}.append(\`${keyPath}\`, JSON.stringify(${valueExpression}));\n`;
  }

  const declaredKeys = resolveSchemaPropertiesToFormData({
    target,
    schema,
    propName: valueExpression,
    keyStyle: style,
    keyPath,
    depth: depth + 1,
  });

  // Only deepObject's bracketed keys can carry a runtime-discovered segment;
  // the dot shape has never expanded undeclared keys.
  if (style !== 'bracket') {
    return declaredKeys;
  }

  const additionalProperties = getSchemaAdditionalProperties(schema);
  if (additionalProperties === false) {
    return declaredKeys;
  }

  const declaredProperties = getSchemaProperties(schema);
  // A schema with no declared properties and no `additionalProperties` still
  // generates an index signature, so its keys are open too.
  if (
    additionalProperties === undefined &&
    Object.keys(declaredProperties ?? {}).length > 0
  ) {
    return declaredKeys;
  }

  const sweep =
    additionalProperties === undefined || additionalProperties === true
      ? appendOpaqueEntries({
          target,
          valueExpression,
          keyPath,
          // Every declared key is appended by the recursion above, readOnly ones
          // included — what it deliberately drops must not reappear here.
          excludedKeys: Object.keys(declaredProperties ?? {}),
        })
      : appendMappedEntries({
          target,
          valueSchema: resolveSchema(additionalProperties, target.context)
            .schema,
          valueExpression,
          keyPath,
          excludedKeys: Object.keys(declaredProperties ?? {}),
          depth,
        });

  return declaredKeys + sweep;
}

interface SerializeValueOptions {
  target: FormDataTarget;
  /** Resolved schema of the value being written. */
  schema: OpenApiSchemaObject;
  /** Runtime expression for the value. */
  value: string;
  /** Runtime expression used to iterate the value when it is an array. */
  iterable: string;
  /** Template-literal body for the value's wire key. */
  keyPath: string;
  style: KeyStyle;
  /** Depth of the property owning this value. */
  depth: number;
  /** `encoding.contentType` declared for this part; top-level parts only. */
  partContentType?: string;
}

/**
 * Emits the append statement(s) for a single value of known schema at a known
 * wire key. Shared by declared properties, array elements, and the values of an
 * `additionalProperties` map, so every one of them expands identically.
 */
function serializeValue({
  target,
  schema,
  value,
  iterable,
  keyPath,
  style,
  depth,
  partContentType,
}: SerializeValueOptions): string {
  const { variableName, isUrlEncoded, context } = target;
  const indexName = `index${depth > 0 ? depth : ''}`;
  const append = (expression: string) =>
    `${variableName}.append(\`${keyPath}\`, ${expression});\n`;

  const fileType = getFormDataFieldFileType(schema, partContentType);
  const isBinary = schema.format === 'binary';

  if (isUrlEncoded && (fileType || isBinary)) {
    // url-encoded: file/binary fields are plain strings (URLSearchParams)
    return append(value);
  }
  if (fileType === 'binary' || isBinary) {
    // Binary: append directly (value is Blob)
    return append(value);
  }
  if (fileType === 'text') {
    // Text file: value is Blob | string, check at runtime
    const contentType =
      partContentType ?? (schema.contentMediaType as string | undefined);
    return append(
      `${value} instanceof Blob ? ${value} : new Blob([${value}], { type: '${contentType}' })`,
    );
  }
  if (hasSchemaType(schema, 'object')) {
    return serializeObject({
      target,
      schema,
      valueExpression: value,
      keyPath,
      style,
      depth,
    });
  }
  if (hasSchemaType(schema, 'array')) {
    const items = getSchemaItems(schema);
    const itemSchema = items ? resolveSchema(items, context).schema : undefined;

    if (style === 'flat') {
      const suffix =
        context.output.override.formData.arrayHandling ===
        FormDataArrayHandling.SERIALIZE_WITH_BRACKETS
          ? '[]'
          : '';
      return `${iterable}.forEach(value => ${variableName}.append(\`${keyPath}${suffix}\`, ${getArrayItemExpression(itemSchema)}));\n`;
    }

    // An array nested inside an array has no key of its own to expand under, so
    // it stays JSON rather than recursing into a schema with no properties.
    if (itemSchema && hasSchemaType(itemSchema, 'object')) {
      const item = serializeObject({
        target,
        schema: itemSchema,
        valueExpression: 'value',
        keyPath: `${keyPath}[\${${indexName}}]`,
        style,
        depth,
      });
      return `${iterable}.forEach((value, ${indexName}) => {
    ${item}});\n`;
    }

    return `${iterable}.forEach((value, ${indexName}) => ${variableName}.append(\`${keyPath}[\${${indexName}}]\`, ${getArrayItemExpression(itemSchema)}));\n`;
  }
  if (hasSchemaType(schema, 'number', 'integer', 'boolean')) {
    return `${variableName}.append(\`${keyPath}\`, ${value}.toString())\n`;
  }
  // A shape declared only through composition: a numeric variant still needs
  // coercing, and `type` is absent so nothing above matched.
  if (
    getCombinedTypes(schema, context).some((type) =>
      ['number', 'integer', 'boolean'].includes(type),
    )
  ) {
    return `${variableName}.append(\`${keyPath}\`, ${value}.toString())\n`;
  }

  return append(value);
}

interface ResolveSchemaPropertiesToFormDataOptions {
  target: FormDataTarget;
  schema: OpenApiSchemaObject;
  propName: string;
  keyStyle: KeyStyle;
  keyPath?: string;
  depth?: number;
  encoding?: Record<string, OpenApiEncodingObject>;
}

function resolveSchemaPropertiesToFormData({
  target,
  schema,
  propName,
  keyStyle,
  keyPath = '',
  depth = 0,
  encoding,
}: ResolveSchemaPropertiesToFormDataOptions): string {
  const { context, isRequestBodyOptional, isUrlEncoded } = target;

  let formDataValues = '';
  for (const [key, value] of Object.entries(
    getSchemaProperties(schema) ?? {},
  )) {
    const { schema: property } = resolveSchema(value, context);

    // Skip readOnly properties for formData
    if (property.readOnly) {
      continue;
    }

    // `encoding` describes a body's top-level parts only, so it is read at the
    // root and never forwarded into the recursion below.
    const partEncoding = depth === 0 ? encoding?.[key] : undefined;
    // deepObject expands an object into bracketed keys, and is url-encoded
    // only: multipart parts carry their own headers, so a nested object there
    // stays a single JSON-typed part. It is ignored for non-object properties —
    // OpenAPI leaves those undefined, and honouring it would silently change
    // how existing specs serialize their arrays. `encoding.explode` is not
    // consulted either: deepObject is only meaningful exploded, and orval has
    // no unexploded bracket shape to fall back to.
    const style: KeyStyle =
      isUrlEncoded &&
      partEncoding?.style === 'deepObject' &&
      hasSchemaType(property, 'object')
        ? 'bracket'
        : keyStyle;

    const formattedKeyPrefix = isRequestBodyOptional
      ? keyword.isIdentifierNameES5(key)
        ? '?'
        : '?.'
      : '';
    const formattedKey = keyword.isIdentifierNameES5(key)
      ? `.${key}`
      : `['${key}']`;

    const valueKey = `${propName}${formattedKeyPrefix}${formattedKey}`;
    const nonOptionalValueKey = `${propName}${formattedKey}`;

    const formDataValue = serializeValue({
      target,
      schema: property,
      value: nonOptionalValueKey,
      iterable: valueKey,
      keyPath: joinKey(keyPath, key, style),
      style,
      depth,
      partContentType: partEncoding?.contentType,
    });

    const isRequired =
      getSchemaRequired(schema)?.includes(key) && !isRequestBodyOptional;
    const isNullable =
      property.nullable ||
      hasSchemaType(property, 'null') ||
      getCombinedTypes(property, context).includes('null');

    if (isNullable) {
      if (isRequired) {
        formDataValues += `if(${valueKey} !== null) {\n ${formDataValue} }\n`;
        continue;
      }

      formDataValues += `if(${valueKey} !== undefined && ${nonOptionalValueKey} !== null) {\n ${formDataValue} }\n`;
      continue;
    }

    if (isRequired) {
      formDataValues += formDataValue;
      continue;
    }

    formDataValues += `if(${valueKey} !== undefined) {\n ${formDataValue} }\n`;
  }

  return formDataValues;
}

interface GetFormDataAdditionalImportsOptions {
  schemaObject: OpenApiSchemaObject | OpenApiReferenceObject;
  context: ContextSpec;
}

export function getFormDataAdditionalImports({
  schemaObject,
  context,
}: GetFormDataAdditionalImportsOptions): GeneratorImport[] {
  const { schema } = resolveSchema(schemaObject, context);

  if (schema.type !== 'object') {
    return [];
  }

  const variants = getSchemaVariants(schema);

  if (!variants) {
    return [];
  }

  return variants
    .map((variant) => resolveSchema(variant, context).imports[0])
    .filter(Boolean);
}

interface GetSchemaFormDataAndUrlEncodedOptions {
  name: string;
  schemaObject: OpenApiSchemaObject | OpenApiReferenceObject;
  context: ContextSpec;
  isRequestBodyOptional: boolean;
  isUrlEncoded?: boolean;
  isRef?: boolean;
  encoding?: Record<string, OpenApiEncodingObject>;
}

export function getSchemaFormDataAndUrlEncoded({
  name,
  schemaObject,
  context,
  isRequestBodyOptional,
  isUrlEncoded = false,
  isRef,
  encoding,
}: GetSchemaFormDataAndUrlEncodedOptions): string {
  const { schema, imports } = resolveSchema(schemaObject, context);
  const propName = camel(
    !isRef && isReference(schemaObject) ? imports[0].name : name,
  );

  const target: FormDataTarget = {
    variableName: isUrlEncoded ? 'formUrlEncoded' : 'formData',
    isUrlEncoded,
    context,
    isRequestBodyOptional,
    rootKeyStyle:
      context.output.override.formData.arrayHandling ===
      FormDataArrayHandling.EXPLODE
        ? 'dot'
        : 'flat',
  };
  const { variableName, rootKeyStyle } = target;

  let form = isUrlEncoded
    ? `const ${variableName} = new URLSearchParams();\n`
    : `const ${variableName} = new FormData();\n`;

  // `oneOf`/`anyOf` erase which keys a value carries, so they are swept at
  // runtime; `allOf` members all contribute their properties, so they are
  // expanded from the schema like any other object.
  const variants = getSchemaVariants(schema);
  const composition = variants ?? getSchemaAllOf(schema);

  if (schema.type === 'object' || (schema.type === undefined && composition)) {
    if (variants) {
      // Direct properties of the outer schema are handled below by the
      // dedicated properties branch. Skip them here to avoid appending the same
      // key twice. readOnly direct properties are left out of the exclusion
      // list so they can still flow through the runtime sweep if a variant
      // declares the same key as writable.
      const writableDeclaredKeys = Object.entries(
        getSchemaProperties(schema) ?? {},
      )
        .filter(([, value]) => !resolveSchema(value, context).schema.readOnly)
        .map(([key]) => key);

      form += appendOpaqueEntries({
        target,
        valueExpression: propName,
        excludedKeys: writableDeclaredKeys,
      });
    } else if (composition) {
      form += composition
        .map((member) =>
          resolveSchemaPropertiesToFormData({
            target,
            schema: resolveSchema(member, context).schema,
            propName,
            keyStyle: rootKeyStyle,
            encoding,
          }),
        )
        .filter(Boolean)
        .join('\n');
    }

    if (schema.properties) {
      form += resolveSchemaPropertiesToFormData({
        target,
        schema,
        propName,
        keyStyle: rootKeyStyle,
        encoding,
      });
    }

    return form;
  }

  if (schema.type === 'array') {
    const items = getSchemaItems(schema);
    const valueStr = getArrayItemExpression(
      items ? resolveSchema(items, context).schema : undefined,
    );

    return `${form}${propName}.forEach(value => ${variableName}.append('data', ${valueStr}))\n`;
  }

  if (
    schema.type === 'number' ||
    schema.type === 'integer' ||
    schema.type === 'boolean'
  ) {
    return `${form}${variableName}.append('data', ${propName}.toString())\n`;
  }

  return `${form}${variableName}.append('data', ${propName})\n`;
}
