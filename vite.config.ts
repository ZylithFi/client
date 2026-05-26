import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    historyApiFallback: true,
    proxy: {
      "/starknet-privacy-discovery": {
        target: "http://35.192.48.142:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/starknet-privacy-discovery/, ""),
      },
      "/starknet-privacy-prover": {
        target: "http://34.29.249.119:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/starknet-privacy-prover/, ""),
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
