import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { oversizedBundles } from "./check-bundle-budget.mjs";

test("bundle budget reports only oversized javascript assets", () => {
  const directory = mkdtempSync(join(tmpdir(), "zylith-bundles-"));
  try {
    writeFileSync(join(directory, "small.js"), "1234");
    writeFileSync(join(directory, "large.js"), "123456");
    writeFileSync(join(directory, "large.css"), "123456");
    assert.deepEqual(oversizedBundles(directory, 5), [{ file: "large.js", bytes: 6 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("production csp permits wallet wasm without enabling javascript eval", () => {
  const config = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  );
  const headers = config.headers.flatMap((entry) => entry.headers);
  const csp = headers.find(
    (header) => header.key.toLowerCase() === "content-security-policy",
  )?.value;

  assert.match(csp, /script-src[^;]*'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /script-src[^;]*\s'unsafe-eval'(?:\s|;|$)/);
});
