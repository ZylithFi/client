type E2eHookEnv = {
  DEV?: boolean;
  VITE_ZYLITH_ENABLE_E2E_HOOKS?: string;
};

export function e2eHooksEnabled(input: {
  search?: string;
  env?: E2eHookEnv;
} = {}) {
  const env = input.env ?? import.meta.env;
  if (
    env.DEV !== true &&
    env.VITE_ZYLITH_ENABLE_E2E_HOOKS !== "1"
  ) {
    return false;
  }
  const search =
    input.search ??
    (typeof window !== "undefined" ? window.location.search : "");
  return new URLSearchParams(search).has("e2e");
}
