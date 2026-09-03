import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const LONG_RUNNING_SERVICE_TIMEOUT_MS = 15 * 60_000;
const e2eDisableHmr = process.env.ZYLITH_E2E_DISABLE_HMR === "1";
const apiProxyTarget = process.env.VITE_ZYLITH_API_PROXY_TARGET ?? "https://api.zylith.fi";
const coordinatorProxyTarget =
  process.env.VITE_ZYLITH_COORDINATOR_PROXY_TARGET ?? apiProxyTarget;
const proverProxyTarget = process.env.VITE_ZYLITH_PROVER_PROXY_TARGET ?? apiProxyTarget;
const indexerProxyTarget = process.env.VITE_ZYLITH_INDEXER_PROXY_TARGET ?? apiProxyTarget;
const paymasterProxyTarget = process.env.VITE_ZYLITH_PAYMASTER_PROXY_TARGET ?? apiProxyTarget;
const relayProxyTarget = process.env.VITE_ZYLITH_RELAY_PROXY_TARGET ?? apiProxyTarget;
const privacyProxyTarget = process.env.VITE_ZYLITH_PRIVACY_PROXY_TARGET ?? apiProxyTarget;
const starknetRpcProxyTarget =
  process.env.VITE_ZYLITH_STARKNET_RPC_PROXY_TARGET ?? apiProxyTarget;
const hostedProxyOrigin = process.env.VITE_ZYLITH_HOSTED_PROXY_ORIGIN;

function localServiceRewrite(servicePath: string, target: string) {
  if (!isLocalProxyTarget(target)) return undefined;
  return (path: string) => path.replace(new RegExp(`^${servicePath}`), "");
}

function isLocalProxyTarget(target: string) {
  try {
    const { hostname } = new URL(target);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}

function hostedProxyHeaders(target: string) {
  if (!hostedProxyOrigin || isLocalProxyTarget(target)) return undefined;
  return {
    origin: hostedProxyOrigin,
    referer: hostedProxyOrigin.endsWith("/") ? hostedProxyOrigin : `${hostedProxyOrigin}/`,
  };
}

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/@starkware-libs/starknet-privacy-sdk/")) {
            return "starknet-privacy";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    hmr: e2eDisableHmr ? false : undefined,
    historyApiFallback: true,
    watch: e2eDisableHmr
      ? { ignored: ["**/*"] }
      : {
          ignored: ["**/test-artifacts/**", "**/runbooks/**", "**/docs/**"],
        },
    proxy: {
      "/coordinator": {
        target: coordinatorProxyTarget,
        changeOrigin: true,
        rewrite: localServiceRewrite("/coordinator", coordinatorProxyTarget),
        timeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
        proxyTimeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
      },
      "/prover": {
        target: proverProxyTarget,
        changeOrigin: true,
        rewrite: localServiceRewrite("/prover", proverProxyTarget),
        timeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
        proxyTimeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
      },
      "/indexer": {
        target: indexerProxyTarget,
        changeOrigin: true,
        rewrite: localServiceRewrite("/indexer", indexerProxyTarget),
        timeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
        proxyTimeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
      },
      "/paymaster": {
        target: paymasterProxyTarget,
        changeOrigin: true,
        rewrite: localServiceRewrite("/paymaster", paymasterProxyTarget),
        headers: hostedProxyHeaders(paymasterProxyTarget),
        timeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
        proxyTimeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
      },
      "/relay": {
        target: relayProxyTarget,
        changeOrigin: true,
        rewrite: localServiceRewrite("/relay", relayProxyTarget),
        timeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
        proxyTimeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
      },
      "/starknet-privacy-discovery": {
        target: privacyProxyTarget,
        changeOrigin: true,
        headers: hostedProxyHeaders(privacyProxyTarget),
        timeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
        proxyTimeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
      },
      "/starknet-privacy-prover": {
        target: privacyProxyTarget,
        changeOrigin: true,
        headers: hostedProxyHeaders(privacyProxyTarget),
        timeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
        proxyTimeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
      },
      "/starknet-rpc": {
        target: starknetRpcProxyTarget,
        changeOrigin: true,
        rewrite: localServiceRewrite("/starknet-rpc", starknetRpcProxyTarget),
        timeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
        proxyTimeout: LONG_RUNNING_SERVICE_TIMEOUT_MS,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
