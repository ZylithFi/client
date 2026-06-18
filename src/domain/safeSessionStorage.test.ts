import { describe, expect, it, vi } from "vitest";
import {
  localRemove,
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
});
