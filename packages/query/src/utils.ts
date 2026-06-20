import nodePath from 'node:path';
import { styleText } from 'node:util';

import {
  type GetterProps,
  GetterPropType,
  isObject,
  isString,
  type Mutator,
  type NormalizedMutator,
  type NormalizedQueryOptions,
  type QueryOptions,
} from '@orval/core';

export const normalizeQueryOptions = (
  queryOptions: QueryOptions = {},
  outputWorkspace: string,
): NormalizedQueryOptions => {
  return {
    ...(queryOptions.usePrefetch ? { usePrefetch: true } : {}),
    ...(queryOptions.useInvalidate ? { useInvalidate: true } : {}),
    ...(queryOptions.useSetQueryData ? { useSetQueryData: true } : {}),
    ...(queryOptions.useGetQueryData ? { useGetQueryData: true } : {}),
    // Preserve explicit `false` so the toggles aren't silent no-ops (#2376).
    ...(queryOptions.useQuery === undefined
      ? {}
      : { useQuery: queryOptions.useQuery }),
    ...(queryOptions.useMutation === undefined
      ? {}
      : { useMutation: queryOptions.useMutation }),
    ...(queryOptions.useSuspenseQuery ? { useSuspenseQuery: true } : {}),
    ...(queryOptions.useSuspenseInfiniteQuery
      ? { useSuspenseInfiniteQuery: true }
      : {}),
    ...(queryOptions.useInfinite ? { useInfinite: true } : {}),
    ...(queryOptions.useInfiniteQueryParam
      ? { useInfiniteQueryParam: queryOptions.useInfiniteQueryParam }
      : {}),
    ...(queryOptions.options ? { options: queryOptions.options } : {}),
    ...(queryOptions.queryKey
      ? {
          queryKey: normalizeMutator(outputWorkspace, queryOptions.queryKey),
        }
      : {}),
    ...(queryOptions.queryOptions
      ? {
          queryOptions: normalizeMutator(
            outputWorkspace,
            queryOptions.queryOptions,
          ),
        }
      : {}),
    ...(queryOptions.mutationOptions
      ? {
          mutationOptions: normalizeMutator(
            outputWorkspace,
            queryOptions.mutationOptions,
          ),
        }
      : {}),
    ...(queryOptions.signal ? { signal: true } : {}),
    ...(queryOptions.shouldExportMutatorHooks
      ? { shouldExportMutatorHooks: true }
      : {}),
    ...(queryOptions.shouldExportQueryKey
      ? { shouldExportQueryKey: true }
      : {}),
    ...(queryOptions.shouldFilterQueryKey
      ? { shouldFilterQueryKey: true }
      : {}),
    ...(queryOptions.queryKeyFilter
      ? { queryKeyFilter: queryOptions.queryKeyFilter }
      : {}),
    ...(queryOptions.shouldExportHttpClient
      ? { shouldExportHttpClient: true }
      : {}),
    ...(queryOptions.shouldSplitQueryKey ? { shouldSplitQueryKey: true } : {}),
    ...(queryOptions.useOperationIdAsQueryKey
      ? { useOperationIdAsQueryKey: true }
      : {}),
  };
};

// Temporary duplicate code before next major release
const normalizeMutator = (
  workspace: string,
  mutator?: Mutator,
): NormalizedMutator | undefined => {
  if (isObject(mutator)) {
    const m = mutator as Exclude<Mutator, string>;
    if (!m.path) {
      throw new Error(styleText('red', `Mutator need a path`));
    }

    return {
      path: nodePath.resolve(workspace, m.path),
      name: m.name,
      default: m.default ?? !m.name,
      alias: m.alias,
      external: m.external,
      extension: m.extension,
    };
  }

  if (isString(mutator)) {
    return {
      path: nodePath.resolve(workspace, mutator),
      default: true,
    };
  }

  return undefined;
};

/**
 * Vue Query v5 requires Vue 3.3+, where `MaybeRefOrGetter<T>` (a superset of
 * `MaybeRef<T>` that also accepts `() => T` getters) and `toValue()` exist.
 */
export interface VueReactivity {
  wrapper: 'MaybeRef' | 'MaybeRefOrGetter';
  resolve: 'unref' | 'toValue';
}

export const getVueReactivity = (hasQueryV5: boolean): VueReactivity =>
  hasQueryV5
    ? { wrapper: 'MaybeRefOrGetter', resolve: 'toValue' }
    : { wrapper: 'MaybeRef', resolve: 'unref' };

export function vueWrapTypeWithMaybeRef(
  props: GetterProps,
  hasQueryV5: boolean,
): GetterProps {
  const { wrapper } = getVueReactivity(hasQueryV5);
  return props.map((prop) => {
    const [paramName, paramType] = prop.implementation.split(':');
    if (!paramType) return prop;
    const name =
      prop.type === GetterPropType.NAMED_PATH_PARAMS ? prop.name : paramName;

    const [type, defaultValue] = paramType.split('=');
    return {
      ...prop,
      implementation: `${name}: ${wrapper}<${type.trim()}>${
        defaultValue ? ` = ${defaultValue}` : ''
      }`,
    };
  });
}

export const vueUnRefParams = (
  props: GetterProps,
  hasQueryV5: boolean,
): string => {
  const { resolve } = getVueReactivity(hasQueryV5);
  return props
    .map((prop) => {
      if (prop.type === GetterPropType.NAMED_PATH_PARAMS) {
        return `const ${prop.destructured} = ${resolve}(${prop.name});`;
      }
      return `${prop.name} = ${resolve}(${prop.name});`;
    })
    .join('\n');
};

export const getQueryTypeForFramework = (type: string): string => {
  // Angular Query and Svelte Query don't have suspense variants, map them to regular queries
  switch (type) {
    case 'suspenseQuery': {
      return 'query';
    }
    case 'suspenseInfiniteQuery': {
      return 'infiniteQuery';
    }
    default: {
      return type;
    }
  }
};

export const getHasSignal = ({
  overrideQuerySignal = false,
}: {
  overrideQuerySignal?: boolean;
}) => overrideQuerySignal;
