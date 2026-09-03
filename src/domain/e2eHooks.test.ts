import { describe, expect, it } from "vitest";

import { e2eHooksEnabled } from "./e2eHooks";

describe("e2eHooksEnabled", () => {
  it("requires the e2e query flag", () => {
    expect(
      e2eHooksEnabled({ search: "", env: { DEV: true } }),
    ).toBe(false);
  });

  it("allows e2e hooks during dev runs", () => {
    expect(
      e2eHooksEnabled({ search: "?e2e", env: { DEV: true } }),
    ).toBe(true);
  });

  it("allows explicit e2e hook builds", () => {
    expect(
      e2eHooksEnabled({
        search: "?e2e",
        env: { DEV: false, VITE_ZYLITH_ENABLE_E2E_HOOKS: "1" },
      }),
    ).toBe(true);
  });

  it("keeps production builds closed by default", () => {
    expect(
      e2eHooksEnabled({ search: "?e2e", env: { DEV: false } }),
    ).toBe(false);
  });
});
