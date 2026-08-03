import { describe, expect, it } from 'vitest';

import type {
  ContextSpec,
  OpenApiRequestBodyObject,
  OpenApiSchemaObject,
} from '../types';
import { getResReqTypes } from './res-req-types';

const context = {
  output: {
    override: {
      formData: { arrayHandling: 'serialize', disabled: false },
      enumGenerationType: 'const',
      namingConvention: {},
      components: {
        schemas: { suffix: '', itemSuffix: 'Item' },
        responses: { suffix: '' },
        parameters: { suffix: '' },
        requestBodies: { suffix: 'RequestBody' },
      },
    },
  },
  target: 'spec',
  workspace: '',
  spec: {
    components: { schemas: {} },
  },
} as unknown as ContextSpec;

describe('form-data body serialization', () => {
  describe("x-www-form-urlencoded with encoding.style: 'deepObject' (#3798)", () => {
    /** Declares `style: deepObject` on `encodedProperties`, `metadata` by default. */
    const deepObjectReqBody = (
      properties: Record<string, OpenApiSchemaObject>,
      required?: string[],
      encodedProperties: string[] = ['metadata'],
    ): [string, OpenApiRequestBodyObject][] => [
      [
        'requestBody',
        {
          content: {
            'application/x-www-form-urlencoded': {
              schema: { type: 'object', properties, required },
              encoding: Object.fromEntries(
                encodedProperties.map((key) => [
                  key,
                  { style: 'deepObject', explode: true },
                ]),
              ),
            },
          },
          required: true,
        },
      ],
    ];

    it('emits bracketed paths while preserving other fields', () => {
      const result = getResReqTypes(
        deepObjectReqBody(
          {
            metadata: {
              type: 'object',
              properties: {
                shipping: {
                  type: 'object',
                  properties: { city: { type: 'string' } },
                },
                lines: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { sku: { type: 'string' } },
                  },
                },
              },
            },
            untouched: {
              type: 'object',
              properties: { foo: { type: 'string' } },
            },
          },
          ['metadata'],
        ),
        'Account',
        context,
      )[0];

      expect(result.formUrlEncoded).toContain(
        'formUrlEncoded.append(`metadata[shipping][city]`',
      );
      expect(result.formUrlEncoded).toMatch(
        /append\(`metadata\[lines]\[\$\{index\d*}]\[sku]`/,
      );
      expect(result.formUrlEncoded).toContain(
        'formUrlEncoded.append(`untouched`, JSON.stringify(accountRequestBody.untouched))',
      );
    });

    it('preserves additional properties alongside declared properties', () => {
      const result = getResReqTypes(
        deepObjectReqBody(
          {
            metadata: {
              type: 'object',
              properties: { fixed: { type: 'string' } },
              additionalProperties: { type: 'string' },
            },
          },
          ['metadata'],
        ),
        'Account',
        context,
      )[0];

      expect(result.formUrlEncoded).toContain(
        'formUrlEncoded.append(`metadata[fixed]`, accountRequestBody.metadata.fixed)',
      );
      expect(result.formUrlEncoded).toContain('if (["fixed"].includes(key))');
      expect(result.formUrlEncoded).toContain('`metadata[${key}]`');
    });

    it('indexes array values of additional properties instead of stringifying them', () => {
      const result = getResReqTypes(
        deepObjectReqBody(
          {
            metadata: {
              type: 'object',
              additionalProperties: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
          ['metadata'],
        ),
        'Account',
        context,
      )[0];

      expect(result.formUrlEncoded).toMatch(
        /`metadata\[\$\{key}]\[\$\{index\d*}]`/,
      );
      expect(result.formUrlEncoded).not.toContain(
        'JSON.stringify(accountRequestBody.metadata)',
      );
    });

    it('expands a declared additionalProperties object value instead of stringifying it', () => {
      const result = getResReqTypes(
        deepObjectReqBody(
          {
            attributes: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                  express: { type: 'boolean' },
                },
              },
            },
          },
          ['attributes'],
          ['attributes'],
        ),
        'Account',
        context,
      )[0];

      expect(result.formUrlEncoded).toContain(
        'formUrlEncoded.append(`attributes[${key}][city]`, entryValue.city)',
      );
      expect(result.formUrlEncoded).toContain(
        'formUrlEncoded.append(`attributes[${key}][express]`, entryValue.express.toString())',
      );
      expect(result.formUrlEncoded).not.toContain('JSON.stringify');
    });

    it('sweeps values generically only when their shape is undeclared', () => {
      const result = getResReqTypes(
        deepObjectReqBody(
          { attributes: { type: 'object', additionalProperties: true } },
          ['attributes'],
          ['attributes'],
        ),
        'Account',
        context,
      )[0];

      expect(result.formUrlEncoded).toContain("typeof value === 'object'");
      expect(result.formUrlEncoded).toContain('`attributes[${key}]`');
    });

    it('leaves array properties alone — deepObject only expands objects', () => {
      const result = getResReqTypes(
        deepObjectReqBody(
          { tags: { type: 'array', items: { type: 'string' } } },
          ['tags'],
          ['tags'],
        ),
        'Account',
        context,
      )[0];

      expect(result.formUrlEncoded).toContain(
        'accountRequestBody.tags.forEach(value => formUrlEncoded.append(`tags`, value))',
      );
    });

    it('expands a nested object rather than letting a numeric oneOf clobber it', () => {
      const result = getResReqTypes(
        deepObjectReqBody(
          {
            metadata: {
              type: 'object',
              properties: { count: { type: 'integer' } },
              oneOf: [{ type: 'integer' }, { type: 'object' }],
            },
          },
          ['metadata'],
        ),
        'Account',
        context,
      )[0];

      expect(result.formUrlEncoded).toContain(
        'formUrlEncoded.append(`metadata[count]`, accountRequestBody.metadata.count.toString())',
      );
      expect(result.formUrlEncoded).not.toContain(
        'accountRequestBody.metadata.toString()',
      );
    });

    it('ignores deepObject encoding for multipart bodies', () => {
      const result = getResReqTypes(
        [
          [
            'requestBody',
            {
              content: {
                'multipart/form-data': {
                  schema: {
                    type: 'object',
                    required: ['metadata'],
                    properties: {
                      metadata: {
                        type: 'object',
                        properties: { order_id: { type: 'string' } },
                      },
                    },
                  },
                  encoding: {
                    metadata: { style: 'deepObject', explode: true },
                  },
                },
              },
              required: true,
            },
          ],
        ],
        'Account',
        context,
      )[0];

      expect(result.formData).toContain(
        'formData.append(`metadata`, JSON.stringify(accountRequestBody.metadata))',
      );
    });
  });

  describe('arrays of arrays', () => {
    const matrixReqBody = (
      contentType: string,
    ): [string, OpenApiRequestBodyObject][] => [
      [
        'requestBody',
        {
          content: {
            [contentType]: {
              schema: {
                type: 'object',
                required: ['matrix'],
                properties: {
                  matrix: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
          required: true,
        },
      ],
    ];

    // An inner array has no key of its own to expand under, so it stays JSON
    // rather than recursing into a schema with no properties — which used to
    // emit an empty `forEach` and drop the field entirely.
    it.each([
      ['serialize', 'matrix`'],
      ['explode', 'matrix[${index}]`'],
    ])(
      'keeps inner arrays as JSON with arrayHandling %s',
      (arrayHandling, expectedKey) => {
        const result = getResReqTypes(
          matrixReqBody('multipart/form-data'),
          'Body',
          {
            ...context,
            output: {
              ...context.output,
              override: {
                ...context.output.override,
                formData: { arrayHandling, disabled: false },
              },
            },
          } as unknown as ContextSpec,
        )[0];

        expect(result.formData).toContain(
          `formData.append(\`${expectedKey}, JSON.stringify(value))`,
        );
        expect(result.formData).not.toMatch(/=>\s*\{\s*\}\)/);
      },
    );
  });
});
