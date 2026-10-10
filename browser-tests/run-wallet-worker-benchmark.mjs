import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = process.env.CHROME_PATH
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const targetUrl = process.env.ZYLITH_WALLET_BROWSER_GATE_URL
  ?? "http://127.0.0.1:5173/browser-tests/wallet-worker-benchmark.html";
const debugPort = Number(process.env.ZYLITH_WALLET_BROWSER_DEBUG_PORT ?? "9333");
const timeoutMs = Number(process.env.ZYLITH_WALLET_BROWSER_TIMEOUT_MS ?? "180000");
const cpuThrottleRate = Number(process.env.ZYLITH_WALLET_BROWSER_CPU_THROTTLE ?? "1");
const profile = mkdtempSync(join(tmpdir(), "zylith-wallet-browser-gate-"));
const child = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--disable-background-networking",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const logs = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  for (const line of chunk.split("\n")) if (line.trim()) logs.push(line.trim());
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function json(path) {
  const response = await fetch(`http://127.0.0.1:${debugPort}${path}`);
  if (!response.ok) throw new Error(`Chrome DevTools endpoint failed: ${response.status}`);
  return response.json();
}

async function waitForPage() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const pages = await json("/json/list");
      const page = pages.find((candidate) => candidate.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // Chrome has not opened its DevTools endpoint yet.
    }
    await delay(50);
  }
  throw new Error("Chrome DevTools endpoint did not become ready");
}

async function runCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === "Log.entryAdded") logs.push(`browser: ${message.params.entry.text}`);
    if (message.method === "Runtime.exceptionThrown") {
      logs.push(`browser exception: ${message.params.exceptionDetails.text}`);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.enable");
  if (!Number.isFinite(cpuThrottleRate) || cpuThrottleRate < 1) {
    throw new Error("ZYLITH_WALLET_BROWSER_CPU_THROTTLE must be at least 1");
  }
  await call("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
  await call("Page.navigate", { url: targetUrl });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const title = await call("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    const value = title?.result?.value;
    if (value === "PASS" || value === "FAIL") {
      const body = await call("Runtime.evaluate", {
        expression: "document.querySelector('#result')?.textContent ?? ''",
        returnByValue: true,
      });
      socket.close();
      return JSON.parse(body.result.value);
    }
    await delay(50);
  }
  const progress = await call("Runtime.evaluate", {
    expression: "document.querySelector('#result')?.textContent ?? ''",
    returnByValue: true,
  });
  socket.close();
  throw new Error(`Wallet browser gate timed out: ${progress?.result?.value ?? "no progress"}`);
}

try {
  const page = await waitForPage();
  const result = await runCdp(page.webSocketDebuggerUrl);
  console.log(JSON.stringify({
    ...result,
    run_profile: {
      cpu_throttle_rate: cpuThrottleRate,
      timeout_ms: timeoutMs,
      target_url: targetUrl,
    },
    browser_logs: logs,
  }, null, 2));
  if (result.status !== "PASS") process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({
    status: "FAIL",
    error: error instanceof Error ? error.message : "unknown browser-runner failure",
    browser_logs: logs,
  }, null, 2));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(2_000),
  ]);
  rmSync(profile, { recursive: true, force: true });
}
