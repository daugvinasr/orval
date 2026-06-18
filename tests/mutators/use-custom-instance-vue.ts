import Axios, { type AxiosRequestConfig } from 'axios';

export const AXIOS_INSTANCE = Axios.create({ baseURL: '' });

// Hook-style mutator: the `use` prefix + zero arguments make orval treat this as
// a hook, so generated operations are wrapped in a `useXxxHook` composable. This
// exercises the Vue `isHook` request-function path, which resolves its reactive
// params in the function body (rather than relying on the axios config to do it).
export const useCustomInstance = <T>(): ((
  config: AxiosRequestConfig,
) => Promise<T>) => {
  return (config: AxiosRequestConfig) =>
    AXIOS_INSTANCE({ ...config }).then(({ data }) => data);
};

export default useCustomInstance;
