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

  it("cannot expose hooks in a production build", () => {
    expect(
      e2eHooksEnabled({
        search: "?e2e",
        env: { DEV: false },
      }),
    ).toBe(false);
  });
});
