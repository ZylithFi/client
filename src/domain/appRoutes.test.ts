import { describe, expect, it } from "vitest";
import {
  takerPath,
  takerTabFromPath,
} from "./appRoutes";

describe("app routes", () => {
  it("maps taker paths to tabs", () => {
    expect(takerTabFromPath("/trade")).toBe("trade");
    expect(takerTabFromPath("/orders")).toBe("orders");
    expect(takerTabFromPath("/assets")).toBe("assets");
    expect(takerTabFromPath("/reports")).toBe("reports");
    expect(takerTabFromPath("/tca")).toBe("reports");
    expect(takerTabFromPath("/unknown")).toBe("trade");
  });

  it("normalizes canonical taker paths", () => {
    expect(takerPath("trade")).toBe("/trade");
    expect(takerPath("orders")).toBe("/orders");
    expect(takerPath("assets")).toBe("/assets");
    expect(takerPath("reports")).toBe("/tca");
  });
});
