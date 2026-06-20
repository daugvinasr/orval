import { type GetterProps, GetterPropType } from '@orval/core';
import { describe, expect, it } from 'vitest';

import {
  getVueReactivity,
  normalizeQueryOptions,
  vueUnRefParams,
  vueWrapTypeWithMaybeRef,
} from './utils';

describe('normalizeQueryOptions', () => {
  it('should include useOperationIdAsQueryKey when provided', () => {
    const result = normalizeQueryOptions(
      { useOperationIdAsQueryKey: true },
      '/workspace',
    );
    expect(result.useOperationIdAsQueryKey).toBe(true);
  });

  it('should not include useOperationIdAsQueryKey when false', () => {
    const result = normalizeQueryOptions(
      { useOperationIdAsQueryKey: false },
      '/workspace',
    );
    expect(result.useOperationIdAsQueryKey).toBeUndefined();
  });

  it('should not include useOperationIdAsQueryKey when not provided', () => {
    const result = normalizeQueryOptions({}, '/workspace');
    expect(result.useOperationIdAsQueryKey).toBeUndefined();
  });
});

describe('getVueReactivity', () => {
  // The wrapper type and resolver must always move together: pairing
  // `MaybeRefOrGetter` with `unref` (which cannot resolve a getter) would
  // silently break reactive params, so this mapping is the single source of
  // truth both the type and the runtime call site derive from.
  it('uses MaybeRefOrGetter/toValue on Vue Query v5 (Vue 3.3+)', () => {
    expect(getVueReactivity(true)).toEqual({
      wrapper: 'MaybeRefOrGetter',
      resolve: 'toValue',
    });
  });

  it('uses MaybeRef/unref on pre-v5 targets', () => {
    expect(getVueReactivity(false)).toEqual({
      wrapper: 'MaybeRef',
      resolve: 'unref',
    });
  });
});

describe('vueWrapTypeWithMaybeRef', () => {
  const queryParam: GetterProps = [
    {
      name: 'params',
      definition: 'params: ListPetsParams',
      implementation: 'params: ListPetsParams',
      default: undefined,
      required: true,
      type: GetterPropType.QUERY_PARAM,
    },
  ];

  it('wraps params in MaybeRefOrGetter on v5', () => {
    expect(vueWrapTypeWithMaybeRef(queryParam, true)[0].implementation).toBe(
      'params: MaybeRefOrGetter<ListPetsParams>',
    );
  });

  it('wraps params in MaybeRef on pre-v5', () => {
    expect(vueWrapTypeWithMaybeRef(queryParam, false)[0].implementation).toBe(
      'params: MaybeRef<ListPetsParams>',
    );
  });

  it('preserves a default value while wrapping', () => {
    const withDefault: GetterProps = [
      {
        name: 'version',
        definition: 'version: number',
        implementation: 'version: number = 1',
        default: 1,
        required: false,
        type: GetterPropType.PARAM,
      },
    ];
    expect(
      vueWrapTypeWithMaybeRef(withDefault, true)[0].implementation,
    ).toMatch(/^version: MaybeRefOrGetter<number>\s*=\s*1$/);
  });
});

describe('vueUnRefParams', () => {
  const props: GetterProps = [
    {
      name: 'params',
      definition: 'params: ListPetsParams',
      implementation: 'params: ListPetsParams',
      default: undefined,
      required: true,
      type: GetterPropType.QUERY_PARAM,
    },
    {
      name: 'pathParams',
      definition: 'pathParams: { id: string }',
      implementation: 'pathParams: { id: string }',
      default: undefined,
      required: true,
      type: GetterPropType.NAMED_PATH_PARAMS,
      destructured: '{ id }',
      schema: { name: 'pathParams', model: '', imports: [] },
    },
  ];

  it('resolves params with toValue on v5 (supports getters)', () => {
    expect(vueUnRefParams(props, true)).toBe(
      'params = toValue(params);\nconst { id } = toValue(pathParams);',
    );
  });

  it('resolves params with unref on pre-v5', () => {
    expect(vueUnRefParams(props, false)).toBe(
      'params = unref(params);\nconst { id } = unref(pathParams);',
    );
  });
});
