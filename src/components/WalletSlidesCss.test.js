import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const globalStyles = readFileSync(
  resolve(process.cwd(), "src/globals.css"),
  "utf8"
);

describe("wallet slide styles", () => {
  it("keeps focused amount inputs out of the slide panel selector", () => {
    expect(globalStyles).toMatch(
      /\.f-input:focus-visible,\s*\.f-input-box :is\(input, select, textarea\):focus-visible \{ outline: 0; \}/
    );
    expect(globalStyles).not.toMatch(
      /\.f-input-box :is\(input, select, textarea\):focus-visible,\s*\.slide-panel/
    );
  });
});
