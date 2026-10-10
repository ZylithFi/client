import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWalletCryptoClient,
  WalletCryptoError,
  type WalletCryptoWorkerLike,
} from "./walletCryptoClient";
import {
  WALLET_WORKER_MAX_SESSION_LIFETIME_MS,
  createWalletCryptoWorkerReplySink,
  createWalletCryptoWorkerDispatcher,
  dispatchWalletCryptoWorkerMessage,
  normalizeWalletWorkerContext,
  parseWalletWorkerRequest,
  parseWalletWorkerReply,
  walletWorkerContextToken,
  type WalletSessionBinding,
  type WalletSessionModule,
  type WalletCryptoWorkerDispatcher,
  type WalletWorkerReply,
} from "../workers/walletCryptoProtocol";
import {
  WalletDeviceSessionError,
  createWalletDeviceRecordStore,
  createWalletDeviceWorkerService,
  inspectWalletDeviceRecord,
  type WalletDeviceKeyOwner,
  type WalletDeviceKeyStore,
  type WalletDeviceOwnedKeyStore,
  type WalletDeviceRecordStore,
  type WalletDeviceWorkerService,
} from "./walletDeviceSession";
import {
  createWalletSignatureVaultWorkerService,
  MAX_WALLET_SIGNATURE_HEX_DIGITS,
  walletSignatureVaultAuthToken,
  walletSignatureVaultId,
  type WalletSignatureVaultWorkerService,
} from "./walletLocalCrypto";

const context = {
  walletAddress: "0xabc",
  chainId: "0x534e5f5345504f4c4941",
  deploymentId: "0x123",
  vaultDeploymentId: "0x456",
  origin: "https://app.zylith.fi",
  manifestIdentity: `sha256:${"ab".repeat(32)}`,
  manifestVersion: "1",
  expiresAtMs: Date.now() + 24 * 60 * 60 * 1_000,
};

class FakeWalletSession {
  static instances: FakeWalletSession[] = [];
  static failConstruction = false;
  static operationFailure: string | null = null;

  readonly calls: Array<[string, string?]> = [];
  readonly seedAtConstruction: Uint8Array;
  locked = false;
  freed = false;

  constructor(
    readonly seed: Uint8Array,
    readonly chainId: string,
    readonly deploymentId: string,
  ) {
    if (FakeWalletSession.failConstruction) throw new Error("raw seed 090909 must not escape");
    this.seedAtConstruction = new Uint8Array(seed);
    FakeWalletSession.instances.push(this);
  }

  lock() {
    this.locked = true;
  }

  free() {
    this.freed = true;
  }

  publicConfig() {
    this.calls.push(["publicConfig"]);
    return JSON.stringify({ account_id: "wallet-1" });
  }

  recoveryAuthTag() {
    this.calls.push(["recoveryAuthTag"]);
    return "recovery-tag";
  }

  deriveProofSigner(input: string) { return this.called("deriveProofSigner", input); }
  encryptLocalState(input: string) { return this.called("encryptLocalState", input); }
  decryptLocalState(input: string) { return this.called("decryptLocalState", input); }
  decryptLocalStateClassified(input: string) {
    if (input === "migration") return JSON.stringify({ status: "MIGRATION_REQUIRED" });
    if (input === "invalid") return JSON.stringify({ status: "DATA_INVALID" });
    if (input === "malformed-outcome") return JSON.stringify({ status: "OK", result_b64: "e30=", extra: true });
    if (input === "malformed-base64") return JSON.stringify({ status: "OK", result_b64: "***=" });
    if (input === "throw-outcome") throw new Error("raw decrypt detail");
    if (input === "escape-heavy") return classifiedSuccess("\\".repeat(4 * 1024 * 1024));
    if (input === "oversize-result") return classifiedSuccess("\\".repeat(4 * 1024 * 1024 + 1));
    return classifiedSuccess(this.called("decryptLocalState", input));
  }
  buildDepositSubmissionPlan(input: string) { return this.called("buildDepositSubmissionPlan", input); }
  buildOrderRequest(input: string) { return this.called("buildOrderRequest", input); }
  buildCancelRequest(input: string) { return this.called("buildCancelRequest", input); }
  buildStatusRequests(input: string) { return this.called("buildStatusRequests", input); }
  buildWithdrawRequest(input: string) { return this.called("buildWithdrawRequest", input); }
  buildResidualRecovery(input: string) { return this.called("buildResidualRecovery", input); }
  createRecoverySnapshot(input: string) { return this.called("createRecoverySnapshot", input); }
  decryptRecoveryArtifact(input: string) { return this.called("decryptRecoveryArtifact", input); }
  decryptRecoveryArtifactClassified(input: string) {
    if (input === "migration") return JSON.stringify({ status: "MIGRATION_REQUIRED" });
    if (input === "invalid") return JSON.stringify({ status: "DATA_INVALID" });
    if (input === "escape-heavy-recovery") return classifiedSuccess("\\".repeat(4 * 1024 * 1024));
    return classifiedSuccess(this.called("decryptRecoveryArtifact", input));
  }
  signStrk20ExitClaim(input: string) { return this.called("signStrk20ExitClaim", input); }

  private called(operation: string, input: string) {
    if (FakeWalletSession.operationFailure === operation) {
      throw new Error("raw seed 090909 must not escape");
    }
    this.calls.push([operation, input]);
    return JSON.stringify({ operation, input });
  }
}

function classifiedSuccess(result: string): string {
  const bytes = new TextEncoder().encode(result);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return JSON.stringify({ status: "OK", result_b64: btoa(binary) });
}

function testModule(): WalletSessionModule {
  return {
    default: async () => undefined,
    WalletSession: FakeWalletSession,
  };
}

class InProcessWorker implements WalletCryptoWorkerLike {
  readonly dispatcher: WalletCryptoWorkerDispatcher;
  readonly receivedMessages: unknown[] = [];
  readonly receivedReplies: WalletWorkerReply[] = [];
  terminated = 0;
  private readonly listeners = {
    message: new Set<(event: MessageEvent<unknown>) => void>(),
    error: new Set<(event: ErrorEvent) => void>(),
    messageerror: new Set<(event: MessageEvent<unknown>) => void>(),
  };

  constructor(
    deviceSessions?: WalletDeviceWorkerService,
    now?: () => number,
    signatureVault: WalletSignatureVaultWorkerService = createWalletSignatureVaultWorkerService({
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }),
  ) {
    this.dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      deviceSessions,
      signatureVault,
      now,
    });
  }

  postMessage(message: unknown, transfer: Transferable[] = []) {
    const cloned = structuredClone(message, { transfer });
    parseWalletWorkerRequest(cloned);
    this.receivedMessages.push(cloned);
    void this.dispatcher.dispatch(cloned).then((reply) => this.emitReply(reply));
  }

  terminate() {
    this.terminated += 1;
    this.dispatcher.terminate();
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    this.listeners[type].add(listener as never);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    this.listeners[type].delete(listener as never);
  }

  private emitReply(reply: WalletWorkerReply) {
    this.receivedReplies.push(structuredClone(reply));
    for (const listener of this.listeners.message) {
      listener(new MessageEvent("message", { data: structuredClone(reply) }));
    }
  }
}

class ManualWorker implements WalletCryptoWorkerLike {
  readonly sent: unknown[] = [];
  readonly listeners = {
    message: new Set<(event: MessageEvent<unknown>) => void>(),
    error: new Set<(event: ErrorEvent) => void>(),
    messageerror: new Set<(event: MessageEvent<unknown>) => void>(),
  };
  terminated = 0;
  throwOnPost = false;

  postMessage(message: unknown, transfer: Transferable[] = []) {
    if (this.throwOnPost) throw new Error("post failed with raw seed 090909");
    this.sent.push(structuredClone(message, { transfer }));
  }

  terminate() {
    this.terminated += 1;
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    this.listeners[type].add(listener as never);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener) {
    this.listeners[type].delete(listener as never);
  }

  reply(reply: unknown) {
    for (const listener of this.listeners.message) {
      listener(new MessageEvent("message", { data: structuredClone(reply) }));
    }
  }

  fail(type: "error" | "messageerror") {
    const event = type === "error" ? new ErrorEvent("error") : new MessageEvent("messageerror");
    for (const listener of this.listeners[type]) listener(event as never);
  }
}

class DeviceMemoryKeyStore implements WalletDeviceKeyStore, WalletDeviceOwnedKeyStore {
  readonly keys = new Map<string, CryptoKey>();
  readonly owners = new Map<string, WalletDeviceKeyOwner>();
  async get(id: string) { return this.keys.get(id) ?? null; }
  async put(id: string, key: CryptoKey) { this.keys.set(id, key); }
  async delete(id: string) { this.keys.delete(id); this.owners.delete(id); }
  async add(entry: { key: CryptoKey; owner: WalletDeviceKeyOwner }) {
    if (this.keys.has(entry.owner.keyId)) throw new Error("collision");
    this.keys.set(entry.owner.keyId, entry.key);
    this.owners.set(entry.owner.keyId, { ...entry.owner });
  }
  async getOwned(owner: WalletDeviceKeyOwner) {
    return this.ownerMatches(owner) ? this.keys.get(owner.keyId) ?? null : null;
  }
  async deleteOwned(owner: WalletDeviceKeyOwner) {
    if (!this.ownerMatches(owner)) return false;
    this.keys.delete(owner.keyId);
    this.owners.delete(owner.keyId);
    return true;
  }
  private ownerMatches(owner: WalletDeviceKeyOwner) {
    return JSON.stringify(this.owners.get(owner.keyId)) === JSON.stringify(owner);
  }
}

class DeviceMemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

class ObservableDeviceRecordStore implements WalletDeviceRecordStore {
  private readonly listeners = new Map<string, Set<(raw: string | null) => void>>();

  constructor(private readonly delegate: WalletDeviceRecordStore) {}

  readRaw(walletAddress: string) {
    return this.delegate.readRaw?.(walletAddress) ?? this.delegate.read(walletAddress)?.raw ?? null;
  }

  read(walletAddress: string) {
    return this.delegate.read(walletAddress);
  }

  compareAndSwap(walletAddress: string, expectedRaw: string | null, nextRaw: string | null) {
    return this.delegate.compareAndSwap(walletAddress, expectedRaw, nextRaw);
  }

  subscribe(walletAddress: string, listener: (raw: string | null) => void) {
    const current = this.listeners.get(walletAddress) ?? new Set();
    current.add(listener);
    this.listeners.set(walletAddress, current);
    return () => {
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(walletAddress);
    };
  }

  async externalCompareAndSwap(walletAddress: string, expectedRaw: string | null, nextRaw: string | null) {
    const changed = await this.delegate.compareAndSwap(walletAddress, expectedRaw, nextRaw);
    if (changed) {
      for (const listener of this.listeners.get(walletAddress) ?? []) listener(nextRaw);
    }
    return changed;
  }

  listenerCount(walletAddress: string) {
    return this.listeners.get(walletAddress)?.size ?? 0;
  }
}

function normalizedContext(value = context) {
  return normalizeWalletWorkerContext(value);
}

function binding(generation = 1, value = context): WalletSessionBinding {
  return {
    sessionId: `wcs_${"07".repeat(16)}`,
    generation,
    contextToken: walletWorkerContextToken(normalizedContext(value)),
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function unlockedReply(
  requestId: number,
  sessionBinding = binding(),
  value = context,
): WalletWorkerReply {
  return {
    type: "unlocked",
    requestId,
    binding: sessionBinding,
    context: normalizedContext(value),
  };
}

async function openManualClient(worker: ManualWorker) {
  const client = createWalletCryptoClient({ workerFactory: () => worker });
  const opening = client.unlock(new Uint8Array(32).fill(9), context);
  worker.reply(unlockedReply(1));
  await opening;
  return client;
}

beforeEach(() => {
  FakeWalletSession.instances = [];
  FakeWalletSession.failConstruction = false;
  FakeWalletSession.operationFailure = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wallet crypto worker client", () => {
  it("derives signature-vault credentials without loading wasm or consuming a session generation", async () => {
    let moduleLoads = 0;
    let randomCalls = 0;
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => {
        moduleLoads += 1;
        return testModule();
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      signatureVault: createWalletSignatureVaultWorkerService({
        randomBytes: (length) => {
          randomCalls += 1;
          return new Uint8Array(length).fill(7);
        },
      }),
    });
    const credentials = await dispatcher.dispatch({
      kind: "derive-signature-vault-credentials",
      requestId: 1,
      signature: ["0x1", "0x2"],
      context: normalizedContext(),
    });
    const legacyContext = {
      signature: ["0x1", "0x2"],
      walletAddress: context.walletAddress,
      chainId: context.chainId,
      deploymentId: context.vaultDeploymentId,
      origin: context.origin,
      messageVersion: 2 as const,
    };
    expect(credentials).toEqual({
      type: "signature-vault-credentials",
      requestId: 1,
      walletAuthId: await walletSignatureVaultId(legacyContext),
      authToken: await walletSignatureVaultAuthToken(legacyContext),
    });
    expect(dispatcher.state).toBe("ABSENT");
    expect(moduleLoads).toBe(0);
    expect(randomCalls).toBe(0);
    expect(FakeWalletSession.instances).toHaveLength(0);

    const opened = await dispatcher.dispatch({
      kind: "unlock",
      requestId: 2,
      seed: new Uint8Array(32).fill(9),
      context: normalizedContext(),
    });
    expect(opened).toMatchObject({ type: "unlocked", binding: { generation: 1 } });
  });

  it("exposes credential-only signature derivation through the closed client API", async () => {
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const legacyContext = {
      signature: ["0x1", "0x2"],
      walletAddress: context.walletAddress,
      chainId: context.chainId,
      deploymentId: context.vaultDeploymentId,
      origin: context.origin,
      messageVersion: 2 as const,
    };
    await expect(client.deriveSignatureVaultCredentials(["0x1", "0x2"], context)).resolves.toEqual({
      walletAuthId: await walletSignatureVaultId(legacyContext),
      authToken: await walletSignatureVaultAuthToken(legacyContext),
    });
    expect(worker.receivedMessages).toHaveLength(1);
    expect(worker.receivedMessages[0]).toMatchObject({
      kind: "derive-signature-vault-credentials",
      requestId: 1,
    });
    expect(FakeWalletSession.instances).toHaveLength(0);
    client.dispose();
  });

  it("prepares, commits, and finalizes a signature-created session without exposing its seed", async () => {
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);

    expect(prepared.vaultRaw).not.toContain("07".repeat(32));
    expect(JSON.parse(prepared.vaultRaw).deployment_id).toBe(context.vaultDeploymentId);
    expect(JSON.stringify(worker.receivedMessages)).not.toContain("07".repeat(32));
    expect(JSON.stringify(worker.receivedReplies)).not.toContain("07".repeat(32));
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "SIGNATURE_VAULT_FAILED" });

    await expect(client.commitSignatureVault(prepared)).resolves.toEqual(prepared.binding);
    await expect(client.publicConfig()).resolves.toContain("wallet-1");
    await expect(client.finalizeSignatureVault(prepared, true)).resolves.toEqual({ remembered: false });
    expect(FakeWalletSession.instances[0]?.seedAtConstruction).toEqual(new Uint8Array(32).fill(7));
    expect(FakeWalletSession.instances[0]?.deploymentId).toBe(context.deploymentId);
  });

  it("publishes a prepared device record only after signature commit and hydration", async () => {
    const keys = new DeviceMemoryKeyStore();
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const deviceSessions = createWalletDeviceWorkerService({ keyStore: keys });
    const worker = new InProcessWorker(deviceSessions);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });

    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    expect(prepared.device).not.toBeNull();
    expect(records.readRaw?.(context.walletAddress)).toBeNull();
    await client.commitSignatureVault(prepared);
    expect(records.readRaw?.(context.walletAddress)).toBeNull();
    await expect(client.publicConfig()).resolves.toContain("wallet-1");
    await expect(client.finalizeSignatureVault(prepared, true)).resolves.toEqual({ remembered: true });
    expect(records.readRaw?.(context.walletAddress)).toBe(prepared.device?.recordRaw);
    expect(keys.keys.size).toBe(1);
  });

  it("installs an exact device monitor before returning a remembered signature session", async () => {
    const keys = new DeviceMemoryKeyStore();
    const records = new ObservableDeviceRecordStore(
      createWalletDeviceRecordStore(new DeviceMemoryStorage()),
    );
    const worker = new InProcessWorker(createWalletDeviceWorkerService({ keyStore: keys }));
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    await client.commitSignatureVault(prepared);

    await expect(client.finalizeSignatureVault(prepared, true)).resolves.toEqual({ remembered: true });
    expect(records.listenerCount(context.walletAddress)).toBe(1);
    await expect(records.externalCompareAndSwap(
      context.walletAddress,
      prepared.device?.recordRaw ?? null,
      null,
    )).resolves.toBe(true);
    await vi.waitFor(() => expect(worker.dispatcher.state).toBe("TERMINATED"));
    expect(keys.keys.size).toBe(0);
    expect(records.listenerCount(context.walletAddress)).toBe(0);
  });

  it("rejects with a fixed error when published signature-device monitoring cannot be installed", async () => {
    const keys = new DeviceMemoryKeyStore();
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records: WalletDeviceRecordStore = {
      read: delegate.read.bind(delegate),
      readRaw: delegate.readRaw?.bind(delegate),
      compareAndSwap: delegate.compareAndSwap.bind(delegate),
      subscribe() { throw new Error("listener unavailable"); },
    };
    const worker = new InProcessWorker(createWalletDeviceWorkerService({ keyStore: keys }));
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    await client.commitSignatureVault(prepared);

    let rejected: unknown;
    try {
      await client.finalizeSignatureVault(prepared, true);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toEqual(new WalletCryptoError("DEVICE_SESSION_FAILED"));
    expect(String(rejected)).not.toContain("listener unavailable");
    expect(delegate.readRaw?.(context.walletAddress)).toBe(prepared.device?.recordRaw);
    expect(keys.keys.size).toBe(1);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("rejects with a fixed error when published signature-device monitoring cannot be reread", async () => {
    const keys = new DeviceMemoryKeyStore();
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    let monitorInstalled = false;
    const records: WalletDeviceRecordStore = {
      read: delegate.read.bind(delegate),
      readRaw(walletAddress) {
        if (monitorInstalled) throw new Error("private monitor reread diagnostic");
        return delegate.readRaw?.(walletAddress) ?? null;
      },
      compareAndSwap: delegate.compareAndSwap.bind(delegate),
      subscribe(walletAddress, listener) {
        const unsubscribe = delegate.subscribe(walletAddress, listener);
        monitorInstalled = true;
        return unsubscribe;
      },
    };
    const worker = new InProcessWorker(createWalletDeviceWorkerService({ keyStore: keys }));
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    await client.commitSignatureVault(prepared);

    let rejected: unknown;
    try {
      await client.finalizeSignatureVault(prepared, true);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toEqual(new WalletCryptoError("DEVICE_SESSION_FAILED"));
    expect(String(rejected)).not.toContain("private monitor reread diagnostic");
    expect(delegate.readRaw?.(context.walletAddress)).toBe(prepared.device?.recordRaw);
    expect(keys.keys.size).toBe(1);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    await expect(client.publicConfig()).rejects.toEqual(
      new WalletCryptoError("CLIENT_INVALIDATED"),
    );
  });

  it("rejects and preserves a replacement observed while arming a signature-device monitor", async () => {
    const storage = new DeviceMemoryStorage();
    const delegate = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const replacement = await service.prepare(new Uint8Array(32).fill(4), normalizedContext());
    let monitorInstalled = false;
    const records: WalletDeviceRecordStore = {
      read: delegate.read.bind(delegate),
      readRaw(walletAddress) {
        if (monitorInstalled) {
          storage.setItem("zylith.wallet.device-session.v3:0xabc", replacement.raw);
        }
        return delegate.readRaw?.(walletAddress) ?? null;
      },
      compareAndSwap: delegate.compareAndSwap.bind(delegate),
      subscribe(walletAddress, listener) {
        const unsubscribe = delegate.subscribe(walletAddress, listener);
        monitorInstalled = true;
        return unsubscribe;
      },
    };
    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    await client.commitSignatureVault(prepared);

    await expect(client.finalizeSignatureVault(prepared, true)).rejects.toEqual(
      new WalletCryptoError("DEVICE_SESSION_FAILED"),
    );
    await vi.waitFor(() => expect(worker.dispatcher.state).toBe("TERMINATED"));
    await vi.waitFor(() => expect(keys.keys.size).toBe(1));
    expect(delegate.readRaw?.(context.walletAddress)).toBe(replacement.raw);
    expect(keys.keys.has(replacement.keyId)).toBe(true);
    await expect(client.publicConfig()).rejects.toEqual(
      new WalletCryptoError("CLIENT_INVALIDATED"),
    );
  });

  it("opens an existing vault entirely inside a fresh worker", async () => {
    const creator = createWalletCryptoClient({ workerFactory: () => new InProcessWorker() });
    const created = await creator.prepareSignatureVaultCreate(["0x1", "0x2"], context, false);
    await creator.abortSignatureVault(created);

    const openerWorker = new InProcessWorker();
    const opener = createWalletCryptoClient({ workerFactory: () => openerWorker });
    const opened = await opener.prepareSignatureVaultOpen(["0x1", "0x2"], created.vaultRaw, context, false);
    expect(JSON.stringify(openerWorker.receivedMessages)).not.toContain("07".repeat(32));
    expect(JSON.stringify(openerWorker.receivedReplies)).not.toContain("07".repeat(32));
    await opener.commitSignatureVault(opened);
    await expect(opener.publicConfig()).resolves.toContain("wallet-1");
    await expect(opener.finalizeSignatureVault(opened, false)).resolves.toEqual({ remembered: false });
    expect(FakeWalletSession.instances.at(-1)?.seedAtConstruction).toEqual(new Uint8Array(32).fill(7));
  });

  it("awaits owned device cleanup and destroys the session on an exact precommit abort", async () => {
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const worker = new InProcessWorker(service);
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    expect(keys.keys.size).toBe(1);

    await client.abortSignatureVault(prepared);
    expect(keys.keys.size).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances[0]).toMatchObject({ locked: true, freed: true });
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("keeps signature unlock usable when optional device preparation fails", async () => {
    const service: WalletDeviceWorkerService = {
      prepare: async () => { throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED"); },
      open: async () => { throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED"); },
      discard: async () => undefined,
      retire: async () => undefined,
    };
    const client = createWalletCryptoClient({ workerFactory: () => new InProcessWorker(service) });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    expect(prepared.device).toBeNull();
    await client.commitSignatureVault(prepared);
    await expect(client.publicConfig()).resolves.toContain("wallet-1");
    await expect(client.finalizeSignatureVault(prepared, true)).resolves.toEqual({ remembered: false });
  });

  it("does not destroy a committed signature session or claim remembrance when device cleanup fails", async () => {
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const worker = new InProcessWorker(service);
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    await client.commitSignatureVault(prepared);
    keys.deleteOwned = async () => { throw new Error("private storage detail"); };

    await expect(client.finalizeSignatureVault(prepared, false)).resolves.toEqual({ remembered: false });
    await expect(client.publicConfig()).resolves.toContain("wallet-1");
    expect(keys.keys.size).toBe(1);
    expect(worker.dispatcher.state).toBe("OPEN");
  });

  it("fails a signature commit at the exact expiry boundary and destroys the unpublished session", async () => {
    let clock = 1_000;
    const expiring = { ...context, expiresAtMs: 1_500 };
    const worker = new InProcessWorker(undefined, () => clock);
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      now: () => clock,
    });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], expiring, false);
    clock = expiring.expiresAtMs;

    await expect(client.commitSignatureVault(prepared)).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances[0]).toMatchObject({ locked: true, freed: true });
  });

  it("does not arm session expiry until the exact signature commit", async () => {
    const setTimer = vi.fn(() => 1 as ReturnType<typeof setTimeout>);
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer,
      clearTimer: () => undefined,
      signatureVault: createWalletSignatureVaultWorkerService({
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
    });
    const prepared = await dispatcher.dispatch({
      kind: "prepare-signature-vault-create",
      requestId: 1,
      signature: ["0x1"],
      context,
      rememberDevice: false,
      deviceTtlMs: 1_000,
      priorDeviceRecordRaw: null,
    });
    if (prepared.type !== "signature-vault-prepared") throw new Error("expected signature preparation");
    expect(setTimer).not.toHaveBeenCalled();

    await expect(dispatcher.dispatch({
      kind: "commit-signature-vault",
      requestId: 2,
      binding: prepared.binding,
      preparationToken: prepared.preparationToken,
      vaultRaw: prepared.vaultRaw,
      device: prepared.device,
    })).resolves.toMatchObject({ type: "signature-vault-committed" });
    expect(setTimer).toHaveBeenCalledTimes(1);
  });

  it("fails closed and cleans the prepared device when commit cannot arm expiry", async () => {
    const keys = new DeviceMemoryKeyStore();
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => { throw new Error("timer detail"); },
      clearTimer: () => undefined,
      deviceSessions: createWalletDeviceWorkerService({ keyStore: keys }),
      signatureVault: createWalletSignatureVaultWorkerService({
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
    });
    const prepared = await dispatcher.dispatch({
      kind: "prepare-signature-vault-create",
      requestId: 1,
      signature: ["0x1"],
      context,
      rememberDevice: true,
      deviceTtlMs: 7 * 24 * 60 * 60 * 1_000,
      priorDeviceRecordRaw: null,
    });
    if (prepared.type !== "signature-vault-prepared") throw new Error("expected signature preparation");
    expect(keys.keys.size).toBe(1);

    await expect(dispatcher.dispatch({
      kind: "commit-signature-vault",
      requestId: 2,
      binding: prepared.binding,
      preparationToken: prepared.preparationToken,
      vaultRaw: prepared.vaultRaw,
      device: prepared.device,
    })).resolves.toEqual({
      type: "fatal",
      error: {
        code: "WORKER_FAILED",
        message: "Wallet security worker failed.",
      },
    });
    expect(keys.keys.size).toBe(0);
    expect(dispatcher.state).toBe("TERMINATED");
  });

  it("preserves the first concurrent signature preparation but terminally rejects a post-prepare replacement", async () => {
    const started = deferred<void>();
    const resume = deferred<void>();
    const delegate = createWalletSignatureVaultWorkerService({
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const delayed: WalletSignatureVaultWorkerService = {
      credentials: (...args) => delegate.credentials(...args),
      create: async (...args) => {
        started.resolve();
        await resume.promise;
        return delegate.create(...args);
      },
      open: (...args) => delegate.open(...args),
    };
    const worker = new InProcessWorker(undefined, undefined, delayed);
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const first = client.prepareSignatureVaultCreate(["0x1", "0x2"], context, false);
    await started.promise;
    await expect(client.prepareSignatureVaultCreate(["0x1", "0x2"], context, false)).rejects.toMatchObject({
      code: "SESSION_ACTIVE",
    });
    resume.resolve();
    const prepared = await first;
    expect(worker.dispatcher.state).toBe("OPEN");

    await expect(client.prepareSignatureVaultOpen(["0x1", "0x2"], prepared.vaultRaw, context, false)).rejects.toMatchObject({
      code: "SESSION_ACTIVE",
    });
    expect(worker.dispatcher.state).toBe("TERMINATED");
  });

  it("rejects a mismatched preparation without cleaning its owned device key", async () => {
    const keys = new DeviceMemoryKeyStore();
    const devices = createWalletDeviceWorkerService({ keyStore: keys });
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      deviceSessions: devices,
      signatureVault: createWalletSignatureVaultWorkerService({
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
    });
    const prepared = await dispatcher.dispatch({
      kind: "prepare-signature-vault-create",
      requestId: 1,
      signature: ["0x1", "0x2"],
      context,
      rememberDevice: true,
      deviceTtlMs: 7 * 24 * 60 * 60 * 1_000,
      priorDeviceRecordRaw: null,
    });
    if (prepared.type !== "signature-vault-prepared") throw new Error("expected signature preparation");
    expect(keys.keys.size).toBe(1);

    await expect(dispatcher.dispatch({
      kind: "commit-signature-vault",
      requestId: 2,
      binding: prepared.binding,
      preparationToken: "08".repeat(16),
      vaultRaw: prepared.vaultRaw,
      device: prepared.device,
    })).resolves.toMatchObject({ type: "error", error: { code: "SIGNATURE_VAULT_INVALID" } });
    expect(keys.keys.size).toBe(1);
    expect(dispatcher.state).toBe("OPEN");
  });

  it("returns only fixed signature-vault errors for corrupted ciphertext", async () => {
    const creator = createWalletCryptoClient({ workerFactory: () => new InProcessWorker() });
    const prepared = await creator.prepareSignatureVaultCreate(["0x1", "0x2"], context, false);
    await creator.abortSignatureVault(prepared);
    const record = JSON.parse(prepared.vaultRaw);
    record.ciphertext = `A${record.ciphertext.slice(1)}`;
    const worker = new InProcessWorker();
    const opener = createWalletCryptoClient({ workerFactory: () => worker });

    await expect(opener.prepareSignatureVaultOpen(
      ["0x1", "0x2"],
      JSON.stringify(record),
      context,
      false,
    )).rejects.toEqual(new WalletCryptoError("SIGNATURE_VAULT_INVALID"));
    expect(JSON.stringify(worker.receivedReplies)).not.toMatch(/ciphertext|private storage detail|07{16}/i);
  });

  it("rejects malformed signature inputs and vault frames locally with one fixed error", async () => {
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });

    await expect(client.prepareSignatureVaultCreate([], context, false)).rejects.toEqual(
      new WalletCryptoError("SIGNATURE_VAULT_INVALID"),
    );
    await expect(client.prepareSignatureVaultOpen(["0x1"], "", context, false)).rejects.toEqual(
      new WalletCryptoError("SIGNATURE_VAULT_INVALID"),
    );
    expect(worker.receivedMessages).toHaveLength(0);
    expect(worker.dispatcher.state).toBe("ABSENT");
  });

  it("normalizes the maximum canonical signature identically in the client and worker", async () => {
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const signature = BigInt(`0x${"f".repeat(MAX_WALLET_SIGNATURE_HEX_DIGITS)}`);
    const canonical = `0x${"f".repeat(MAX_WALLET_SIGNATURE_HEX_DIGITS)}`;

    const prepared = await client.prepareSignatureVaultCreate(signature, context, false);
    expect(worker.receivedMessages.at(-1)).toMatchObject({ signature: canonical });
    await client.abortSignatureVault(prepared);

    const rejectedWorker = new InProcessWorker();
    const rejectedClient = createWalletCryptoClient({ workerFactory: () => rejectedWorker });
    const firstRejected = `0x${"f".repeat(MAX_WALLET_SIGNATURE_HEX_DIGITS + 1)}`;
    await expect(rejectedClient.prepareSignatureVaultCreate(firstRejected, context, false)).rejects.toEqual(
      new WalletCryptoError("SIGNATURE_VAULT_INVALID"),
    );
    expect(rejectedWorker.receivedMessages).toHaveLength(0);
    expect(rejectedWorker.dispatcher.state).toBe("ABSENT");
  });

  it("does not construct a wallet session when the vault nonce source fails", async () => {
    const seed = new Uint8Array(32).fill(0x5a);
    let calls = 0;
    const service = createWalletSignatureVaultWorkerService({
      randomBytes: () => {
        calls += 1;
        if (calls === 1) return seed;
        throw new Error("private random source detail");
      },
    });
    const worker = new InProcessWorker(undefined, undefined, service);
    const client = createWalletCryptoClient({ workerFactory: () => worker });

    await expect(client.prepareSignatureVaultCreate(["0x1"], context, false)).rejects.toEqual(
      new WalletCryptoError("SIGNATURE_VAULT_FAILED"),
    );
    expect(seed).toEqual(new Uint8Array(32));
    expect(FakeWalletSession.instances).toHaveLength(0);
    expect(worker.dispatcher.state).toBe("ABSENT");
    expect(JSON.stringify(worker.receivedReplies)).not.toContain("private random source detail");
  });

  it("consumes a failed open generation and permits one later fresh preparation", async () => {
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });

    await expect(client.prepareSignatureVaultOpen(["0x1"], "{}", context, false)).rejects.toEqual(
      new WalletCryptoError("SIGNATURE_VAULT_INVALID"),
    );
    const prepared = await client.prepareSignatureVaultCreate(["0x1"], context, false);
    expect(prepared.binding.generation).toBe(2);
    await client.abortSignatureVault(prepared);
  });

  it("wipes and rejects malformed injected vault-service results before wallet construction", async () => {
    const leaked = new Uint8Array(32).fill(91);
    const malformed: WalletSignatureVaultWorkerService = {
      credentials: async () => { throw new Error("unused"); },
      create: async () => ({
        seed: leaked,
        vaultRaw: "{}",
        walletAuthId: `0x${"00".repeat(32)}`,
        authToken: "00".repeat(32),
      }),
      open: async () => { throw new Error("unused"); },
    };
    const worker = new InProcessWorker(undefined, undefined, malformed);
    const client = createWalletCryptoClient({ workerFactory: () => worker });

    await expect(client.prepareSignatureVaultCreate(["0x1"], context, false)).rejects.toEqual(
      new WalletCryptoError("SIGNATURE_VAULT_FAILED"),
    );
    expect(leaked).toEqual(new Uint8Array(32));
    expect(FakeWalletSession.instances).toHaveLength(0);
    expect(JSON.stringify(worker.receivedReplies)).not.toContain("91".repeat(16));
  });

  it("binds exchange and vault deployments in one exact manifest-v1 context token", () => {
    const normalized = normalizedContext();
    expect(walletWorkerContextToken(normalized)).toBe(JSON.stringify([
      "0xabc",
      "0x534e5f5345504f4c4941",
      "0x123",
      "0x456",
      "https://app.zylith.fi",
      `sha256:${"ab".repeat(32)}`,
      "1",
      context.expiresAtMs,
    ]));
    expect(walletWorkerContextToken(normalizeWalletWorkerContext({
      ...context,
      vaultDeploymentId: "0x457",
    }))).not.toBe(walletWorkerContextToken(normalized));
    for (const invalid of [
      { ...context, manifestIdentity: `sha256:${"AB".repeat(32)}` },
      { ...context, manifestIdentity: "zylith-sepolia" },
      { ...context, manifestVersion: "2" },
      { ...context, vaultDeploymentId: "0x0" },
    ]) expect(() => normalizeWalletWorkerContext(invalid)).toThrow();
  });

  it("keeps every signature-vault command and reply schema closed", async () => {
    const validRequest = {
      kind: "prepare-signature-vault-create",
      requestId: 1,
      signature: ["0x1", "0x2"],
      context,
      rememberDevice: false,
      deviceTtlMs: 1_000,
      priorDeviceRecordRaw: null,
    };
    expect(parseWalletWorkerRequest(validRequest)).toMatchObject({
      kind: validRequest.kind,
      signature: ["0x1", "0x2"],
    });
    expect(() => parseWalletWorkerRequest({ ...validRequest, walletAddress: context.walletAddress })).toThrow();
    expect(() => parseWalletWorkerRequest({ ...validRequest, signature: [] })).toThrow();

    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context, false);
    const reply = worker.receivedReplies.at(-1)!;
    expect(parseWalletWorkerReply(reply)).toEqual(reply);
    expect(() => parseWalletWorkerReply({ ...reply, seedHex: "07".repeat(32) })).toThrow();
    expect(() => parseWalletWorkerReply({ ...reply, authToken: "A".repeat(64) })).toThrow();
    await client.abortSignatureVault(prepared);
  });

  it("preserves a device key after publication is authorized even if acknowledgement is lost", async () => {
    const keys = new DeviceMemoryKeyStore();
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      deviceSessions: createWalletDeviceWorkerService({ keyStore: keys }),
      signatureVault: createWalletSignatureVaultWorkerService({
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
    });
    const prepared = await dispatcher.dispatch({
      kind: "prepare-signature-vault-create",
      requestId: 1,
      signature: ["0x1", "0x2"],
      context,
      rememberDevice: true,
      deviceTtlMs: 7 * 24 * 60 * 60 * 1_000,
      priorDeviceRecordRaw: null,
    });
    if (prepared.type !== "signature-vault-prepared") throw new Error("expected signature preparation");
    const exact = {
      binding: prepared.binding,
      preparationToken: prepared.preparationToken,
      vaultRaw: prepared.vaultRaw,
      device: prepared.device,
    };
    await expect(dispatcher.dispatch({ kind: "commit-signature-vault", requestId: 2, ...exact })).resolves.toMatchObject({
      type: "signature-vault-committed",
    });
    await expect(dispatcher.dispatch({
      kind: "begin-signature-vault-device-publication",
      requestId: 3,
      ...exact,
    })).resolves.toMatchObject({ type: "signature-vault-device-publication-ready" });

    dispatcher.terminate("CLIENT_INVALIDATED");
    await Promise.resolve();
    expect(keys.keys.size).toBe(1);
    expect(dispatcher.state).toBe("TERMINATED");
  });

  it("rejects publication before commit and an abort mismatch without deleting the owned key", async () => {
    const keys = new DeviceMemoryKeyStore();
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      deviceSessions: createWalletDeviceWorkerService({ keyStore: keys }),
      signatureVault: createWalletSignatureVaultWorkerService({
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
    });
    const prepared = await dispatcher.dispatch({
      kind: "prepare-signature-vault-create",
      requestId: 1,
      signature: ["0x1"],
      context,
      rememberDevice: true,
      deviceTtlMs: 7 * 24 * 60 * 60 * 1_000,
      priorDeviceRecordRaw: null,
    });
    if (prepared.type !== "signature-vault-prepared") throw new Error("expected signature preparation");
    const exact = {
      binding: prepared.binding,
      preparationToken: prepared.preparationToken,
      vaultRaw: prepared.vaultRaw,
      device: prepared.device,
    };

    await expect(dispatcher.dispatch({
      kind: "begin-signature-vault-device-publication",
      requestId: 2,
      ...exact,
    })).resolves.toMatchObject({ type: "error", error: { code: "SIGNATURE_VAULT_FAILED" } });
    await expect(dispatcher.dispatch({
      kind: "abort-signature-vault",
      requestId: 3,
      ...exact,
      preparationToken: "09".repeat(16),
    })).resolves.toMatchObject({ type: "error", error: { code: "SIGNATURE_VAULT_INVALID" } });
    expect(keys.keys.size).toBe(1);
    expect(dispatcher.state).toBe("OPEN");
  });

  it("preserves a possibly published device key when expiry races final acknowledgement", async () => {
    let clock = 1_000;
    const expiring = { ...context, expiresAtMs: 2_000 };
    const keys = new DeviceMemoryKeyStore();
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      now: () => clock,
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      deviceSessions: createWalletDeviceWorkerService({ keyStore: keys, now: () => clock }),
      signatureVault: createWalletSignatureVaultWorkerService({
        randomBytes: (length) => new Uint8Array(length).fill(7),
      }),
    });
    const prepared = await dispatcher.dispatch({
      kind: "prepare-signature-vault-create",
      requestId: 1,
      signature: ["0x1"],
      context: expiring,
      rememberDevice: true,
      deviceTtlMs: 7 * 24 * 60 * 60 * 1_000,
      priorDeviceRecordRaw: null,
    });
    if (prepared.type !== "signature-vault-prepared") throw new Error("expected signature preparation");
    const exact = {
      binding: prepared.binding,
      preparationToken: prepared.preparationToken,
      vaultRaw: prepared.vaultRaw,
      device: prepared.device,
    };
    await dispatcher.dispatch({ kind: "commit-signature-vault", requestId: 2, ...exact });
    await dispatcher.dispatch({ kind: "begin-signature-vault-device-publication", requestId: 3, ...exact });
    clock = expiring.expiresAtMs;

    await expect(dispatcher.dispatch({
      kind: "finalize-signature-vault",
      requestId: 4,
      ...exact,
      devicePublication: "unknown",
    })).resolves.toMatchObject({ type: "error", error: { code: "SESSION_EXPIRED" } });
    await Promise.resolve();
    expect(keys.keys.size).toBe(1);
    expect(dispatcher.state).toBe("TERMINATED");
  });

  it("recognizes a device publication that took effect before storage reported failure", async () => {
    const keys = new DeviceMemoryKeyStore();
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records: WalletDeviceRecordStore = {
      readRaw: (wallet) => delegate.readRaw?.(wallet) ?? null,
      read: (wallet) => delegate.read(wallet),
      subscribe: (wallet, listener) => delegate.subscribe(wallet, listener),
      compareAndSwap: async (wallet, expected, next) => {
        const changed = await delegate.compareAndSwap(wallet, expected, next);
        if (next !== null && changed) throw new Error("storage reported failure after write");
        return changed;
      },
    };
    const client = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(createWalletDeviceWorkerService({ keyStore: keys })),
      deviceRecordStore: records,
    });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    await client.commitSignatureVault(prepared);

    await expect(client.finalizeSignatureVault(prepared, true)).resolves.toEqual({ remembered: true });
    expect(delegate.readRaw?.(context.walletAddress)).toBe(prepared.device?.recordRaw);
    expect(keys.keys.size).toBe(1);
  });

  it("preserves the key but reports not remembered when publication ownership is unknowable", async () => {
    const keys = new DeviceMemoryKeyStore();
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    let publicationStarted = false;
    const records: WalletDeviceRecordStore = {
      readRaw: (wallet) => {
        if (publicationStarted) throw new Error("ownership read unavailable");
        return delegate.readRaw?.(wallet) ?? null;
      },
      read: (wallet) => delegate.read(wallet),
      subscribe: (wallet, listener) => delegate.subscribe(wallet, listener),
      compareAndSwap: async (wallet, expected, next) => {
        const changed = await delegate.compareAndSwap(wallet, expected, next);
        publicationStarted = next !== null;
        return changed;
      },
    };
    const worker = new InProcessWorker(createWalletDeviceWorkerService({ keyStore: keys }));
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    await client.commitSignatureVault(prepared);

    await expect(client.finalizeSignatureVault(prepared, true)).resolves.toEqual({ remembered: false });
    expect(delegate.readRaw?.(context.walletAddress)).toBe(prepared.device?.recordRaw);
    expect(keys.keys.size).toBe(1);
    await expect(client.publicConfig()).resolves.toContain("wallet-1");
    expect(worker.dispatcher.state).toBe("OPEN");
  });

  it("keeps the new remembered session usable when prior-key retirement fails", async () => {
    const keys = new DeviceMemoryKeyStore();
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const devices = createWalletDeviceWorkerService({ keyStore: keys });
    const prior = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(devices),
      deviceRecordStore: records,
    });
    await prior.unlockAndSealDeviceSession(new Uint8Array(32).fill(1), context);
    await prior.lock();
    const priorRaw = records.readRaw?.(context.walletAddress);
    expect(keys.keys.size).toBe(1);

    const worker = new InProcessWorker(devices);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context);
    expect(prepared.device?.priorRecordRaw).toBe(priorRaw);
    await client.commitSignatureVault(prepared);
    keys.deleteOwned = async () => { throw new Error("prior cleanup unavailable"); };

    await expect(client.finalizeSignatureVault(prepared, true)).resolves.toEqual({ remembered: true });
    expect(records.readRaw?.(context.walletAddress)).toBe(prepared.device?.recordRaw);
    expect(keys.keys.size).toBe(2);
    await expect(client.publicConfig()).resolves.toContain("wallet-1");
  });

  it("enforces the maximum lifetime and expires both worker and client timers at the exact boundary", async () => {
    let workerNow = 10_000;
    let workerExpiry: (() => void) | null = null;
    let clearedWorkerTimers = 0;
    const asyncTerminal: string[] = [];
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      now: () => workerNow,
      setTimer: (callback) => {
        workerExpiry = callback;
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => { clearedWorkerTimers += 1; },
      onAsyncTerminal: (code) => asyncTerminal.push(code),
    });
    const maximumContext = {
      ...context,
      expiresAtMs: workerNow + WALLET_WORKER_MAX_SESSION_LIFETIME_MS,
    };
    await expect(dispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(32).fill(9),
      context: maximumContext,
    })).resolves.toMatchObject({ type: "unlocked" });
    expect(workerExpiry).not.toBeNull();
    workerNow = maximumContext.expiresAtMs;
    (workerExpiry as unknown as () => void)();
    expect(dispatcher.state).toBe("TERMINATED");
    expect(dispatcher.terminalReason).toBe("SESSION_EXPIRED");
    expect(asyncTerminal).toEqual(["SESSION_EXPIRED"]);
    expect(clearedWorkerTimers).toBe(1);
    expect(FakeWalletSession.instances[0]).toMatchObject({ locked: true, freed: true });

    const worker = new ManualWorker();
    let clientNow = 20_000;
    let clientExpiry: (() => void) | null = null;
    let clearedClientTimers = 0;
    const clientContext = { ...context, expiresAtMs: clientNow + 100 };
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      now: () => clientNow,
      setTimer: (callback, milliseconds) => {
        if (milliseconds === 100) clientExpiry = callback;
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => { clearedClientTimers += 1; },
    });
    const opening = client.unlock(new Uint8Array(32).fill(4), clientContext);
    worker.reply(unlockedReply(1, binding(1, clientContext), clientContext));
    await opening;
    clientNow = clientContext.expiresAtMs;
    (clientExpiry as unknown as () => void)();
    expect(worker.terminated).toBe(1);
    expect(clearedClientTimers).toBe(2);
    await expect(client.publicConfig()).rejects.toMatchObject({
      code: "SESSION_EXPIRED",
      message: "Wallet session expired.",
    });

    const tooLongWorker = new ManualWorker();
    const tooLongClient = createWalletCryptoClient({
      workerFactory: () => tooLongWorker,
      now: () => 30_000,
    });
    const tooLongSeed = new Uint8Array(32).fill(5);
    await expect(tooLongClient.unlock(tooLongSeed, {
      ...context,
      expiresAtMs: 30_000 + WALLET_WORKER_MAX_SESSION_LIFETIME_MS + 1,
    })).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(tooLongSeed).toEqual(new Uint8Array(32));
    expect(tooLongWorker.sent).toEqual([]);
  });

  it("expires at the exact worker boundary and destroys the session", async () => {
    let now = 1_000;
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      now: () => now,
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    const expiringContext = { ...context, expiresAtMs: 1_100 };
    const opened = await dispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(32).fill(9),
      context: expiringContext,
    });
    expect(opened.type).toBe("unlocked");
    if (opened.type !== "unlocked") throw new Error("test setup failed");
    now = 1_099;
    await expect(dispatcher.dispatch({ kind: "public-config", requestId: 2, binding: opened.binding })).resolves.toMatchObject({ type: "result" });
    now = 1_100;
    await expect(dispatcher.dispatch({ kind: "public-config", requestId: 3, binding: opened.binding })).resolves.toMatchObject({
      type: "error",
      error: { code: "SESSION_EXPIRED", message: "Wallet session expired." },
    });
    expect(dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances[0]).toMatchObject({ locked: true, freed: true });
  });

  it("terminally rejects an already-expired unlock while preserving an invalid-context retry", async () => {
    let now = 1_000;
    const expiredDispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      now: () => now,
    });
    const expiredSeed = new Uint8Array(32).fill(1);
    await expect(expiredDispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: expiredSeed,
      context: { ...context, expiresAtMs: now },
    })).resolves.toMatchObject({ type: "error", error: { code: "SESSION_EXPIRED" } });
    expect(expiredSeed).toEqual(new Uint8Array(32));
    expect(expiredDispatcher.state).toBe("TERMINATED");
    expect(expiredDispatcher.terminalReason).toBe("SESSION_EXPIRED");

    const retryDispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      now: () => now,
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    await expect(retryDispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(32).fill(2),
      context: { ...context, expiresAtMs: now + WALLET_WORKER_MAX_SESSION_LIFETIME_MS + 1 },
    })).resolves.toMatchObject({ type: "error", error: { code: "INVALID_CONTEXT" } });
    expect(retryDispatcher.state).toBe("ABSENT");
    now += 1;
    await expect(retryDispatcher.dispatch({
      kind: "unlock",
      requestId: 2,
      seed: new Uint8Array(32).fill(3),
      context: { ...context, expiresAtMs: now + 100 },
    })).resolves.toMatchObject({ type: "unlocked", binding: { generation: 1 } });
  });

  it("transfers one dedicated seed, binds the session, routes an operation, and locks", async () => {
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const seed = new Uint8Array(32).fill(9);

    const unlocked = client.unlock(seed, context);
    expect(seed.byteLength).toBe(0);
    await expect(unlocked).resolves.toMatchObject({ generation: 1 });
    await expect(client.publicConfig()).resolves.toBe(JSON.stringify({ account_id: "wallet-1" }));
    await expect(client.lock()).resolves.toBeUndefined();
    expect(FakeWalletSession.instances[0].seedAtConstruction).toEqual(new Uint8Array(32).fill(9));
    expect(FakeWalletSession.instances[0].seed).toEqual(new Uint8Array(32));
    expect(FakeWalletSession.instances[0]).toMatchObject({ locked: true, freed: true });
    const unlockMessage = worker.receivedMessages[0] as { seed: Uint8Array };
    expect(Array.from(unlockMessage.seed)).toEqual(Array(32).fill(0));
    expect(worker.receivedMessages.slice(1).every((message) => !("seed" in (message as object)))).toBe(true);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(worker.terminated).toBe(1);
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it.each(["malformed seal", "device reload"])(
    "keeps task-2 terminal replacement policy for a post-open %s",
    async (attempt) => {
      const worker = new InProcessWorker(createWalletDeviceWorkerService({
        keyStore: new DeviceMemoryKeyStore(),
      }));
      const client = createWalletCryptoClient({
        workerFactory: () => worker,
        deviceRecordStore: createWalletDeviceRecordStore(new DeviceMemoryStorage()),
      });
      await client.unlock(new Uint8Array(32).fill(1), context);

      const replacement = attempt === "malformed seal"
        ? client.unlockAndSealDeviceSession(new Uint8Array(31).fill(2), context)
        : client.unlockFromDeviceSession(context);
      await expect(replacement).rejects.toMatchObject({
        code: attempt === "malformed seal" ? "INVALID_SEED" : "SESSION_ACTIVE",
      });
      expect(worker.terminated).toBe(1);
      await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
    },
  );

  it("seals and reloads a device session without returning plaintext seed to the main thread", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    let clock = Date.now();
    let random = 1;
    const deviceSessions = createWalletDeviceWorkerService({
      keyStore: keys,
      now: () => clock,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const firstWorker = new InProcessWorker(deviceSessions);
    const firstClient = createWalletCryptoClient({
      workerFactory: () => firstWorker,
      deviceRecordStore: records,
      now: () => clock,
    });
    const seed = new Uint8Array(32).fill(0x5a);
    const firstBinding = await firstClient.unlockAndSealDeviceSession(seed, context);
    expect(seed.byteLength).toBe(0);
    expect(firstBinding.generation).toBe(1);
    const snapshot = records.read(context.walletAddress);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.raw).not.toContain("5a".repeat(32));
    expect(firstWorker.receivedMessages.every((message) => {
      const record = message as Record<string, unknown>;
      return !("seed" in record) || (record.seed as Uint8Array).every((byte) => byte === 0);
    })).toBe(true);
    const [deviceKey] = [...keys.keys.values()];
    await expect(crypto.subtle.exportKey("raw", deviceKey)).rejects.toBeTruthy();
    await firstClient.lock();

    clock += 1;
    const secondWorker = new InProcessWorker(deviceSessions);
    const secondClient = createWalletCryptoClient({
      workerFactory: () => secondWorker,
      deviceRecordStore: records,
      now: () => clock,
    });
    const reloaded = await secondClient.unlockFromDeviceSession({ ...context, expiresAtMs: context.expiresAtMs });
    expect(reloaded.generation).toBe(1);
    expect(FakeWalletSession.instances.at(-1)?.seedAtConstruction).toEqual(new Uint8Array(32).fill(0x5a));
    expect(secondWorker.receivedMessages.every((message) => !("seed" in (message as object)))).toBe(true);
  });

  it("keeps client and worker generations aligned after a transient device prepare failure", async () => {
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    let fail = true;
    const transient: WalletDeviceWorkerService = {
      ...service,
      async prepare(...args) {
        if (fail) {
          fail = false;
          throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
        }
        return service.prepare(...args);
      },
    };
    const worker = new InProcessWorker(transient);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });

    await expect(client.unlockAndSealDeviceSession(new Uint8Array(32).fill(1), context)).rejects.toMatchObject({
      code: "DEVICE_SESSION_FAILED",
    });
    await expect(client.unlockAndSealDeviceSession(new Uint8Array(32).fill(2), context)).resolves.toMatchObject({
      generation: 2,
    });
  });

  it("keeps client and worker generations aligned after a transient device open failure", async () => {
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(3), context);
    await sealer.lock();
    let fail = true;
    const transient: WalletDeviceWorkerService = {
      ...service,
      async open(...args) {
        if (fail) {
          fail = false;
          throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
        }
        return service.open(...args);
      },
    };
    const opener = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(transient),
      deviceRecordStore: records,
    });

    await expect(opener.unlockFromDeviceSession(context)).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    await expect(opener.unlockFromDeviceSession(context)).resolves.toMatchObject({ generation: 2 });
  });

  it("does not consume a generation when an overlong context is rejected before posting", async () => {
    const capturedNow = Date.now();
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const worker = new InProcessWorker(
      createWalletDeviceWorkerService({ keyStore: new DeviceMemoryKeyStore(), now: () => capturedNow }),
      () => capturedNow,
    );
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: records,
      now: () => capturedNow,
    });
    const overlong = { ...context, expiresAtMs: capturedNow + WALLET_WORKER_MAX_SESSION_LIFETIME_MS + 1 };

    await expect(client.unlockAndSealDeviceSession(new Uint8Array(32).fill(4), overlong)).rejects.toMatchObject({
      code: "INVALID_CONTEXT",
    });
    await expect(client.unlockAndSealDeviceSession(new Uint8Array(32).fill(5), context)).resolves.toMatchObject({
      generation: 1,
    });
  });

  it("rejects a remembered unlock revoked by another cooperating tab while decryption is in flight", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    const snapshot = records.read(context.walletAddress)!;
    const entered = deferred<void>();
    const resume = deferred<void>();
    const delayed: WalletDeviceWorkerService = {
      ...service,
      async open(...args) {
        const seed = await service.open(...args);
        entered.resolve();
        await resume.promise;
        return seed;
      },
    };
    const worker = new InProcessWorker(delayed);
    const opener = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });

    const opening = opener.unlockFromDeviceSession(context);
    await entered.promise;
    await expect(records.externalCompareAndSwap(context.walletAddress, snapshot.raw, null)).resolves.toBe(true);
    resume.resolve();
    await expect(opening).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(keys.keys.size).toBe(0);
  });

  it("terminally locks an open device-derived worker after a cooperating-tab revoke", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(7), context);
    await sealer.lock();
    const snapshot = records.read(context.walletAddress)!;
    const worker = new InProcessWorker(service);
    const opener = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    await opener.unlockFromDeviceSession(context);
    expect(records.listenerCount(context.walletAddress)).toBe(1);

    await expect(records.externalCompareAndSwap(context.walletAddress, snapshot.raw, null)).resolves.toBe(true);
    await vi.waitFor(() => expect(worker.dispatcher.state).toBe("TERMINATED"));
    expect(records.listenerCount(context.walletAddress)).toBe(0);
    await expect(opener.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
    expect(keys.keys.size).toBe(0);
  });

  it("locks but never deletes a same-key replacement owned by another device record", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    const worker = new InProcessWorker(createWalletDeviceWorkerService({ keyStore: keys }));
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    await client.unlockAndSealDeviceSession(new Uint8Array(32).fill(7), context);
    const active = records.read(context.walletAddress)!;
    const activeDetails = inspectWalletDeviceRecord(active.raw);
    const replacement = JSON.parse(active.raw) as Record<string, unknown>;
    replacement.record_id = "fe".repeat(16);
    const replacementRaw = JSON.stringify(replacement);
    keys.owners.set(activeDetails.keyId, {
      recordId: replacement.record_id as string,
      keyId: activeDetails.keyId,
      walletAddress: activeDetails.walletAddress,
      chainId: activeDetails.chainId,
      deploymentId: activeDetails.deploymentId,
      vaultDeploymentId: activeDetails.vaultDeploymentId,
      origin: activeDetails.origin,
      manifestIdentity: activeDetails.manifestIdentity,
      manifestVersion: activeDetails.manifestVersion,
    });

    await expect(records.externalCompareAndSwap(context.walletAddress, active.raw, replacementRaw)).resolves.toBe(true);
    await vi.waitFor(() => expect(worker.dispatcher.state).toBe("TERMINATED"));
    expect(records.readRaw(context.walletAddress)).toBe(replacementRaw);
    expect(keys.keys.has(activeDetails.keyId)).toBe(true);
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("unsubscribes a device-record monitor on explicit client disposal", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(7), context);
    expect(records.listenerCount(context.walletAddress)).toBe(1);

    sealer.dispose();

    expect(records.listenerCount(context.walletAddress)).toBe(0);
  });

  it("terminally closes a sealed session when monitor subscription fails", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const failingRecords: WalletDeviceRecordStore = {
      read: records.read.bind(records),
      readRaw: records.readRaw.bind(records),
      compareAndSwap: records.compareAndSwap.bind(records),
      subscribe() {
        throw new Error("storage listener unavailable");
      },
    };
    const keys = new DeviceMemoryKeyStore();
    const worker = new InProcessWorker(createWalletDeviceWorkerService({ keyStore: keys }));
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: failingRecords,
    });

    await expect(client.unlockAndSealDeviceSession(
      new Uint8Array(32).fill(7),
      context,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(records.listenerCount(context.walletAddress)).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances.at(-1)).toMatchObject({ locked: true, freed: true });
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("keeps the opening listener until a reload monitor replacement is fully installed", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    let reads = 0;
    const failingRecords: WalletDeviceRecordStore = {
      read: records.read.bind(records),
      readRaw(walletAddress) {
        reads += 1;
        if (reads === 4) throw new Error("ownership reread failed");
        return records.readRaw(walletAddress);
      },
      compareAndSwap: records.compareAndSwap.bind(records),
      subscribe: records.subscribe.bind(records),
    };
    const worker = new InProcessWorker(service);
    const opener = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: failingRecords,
    });

    await expect(opener.unlockFromDeviceSession(context)).rejects.toMatchObject({
      code: "DEVICE_SESSION_FAILED",
    });
    expect(records.listenerCount(context.walletAddress)).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances.at(-1)).toMatchObject({ locked: true, freed: true });
    await expect(opener.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("terminally sanitizes an initial reload subscription failure without touching the record or key", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    const authoritative = records.read(context.walletAddress)!;
    const authoritativeKeyId = JSON.parse(authoritative.raw).key_id as string;
    const sessionCount = FakeWalletSession.instances.length;
    const failingRecords: WalletDeviceRecordStore = {
      read: records.read.bind(records),
      readRaw: records.readRaw.bind(records),
      compareAndSwap: records.compareAndSwap.bind(records),
      subscribe() {
        throw new Error("raw storage subscription diagnostic");
      },
    };
    const worker = new InProcessWorker(service);
    const opener = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: failingRecords,
    });

    let rejected: unknown;
    try {
      await opener.unlockFromDeviceSession(context);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({
      code: "DEVICE_SESSION_FAILED",
      message: "Remembered wallet session failed.",
    });
    expect(String(rejected)).not.toContain("raw storage subscription diagnostic");
    expect(records.listenerCount(context.walletAddress)).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances).toHaveLength(sessionCount);
    await expect(opener.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
    expect(records.read(context.walletAddress)?.raw).toBe(authoritative.raw);
    expect(keys.keys.has(authoritativeKeyId)).toBe(true);
  });

  it("keeps and then clears the opening listener if reload monitor subscription fails", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    let subscriptions = 0;
    const failingRecords: WalletDeviceRecordStore = {
      read: records.read.bind(records),
      readRaw: records.readRaw.bind(records),
      compareAndSwap: records.compareAndSwap.bind(records),
      subscribe(walletAddress, listener) {
        subscriptions += 1;
        if (subscriptions === 2) throw new Error("replacement listener unavailable");
        return records.subscribe(walletAddress, listener);
      },
    };
    const worker = new InProcessWorker(service);
    const opener = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: failingRecords,
    });

    await expect(opener.unlockFromDeviceSession(context)).rejects.toMatchObject({
      code: "DEVICE_SESSION_FAILED",
    });
    expect(records.listenerCount(context.walletAddress)).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances.at(-1)).toMatchObject({ locked: true, freed: true });
  });

  it("removes a mismatched sealed monitor and protects the replacement record and key", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const replacement = await service.prepare(new Uint8Array(32).fill(4), normalizedContext());
    const failingRecords: WalletDeviceRecordStore = {
      read: records.read.bind(records),
      readRaw: records.readRaw.bind(records),
      async compareAndSwap(walletAddress, expectedRaw, nextRaw) {
        const changed = await records.compareAndSwap(walletAddress, expectedRaw, nextRaw);
        if (changed && nextRaw !== null) {
          await records.externalCompareAndSwap(walletAddress, nextRaw, replacement.raw);
        }
        return changed;
      },
      subscribe: records.subscribe.bind(records),
    };
    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: failingRecords,
    });

    await expect(client.unlockAndSealDeviceSession(
      new Uint8Array(32).fill(3),
      context,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(records.listenerCount(context.walletAddress)).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(records.read(context.walletAddress)?.raw).toBe(replacement.raw);
    expect(keys.keys.has(replacement.keyId)).toBe(true);
    expect(keys.keys.size).toBe(1);
  });

  it("preserves a cooperating-tab replacement while retiring only the stale open key", async () => {
    const delegate = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const records = new ObservableDeviceRecordStore(delegate);
    const keys = new DeviceMemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(8), context);
    await sealer.lock();
    const stale = records.read(context.walletAddress)!;
    const staleKey = JSON.parse(stale.raw).key_id as string;
    const worker = new InProcessWorker(service);
    const opener = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    await opener.unlockFromDeviceSession(context);
    const replacement = await service.prepare(new Uint8Array(32).fill(9), normalizedContext());

    await expect(records.externalCompareAndSwap(context.walletAddress, stale.raw, replacement.raw)).resolves.toBe(true);
    await vi.waitFor(() => expect(worker.dispatcher.state).toBe("TERMINATED"));
    expect(records.read(context.walletAddress)?.raw).toBe(replacement.raw);
    expect(keys.keys.has(staleKey)).toBe(false);
    expect(keys.keys.has(replacement.keyId)).toBe(true);
  });

  it("rejects a prepared reply whose ownership token does not name its exact record", async () => {
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const prepared = await service.prepare(
      new Uint8Array(32).fill(4),
      normalizedContext(),
    );
    const worker = new ManualWorker();
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: createWalletDeviceRecordStore(new DeviceMemoryStorage()),
    });
    const opening = client.unlockAndSealDeviceSession(new Uint8Array(32).fill(5), context);
    worker.reply({
      type: "device-session-prepared",
      requestId: 1,
      binding: binding(),
      context: normalizedContext(),
      recordRaw: prepared.raw,
      ownershipToken: "ff".repeat(16),
      expiresAtMs: prepared.expiresAtMs,
    });

    await expect(opening).rejects.toMatchObject({ code: "WORKER_FAILED" });
    expect(worker.terminated).toBe(1);
  });

  it("revokes invalid device context without deleting a concurrent replacement", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(1), context);
    await sealer.lock();
    const stale = records.read(context.walletAddress)!;

    const replacementService = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const prepared = await replacementService.prepare(
      new Uint8Array(32).fill(2),
      { ...context, expiresAtMs: context.expiresAtMs },
    );
    const racingService: WalletDeviceWorkerService = {
      ...service,
      async open(raw, workerContext) {
        await records.compareAndSwap(context.walletAddress, stale.raw, prepared.raw);
        return service.open(raw, workerContext);
      },
    };

    const opener = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(racingService),
      deviceRecordStore: records,
    });
    await expect(opener.unlockFromDeviceSession({ ...context, deploymentId: "0x456" })).rejects.toMatchObject({
      code: "DEVICE_SESSION_INVALID",
    });
    expect(records.read(context.walletAddress)?.raw).toBe(prepared.raw);
    expect(keys.keys.has(prepared.keyId)).toBe(true);
  });

  it("aborts the prepared worker session and key when opaque record storage fails", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const failingRecords = {
      read: records.read,
      compareAndSwap() { throw new Error("raw local storage diagnostic"); },
      subscribe: records.subscribe,
    };
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: failingRecords,
    });
    await expect(client.unlockAndSealDeviceSession(new Uint8Array(32).fill(9), context)).rejects.toMatchObject({
      code: "DEVICE_SESSION_FAILED",
      message: "Remembered wallet session failed.",
    });
    expect(keys.keys.size).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances.at(-1)).toMatchObject({ locked: true, freed: true });
  });

  it("preserves a published record and key when the ownership reread fails", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    let reads = 0;
    const ambiguousRecords = {
      read(walletAddress: string) {
        reads += 1;
        if (reads === 2) throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
        return records.read(walletAddress);
      },
      compareAndSwap: records.compareAndSwap,
      subscribe: records.subscribe,
    };
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: ambiguousRecords,
    });

    await expect(client.unlockAndSealDeviceSession(
      new Uint8Array(32).fill(9),
      context,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    const published = records.read(context.walletAddress)!;
    expect(keys.keys.has(JSON.parse(published.raw).key_id)).toBe(true);
    expect(worker.dispatcher.state).toBe("TERMINATED");
  });

  it("keeps the newly published record recoverable when retiring the prior key fails", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const first = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await first.unlockAndSealDeviceSession(new Uint8Array(32).fill(1), context);
    await first.lock();
    const prior = records.read(context.walletAddress)!;
    const priorKeyId = JSON.parse(prior.raw).key_id as string;
    const remove = keys.deleteOwned.bind(keys);
    keys.deleteOwned = async (owner) => {
      if (owner.keyId === priorKeyId) throw new Error("ambiguous indexeddb retirement");
      return remove(owner);
    };

    const secondWorker = new InProcessWorker(service);
    const second = createWalletCryptoClient({
      workerFactory: () => secondWorker,
      deviceRecordStore: records,
    });
    await expect(second.unlockAndSealDeviceSession(
      new Uint8Array(32).fill(2),
      context,
    )).resolves.toMatchObject({ generation: 1 });

    const current = records.read(context.walletAddress)!;
    expect(current.raw).not.toBe(prior.raw);
    expect(keys.keys.has(JSON.parse(current.raw).key_id)).toBe(true);
    expect(keys.keys.has(priorKeyId)).toBe(true);
    expect(secondWorker.dispatcher.state).toBe("OPEN");
    await expect(second.publicConfig()).resolves.toBe(JSON.stringify({ account_id: "wallet-1" }));
  });

  it("detects a cross-tab replacement before commit and protects both replacement and prior keys", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const first = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await first.unlockAndSealDeviceSession(new Uint8Array(32).fill(1), context);
    await first.lock();
    const prior = records.read(context.walletAddress)!;
    const priorKeyId = JSON.parse(prior.raw).key_id as string;
    const replacement = await service.prepare(
      new Uint8Array(32).fill(3),
      normalizedContext(),
    );
    const racingRecords = {
      read: records.read,
      async compareAndSwap(walletAddress: string, expectedRaw: string | null, nextRaw: string | null) {
        const changed = await records.compareAndSwap(walletAddress, expectedRaw, nextRaw);
        if (changed && expectedRaw === prior.raw && nextRaw !== null) {
          await records.compareAndSwap(walletAddress, nextRaw, replacement.raw);
        }
        return changed;
      },
      subscribe: records.subscribe,
    };
    const worker = new InProcessWorker(service);
    const second = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: racingRecords,
    });

    await expect(second.unlockAndSealDeviceSession(
      new Uint8Array(32).fill(2),
      context,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(records.read(context.walletAddress)?.raw).toBe(replacement.raw);
    expect(keys.keys.has(replacement.keyId)).toBe(true);
    expect(keys.keys.has(priorKeyId)).toBe(true);
    expect(keys.keys.size).toBe(2);
    expect(worker.dispatcher.state).toBe("TERMINATED");
  });

  it("fails closed and reports failure when abort cannot confirm prepared-key deletion", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const failingRecords = {
      read: records.read,
      compareAndSwap: async () => false,
      subscribe: records.subscribe,
    };
    const keys = new DeviceMemoryKeyStore();
    keys.deleteOwned = async () => { throw new Error("indexeddb delete unavailable"); };
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: failingRecords,
    });

    await expect(client.unlockAndSealDeviceSession(
      new Uint8Array(32).fill(9),
      context,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(records.read(context.walletAddress)).toBeNull();
    expect(keys.keys.size).toBe(1);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("retires only its own key when a cross-tab replacement wins after the publication fence", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const first = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await first.unlockAndSealDeviceSession(new Uint8Array(32).fill(1), context);
    await first.lock();
    const prior = records.read(context.walletAddress)!;
    const priorKeyId = JSON.parse(prior.raw).key_id as string;
    const replacement = await service.prepare(
      new Uint8Array(32).fill(3),
      normalizedContext(),
    );
    let reads = 0;
    let publishedKeyId = "";
    const racingRecords = {
      read(walletAddress: string) {
        const current = records.read(walletAddress);
        reads += 1;
        if (reads === 2 && current !== null) {
          publishedKeyId = JSON.parse(current.raw).key_id as string;
          records.compareAndSwap(walletAddress, current.raw, replacement.raw);
        }
        return current;
      },
      compareAndSwap: records.compareAndSwap,
      subscribe: records.subscribe,
    };
    const worker = new InProcessWorker(service);
    const second = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: racingRecords,
    });

    await expect(second.unlockAndSealDeviceSession(
      new Uint8Array(32).fill(2),
      context,
    )).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(records.read(context.walletAddress)?.raw).toBe(replacement.raw);
    expect(keys.keys.has(replacement.keyId)).toBe(true);
    expect(keys.keys.has(priorKeyId)).toBe(false);
    expect(keys.keys.has(publishedKeyId)).toBe(false);
    expect(keys.keys.size).toBe(1);
    expect(worker.dispatcher.state).toBe("TERMINATED");
  });

  it("revokes both stores when a remembered session expires before reload", async () => {
    let clock = 10_000;
    const shortContext = { ...context, expiresAtMs: clock + 1_000 };
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys, now: () => clock });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service, () => clock),
      deviceRecordStore: records,
      now: () => clock,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(8), shortContext, 1_000);
    await sealer.lock();
    clock = shortContext.expiresAtMs;
    const opener = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service, () => clock),
      deviceRecordStore: records,
      now: () => clock,
    });
    await expect(opener.unlockFromDeviceSession(shortContext)).rejects.toMatchObject({
      code: "DEVICE_SESSION_EXPIRED",
    });
    expect(records.read(shortContext.walletAddress)).toBeNull();
    expect(keys.keys.size).toBe(0);
  });

  it("removes both the owned record and key when remembered ciphertext is corrupted", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(8), context);
    await sealer.lock();
    const snapshot = records.read(context.walletAddress)!;
    const corrupted = JSON.parse(snapshot.raw);
    corrupted.ciphertext = `${corrupted.ciphertext[0] === "A" ? "B" : "A"}${corrupted.ciphertext.slice(1)}`;
    storage.setItem(
      "zylith.wallet.device-session.v3:0xabc",
      JSON.stringify(corrupted),
    );
    const opener = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });

    await expect(opener.unlockFromDeviceSession(context)).rejects.toMatchObject({
      code: "DEVICE_SESSION_INVALID",
    });
    expect(records.read(context.walletAddress)).toBeNull();
    expect(keys.keys.size).toBe(0);
  });

  it("removes both stores when remembered metadata has noncanonical base64", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(8), context);
    await sealer.lock();
    const snapshot = records.read(context.walletAddress)!;
    const malformed = JSON.parse(snapshot.raw);
    malformed.nonce = malformed.nonce.slice(0, -1);
    const raw = JSON.stringify(malformed);
    storage.setItem("zylith.wallet.device-session.v3:0xabc", raw);
    const opener = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });

    await expect(opener.unlockFromDeviceSession(context)).rejects.toMatchObject({
      code: "DEVICE_SESSION_INVALID",
    });
    expect(storage.getItem("zylith.wallet.device-session.v3:0xabc")).toBeNull();
    expect(keys.keys.size).toBe(0);
  });

  it("keeps the owned record when invalid-session key deletion cannot be confirmed", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(8), context);
    await sealer.lock();
    const snapshot = records.read(context.walletAddress)!;
    keys.deleteOwned = async () => { throw new Error("indexeddb delete unavailable"); };
    const opener = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });

    await expect(opener.unlockFromDeviceSession({
      ...context,
      deploymentId: "0x456",
    })).rejects.toMatchObject({ code: "DEVICE_SESSION_FAILED" });
    expect(records.read(context.walletAddress)?.raw).toBe(snapshot.raw);
    expect(keys.keys.size).toBe(1);
  });

  it("does not delete a device key when record revocation cannot be published", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    const snapshot = records.read(context.walletAddress)!;
    const keyId = JSON.parse(snapshot.raw).key_id as string;
    const failingRecords = {
      read: records.read,
      compareAndSwap() {
        throw new WalletDeviceSessionError("DEVICE_SESSION_FAILED");
      },
      subscribe: records.subscribe,
    };
    const worker = new InProcessWorker(service);
    const revoker = createWalletCryptoClient({
      workerFactory: () => worker,
      deviceRecordStore: failingRecords,
    });

    await expect(revoker.revokeDeviceSession(context)).rejects.toMatchObject({
      code: "DEVICE_SESSION_FAILED",
    });
    expect(records.read(context.walletAddress)?.raw).toBe(snapshot.raw);
    expect(keys.keys.has(keyId)).toBe(true);
    expect(worker.receivedMessages).toHaveLength(0);
  });

  it("revokes an authoritative device record from an open non-device session", async () => {
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    const cachedRaw = records.readRaw?.(context.walletAddress) ?? null;
    expect(cachedRaw).not.toBeNull();
    if (cachedRaw === null) throw new Error("expected cached device record");

    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    await client.unlock(new Uint8Array(32).fill(9), context);

    await expect(client.revokeDeviceSession(context)).resolves.toBeUndefined();
    expect(records.readRaw?.(context.walletAddress)).toBeNull();
    expect(keys.keys.size).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    await expect(service.open(cachedRaw, normalizedContext())).rejects.toEqual(
      new WalletDeviceSessionError("DEVICE_SESSION_INVALID"),
    );
    await expect(client.publicConfig()).rejects.toEqual(
      new WalletCryptoError("CLIENT_INVALIDATED"),
    );
  });

  it("revokes an authoritative device record from an open signature session", async () => {
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    const cachedRaw = records.readRaw?.(context.walletAddress) ?? null;
    expect(cachedRaw).not.toBeNull();
    if (cachedRaw === null) throw new Error("expected cached device record");

    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    const prepared = await client.prepareSignatureVaultCreate(["0x1", "0x2"], context, false);
    await client.commitSignatureVault(prepared);
    await expect(client.finalizeSignatureVault(prepared, false)).resolves.toEqual({ remembered: false });

    await expect(client.revokeDeviceSession(context)).resolves.toBeUndefined();
    expect(records.readRaw?.(context.walletAddress)).toBeNull();
    expect(keys.keys.size).toBe(0);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    await expect(service.open(cachedRaw, normalizedContext())).rejects.toEqual(
      new WalletDeviceSessionError("DEVICE_SESSION_INVALID"),
    );
  });

  it("reports owned-key deletion failure and terminally locks a non-device session", async () => {
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    keys.deleteOwned = async () => { throw new Error("private indexeddb diagnostic"); };

    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    await client.unlock(new Uint8Array(32).fill(9), context);

    let rejected: unknown;
    try {
      await client.revokeDeviceSession(context);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toEqual(new WalletCryptoError("DEVICE_SESSION_FAILED"));
    expect(String(rejected)).not.toContain("private indexeddb diagnostic");
    expect(records.readRaw?.(context.walletAddress)).toBeNull();
    expect(keys.keys.size).toBe(1);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    await expect(client.publicConfig()).rejects.toEqual(
      new WalletCryptoError("CLIENT_INVALIDATED"),
    );
  });

  it("preserves a differently owned key while revoking its stale record from a non-device session", async () => {
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    await sealer.lock();
    const stale = records.read(context.walletAddress)!;
    const details = inspectWalletDeviceRecord(stale.raw);
    keys.owners.set(details.keyId, {
      recordId: "ef".repeat(16),
      keyId: details.keyId,
      walletAddress: details.walletAddress,
      chainId: details.chainId,
      deploymentId: details.deploymentId,
      vaultDeploymentId: details.vaultDeploymentId,
      origin: details.origin,
      manifestIdentity: details.manifestIdentity,
      manifestVersion: details.manifestVersion,
    });

    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    await client.unlock(new Uint8Array(32).fill(9), context);

    await expect(client.revokeDeviceSession(context)).resolves.toBeUndefined();
    expect(records.readRaw?.(context.walletAddress)).toBeNull();
    expect(keys.keys.has(details.keyId)).toBe(true);
    expect(worker.dispatcher.state).toBe("TERMINATED");
  });

  it("rejects a mismatched active revoke before touching either wallet record or key", async () => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    let random = 1;
    const service = createWalletDeviceWorkerService({
      keyStore: keys,
      randomBytes: (length) => new Uint8Array(length).fill(random++),
    });
    const worker = new InProcessWorker(service);
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    await client.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    const active = records.read(context.walletAddress)!;
    const foreignContext = normalizedContext({ ...context, walletAddress: "0xdef" });
    const foreign = await service.prepare(new Uint8Array(32).fill(8), foreignContext);
    await expect(records.compareAndSwap(foreignContext.walletAddress, null, foreign.raw)).resolves.toBe(true);

    await expect(client.revokeDeviceSession(foreignContext)).rejects.toEqual(
      new WalletCryptoError("SESSION_MISMATCH"),
    );
    expect(records.readRaw?.(context.walletAddress)).toBe(active.raw);
    expect(records.readRaw?.(foreignContext.walletAddress)).toBe(foreign.raw);
    expect(keys.keys.size).toBe(2);
    expect(worker.receivedMessages.some((message) => (
      typeof message === "object" && message !== null
      && (message as { kind?: unknown }).kind === "revoke-device-session"
    ))).toBe(false);
    await expect(client.publicConfig()).resolves.toContain("wallet-1");
  });

  it.each([
    ["chain", { chainId: "0x1" }],
    ["exchange", { deploymentId: "0x999" }],
    ["vault", { vaultDeploymentId: "0x999" }],
    ["origin", { origin: "https://other.zylith.fi" }],
    ["manifest", { manifestIdentity: `sha256:${"cd".repeat(32)}` }],
    ["expiry", { expiresAtMs: context.expiresAtMs + 8 * 24 * 60 * 60 * 1_000 }],
  ])("rejects an inactive fresh revoke with mismatched %s context before mutation", async (_name, change) => {
    const storage = new DeviceMemoryStorage();
    const records = createWalletDeviceRecordStore(storage);
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const sealer = createWalletCryptoClient({
      workerFactory: () => new InProcessWorker(service),
      deviceRecordStore: records,
    });
    await sealer.unlockAndSealDeviceSession(new Uint8Array(32).fill(4), context);
    await sealer.lock();
    const before = records.readRaw?.(context.walletAddress) ?? null;
    const keyCount = keys.keys.size;
    const worker = new InProcessWorker(service);
    const revoker = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });

    await expect(revoker.revokeDeviceSession({ ...context, ...change })).rejects.toEqual(
      new WalletCryptoError("DEVICE_SESSION_INVALID"),
    );
    expect(records.readRaw?.(context.walletAddress)).toBe(before);
    expect(keys.keys.size).toBe(keyCount);
    expect(worker.receivedMessages).toHaveLength(0);
  });

  it("locks on explicit revoke while preserving a concurrent same-key replacement", async () => {
    const records = createWalletDeviceRecordStore(new DeviceMemoryStorage());
    const keys = new DeviceMemoryKeyStore();
    const worker = new InProcessWorker(createWalletDeviceWorkerService({ keyStore: keys }));
    const client = createWalletCryptoClient({ workerFactory: () => worker, deviceRecordStore: records });
    await client.unlockAndSealDeviceSession(new Uint8Array(32).fill(6), context);
    const active = records.read(context.walletAddress)!;
    const details = inspectWalletDeviceRecord(active.raw);
    const replacement = JSON.parse(active.raw) as Record<string, unknown>;
    replacement.record_id = "ef".repeat(16);
    const replacementRaw = JSON.stringify(replacement);
    keys.owners.set(details.keyId, {
      recordId: replacement.record_id as string,
      keyId: details.keyId,
      walletAddress: details.walletAddress,
      chainId: details.chainId,
      deploymentId: details.deploymentId,
      vaultDeploymentId: details.vaultDeploymentId,
      origin: details.origin,
      manifestIdentity: details.manifestIdentity,
      manifestVersion: details.manifestVersion,
    });
    await expect(records.compareAndSwap(context.walletAddress, active.raw, replacementRaw)).resolves.toBe(true);

    await expect(client.revokeDeviceSession(context)).resolves.toBeUndefined();
    expect(records.readRaw?.(context.walletAddress)).toBe(replacementRaw);
    expect(keys.keys.has(details.keyId)).toBe(true);
    expect(worker.dispatcher.state).toBe("TERMINATED");
    await expect(client.publicConfig()).rejects.toEqual(
      new WalletCryptoError("CLIENT_INVALIDATED"),
    );
  });

  it("accepts genuine cross-realm dedicated seed views and rejects non-ASCII semantic identifiers", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    try {
      const foreign = frame.contentWindow;
      if (!foreign) throw new Error("foreign realm unavailable");
      const ForeignUint8Array = (foreign as unknown as typeof globalThis).Uint8Array;
      const seed = new ForeignUint8Array(32);
      seed.fill(9);
      const dispatcher = createWalletCryptoWorkerDispatcher({
        loadWalletModule: async () => testModule(),
        randomBytes: (length) => new Uint8Array(length).fill(7),
        setTimer: () => 1 as ReturnType<typeof setTimeout>,
        clearTimer: () => undefined,
      });
      await expect(dispatcher.dispatch({ kind: "unlock", requestId: 1, seed, context })).resolves.toMatchObject({
        type: "unlocked",
      });
      expect(seed).toEqual(new ForeignUint8Array(32));
    } finally {
      frame.remove();
    }

    for (const invalid of [
      { ...context, manifestIdentity: "zylith-β" },
      { ...context, manifestVersion: "３" },
    ]) {
      expect(() => normalizeWalletWorkerContext(invalid)).toThrow();
    }
  });

  it("routes every WalletSession operation through the closed command set", async () => {
    const client = createWalletCryptoClient({ workerFactory: () => new InProcessWorker() });
    await client.unlock(new Uint8Array(32).fill(3), context);
    const input = '{"value":"fixed"}';
    const operations: Array<[string, () => Promise<string>]> = [
      ["publicConfig", () => client.publicConfig()],
      ["recoveryAuthTag", () => client.recoveryAuthTag()],
      ["deriveProofSigner", () => client.deriveProofSigner(input)],
      ["encryptLocalState", () => client.encryptLocalState(input)],
      ["decryptLocalState", () => client.decryptLocalState(input)],
      ["buildDepositSubmissionPlan", () => client.buildDepositSubmissionPlan(input)],
      ["buildOrderRequest", () => client.buildOrderRequest(input)],
      ["buildCancelRequest", () => client.buildCancelRequest(input)],
      ["buildStatusRequests", () => client.buildStatusRequests(input)],
      ["buildWithdrawRequest", () => client.buildWithdrawRequest(input)],
      ["buildResidualRecovery", () => client.buildResidualRecovery(input)],
      ["createRecoverySnapshot", () => client.createRecoverySnapshot(input)],
      ["decryptRecoveryArtifact", () => client.decryptRecoveryArtifact(input)],
      ["signStrk20ExitClaim", () => client.signStrk20ExitClaim(input)],
    ];
    for (const [operation, invoke] of operations) {
      const result = await invoke();
      expect(typeof result, operation).toBe("string");
    }
    expect(FakeWalletSession.instances[0].calls.map(([operation]) => operation)).toEqual(
      operations.map(([operation]) => operation),
    );
  });

  it("maps closed decrypt outcomes without inspecting thrown error strings", async () => {
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    await client.unlock(new Uint8Array(32).fill(3), context);
    await expect(client.decryptLocalState("migration")).rejects.toEqual(
      new WalletCryptoError("MIGRATION_REQUIRED"),
    );
    await expect(client.decryptRecoveryArtifact("invalid")).rejects.toEqual(
      new WalletCryptoError("OPERATION_FAILED"),
    );
    await expect(client.decryptLocalState('{"value":"fixed"}')).resolves.toContain(
      "decryptLocalState",
    );
  });

  it(
    "accepts a maximum-size escape-heavy classified result and rejects the first oversized byte",
    async () => {
      const client = createWalletCryptoClient({ workerFactory: () => new InProcessWorker() });
      await client.unlock(new Uint8Array(32).fill(3), context);
      const result = await client.decryptLocalState("escape-heavy");
      expect(result.length).toBe(4 * 1024 * 1024);
      expect(result[0]).toBe("\\");
      expect(result.at(-1)).toBe("\\");
      await expect(client.decryptRecoveryArtifact("escape-heavy-recovery")).resolves.toHaveLength(
        4 * 1024 * 1024,
      );

      await expect(client.decryptLocalState("oversize-result")).rejects.toEqual(
        new WalletCryptoError("WORKER_FAILED"),
      );
    },
    20_000,
  );

  it.each(["malformed-outcome", "malformed-base64", "throw-outcome"])(
    "terminally fails on an unexpected classified decrypt %s",
    async (input) => {
      const worker = new InProcessWorker();
      const client = createWalletCryptoClient({ workerFactory: () => worker });
      await client.unlock(new Uint8Array(32).fill(3), context);
      await expect(client.decryptLocalState(input)).rejects.toEqual(
        new WalletCryptoError("WORKER_FAILED"),
      );
      expect(worker.dispatcher.state).toBe("TERMINATED");
      await expect(client.publicConfig()).rejects.toEqual(
        new WalletCryptoError("CLIENT_INVALIDATED"),
      );
    },
  );

  it("does not expose the mutable binding object retained by the client", async () => {
    const client = createWalletCryptoClient({ workerFactory: () => new InProcessWorker() });
    const exposed = await client.unlock(new Uint8Array(32).fill(3), context);
    exposed.sessionId = `wcs_${"ff".repeat(16)}`;
    exposed.generation = 99;
    exposed.contextToken = "changed";
    await expect(client.publicConfig()).resolves.toBe(JSON.stringify({ account_id: "wallet-1" }));
  });

  it("leaves no session after initial constructor failure and safely retries before any successful open", async () => {
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    FakeWalletSession.failConstruction = true;
    const failedSeed = new Uint8Array(32).fill(2);
    await expect(client.unlock(failedSeed, context)).rejects.toMatchObject({
      code: "OPERATION_FAILED",
      message: "Wallet operation failed.",
    });
    expect(FakeWalletSession.instances).toHaveLength(0);
    expect(worker.dispatcher.state).toBe("LOCKED");
    expect(failedSeed.byteLength).toBe(0);
    const failedUnlock = worker.receivedMessages[0] as { seed: Uint8Array };
    expect(Array.from(failedUnlock.seed)).toEqual(Array(32).fill(0));
    FakeWalletSession.failConstruction = false;
    await expect(client.unlock(new Uint8Array(32).fill(3), context)).resolves.toMatchObject({ generation: 2 });
    expect(worker.dispatcher.state).toBe("OPEN");
    expect(FakeWalletSession.instances).toHaveLength(1);
  });

  it("wipes malformed and late transferred seed candidates before terminating", async () => {
    const worker = new InProcessWorker();
    const malformedSeed = new Uint8Array(31).fill(9);
    await expect(worker.dispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: malformedSeed,
      context,
    })).resolves.toMatchObject({ type: "fatal", error: { code: "INVALID_MESSAGE" } });
    expect(malformedSeed).toEqual(new Uint8Array(31));
    const lateSeed = new Uint8Array(32).fill(8);
    await expect(worker.dispatcher.dispatch({
      kind: "unlock",
      requestId: 2,
      seed: lateSeed,
      context,
    })).resolves.toMatchObject({ type: "fatal", error: { code: "INVALID_MESSAGE" } });
    expect(lateSeed).toEqual(new Uint8Array(32));
  });

  it("wipes the entire backing store of malformed seed data descriptors without invoking accessors", async () => {
    async function rejectAndCheck(candidate: object, backing: ArrayBufferLike) {
      const dispatcher = createWalletCryptoWorkerDispatcher({
        loadWalletModule: async () => testModule(),
        setTimer: () => 1 as ReturnType<typeof setTimeout>,
        clearTimer: () => undefined,
      });
      await expect(dispatcher.dispatch(candidate)).resolves.toMatchObject({
        type: "fatal",
        error: { code: "INVALID_MESSAGE" },
      });
      expect(Array.from(new Uint8Array(backing))).toEqual(Array(backing.byteLength).fill(0));
    }

    const arrayBacking = new ArrayBuffer(40);
    new Uint8Array(arrayBacking).fill(1);
    const arrayRoot = Object.assign([], {
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(arrayBacking, 4, 32),
      context,
    });
    await rejectAndCheck(arrayRoot, arrayBacking);

    const prototypeBacking = new ArrayBuffer(32);
    new Uint8Array(prototypeBacking).fill(2);
    const nonPlain = Object.assign(Object.create({ inherited: true }), {
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(prototypeBacking),
      context,
    });
    await rejectAndCheck(nonPlain, prototypeBacking);

    const extraBacking = new ArrayBuffer(64);
    new Uint8Array(extraBacking).fill(3);
    await rejectAndCheck({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(extraBacking, 16, 32),
      context,
      extra: true,
    }, extraBacking);

    const symbolBacking = new ArrayBuffer(32);
    new Uint8Array(symbolBacking).fill(4);
    await rejectAndCheck(Object.assign({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(symbolBacking),
      context,
    }, { [Symbol("forbidden")]: true }), symbolBacking);

    if (typeof SharedArrayBuffer !== "undefined") {
      const sharedBacking = new SharedArrayBuffer(32);
      new Uint8Array(sharedBacking).fill(5);
      await rejectAndCheck({
        kind: "unlock",
        requestId: 1,
        seed: new Uint8Array(sharedBacking),
        context,
      }, sharedBacking);
    }

    let getterCalls = 0;
    const hiddenSeed = new Uint8Array(32).fill(6);
    const accessorRoot = { kind: "unlock", requestId: 1, context } as Record<string, unknown>;
    Object.defineProperty(accessorRoot, "seed", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return hiddenSeed;
      },
    });
    const accessorDispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
    });
    await expect(accessorDispatcher.dispatch(accessorRoot)).resolves.toMatchObject({
      type: "fatal",
      error: { code: "INVALID_MESSAGE" },
    });
    expect(getterCalls).toBe(0);
    expect(hiddenSeed).toEqual(new Uint8Array(32).fill(6));

    let typedArrayGetterCalls = 0;
    const accessorSeed = new Uint8Array(32).fill(7);
    Object.defineProperty(accessorSeed, "buffer", {
      configurable: true,
      get() {
        typedArrayGetterCalls += 1;
        throw new Error("must not run");
      },
    });
    const accessorSeedDispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    await expect(accessorSeedDispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: accessorSeed,
      context,
    })).resolves.toMatchObject({ type: "unlocked" });
    expect(typedArrayGetterCalls).toBe(0);
    expect(accessorSeed).toEqual(new Uint8Array(32));

    let proxyReads = 0;
    const proxiedBacking = new Uint8Array(32).fill(8);
    const proxiedSeed = new Proxy(proxiedBacking, {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const proxyDispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
    });
    await expect(proxyDispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: proxiedSeed,
      context,
    })).resolves.toMatchObject({ type: "fatal", error: { code: "INVALID_MESSAGE" } });
    expect(proxyReads).toBe(0);
    expect(proxiedBacking).toEqual(new Uint8Array(32).fill(8));
  });

  it("immediately wipes queued unlocks and prevents resurrection when terminated during module loading", async () => {
    let release!: (module: WalletSessionModule) => void;
    const moduleReady = new Promise<WalletSessionModule>((resolve) => { release = resolve; });
    let defaultCalls = 0;
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: () => moduleReady,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    const activeSeed = new Uint8Array(32).fill(1);
    const queuedSeed = new Uint8Array(32).fill(2);
    const active = dispatcher.dispatch({ kind: "unlock", requestId: 1, seed: activeSeed, context });
    const queued = dispatcher.dispatch({ kind: "unlock", requestId: 2, seed: queuedSeed, context });
    await Promise.resolve();
    expect(dispatcher.state).toBe("BOOTING");
    dispatcher.terminate("CLIENT_INVALIDATED");
    expect(activeSeed).toEqual(new Uint8Array(32));
    expect(queuedSeed).toEqual(new Uint8Array(32));
    release({
      default: async () => { defaultCalls += 1; },
      WalletSession: FakeWalletSession,
    });
    await expect(active).resolves.toMatchObject({ type: "fatal", error: { code: "CLIENT_INVALIDATED" } });
    await expect(queued).resolves.toMatchObject({ type: "fatal", error: { code: "CLIENT_INVALIDATED" } });
    expect(defaultCalls).toBe(0);
    expect(FakeWalletSession.instances).toHaveLength(0);
    expect(dispatcher.state).toBe("TERMINATED");
  });

  it("fail-stops immediately on a malformed late dispatch while an unlock is booting", async () => {
    let release!: (module: WalletSessionModule) => void;
    const moduleReady = new Promise<WalletSessionModule>((resolve) => { release = resolve; });
    const dispatcher = createWalletCryptoWorkerDispatcher({ loadWalletModule: () => moduleReady });
    const activeSeed = new Uint8Array(32).fill(1);
    const opening = dispatcher.dispatch({ kind: "unlock", requestId: 1, seed: activeSeed, context });
    await Promise.resolve();
    const malformedBacking = new ArrayBuffer(48);
    new Uint8Array(malformedBacking).fill(2);
    const malformed = {
      kind: "unlock",
      requestId: 2,
      seed: new Uint8Array(malformedBacking, 8, 32),
      context,
      extra: true,
    };
    await expect(dispatcher.dispatch(malformed)).resolves.toMatchObject({
      type: "fatal",
      error: { code: "INVALID_MESSAGE" },
    });
    expect(activeSeed).toEqual(new Uint8Array(32));
    expect(new Uint8Array(malformedBacking)).toEqual(new Uint8Array(48));
    expect(dispatcher.state).toBe("TERMINATED");
    release(testModule());
    await expect(opening).resolves.toMatchObject({ type: "fatal", error: { code: "INVALID_MESSAGE" } });
    expect(FakeWalletSession.instances).toHaveLength(0);
  });

  it("fail-stops immediately on a duplicate queued request ID and wipes every unlock", async () => {
    let release!: (module: WalletSessionModule) => void;
    const moduleReady = new Promise<WalletSessionModule>((resolve) => { release = resolve; });
    const dispatcher = createWalletCryptoWorkerDispatcher({ loadWalletModule: () => moduleReady });
    const activeSeed = new Uint8Array(32).fill(1);
    const duplicateSeed = new Uint8Array(32).fill(2);
    const opening = dispatcher.dispatch({ kind: "unlock", requestId: 1, seed: activeSeed, context });
    await Promise.resolve();
    await expect(dispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: duplicateSeed,
      context,
    })).resolves.toMatchObject({ type: "fatal", error: { code: "INVALID_MESSAGE" } });
    expect(dispatcher.state).toBe("TERMINATED");
    expect(activeSeed).toEqual(new Uint8Array(32));
    expect(duplicateSeed).toEqual(new Uint8Array(32));
    release(testModule());
    await expect(opening).resolves.toMatchObject({ type: "fatal", error: { code: "INVALID_MESSAGE" } });
    expect(FakeWalletSession.instances).toHaveLength(0);
  });

  it("cancels safely during asynchronous wasm initialization and never publishes a session", async () => {
    let release!: () => void;
    let initializationStarted!: () => void;
    const started = new Promise<void>((resolve) => { initializationStarted = resolve; });
    const initialize = new Promise<void>((resolve) => { release = resolve; });
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => ({
        default: async () => {
          initializationStarted();
          await initialize;
        },
        WalletSession: FakeWalletSession,
      }),
    });
    const seed = new Uint8Array(32).fill(3);
    const opening = dispatcher.dispatch({ kind: "unlock", requestId: 1, seed, context });
    await started;
    dispatcher.terminate("CLIENT_INVALIDATED");
    expect(seed).toEqual(new Uint8Array(32));
    release();
    await expect(opening).resolves.toMatchObject({ type: "fatal", error: { code: "CLIENT_INVALIDATED" } });
    expect(FakeWalletSession.instances).toHaveLength(0);
  });

  it("cleans every pre-publication failure and permits only a safe initial retry", async () => {
    let randomFails = true;
    const randomDispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => {
        if (randomFails) throw new Error("random failure must be sanitized");
        return new Uint8Array(length).fill(7);
      },
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    await expect(randomDispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(32).fill(4),
      context,
    })).resolves.toMatchObject({ type: "error", error: { code: "OPERATION_FAILED" } });
    expect(FakeWalletSession.instances).toHaveLength(0);
    expect(randomDispatcher.state).toBe("LOCKED");
    randomFails = false;
    await expect(randomDispatcher.dispatch({
      kind: "unlock",
      requestId: 2,
      seed: new Uint8Array(32).fill(5),
      context,
    })).resolves.toMatchObject({ type: "unlocked", binding: { generation: 2 } });

    FakeWalletSession.instances = [];
    let publicationFails = true;
    const publicationDispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(8),
      beforePublish: () => {
        if (publicationFails) throw new Error("publication failure must be sanitized");
      },
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    await expect(publicationDispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(32).fill(6),
      context,
    })).resolves.toMatchObject({ type: "error", error: { code: "OPERATION_FAILED" } });
    expect(FakeWalletSession.instances).toHaveLength(1);
    expect(FakeWalletSession.instances[0]).toMatchObject({ locked: true, freed: true });
    expect(publicationDispatcher.state).toBe("LOCKED");
    publicationFails = false;
    await expect(publicationDispatcher.dispatch({
      kind: "unlock",
      requestId: 2,
      seed: new Uint8Array(32).fill(7),
      context,
    })).resolves.toMatchObject({ type: "unlocked", binding: { generation: 2 } });
    expect(FakeWalletSession.instances).toHaveLength(2);
  });

  it("terminalizes on wasm initialization failure without caching or retrying the failed module", async () => {
    let loads = 0;
    let initializations = 0;
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => {
        loads += 1;
        return {
          default: async () => {
            initializations += 1;
            throw new Error("wasm initialization detail");
          },
          WalletSession: FakeWalletSession,
        };
      },
    });
    await expect(dispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(32).fill(8),
      context,
    })).resolves.toEqual({
      type: "fatal",
      error: { code: "WORKER_FAILED", message: "Wallet security worker failed." },
    });
    const retrySeed = new Uint8Array(32).fill(9);
    await expect(dispatcher.dispatch({ kind: "unlock", requestId: 2, seed: retrySeed, context })).resolves.toMatchObject({
      type: "fatal",
      error: { code: "WORKER_FAILED" },
    });
    expect(retrySeed).toEqual(new Uint8Array(32));
    expect(loads).toBe(1);
    expect(initializations).toBe(1);
    expect(FakeWalletSession.instances).toHaveLength(0);
  });

  it("initializes a loaded wasm module exactly once across a safe constructor retry", async () => {
    let loads = 0;
    let initializations = 0;
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => {
        loads += 1;
        return {
          default: async () => { initializations += 1; },
          WalletSession: FakeWalletSession,
        };
      },
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    FakeWalletSession.failConstruction = true;
    await expect(dispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(32).fill(1),
      context,
    })).resolves.toMatchObject({ type: "error", error: { code: "OPERATION_FAILED" } });
    FakeWalletSession.failConstruction = false;
    await expect(dispatcher.dispatch({
      kind: "unlock",
      requestId: 2,
      seed: new Uint8Array(32).fill(2),
      context,
    })).resolves.toMatchObject({ type: "unlocked", binding: { generation: 2 } });
    expect(loads).toBe(1);
    expect(initializations).toBe(1);
  });

  it("rejects stale session, generation, and context bindings before invoking an operation", async () => {
    const worker = new InProcessWorker();
    const first = await worker.dispatcher.dispatch({
      kind: "unlock",
      requestId: 1,
      seed: new Uint8Array(32).fill(1),
      context,
    });
    expect(first.type).toBe("unlocked");
    if (first.type !== "unlocked") throw new Error("test setup failed");
    const variants = [
      { ...first.binding, sessionId: `wcs_${"08".repeat(16)}` },
      { ...first.binding, generation: 2 },
      { ...first.binding, contextToken: `${first.binding.contextToken}x` },
    ];
    for (const stale of variants) {
      await expect(worker.dispatcher.dispatch({
        kind: "public-config",
        requestId: variants.indexOf(stale) + 2,
        binding: stale,
      })).resolves.toMatchObject({ type: "error", error: { code: "SESSION_MISMATCH" } });
    }
    expect(FakeWalletSession.instances[0].calls).toEqual([]);
  });

  it.each([
    { kind: "unknown", requestId: 2 },
    { kind: "public-config", requestId: 2, binding: binding(), extra: true },
    { kind: "public-config", requestId: 2, binding: { ...binding(), extra: true } },
  ])("terminates on unknown or non-exact command %#", async (malformed) => {
    const worker = new InProcessWorker();
    await worker.dispatcher.dispatch({ kind: "unlock", requestId: 1, seed: new Uint8Array(32), context });
    const session = FakeWalletSession.instances[0];
    await expect(worker.dispatcher.dispatch(malformed)).resolves.toEqual({
      type: "fatal",
      error: { code: "INVALID_MESSAGE", message: "Invalid wallet worker message." },
    });
    expect(worker.dispatcher.state).toBe("TERMINATED");
    expect(session).toMatchObject({ locked: true, freed: true });
    expect(session.calls).toEqual([]);
  });

  it("executes concurrently received commands in FIFO order and terminally rejects a second unlock", async () => {
    let release!: () => void;
    const moduleReady = new Promise<void>((resolve) => { release = resolve; });
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => { await moduleReady; return testModule(); },
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });
    expect(dispatcher.state).toBe("ABSENT");
    const first = dispatcher.dispatch({ kind: "unlock", requestId: 1, seed: new Uint8Array(32).fill(1), context });
    const second = dispatcher.dispatch({ kind: "unlock", requestId: 2, seed: new Uint8Array(32).fill(2), context });
    await Promise.resolve();
    expect(dispatcher.state).toBe("BOOTING");
    release();
    await expect(first).resolves.toMatchObject({ type: "unlocked", binding: { generation: 1 } });
    await expect(second).resolves.toMatchObject({ type: "fatal", error: { code: "SESSION_ACTIVE" } });
    expect(dispatcher.state).toBe("TERMINATED");
    expect(FakeWalletSession.instances.map((session) => session.seedAtConstruction[0])).toEqual([1]);
    expect(FakeWalletSession.instances[0]).toMatchObject({ locked: true, freed: true });
    await expect(dispatcher.dispatch({ kind: "unlock", requestId: 2, seed: new Uint8Array(32).fill(3), context })).resolves.toMatchObject({
      type: "fatal",
      error: { code: "SESSION_ACTIVE" },
    });
    expect(FakeWalletSession.instances).toHaveLength(1);
  });

  it("awaits prepared-key cleanup before terminally rejecting a second device unlock", async () => {
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys });
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      deviceSessions: service,
    });
    await expect(dispatcher.dispatch({
      kind: "unlock-and-seal-device",
      requestId: 1,
      seed: new Uint8Array(32).fill(1),
      context,
      ttlMs: 24 * 60 * 60 * 1_000,
      priorRecordRaw: null,
    })).resolves.toMatchObject({ type: "device-session-prepared" });
    const entered = deferred<void>();
    const resume = deferred<void>();
    const remove = keys.deleteOwned.bind(keys);
    keys.deleteOwned = async (owner) => {
      entered.resolve();
      await resume.promise;
      return remove(owner);
    };
    let settled = false;
    const second = dispatcher.dispatch({
      kind: "unlock-and-seal-device",
      requestId: 2,
      seed: new Uint8Array(32).fill(2),
      context,
      ttlMs: 24 * 60 * 60 * 1_000,
      priorRecordRaw: null,
    }).finally(() => { settled = true; });
    await entered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    resume.resolve();

    await expect(second).resolves.toMatchObject({
      type: "fatal",
      error: { code: "SESSION_ACTIVE" },
    });
    expect(keys.keys.size).toBe(0);
    expect(dispatcher.state).toBe("TERMINATED");
  });

  it("preserves the committed device key when the worker session expires before commit acknowledgement", async () => {
    let clock = 1_000;
    const expiringContext = { ...context, expiresAtMs: 1_500 };
    const keys = new DeviceMemoryKeyStore();
    const service = createWalletDeviceWorkerService({ keyStore: keys, now: () => clock });
    const dispatcher = createWalletCryptoWorkerDispatcher({
      loadWalletModule: async () => testModule(),
      randomBytes: (length) => new Uint8Array(length).fill(7),
      now: () => clock,
      setTimer: () => 1 as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
      deviceSessions: service,
    });
    const prepared = await dispatcher.dispatch({
      kind: "unlock-and-seal-device",
      requestId: 1,
      seed: new Uint8Array(32).fill(1),
      context: expiringContext,
      ttlMs: 1_000,
      priorRecordRaw: null,
    });
    expect(prepared).toMatchObject({ type: "device-session-prepared" });
    if (prepared.type !== "device-session-prepared") throw new Error("expected prepared device session");
    clock = expiringContext.expiresAtMs;

    await expect(dispatcher.dispatch({
      kind: "commit-device-session",
      requestId: 2,
      binding: prepared.binding,
      ownershipToken: prepared.ownershipToken,
      priorRecordRaw: null,
    })).resolves.toMatchObject({ type: "error", error: { code: "SESSION_EXPIRED" } });
    expect(keys.keys.size).toBe(1);
    expect(dispatcher.state).toBe("TERMINATED");
  });

  it("associates concurrent out-of-order replies with their request IDs", async () => {
    const worker = new ManualWorker();
    const client = await openManualClient(worker);
    const first = client.publicConfig();
    const second = client.recoveryAuthTag();
    worker.reply({ type: "result", requestId: 3, result: "second" });
    worker.reply({ type: "result", requestId: 2, result: "first" });
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
  });

  it("fails closed on unsolicited and duplicate syntactically valid reply IDs", async () => {
    const unsolicitedWorker = new ManualWorker();
    const unsolicitedClient = await openManualClient(unsolicitedWorker);
    const first = unsolicitedClient.publicConfig();
    const second = unsolicitedClient.recoveryAuthTag();
    unsolicitedWorker.reply({ type: "result", requestId: 99, result: "unsolicited" });
    await expect(first).rejects.toMatchObject({ code: "WORKER_FAILED" });
    await expect(second).rejects.toMatchObject({ code: "WORKER_FAILED" });
    expect(unsolicitedWorker.terminated).toBe(1);
    unsolicitedWorker.reply({ type: "result", requestId: 2, result: "late" });
    expect(unsolicitedWorker.terminated).toBe(1);

    const duplicateWorker = new ManualWorker();
    const duplicateClient = await openManualClient(duplicateWorker);
    const completed = duplicateClient.publicConfig();
    duplicateWorker.reply({ type: "result", requestId: 2, result: "once" });
    await expect(completed).resolves.toBe("once");
    duplicateWorker.reply({ type: "result", requestId: 2, result: "twice" });
    expect(duplicateWorker.terminated).toBe(1);
    await expect(duplicateClient.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("invalidates an unlock reply bound to a different immutable context", async () => {
    const worker = new ManualWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const opening = client.unlock(new Uint8Array(32).fill(9), context);
    worker.reply({
      ...unlockedReply(1),
      context: normalizedContext(),
      binding: {
        ...binding(),
        contextToken: walletWorkerContextToken(normalizeWalletWorkerContext({ ...context, walletAddress: "0xdef" })),
      },
    });
    await expect(opening).rejects.toMatchObject({ code: "WORKER_FAILED" });
    expect(worker.terminated).toBe(1);
  });

  it("invalidates and rejects all pending calls on worker error or messageerror", async () => {
    for (const failure of ["error", "messageerror"] as const) {
      const worker = new ManualWorker();
      const client = await openManualClient(worker);
      const first = client.publicConfig();
      const second = client.recoveryAuthTag();
      worker.fail(failure);
      await expect(first).rejects.toMatchObject({ code: "WORKER_FAILED", message: "Wallet security worker failed." });
      await expect(second).rejects.toMatchObject({ code: "WORKER_FAILED", message: "Wallet security worker failed." });
      expect(worker.terminated).toBe(1);
      expect(worker.sent).toHaveLength(3);
      await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
      expect(worker.sent).toHaveLength(3);
    }
  });

  it("notifies invalidation once after terminal cleanup and contains reentrant observer failures", async () => {
    for (const failure of ["error", "messageerror"] as const) {
      const worker = new ManualWorker();
      const observed: string[] = [];
      let client!: ReturnType<typeof createWalletCryptoClient>;
      client = createWalletCryptoClient({
        workerFactory: () => worker,
        onInvalidated: (code) => {
          observed.push(code);
          expect(worker.terminated).toBe(1);
          expect(worker.listeners.message.size).toBe(0);
          expect(worker.listeners.error.size).toBe(0);
          expect(worker.listeners.messageerror.size).toBe(0);
          client.dispose();
          throw new Error("observer detail must be contained");
        },
      });
      const opening = client.unlock(new Uint8Array(32).fill(9), context);
      worker.reply(unlockedReply(1));
      await opening;
      const pending = client.publicConfig();
      worker.fail(failure);
      await expect(pending).rejects.toMatchObject({ code: "WORKER_FAILED" });
      await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
      client.dispose();
      expect(observed).toEqual(["WORKER_FAILED"]);
      expect(worker.terminated).toBe(1);
    }
  });

  it("notifies exact expiry once before ignoring a late reply", async () => {
    const worker = new ManualWorker();
    const timers: Array<() => void> = [];
    const observed: string[] = [];
    let now = context.expiresAtMs - 1;
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      now: () => now,
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
      onInvalidated: (code) => observed.push(code),
    });
    const opening = client.unlock(new Uint8Array(32).fill(9), context);
    worker.reply(unlockedReply(1));
    await opening;
    const pending = client.publicConfig();
    now = context.expiresAtMs;
    timers[1]?.();
    await expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    worker.reply({ type: "result", requestId: 2, result: "late" });
    client.dispose();
    expect(observed).toEqual(["SESSION_EXPIRED"]);
    expect(worker.terminated).toBe(1);
  });

  it("invalidates every pending call on a fatal or malformed reply and ignores late replies", async () => {
    for (const reply of [
      { type: "fatal", error: { code: "INVALID_MESSAGE", message: "Invalid wallet worker message." } },
      { type: "result", requestId: 2, result: "x", extra: "forbidden" },
    ]) {
      const worker = new ManualWorker();
      const client = await openManualClient(worker);
      const first = client.publicConfig();
      const second = client.recoveryAuthTag();
      worker.reply(reply);
      await expect(first).rejects.toMatchObject({ code: "WORKER_FAILED" });
      await expect(second).rejects.toMatchObject({ code: "WORKER_FAILED" });
      worker.reply({ type: "result", requestId: 2, result: "late" });
      expect(worker.terminated).toBe(1);
      expect(worker.sent).toHaveLength(3);
    }
  });

  it("posts one terminal worker reply, suppresses an in-flight reply, and contains dispatch rejection", async () => {
    const posted: unknown[] = [];
    let closes = 0;
    const terminate = vi.fn();
    const sink = createWalletCryptoWorkerReplySink({
      postMessage: (message) => posted.push(structuredClone(message)),
      close: () => { closes += 1; },
    }, terminate);
    sink.fail("SESSION_EXPIRED");
    sink.post({ type: "result", requestId: 1, result: "late" });
    expect(posted).toEqual([{
      type: "fatal",
      error: { code: "SESSION_EXPIRED", message: "Wallet session expired." },
    }]);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(closes).toBe(1);

    let rejectionCloses = 0;
    const rejectingDispatcher: WalletCryptoWorkerDispatcher = {
      state: "ABSENT",
      terminalReason: null,
      dispatch: async () => { throw new Error("dispatcher detail"); },
      terminate: vi.fn(),
    };
    const rejectionPosts: unknown[] = [];
    const rejectionSink = createWalletCryptoWorkerReplySink({
      postMessage: (message) => rejectionPosts.push(message),
      close: () => { rejectionCloses += 1; },
    }, (code) => rejectingDispatcher.terminate(code));
    await expect(dispatchWalletCryptoWorkerMessage(
      rejectingDispatcher,
      rejectionSink,
      { private: "must not escape" },
    )).resolves.toBeUndefined();
    expect(rejectionPosts).toEqual([{
      type: "fatal",
      error: { code: "WORKER_FAILED", message: "Wallet security worker failed." },
    }]);
    expect(rejectingDispatcher.terminate).toHaveBeenCalledWith("WORKER_FAILED");
    expect(rejectionCloses).toBe(1);

    const failedPostTerminate = vi.fn();
    const failedPostSink = createWalletCryptoWorkerReplySink({
      postMessage: () => { throw new Error("host post failed"); },
      close: () => undefined,
    }, failedPostTerminate);
    expect(() => failedPostSink.post({ type: "result", requestId: 1, result: "x" })).not.toThrow();
    expect(failedPostTerminate).toHaveBeenCalledWith("WORKER_FAILED");
    expect(failedPostSink.closed).toBe(true);
  });

  it("lets FIFO work settle before lock, rejects new work, and then terminalizes the client", async () => {
    const worker = new ManualWorker();
    const client = await openManualClient(worker);
    const pending = client.publicConfig();
    const locking = client.lock();
    await expect(client.recoveryAuthTag()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
    expect(worker.sent).toHaveLength(3);
    worker.reply({ type: "result", requestId: 2, result: "before-lock" });
    await expect(pending).resolves.toBe("before-lock");
    worker.reply({ type: "locked", requestId: 3, generation: 2 });
    await expect(locking).resolves.toBeUndefined();
    expect(worker.terminated).toBe(1);
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("expires the client while operations and lock are pending with one consistent error", async () => {
    const worker = new ManualWorker();
    let now = 5_000;
    let expire: (() => void) | null = null;
    const expiringContext = { ...context, expiresAtMs: now + 100 };
    const client = createWalletCryptoClient({
      workerFactory: () => worker,
      now: () => now,
      setTimer: (callback, milliseconds) => {
        if (milliseconds === 100) expire = callback;
        return 1 as ReturnType<typeof setTimeout>;
      },
      clearTimer: () => undefined,
    });
    const opening = client.unlock(new Uint8Array(32).fill(9), expiringContext);
    worker.reply(unlockedReply(1, binding(1, expiringContext), expiringContext));
    await opening;
    const pending = client.publicConfig();
    const locking = client.lock();
    now = expiringContext.expiresAtMs;
    (expire as unknown as () => void)();
    await expect(pending).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await expect(locking).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(worker.terminated).toBe(1);
    worker.reply({ type: "result", requestId: 2, result: "late" });
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
  });

  it("rejects non-monotonic unlock and lock generations as terminal worker failures", async () => {
    const unlockWorker = new ManualWorker();
    const unlockClient = createWalletCryptoClient({ workerFactory: () => unlockWorker });
    const opening = unlockClient.unlock(new Uint8Array(32).fill(1), context);
    unlockWorker.reply(unlockedReply(1, binding(2)));
    await expect(opening).rejects.toMatchObject({ code: "WORKER_FAILED" });
    expect(unlockWorker.terminated).toBe(1);

    const lockWorker = new ManualWorker();
    const lockClient = await openManualClient(lockWorker);
    const locking = lockClient.lock();
    lockWorker.reply({ type: "locked", requestId: 2, generation: 3 });
    await expect(locking).rejects.toMatchObject({ code: "WORKER_FAILED" });
    expect(lockWorker.terminated).toBe(1);
  });

  it("times out once, rejects all pending calls, ignores late replies, and never replays", async () => {
    vi.useFakeTimers();
    const worker = new ManualWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker, timeoutMs: 50 });
    const opening = client.unlock(new Uint8Array(32).fill(9), context);
    const timedOut = expect(opening).rejects.toMatchObject({ code: "WORKER_TIMEOUT", message: "Wallet security worker timed out." });
    await vi.advanceTimersByTimeAsync(50);
    await timedOut;
    expect(worker.terminated).toBe(1);
    expect(worker.sent).toHaveLength(1);
    worker.reply(unlockedReply(1));
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
    expect(worker.sent).toHaveLength(1);
  });

  it("wipes rejected and pre-transfer seed buffers without posting", async () => {
    for (const seed of [
      new Uint8Array(31).fill(9),
      new Uint8Array(new ArrayBuffer(33), 1, 32).fill(9),
      new Uint8Array(new ArrayBuffer(64), 0, 32).fill(9),
    ]) {
      const worker = new ManualWorker();
      const client = createWalletCryptoClient({ workerFactory: () => worker });
      const backing = seed.buffer;
      await expect(client.unlock(seed, context)).rejects.toMatchObject({ code: "INVALID_SEED" });
      expect(new Uint8Array(backing)).toEqual(new Uint8Array(backing.byteLength));
      expect(worker.sent).toEqual([]);
    }
    if (typeof SharedArrayBuffer !== "undefined") {
      const worker = new ManualWorker();
      const client = createWalletCryptoClient({ workerFactory: () => worker });
      const shared = new SharedArrayBuffer(32);
      const seed = new Uint8Array(shared).fill(9);
      await expect(client.unlock(seed, context)).rejects.toMatchObject({ code: "INVALID_SEED" });
      expect(new Uint8Array(shared)).toEqual(new Uint8Array(32));
      expect(worker.sent).toEqual([]);
    }
    const worker = new ManualWorker();
    worker.throwOnPost = true;
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const seed = new Uint8Array(32).fill(9);
    await expect(client.unlock(seed, context)).rejects.toMatchObject({ code: "WORKER_FAILED" });
    expect(seed).toEqual(new Uint8Array(32));
    expect(worker.terminated).toBe(1);
  });

  it("terminally rejects a post-open unlock without posting its seed", async () => {
    const worker = new ManualWorker();
    const client = await openManualClient(worker);
    const seed = new Uint8Array(32).fill(4);
    await expect(client.unlock(seed, { ...context, deploymentId: "0x0" })).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
    expect(seed).toEqual(new Uint8Array(32));
    expect(worker.sent).toHaveLength(1);
    expect(worker.terminated).toBe(1);
    await expect(client.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("terminally invalidates an open client after malformed-seed or invalid-context re-unlock", async () => {
    const malformedWorker = new ManualWorker();
    const malformedClient = await openManualClient(malformedWorker);
    const malformedSeed = new Uint8Array(31).fill(5);
    await expect(malformedClient.unlock(malformedSeed, context)).rejects.toMatchObject({ code: "INVALID_SEED" });
    expect(malformedSeed).toEqual(new Uint8Array(31));
    expect(malformedWorker.sent).toHaveLength(1);
    expect(malformedWorker.terminated).toBe(1);
    await expect(malformedClient.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });

    const invalidContextWorker = new ManualWorker();
    const invalidContextClient = await openManualClient(invalidContextWorker);
    const invalidContextSeed = new Uint8Array(32).fill(6);
    await expect(invalidContextClient.unlock(invalidContextSeed, {
      ...context,
      deploymentId: "0x0",
    })).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
    expect(invalidContextSeed).toEqual(new Uint8Array(32));
    expect(invalidContextWorker.sent).toHaveLength(1);
    expect(invalidContextWorker.terminated).toBe(1);
    await expect(invalidContextClient.publicConfig()).rejects.toMatchObject({ code: "CLIENT_INVALIDATED" });
  });

  it("rejects a concurrent client unlock without posting, replaying, or disturbing the opening request", async () => {
    const worker = new ManualWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    const firstSeed = new Uint8Array(32).fill(1);
    const secondSeed = new Uint8Array(32).fill(2);
    const opening = client.unlock(firstSeed, context);
    await expect(client.unlock(secondSeed, context)).rejects.toMatchObject({ code: "SESSION_ACTIVE" });
    expect(secondSeed).toEqual(new Uint8Array(32));
    expect(worker.sent).toHaveLength(1);
    worker.reply(unlockedReply(1));
    await expect(opening).resolves.toMatchObject({ generation: 1 });
    const operation = client.publicConfig();
    worker.reply({ type: "result", requestId: 2, result: "open" });
    await expect(operation).resolves.toBe("open");
  });

  it("returns only fixed sanitized operation failures", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    FakeWalletSession.operationFailure = "buildOrderRequest";
    const worker = new InProcessWorker();
    const client = createWalletCryptoClient({ workerFactory: () => worker });
    await client.unlock(new Uint8Array(32).fill(9), context);
    let rejected: unknown;
    try {
      await client.buildOrderRequest('{"private":"raw seed 090909"}');
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(WalletCryptoError);
    expect(rejected).toMatchObject({ code: "OPERATION_FAILED", message: "Wallet operation failed." });
    expect(JSON.stringify(rejected)).not.toContain("090909");
    expect(String(rejected)).not.toContain("090909");
    expect(JSON.stringify(worker.receivedMessages)).not.toContain("090909 must not escape");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
