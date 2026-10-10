import { describe, expect, it } from "vitest";
import {
  createBrowserWalletStorageLockManager,
  walletStorageLockName,
} from "./walletStorageLock";

describe("wallet storage lock", () => {
  it("uses one bounded versioned namespace for exact record kinds", () => {
    expect(walletStorageLockName("device-session", "0xabc")).toBe(
      "zylith-wallet-storage:v1:device-session:0xabc",
    );
    expect(walletStorageLockName("signature-vault", "0xabc")).toBe(
      "zylith-wallet-storage:v1:signature-vault:0xabc",
    );
    expect(() => walletStorageLockName("device-session", `0x${"a".repeat(200)}`)).toThrow(
      "invalid wallet storage lock name",
    );
  });

  it("requests an exclusive browser lock and returns only the callback result", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
    const seen: Array<{ name: string; mode: string }> = [];
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: {
        async request<T>(
          name: string,
          options: { mode: "exclusive" },
          callback: () => Promise<T> | T,
        ): Promise<T> {
          seen.push({ name, mode: options.mode });
          return callback();
        },
      },
    });
    try {
      await expect(
        createBrowserWalletStorageLockManager().requestExclusive("bounded", async () => 7),
      ).resolves.toBe(7);
      expect(seen).toEqual([{ name: "bounded", mode: "exclusive" }]);
    } finally {
      if (descriptor) Object.defineProperty(globalThis.navigator, "locks", descriptor);
      else Reflect.deleteProperty(globalThis.navigator, "locks");
    }
  });

  it("fails closed before mutation when Web Locks are unavailable or reject", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "locks");
    const callback = () => {
      throw new Error("callback must not run");
    };
    try {
      Object.defineProperty(globalThis.navigator, "locks", {
        configurable: true,
        value: undefined,
      });
      await expect(
        createBrowserWalletStorageLockManager().requestExclusive("bounded", callback),
      ).rejects.toThrow("wallet storage lock is unavailable");

      Object.defineProperty(globalThis.navigator, "locks", {
        configurable: true,
        value: {
          request: async () => { throw new Error("raw browser lock detail"); },
        },
      });
      await expect(
        createBrowserWalletStorageLockManager().requestExclusive("bounded", callback),
      ).rejects.toThrow("raw browser lock detail");
    } finally {
      if (descriptor) Object.defineProperty(globalThis.navigator, "locks", descriptor);
      else Reflect.deleteProperty(globalThis.navigator, "locks");
    }
  });
});
