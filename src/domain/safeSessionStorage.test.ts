import { describe, expect, it, vi } from "vitest";
import {
  localGetNullable,
  localRemove,
  localSet,
  sessionGet,
  sessionGetNullable,
  sessionRemove,
  sessionSet,
} from "./safeSessionStorage";

describe("safe session storage", () => {
  it("reads stored values and falls back for missing values", () => {
    sessionStorage.setItem("zylith.test.session", "stored");

    expect(sessionGet("zylith.test.session", "fallback")).toBe("stored");
    expect(sessionGetNullable("zylith.test.session")).toBe("stored");
    expect(sessionGet("zylith.test.missing", "fallback")).toBe("fallback");
    expect(sessionGetNullable("zylith.test.missing")).toBeNull();
  });

  it("writes and removes session values when storage is available", () => {
    sessionSet("zylith.test.write", "next");

    expect(sessionStorage.getItem("zylith.test.write")).toBe("next");
    sessionRemove("zylith.test.write");
    expect(sessionStorage.getItem("zylith.test.write")).toBeNull();
  });

  it("falls back when sessionStorage throws", () => {
    const getSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const setSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    expect(sessionGet("zylith.test.blocked", "fallback")).toBe("fallback");
    expect(sessionGetNullable("zylith.test.blocked")).toBeNull();
    expect(() => sessionSet("zylith.test.blocked", "value")).not.toThrow();
    expect(() => sessionRemove("zylith.test.blocked")).not.toThrow();

    getSpy.mockRestore();
    setSpy.mockRestore();
  });

  it("ignores localStorage remove errors", () => {
    const removeSpy = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });

    expect(() => localRemove("zylith.test.local")).not.toThrow();

    removeSpy.mockRestore();
  });

  it("reads and writes persistent convenience values", () => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
    localSet("zylith.test.local", "stored");
    expect(localGetNullable("zylith.test.local")).toBe("stored");
    localRemove("zylith.test.local");
    expect(localGetNullable("zylith.test.local")).toBeNull();
  });
});
