import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_TRUSTED_TYPES = Object.getOwnPropertyDescriptor(globalThis, "trustedTypes");

async function loadSubject() {
  vi.resetModules();
  return import("./walletWorkerScriptUrl");
}

afterEach(() => {
  if (ORIGINAL_TRUSTED_TYPES) {
    Object.defineProperty(globalThis, "trustedTypes", ORIGINAL_TRUSTED_TYPES);
  } else {
    Reflect.deleteProperty(globalThis, "trustedTypes");
  }
  vi.restoreAllMocks();
});

describe("wallet worker Trusted Types URL", () => {
  it("returns an ordinary same-origin URL when Trusted Types is unavailable", async () => {
    Reflect.deleteProperty(globalThis, "trustedTypes");
    const { walletWorkerScriptUrl } = await loadSubject();

    const result = walletWorkerScriptUrl(new URL("/assets/wallet-worker.js", location.href));

    expect(result).toBeInstanceOf(URL);
    expect((result as URL).origin).toBe(location.origin);
  });

  it("uses one named policy and validates every script URL", async () => {
    const createScriptURL = vi.fn((input: string) => ({ trustedScriptUrl: input }));
    const createPolicy = vi.fn((name: string, rules: { createScriptURL(input: string): string }) => {
      expect(name).toBe("zylith-wallet-worker");
      expect(rules.createScriptURL("/assets/wallet-worker.js")).toBe(
        new URL("/assets/wallet-worker.js", location.href).href,
      );
      expect(() => rules.createScriptURL("/assets/another-worker.js")).toThrow("pinned asset");
      expect(() => rules.createScriptURL("https://attacker.invalid/worker.js")).toThrow(
        "same-origin",
      );
      expect(() => rules.createScriptURL("data:text/javascript,postMessage(1)")).toThrow(
        "same-origin",
      );
      expect(() => rules.createScriptURL(`blob:${location.origin}/worker-id`)).toThrow(
        "HTTP(S)",
      );
      return { createScriptURL };
    });
    Object.defineProperty(globalThis, "trustedTypes", {
      configurable: true,
      value: { createPolicy },
    });
    const { walletWorkerScriptUrl } = await loadSubject();
    const source = new URL("/assets/wallet-worker.js", location.href);

    expect(walletWorkerScriptUrl(source)).toEqual({ trustedScriptUrl: source.href });
    expect(walletWorkerScriptUrl(source)).toEqual({ trustedScriptUrl: source.href });
    expect(createPolicy).toHaveBeenCalledTimes(1);
    expect(createScriptURL).toHaveBeenCalledTimes(2);
  });

  it("pins the first compiled worker asset for the lifetime of the module", async () => {
    const createPolicy = vi.fn((_name: string, rules: { createScriptURL(input: string): string }) => ({
      createScriptURL: rules.createScriptURL,
    }));
    Object.defineProperty(globalThis, "trustedTypes", {
      configurable: true,
      value: { createPolicy },
    });
    const { walletWorkerScriptUrl } = await loadSubject();

    walletWorkerScriptUrl(new URL("/assets/wallet-worker.js", location.href));
    expect(() => walletWorkerScriptUrl(
      new URL("/assets/another-worker.js", location.href),
    )).toThrow("pinned asset");
    expect(createPolicy).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-origin source before consulting Trusted Types", async () => {
    const createPolicy = vi.fn();
    Object.defineProperty(globalThis, "trustedTypes", {
      configurable: true,
      value: { createPolicy },
    });
    const { walletWorkerScriptUrl } = await loadSubject();

    expect(() => walletWorkerScriptUrl(new URL("https://attacker.invalid/worker.js"))).toThrow(
      "same-origin",
    );
    expect(createPolicy).not.toHaveBeenCalled();
  });
});
