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
  assert.match(csp, /worker-src 'self'(?:;|$)/);
  assert.doesNotMatch(csp, /worker-src[^;]*(?:blob:|data:|https?:)/);
  assert.match(csp, /require-trusted-types-for 'script'/);
  assert.match(csp, /trusted-types zylith-wallet-worker(?:;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*(?:https?:|data:|blob:|'unsafe-inline')/);
});

test("wallet worker creation is module-only and routed through the same-origin policy", () => {
  const client = readFileSync(
    new URL("../src/domain/walletCryptoClient.ts", import.meta.url),
    "utf8",
  );
  const policy = readFileSync(
    new URL("../src/domain/walletWorkerScriptUrl.ts", import.meta.url),
    "utf8",
  );

  assert.match(client, /walletWorkerScriptUrl\(/);
  assert.match(client, /walletCrypto\.worker\.ts\?worker&url/);
  assert.match(client, /type:\s*"module"/);
  assert.match(policy, /createPolicy\("zylith-wallet-worker"/);
  assert.match(policy, /candidate\.origin !== globalThis\.location\.origin/);
  assert.match(policy, /candidate !== walletWorkerSourceUrl/);
  assert.doesNotMatch(policy, /blob:|data:/);
});

test("production and browser-gate entrypoints load no third-party scripts", () => {
  for (const relative of ["../index.html", "../browser-tests/wallet-worker-benchmark.html"]) {
    const html = readFileSync(new URL(relative, import.meta.url), "utf8");
    const sources = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
      .map((match) => match[1]);
    assert.ok(sources.length > 0, `${relative} must contain a script entrypoint`);
    for (const source of sources) {
      assert.doesNotMatch(source, /^(?:https?:)?\/\//i);
      assert.doesNotMatch(source, /^(?:data|blob):/i);
    }
  }
});
