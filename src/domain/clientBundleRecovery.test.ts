import { describe, expect, it, vi } from "vitest";
import {
  isStaleClientBundleError,
  reloadStaleClientBundle,
} from "./clientBundleRecovery";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("client bundle recovery", () => {
  it("recognizes stale lazy-chunk failures without treating ordinary network errors as bundle drift", () => {
    expect(isStaleClientBundleError(new TypeError("Failed to fetch dynamically imported module: /assets/runtime-old.js"))).toBe(true);
    expect(isStaleClientBundleError("Importing a module script failed.")).toBe(true);
    expect(isStaleClientBundleError(new Error("Network request failed"))).toBe(false);
  });

  it("reloads once inside the recovery window and permits a later independent recovery", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadStaleClientBundle(storage, reload, 10_000)).toBe(true);
    expect(reloadStaleClientBundle(storage, reload, 20_000)).toBe(false);
    expect(reloadStaleClientBundle(storage, reload, 70_001)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("fails safely when browser storage is unavailable", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(reloadStaleClientBundle(storage, vi.fn(), 10_000)).toBe(false);
  });
});
