import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";

const walletStorageLockTails = new Map<string, Promise<void>>();

Object.defineProperty(globalThis.navigator, "locks", {
  configurable: true,
  value: {
    async request<T>(
      name: string,
      _options: { mode: "exclusive" },
      callback: () => Promise<T> | T,
    ): Promise<T> {
      const prior = walletStorageLockTails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolve) => { release = resolve; });
      const queued = prior.then(() => tail);
      walletStorageLockTails.set(name, queued);
      await prior;
      try {
        return await callback();
      } finally {
        release();
        if (walletStorageLockTails.get(name) === queued) walletStorageLockTails.delete(name);
      }
    },
  },
});
import deployment from "../../public/deployment.example.json";
import { configureAssetDecimals } from "../domain/assets";
import type { DeploymentConfig } from "../domain/deployment";

beforeEach(() => configureAssetDecimals(deployment as unknown as DeploymentConfig));
