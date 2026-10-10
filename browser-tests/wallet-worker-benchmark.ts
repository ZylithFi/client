import { createWalletCryptoClient } from "../src/domain/walletCryptoClient";

const CHAIN_ID = "0x534e5f5345504f4c4941";
const DEPLOYMENT_ID = "0x123";
const X25519_PUBLIC_KEY = "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a";
const HPKE_PROFILE = "DHKEM(X25519,HKDF-SHA256)/HKDF-SHA256/ChaCha20Poly1305/base";
const resultElement = document.querySelector<HTMLPreElement>("#result");
const workerDiagnostics: string[] = [];
const workerLaunches: Array<{ url: string; type: WorkerType | "classic"; name: string }> = [];
const benchmarkStartedAt = performance.now();
const NativeWorker = Worker;
(globalThis as typeof globalThis & { Worker: typeof Worker }).Worker = class extends NativeWorker {
  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    workerLaunches.push({
      url: new URL(String(scriptURL), location.href).href,
      type: options?.type ?? "classic",
      name: options?.name ?? "",
    });
    super(scriptURL, options);
    this.addEventListener("error", (event) => {
      workerDiagnostics.push(`${event.message} at ${event.filename}:${event.lineno}:${event.colno}`);
    });
    this.addEventListener("messageerror", () => workerDiagnostics.push("worker messageerror"));
  }
};

async function inspectDeviceKeys() {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("zylith-wallet-device-sessions-v3", 1);
    request.onerror = () => reject(request.error ?? new Error("device-key inspection failed"));
    request.onblocked = () => reject(new Error("device-key inspection blocked"));
    request.onsuccess = () => resolve(request.result);
  });
  try {
    const entries = await new Promise<unknown[]>((resolve, reject) => {
      const transaction = database.transaction("owned-keys", "readonly");
      const request = transaction.objectStore("owned-keys").getAll();
      let result: unknown[] | null = null;
      request.onerror = () => reject(request.error ?? new Error("device-key inspection failed"));
      request.onsuccess = () => { result = request.result; };
      transaction.onabort = () => reject(
        transaction.error ?? new Error("device-key inspection aborted"),
      );
      transaction.onerror = () => reject(
        transaction.error ?? new Error("device-key inspection failed"),
      );
      transaction.oncomplete = () => {
        if (result === null) reject(new Error("device-key inspection completed without a result"));
        else resolve(result);
      };
    });
    return entries.map((entry) => {
      if (!entry || typeof entry !== "object" || !("key" in entry)) {
        throw new Error("device-key entry shape is invalid");
      }
      const key = (entry as { key: unknown }).key;
      if (!(key instanceof CryptoKey)) throw new Error("device-key entry does not contain a CryptoKey");
      return {
        extractable: key.extractable,
        algorithm: key.algorithm.name,
        usages: [...key.usages].sort(),
      };
    });
  } finally {
    database.close();
  }
}

function context() {
  return {
    walletAddress: "0xabc",
    chainId: CHAIN_ID,
    deploymentId: DEPLOYMENT_ID,
    vaultDeploymentId: "0x456",
    origin: location.origin,
    manifestIdentity: `sha256:${"ab".repeat(32)}`,
    manifestVersion: "1",
    expiresAtMs: Date.now() + 10 * 60_000,
  };
}

function reportPhase(phase: string, completed = 0, total = 0) {
  if (!resultElement) return;
  resultElement.textContent = JSON.stringify({
    status: "RUNNING",
    phase,
    completed,
    total,
    elapsed_ms: Number((performance.now() - benchmarkStartedAt).toFixed(3)),
    worker_diagnostics: workerDiagnostics,
  }, null, 2);
}

function percentile(samples: number[], fraction: number) {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(3));
}

function distribution(samples: number[]) {
  return {
    count: samples.length,
    min_ms: Number(Math.min(...samples).toFixed(3)),
    p50_ms: percentile(samples, 0.5),
    p95_ms: percentile(samples, 0.95),
    p99_ms: percentile(samples, 0.99),
    max_ms: Number(Math.max(...samples).toFixed(3)),
  };
}

async function measured(operation: () => Promise<unknown>) {
  const started = performance.now();
  await operation();
  return performance.now() - started;
}

async function run() {
  const coldSamples: number[] = [];
  let firstSeedDetached = false;
  reportPhase("cold-worker", 0, 8);
  for (let index = 0; index < 8; index += 1) {
    const client = createWalletCryptoClient();
    const seed = new Uint8Array(32).fill(index + 1);
    const duration = await measured(async () => {
      await client.unlock(seed, context());
      await client.publicConfig();
    });
    if (index === 0) firstSeedDetached = seed.buffer.byteLength === 0;
    coldSamples.push(duration);
    client.dispose();
    reportPhase("cold-worker", index + 1, 8);
  }

  reportPhase("warm-worker-unlock");
  const client = createWalletCryptoClient();
  const seed = new Uint8Array(32).fill(19);
  await client.unlock(seed, context());
  const depositSamples: number[] = [];
  const orderSamples: number[] = [];
  const registry = {
    keys: [{ key_id: "browser-benchmark", algorithm: HPKE_PROFILE, public_key: X25519_PUBLIC_KEY }],
  };
  let noteFields: unknown = null;
  reportPhase("warm-deposit-plan", 0, 50);
  for (let index = 0; index < 50; index += 1) {
    let output = "";
    depositSamples.push(await measured(async () => {
      output = await client.buildDepositSubmissionPlan(JSON.stringify({
        bridge_address: "0x789",
        asset_id: "STRK",
        amount: "1000000000000000000",
        deposit_nonce: String(index + 1),
      }));
    }));
    if (index === 0) noteFields = (JSON.parse(output) as { note_fields: unknown }).note_fields;
    reportPhase("warm-deposit-plan", index + 1, 50);
  }
  if (!noteFields) throw new Error("deposit benchmark did not produce funding note fields");
  reportPhase("warm-order-request", 0, 30);
  for (let index = 0; index < 30; index += 1) {
    orderSamples.push(await measured(async () => {
      await client.buildOrderRequest(JSON.stringify({
        pair: "STRK/USDC",
        sell: true,
        external: false,
        amount: "1000000000000000000",
        limit: "1000000",
        expiry_ms: Date.now() + 60_000 + index,
        funding: [noteFields],
        registry,
      }));
    }));
    reportPhase("warm-order-request", index + 1, 30);
  }
  client.dispose();

  reportPhase("device-session-seal");
  const deviceSeed = new Uint8Array(32).fill(27);
  const deviceContext = context();
  const deviceClient = createWalletCryptoClient();
  await deviceClient.unlockAndSealDeviceSession(deviceSeed, deviceContext);
  const deviceSeedDetached = deviceSeed.buffer.byteLength === 0;
  deviceClient.dispose();
  reportPhase("device-session-restore");
  const restoredClient = createWalletCryptoClient();
  await restoredClient.unlockFromDeviceSession(deviceContext);
  const restoredConfig = JSON.parse(await restoredClient.publicConfig()) as { account_id?: unknown };
  restoredClient.dispose();

  const persistedDeviceKeys = await inspectDeviceKeys();
  const trustedTypesApiAvailable = typeof (
    globalThis as typeof globalThis & { trustedTypes?: unknown }
  ).trustedTypes === "object";
  const policy = document.querySelector<HTMLMetaElement>(
    'meta[http-equiv="Content-Security-Policy"]',
  )?.content ?? "";
  const trustedTypesRequiredByMeta = policy.includes("require-trusted-types-for 'script'")
    && policy.includes("trusted-types zylith-wallet-worker");
  const sameOriginModuleWorkers = workerLaunches.length === 11
    && workerLaunches.every((launch) => (
      new URL(launch.url).origin === location.origin
      && launch.type === "module"
      && launch.name === "zylith-wallet-crypto"
    ));
  const crossOriginResources = performance.getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((resource) => new URL(resource, location.href).origin !== location.origin);
  const deviceKeyIsNonextractable = persistedDeviceKeys.length === 1
    && persistedDeviceKeys[0].extractable === false
    && persistedDeviceKeys[0].algorithm === "AES-GCM"
    && JSON.stringify(persistedDeviceKeys[0].usages) === JSON.stringify(["decrypt", "encrypt"]);
  if (
    !firstSeedDetached
    || !deviceSeedDetached
    || typeof restoredConfig.account_id !== "string"
    || !trustedTypesApiAvailable
    || !trustedTypesRequiredByMeta
    || !sameOriginModuleWorkers
    || crossOriginResources.length !== 0
    || !deviceKeyIsNonextractable
    || workerDiagnostics.length !== 0
  ) {
    throw new Error("browser security invariant failed");
  }

  return {
    status: "PASS",
    user_agent: navigator.userAgent,
    cross_origin_isolated: crossOriginIsolated,
    security: {
      worker_type: "module",
      worker_origin: location.origin,
      initial_seed_buffer_detached: firstSeedDetached,
      device_seed_buffer_detached: deviceSeedDetached,
      nonextractable_indexeddb_key_restored: typeof restoredConfig.account_id === "string",
      persisted_device_keys: persistedDeviceKeys,
      trusted_types_api_available: trustedTypesApiAvailable,
      trusted_types_required_by_meta: trustedTypesRequiredByMeta,
      same_origin_module_workers: sameOriginModuleWorkers,
      worker_launch_count: workerLaunches.length,
      worker_script_urls: [...new Set(workerLaunches.map((launch) => launch.url))],
      cross_origin_resources: crossOriginResources,
    },
    latency: {
      cold_worker_unlock_and_public_config: distribution(coldSamples),
      first_cold_worker_ms: Number(coldSamples[0].toFixed(3)),
      warm_deposit_plan: distribution(depositSamples),
      warm_order_request: distribution(orderSamples),
    },
  };
}

void run().then(
  (result) => {
    if (resultElement) resultElement.textContent = JSON.stringify(result, null, 2);
    document.title = "PASS";
  },
  (error: unknown) => {
    const result = {
      status: "FAIL",
      error: error instanceof Error ? error.message : "unknown browser gate failure",
      worker_diagnostics: workerDiagnostics,
    };
    if (resultElement) resultElement.textContent = JSON.stringify(result, null, 2);
    document.title = "FAIL";
  },
);
