import { uniqueBy } from 'remeda';

import { resolveObject } from '../resolvers/object';
import { resolveExampleRefs, resolveRef } from '../resolvers/ref';
import type {
  ContextSpec,
  GetterResponse,
  OpenApiMediaTypeObject,
  OpenApiReferenceObject,
  OpenApiRequestBodyObject,
  OpenApiResponseObject,
  OpenApiSchemaObject,
  ResReqTypesValue,
} from '../types';
import { isReference } from '../utils/assertion';
import { pascal } from '../utils/case';
import { isBinaryContentType } from '../utils/content-type';
import { getSchemaVariants } from '../utils/schema';
import { getNumberWord } from '../utils/string';
import {
  getFormDataAdditionalImports,
  getSchemaFormDataAndUrlEncoded,
} from './form-data-body';
import type { FormDataContext } from './object';

const formDataContentTypes = new Set(['multipart/form-data']);

const formUrlEncodedContentTypes = new Set([
  'application/x-www-form-urlencoded',
]);

interface GetResReqContentTypesOptions {
  mediaType: OpenApiMediaTypeObject;
  propName?: string;
  context: ContextSpec;
  isFormData?: boolean;
  contentType: string;
}

function getResReqContentTypes({
  mediaType,
  propName,
  context,
  isFormData,
  contentType,
}: GetResReqContentTypesOptions) {
  if (!mediaType.schema) {
    return;
  }

  // For form bodies, pass context that tracks encoding for file type
  // detection. url-encoded bodies additionally flag `urlEncoded` so file/binary
  // fields are typed as `string` rather than `Blob` (#1624).
  const isFormUrlEncoded = formUrlEncodedContentTypes.has(contentType);
  const formDataContext: FormDataContext | undefined = isFormData
    ? { atPart: false, encoding: mediaType.encoding ?? {} }
    : isFormUrlEncoded
      ? { atPart: false, encoding: mediaType.encoding ?? {}, urlEncoded: true }
      : undefined;

  const resolvedObject = resolveObject({
    schema: mediaType.schema,
    propName,
    context,
    formDataContext,
  });

  // Known binary content type → Blob (overrides schema)
  // This ensures correct responseType ('blob') even when schema lacks format: binary.
  if (!isFormData && isBinaryContentType(contentType)) {
    return {
      ...resolvedObject,
      value: 'Blob',
    };
  }

  return resolvedObject;
}

export function getResReqTypes(
  responsesOrRequests: [
    string,
    OpenApiReferenceObject | OpenApiResponseObject | OpenApiRequestBodyObject,
  ][],
  name: string,
  context: ContextSpec,
  defaultType = 'unknown',
  uniqueKey: (
    item: ResReqTypesValue,
    index: number,
    data: ResReqTypesValue[],
  ) => unknown = (item) => item.value,
): ResReqTypesValue[] {
  const typesArray = responsesOrRequests
    .filter(([, res]) => Boolean(res))
    .map(([key, res]) => {
      if (isReference(res)) {
        const {
          schema: bodySchema,
          imports: [{ name, schemaName }],
        } = resolveRef<OpenApiResponseObject | OpenApiRequestBodyObject>(
          res,
          context,
        );

        const firstEntry = Object.entries(bodySchema.content ?? {}).at(0);

        if (!firstEntry) {
          return [
            {
              value: name,
              imports: [{ name, schemaName }],
              schemas: [],
              type: 'unknown',
              isEnum: false,
              isRef: true,
              hasReadonlyProps: false,
              dependencies: [name],
              originalSchema: undefined,
              example: undefined,
              examples: undefined,
              key,
              contentType: '',
            },
          ] as ResReqTypesValue[];
        }

        const [contentType, mediaType] = firstEntry;

        const isFormData = formDataContentTypes.has(contentType);
        const isFormUrlEncoded = formUrlEncodedContentTypes.has(contentType);

        if ((!isFormData && !isFormUrlEncoded) || !mediaType.schema) {
          return [
            {
              value: name,
              imports: [{ name, schemaName }],
              schemas: [],
              type: 'unknown',
              isEnum: false,
              isRef: true,
              hasReadonlyProps: false,
              dependencies: [name],
              originalSchema: mediaType.schema,
              example: mediaType.example as unknown,
              examples: resolveExampleRefs(
                mediaType.examples as
                  | Record<string, OpenApiReferenceObject | { value?: unknown }>
                  | undefined,
                context,
              ),
              key,
              contentType,
            },
          ] as ResReqTypesValue[];
        }

        const formData = isFormData
          ? getSchemaFormDataAndUrlEncoded({
              name,
              schemaObject: mediaType.schema,
              context,
              isRequestBodyOptional: bodySchema.required !== true,
              isRef: true,
              encoding: mediaType.encoding,
            })
          : undefined;

        const formUrlEncoded = isFormUrlEncoded
          ? getSchemaFormDataAndUrlEncoded({
              name,
              schemaObject: mediaType.schema,
              context,
              isRequestBodyOptional: bodySchema.required !== true,
              isUrlEncoded: true,
              isRef: true,
              encoding: mediaType.encoding,
            })
          : undefined;

        const additionalImports = getFormDataAdditionalImports({
          schemaObject: mediaType.schema,
          context,
        });

        return [
          {
            value: name,
            imports: [{ name, schemaName }, ...additionalImports],
            schemas: [],
            type: 'unknown',
            isEnum: false,
            hasReadonlyProps: false,
            dependencies: [name],
            formData,
            formUrlEncoded,
            isRef: true,
            originalSchema: mediaType.schema,
            example: mediaType.example,
            examples: resolveExampleRefs(mediaType.examples, context),
            key,
            contentType,
          },
        ] as ResReqTypesValue[];
      }

      if (res.content) {
        const contents = Object.entries(res.content).map(
          ([contentType, mediaType], index, arr) => {
            let propName = key ? pascal(name) + pascal(key) : undefined;

            if (propName && arr.length > 1) {
              propName = propName + pascal(getNumberWord(index + 1));
            }

            const isFormData = formDataContentTypes.has(contentType);
            const isFormUrlEncoded =
              formUrlEncodedContentTypes.has(contentType);

            // When schema is a $ref, use schema name for consistent param naming
            let effectivePropName = propName;
            if (mediaType.schema && isReference(mediaType.schema)) {
              const { imports } = resolveRef<OpenApiSchemaObject>(
                mediaType.schema,
                context,
              );
              if (imports[0]?.name) {
                effectivePropName = imports[0].name;
              }
            } else if ((isFormData || isFormUrlEncoded) && mediaType.schema) {
              // For form-data and url-encoded, the param name is also the
              // runtime variable iterated by the FormData/URLSearchParams code.
              // Derive it from the inner DTO names so it matches the function
              // parameter (#3242). Scoped to these content types: forcing the
              // schema name elsewhere aliases the import to `Foo as __Foo` in
              // split mode and broke the MSW mock filter (#3269).
              const variants = getSchemaVariants(mediaType.schema);
              if (variants) {
                const names: string[] = [];
                for (const ref of variants) {
                  if (!isReference(ref)) continue;
                  const refName = resolveRef<OpenApiSchemaObject>(ref, context)
                    .imports[0]?.name;
                  if (refName) {
                    names.push(refName);
                  }
                }
                if (names.length > 0) {
                  effectivePropName = names.join('');
                }
              }
            }

            const resolvedValue = getResReqContentTypes({
              mediaType,
              propName: effectivePropName,
              context,
              isFormData,
              contentType,
            });

            if (!resolvedValue) {
              // openapi spec 3.1 allows describing binary responses with only a content type
              if (isBinaryContentType(contentType)) {
                return {
                  value: 'Blob',
                  imports: [],
                  schemas: [],
                  type: 'Blob',
                  isEnum: false,
                  key,
                  isRef: false,
                  hasReadonlyProps: false,
                  contentType,
                };
              }

              return;
            }

            if (
              (!isFormData && !isFormUrlEncoded) ||
              !effectivePropName ||
              !mediaType.schema
            ) {
              return {
                ...resolvedValue,
                imports: resolvedValue.imports,
                dependencies: resolvedValue.dependencies,
                contentType,
                example: mediaType.example,
                examples: resolveExampleRefs(mediaType.examples, context),
              };
            }

            const formData = isFormData
              ? getSchemaFormDataAndUrlEncoded({
                  name: effectivePropName,
                  schemaObject: mediaType.schema,
                  context,
                  isRequestBodyOptional: res.required !== true,
                  isRef: true,
                  encoding: mediaType.encoding,
                })
              : undefined;

            const formUrlEncoded = isFormUrlEncoded
              ? getSchemaFormDataAndUrlEncoded({
                  name: effectivePropName,
                  schemaObject: mediaType.schema,
                  context,
                  isUrlEncoded: true,
                  isRequestBodyOptional: res.required !== true,
                  isRef: true,
                  encoding: mediaType.encoding,
                })
              : undefined;

            const additionalImports = getFormDataAdditionalImports({
              schemaObject: mediaType.schema,
              context,
            });
            return {
              ...resolvedValue,
              imports: [...resolvedValue.imports, ...additionalImports],
              formData,
              formUrlEncoded,
              contentType,
              example: mediaType.example as unknown,
              examples: resolveExampleRefs(
                mediaType.examples as
                  | Record<string, OpenApiReferenceObject | { value?: unknown }>
                  | undefined,
                context,
              ),
            };
          },
        );

        return contents
          .filter(Boolean)
          .map((x) => ({ ...x, key })) as ResReqTypesValue[];
      }
      const swaggerSchema =
        'schema' in res
          ? (
              res as {
                schema?: OpenApiSchemaObject | OpenApiReferenceObject;
              }
            ).schema
          : undefined;

      if (swaggerSchema) {
        const propName = key ? pascal(name) + pascal(key) : undefined;
        const resolvedValue = resolveObject({
          schema: swaggerSchema,
          propName,
          context,
        });

        return [
          {
            ...resolvedValue,
            contentType: 'application/json',
            key,
          },
        ] as ResReqTypesValue[];
      }

      return [
        {
          value: defaultType,
          imports: [],
          schemas: [],
          type: defaultType,
          isEnum: false,
          dependencies: [],
          key,
          isRef: false,
          hasReadonlyProps: false,
          contentType: 'application/json',
        },
      ] as ResReqTypesValue[];
    });

  return uniqueBy(typesArray.flat(), uniqueKey);
}

/**
 * Response type categories for HTTP client response parsing.
 * Maps to Angular HttpClient's responseType, Axios responseType, and Fetch response methods.
 */
export type ResponseTypeCategory = 'json' | 'text' | 'blob' | 'arraybuffer';

/**
 * Determine the responseType option based on success content types only.
 * This avoids error-response content types influencing the responseType.
 */
export function getSuccessResponseType(
  response: GetterResponse,
): 'blob' | 'text' | undefined {
  const successContentTypes = response.types.success
    .map((t) => t.contentType)
    .filter(Boolean);

  if (response.isBlob) {
    return 'blob' as const;
  }

  const hasJsonResponse = successContentTypes.some(
    (contentType) =>
      contentType.includes('json') || contentType.includes('+json'),
  );
  const hasTextResponse = successContentTypes.some(
    (contentType) =>
      contentType.startsWith('text/') || contentType.includes('xml'),
  );

  if (!hasJsonResponse && hasTextResponse) {
    return 'text' as const;
  }

  return undefined;
}

/**
 * Determine the response type category for a given content type.
 * Used to set the correct responseType option in HTTP clients.
 *
 * @param contentType - The MIME content type (e.g., 'application/json', 'text/plain')
 * @returns The response type category to use for parsing
 */
export function getResponseTypeCategory(
  contentType: string,
): ResponseTypeCategory {
  // Binary types → blob
  if (isBinaryContentType(contentType)) {
    return 'blob';
  }

  // JSON types
  if (
    contentType === 'application/json' ||
    contentType.includes('+json') ||
    contentType.includes('-json')
  ) {
    return 'json';
  }

  // Everything else is text (text/*, application/xml, etc.)
  return 'text';
}

/**
 * Get the default content type from a list of content types.
 * Priority: application/json > any JSON-like type > first in list
 *
 * @param contentTypes - Array of content types from OpenAPI spec
 * @returns The default content type to use
 */
export function getDefaultContentType(contentTypes: string[]): string {
  if (contentTypes.length === 0) {
    return 'application/json';
  }

  // Prefer application/json
  if (contentTypes.includes('application/json')) {
    return 'application/json';
  }

  // Prefer any JSON-like type
  const jsonType = contentTypes.find(
    (ct) => ct.includes('+json') || ct.includes('-json'),
  );
  if (jsonType) {
    return jsonType;
  }

  // Default to first
  return contentTypes[0];
}
