import {
  WALLET_CRYPTO_ERROR_MESSAGES,
  WALLET_WORKER_MAX_SESSION_LIFETIME_MS,
  WALLET_WORKER_MAX_REQUEST_ID,
  normalizeWalletWorkerContext,
  parseWalletWorkerReply,
  walletWorkerContextToken,
  type WalletCryptoErrorCode,
  type WalletSessionBinding,
  type SignatureVaultDevicePreparation,
  type WalletWorkerContext,
  type WalletWorkerReply,
  type WalletWorkerRequest,
} from "../workers/walletCryptoProtocol";
import {
  WALLET_DEVICE_SESSION_DEFAULT_TTL_MS,
  WalletDeviceSessionError,
  createWalletDeviceRecordStore,
  inspectWalletDeviceRecord,
  walletDeviceRecordMatchesContext,
  type WalletDeviceRecordStore,
} from "./walletDeviceSession";
import { normalizeWalletSignature } from "./walletLocalCrypto";
import { walletWorkerScriptUrl } from "./walletWorkerScriptUrl";
import walletCryptoWorkerUrl from "../workers/walletCrypto.worker.ts?worker&url";

const DEFAULT_TIMEOUT_MS = 30_000;

export class WalletCryptoError extends Error {
  readonly code: WalletCryptoErrorCode;

  constructor(code: WalletCryptoErrorCode) {
    super(WALLET_CRYPTO_ERROR_MESSAGES[code]);
    this.name = "WalletCryptoError";
    this.code = code;
  }
}

export interface WalletCryptoWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
}

export interface WalletCryptoClientOptions {
  workerFactory?: () => WalletCryptoWorkerLike;
  timeoutMs?: number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
  deviceRecordStore?: WalletDeviceRecordStore;
  onInvalidated?: (code: WalletCryptoErrorCode) => void;
}

interface PendingRequest {
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (reply: WalletWorkerReply) => void;
  reject: (error: WalletCryptoError) => void;
}

export interface SignatureVaultPreparation {
  binding: WalletSessionBinding;
  preparationToken: string;
  vaultRaw: string;
  walletAuthId: string;
  authToken: string;
  device: SignatureVaultDevicePreparation | null;
}

function createDefaultWorker(): WalletCryptoWorkerLike {
  const scriptUrl = walletWorkerScriptUrl(
    new URL(walletCryptoWorkerUrl, import.meta.url),
  );
  return new Worker(scriptUrl as string | URL, {
    type: "module",
    name: "zylith-wallet-crypto",
  });
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  Symbol.toStringTag,
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)?.get;
const SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER = typeof SharedArrayBuffer === "undefined"
  ? undefined
  : Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;

function arrayBufferByteLength(value: unknown): number | null {
  try {
    return ARRAY_BUFFER_BYTE_LENGTH_GETTER?.call(value) ?? null;
  } catch {
    return null;
  }
}

function sharedArrayBufferByteLength(value: unknown): number | null {
  try {
    return SHARED_ARRAY_BUFFER_BYTE_LENGTH_GETTER?.call(value) ?? null;
  } catch {
    return null;
  }
}

function inspectSeedView(seed: unknown): {
  buffer: ArrayBuffer | SharedArrayBuffer;
  byteOffset: number;
  byteLength: number;
} | null {
  if (!ArrayBuffer.isView(seed)) return null;
  try {
    if (TYPED_ARRAY_TAG_GETTER?.call(seed) !== "Uint8Array") return null;
    const buffer = TYPED_ARRAY_BUFFER_GETTER?.call(seed) as unknown;
    if (arrayBufferByteLength(buffer) === null && sharedArrayBufferByteLength(buffer) === null) {
      return null;
    }
    return {
      buffer: buffer as ArrayBuffer | SharedArrayBuffer,
      byteOffset: TYPED_ARRAY_BYTE_OFFSET_GETTER?.call(seed) as number,
      byteLength: TYPED_ARRAY_BYTE_LENGTH_GETTER?.call(seed) as number,
    };
  } catch {
    return null;
  }
}

function wipeBytes(seed: unknown) {
  try {
    const inspected = inspectSeedView(seed);
    if (!inspected) return;
    const length = arrayBufferByteLength(inspected.buffer)
      ?? sharedArrayBufferByteLength(inspected.buffer)
      ?? 0;
    if (length > 0) new Uint8Array(inspected.buffer).fill(0);
  } catch {
    // detached buffers have no remaining sender-side bytes to overwrite
  }
}

function requireDedicatedSeed(seed: unknown): ArrayBuffer {
  const inspected = inspectSeedView(seed);
  if (
    !inspected
    || arrayBufferByteLength(inspected.buffer) !== 32
    || inspected.byteOffset !== 0
    || inspected.byteLength !== 32
  ) {
    throw new WalletCryptoError("INVALID_SEED");
  }
  return inspected.buffer as ArrayBuffer;
}

export class WalletCryptoClient {
  private readonly worker: WalletCryptoWorkerLike;
  private readonly timeoutMs: number;
  private readonly setTimer: NonNullable<WalletCryptoClientOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<WalletCryptoClientOptions["clearTimer"]>;
  private readonly now: NonNullable<WalletCryptoClientOptions["now"]>;
  private readonly configuredDeviceRecordStore: WalletDeviceRecordStore | null;
  private onInvalidated: ((code: WalletCryptoErrorCode) => void) | null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private nextUnlockGeneration = 1;
  private binding: WalletSessionBinding | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lockPromise: Promise<void> | null = null;
  private locking = false;
  private opening = false;
  private opened = false;
  private invalidated = false;
  private unavailableCode: WalletCryptoErrorCode = "CLIENT_INVALIDATED";
  private deviceRecordUnsubscribe: (() => void) | null = null;
  private activeDevice: {
    walletAddress: string;
    raw: string;
    ownershipToken: string;
    binding: WalletSessionBinding;
  } | null = null;
  private signaturePreparation: {
    public: SignatureVaultPreparation;
    context: WalletWorkerContext;
    phase: "prepared" | "committed" | "publishing";
  } | null = null;

  private readonly onMessage = (event: Event) => {
    if (this.invalidated) return;
    let reply: WalletWorkerReply;
    try {
      reply = parseWalletWorkerReply((event as MessageEvent<unknown>).data);
    } catch {
      this.invalidate("WORKER_FAILED");
      return;
    }
    if (reply.type === "fatal") {
      this.invalidate(reply.error.code === "SESSION_EXPIRED" ? "SESSION_EXPIRED" : "WORKER_FAILED");
      return;
    }
    const pending = this.pending.get(reply.requestId);
    if (!pending) {
      this.invalidate("WORKER_FAILED");
      return;
    }
    this.pending.delete(reply.requestId);
    if (pending.timer !== null) this.clearTimerSafely(pending.timer);
    if (reply.type === "error") {
      pending.reject(new WalletCryptoError(reply.error.code));
      if (reply.error.code === "SESSION_LOCKED" || reply.error.code === "SESSION_MISMATCH") {
        this.invalidate("CLIENT_INVALIDATED");
      }
      if (reply.error.code === "SESSION_EXPIRED") this.invalidate("SESSION_EXPIRED");
      return;
    }
    pending.resolve(reply);
  };

  private readonly onWorkerFailure = () => this.invalidate("WORKER_FAILED");

  constructor(options: WalletCryptoClientOptions = {}) {
    try {
      this.worker = (options.workerFactory ?? createDefaultWorker)();
    } catch {
      throw new WalletCryptoError("WORKER_FAILED");
    }
    this.timeoutMs = Number.isSafeInteger(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? options.timeoutMs as number
      : DEFAULT_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.now = options.now ?? Date.now;
    this.configuredDeviceRecordStore = options.deviceRecordStore ?? null;
    this.onInvalidated = options.onInvalidated ?? null;
    try {
      this.worker.addEventListener("message", this.onMessage);
      this.worker.addEventListener("error", this.onWorkerFailure);
      this.worker.addEventListener("messageerror", this.onWorkerFailure);
    } catch {
      try {
        this.worker.terminate();
      } catch {
        // constructor failure remains a fixed worker failure
      }
      throw new WalletCryptoError("WORKER_FAILED");
    }
  }

  async unlock(seed: Uint8Array, suppliedContext: WalletWorkerContext): Promise<WalletSessionBinding> {
    let unlockSent = false;
    try {
      let seedBuffer: ArrayBuffer;
      try {
        seedBuffer = requireDedicatedSeed(seed);
      } catch (error) {
        if (this.opened && !this.invalidated) this.invalidate("CLIENT_INVALIDATED");
        throw error;
      }
      if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
      if (this.opening) throw new WalletCryptoError("SESSION_ACTIVE");
      if (this.opened) {
        this.invalidate("CLIENT_INVALIDATED");
        throw new WalletCryptoError("SESSION_ACTIVE");
      }
      let context: WalletWorkerContext;
      try {
        context = normalizeWalletWorkerContext(suppliedContext);
      } catch {
        throw new WalletCryptoError("INVALID_CONTEXT");
      }
      this.validateContextTime(context);
      const expectedContextToken = walletWorkerContextToken(context);
      const requestId = this.allocateRequestId();
      const expectedGeneration = this.nextUnlockGeneration;
      this.nextUnlockGeneration += 1;
      this.opening = true;
      unlockSent = true;
      const reply = await this.send(
        { kind: "unlock", requestId, seed, context },
        [seedBuffer],
      );
      if (
        reply.type !== "unlocked"
        || reply.binding.generation !== expectedGeneration
        || walletWorkerContextToken(reply.context) !== expectedContextToken
        || reply.binding.contextToken !== expectedContextToken
      ) {
        this.invalidate("WORKER_FAILED");
        throw new WalletCryptoError("WORKER_FAILED");
      }
      this.binding = Object.freeze({ ...reply.binding });
      try {
        this.scheduleExpiry(context.expiresAtMs);
      } catch {
        this.invalidate("WORKER_FAILED");
        throw new WalletCryptoError("WORKER_FAILED");
      }
      if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
      this.opened = true;
      return { ...this.binding };
    } catch (error) {
      if (unlockSent && !this.opened) this.binding = null;
      if (error instanceof WalletCryptoError) throw error;
      throw new WalletCryptoError("WORKER_FAILED");
    } finally {
      this.opening = false;
      wipeBytes(seed);
    }
  }

  async unlockAndSealDeviceSession(
    seed: Uint8Array,
    suppliedContext: WalletWorkerContext,
    ttlMs = WALLET_DEVICE_SESSION_DEFAULT_TTL_MS,
  ): Promise<WalletSessionBinding> {
    let unlockSent = false;
    let prepared: { raw: string; ownershipToken: string; binding: WalletSessionBinding } | null = null;
    try {
      let seedBuffer: ArrayBuffer;
      try {
        seedBuffer = requireDedicatedSeed(seed);
      } catch (error) {
        if (this.opened && !this.invalidated) this.invalidate("CLIENT_INVALIDATED");
        throw error;
      }
      if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
      if (this.opening) throw new WalletCryptoError("SESSION_ACTIVE");
      if (this.opened) {
        this.invalidate("CLIENT_INVALIDATED");
        throw new WalletCryptoError("SESSION_ACTIVE");
      }
      const context = this.normalizedContext(suppliedContext);
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new WalletCryptoError("DEVICE_SESSION_INVALID");
      const store = this.deviceRecordStore();
      const prior = store.read(context.walletAddress);
      const expectedContextToken = walletWorkerContextToken(context);
      const expectedGeneration = this.nextUnlockGeneration++;
      this.opening = true;
      unlockSent = true;
      const reply = await this.send({
        kind: "unlock-and-seal-device",
        requestId: this.allocateRequestId(),
        seed,
        context,
        ttlMs,
        priorRecordRaw: prior?.raw ?? null,
      }, [seedBuffer]);
      if (
        reply.type !== "device-session-prepared"
        || reply.binding.generation !== expectedGeneration
        || reply.binding.contextToken !== expectedContextToken
        || walletWorkerContextToken(reply.context) !== expectedContextToken
        || reply.expiresAtMs < context.expiresAtMs
      ) {
        this.invalidate("WORKER_FAILED");
        throw new WalletCryptoError("WORKER_FAILED");
      }
      prepared = { raw: reply.recordRaw, ownershipToken: reply.ownershipToken, binding: reply.binding };
      if (!await store.compareAndSwap(context.walletAddress, prior?.raw ?? null, reply.recordRaw)) {
        const abandoned = prepared;
        prepared = null;
        await this.abortPreparedDeviceSession(abandoned);
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      const published = prepared;
      prepared = null;
      const commitPublished = () => this.send({
        kind: "commit-device-session",
        requestId: this.allocateRequestId(),
        binding: reply.binding,
        ownershipToken: reply.ownershipToken,
        priorRecordRaw: prior?.raw ?? null,
      });
      let ownsBeforeCommit: boolean;
      try {
        ownsBeforeCommit = store.read(context.walletAddress)?.raw === reply.recordRaw;
      } catch {
        try {
          await commitPublished();
        } catch {
          // the published record remains the recovery source of truth on an ambiguous acknowledgement
        }
        if (!this.invalidated) this.invalidate("CLIENT_INVALIDATED");
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      if (!ownsBeforeCommit) {
        await this.abortPreparedDeviceSession(published);
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      let committed: WalletWorkerReply;
      try {
        committed = await commitPublished();
      } catch (error) {
        this.invalidate("CLIENT_INVALIDATED");
        throw error;
      }
      if (committed.type !== "device-session-committed") {
        this.invalidate("CLIENT_INVALIDATED");
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      let ownsPublishedRecord: boolean;
      try {
        ownsPublishedRecord = store.read(context.walletAddress)?.raw === reply.recordRaw;
      } catch {
        this.invalidate("CLIENT_INVALIDATED");
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      if (!ownsPublishedRecord) {
        try {
          const revoked = await this.send({
            kind: "revoke-device-session",
            requestId: this.allocateRequestId(),
            binding: reply.binding,
            recordRaw: reply.recordRaw,
            ownershipToken: reply.ownershipToken,
          });
          if (revoked.type !== "locked" || revoked.generation !== reply.binding.generation + 1) {
            throw new WalletCryptoError("DEVICE_SESSION_FAILED");
          }
        } catch {
          if (!this.invalidated) this.invalidate("CLIENT_INVALIDATED");
          throw new WalletCryptoError("DEVICE_SESSION_FAILED");
        }
        this.invalidate("CLIENT_INVALIDATED");
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      if (!this.replaceDeviceRecordMonitor(
        store,
        context.walletAddress,
        reply.recordRaw,
        reply.ownershipToken,
        reply.binding,
      )) {
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      this.activeDevice = {
        walletAddress: context.walletAddress,
        raw: reply.recordRaw,
        ownershipToken: reply.ownershipToken,
        binding: { ...reply.binding },
      };
      return this.publishBinding(reply.binding, context);
    } catch (error) {
      if (prepared !== null) {
        const abandoned = prepared;
        prepared = null;
        await this.abortPreparedDeviceSession(abandoned);
      }
      if (unlockSent && !this.opened) this.binding = null;
      if (error instanceof WalletCryptoError) throw error;
      if (error instanceof WalletDeviceSessionError) throw new WalletCryptoError(error.code);
      throw new WalletCryptoError("DEVICE_SESSION_FAILED");
    } finally {
      this.opening = false;
      wipeBytes(seed);
    }
  }

  async unlockFromDeviceSession(suppliedContext: WalletWorkerContext): Promise<WalletSessionBinding> {
    if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
    if (this.opening) throw new WalletCryptoError("SESSION_ACTIVE");
    if (this.opened) {
      this.invalidate("CLIENT_INVALIDATED");
      throw new WalletCryptoError("SESSION_ACTIVE");
    }
    let context: WalletWorkerContext;
    try {
      context = normalizeWalletWorkerContext(suppliedContext);
    } catch {
      throw new WalletCryptoError("INVALID_CONTEXT");
    }
    const store = this.deviceRecordStore();
    let expectedRaw: string | undefined;
    let changedDuringOpen = false;
    let unsubscribe: () => void;
    try {
      unsubscribe = store.subscribe(context.walletAddress, (nextRaw) => {
        if (expectedRaw === undefined || nextRaw !== expectedRaw) changedDuringOpen = true;
      });
    } catch {
      this.invalidate("CLIENT_INVALIDATED");
      throw new WalletCryptoError("DEVICE_SESSION_FAILED");
    }
    let recordRaw: string | null;
    try {
      recordRaw = store.readRaw
        ? store.readRaw(context.walletAddress)
        : store.read(context.walletAddress)?.raw ?? null;
    } catch (error) {
      unsubscribe();
      if (error instanceof WalletDeviceSessionError) throw new WalletCryptoError(error.code);
      throw new WalletCryptoError("DEVICE_SESSION_FAILED");
    }
    if (recordRaw === null) {
      unsubscribe();
      throw new WalletCryptoError("DEVICE_SESSION_MISSING");
    }
    expectedRaw = recordRaw;
    try {
      const immediate = store.readRaw
        ? store.readRaw(context.walletAddress)
        : store.read(context.walletAddress)?.raw ?? null;
      if (immediate !== recordRaw) changedDuringOpen = true;
    } catch {
      unsubscribe();
      throw new WalletCryptoError("DEVICE_SESSION_FAILED");
    }
    if (changedDuringOpen) {
      unsubscribe();
      throw new WalletCryptoError("DEVICE_SESSION_FAILED");
    }
    const expectedContextToken = walletWorkerContextToken(context);
    const expectedGeneration = this.nextUnlockGeneration++;
    this.opening = true;
    try {
      const reply = await this.send({
        kind: "unlock-from-device",
        requestId: this.allocateRequestId(),
        context,
        recordRaw,
      });
      if (
        reply.type !== "unlocked"
        || reply.binding.generation !== expectedGeneration
        || reply.binding.contextToken !== expectedContextToken
        || walletWorkerContextToken(reply.context) !== expectedContextToken
      ) {
        this.invalidate("WORKER_FAILED");
        throw new WalletCryptoError("WORKER_FAILED");
      }
      let ownershipToken: string;
      try {
        ownershipToken = inspectWalletDeviceRecord(recordRaw).ownershipToken;
      } catch {
        unsubscribe();
        this.invalidate("WORKER_FAILED");
        throw new WalletCryptoError("WORKER_FAILED");
      }
      let currentRaw: string | null;
      try {
        currentRaw = store.readRaw
          ? store.readRaw(context.walletAddress)
          : store.read(context.walletAddress)?.raw ?? null;
      } catch {
        unsubscribe();
        this.invalidate("CLIENT_INVALIDATED");
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      if (changedDuringOpen || currentRaw !== recordRaw) {
        unsubscribe();
        await this.revokeStaleDeviceSession(reply.binding, recordRaw, ownershipToken);
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      this.deviceRecordUnsubscribe = unsubscribe;
      if (!this.replaceDeviceRecordMonitor(
        store,
        context.walletAddress,
        recordRaw,
        ownershipToken,
        reply.binding,
      )) {
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      this.activeDevice = {
        walletAddress: context.walletAddress,
        raw: recordRaw,
        ownershipToken,
        binding: { ...reply.binding },
      };
      return this.publishBinding(reply.binding, context);
    } catch (error) {
      if (this.deviceRecordUnsubscribe !== unsubscribe) unsubscribe();
      if (
        error instanceof WalletCryptoError
        && (error.code === "DEVICE_SESSION_INVALID" || error.code === "DEVICE_SESSION_EXPIRED")
      ) {
        try {
          await store.compareAndSwap(context.walletAddress, recordRaw, null);
        } catch {
          throw new WalletCryptoError("DEVICE_SESSION_FAILED");
        }
      }
      throw error;
    } finally {
      this.opening = false;
    }
  }

  async revokeDeviceSession(suppliedContext: WalletWorkerContext): Promise<void> {
    const context = this.normalizedContext(suppliedContext);
    const activeBinding = this.binding ? { ...this.binding } : null;
    if (activeBinding !== null && walletWorkerContextToken(context) !== activeBinding.contextToken) {
      throw new WalletCryptoError("SESSION_MISMATCH");
    }
    const store = this.deviceRecordStore();
    let owned = this.activeDevice && this.activeDevice.walletAddress === context.walletAddress
      ? { raw: this.activeDevice.raw, ownershipToken: this.activeDevice.ownershipToken }
      : null;
    if (owned === null) {
      let recordRaw: string | null;
      try {
        recordRaw = store.readRaw
          ? store.readRaw(context.walletAddress)
          : store.read(context.walletAddress)?.raw ?? null;
      } catch (error) {
        if (activeBinding !== null && !this.invalidated) this.invalidate("CLIENT_INVALIDATED");
        if (error instanceof WalletDeviceSessionError) throw new WalletCryptoError(error.code);
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      if (recordRaw === null) {
        if (activeBinding !== null) this.invalidate("CLIENT_INVALIDATED");
        return;
      }
      try {
        const record = inspectWalletDeviceRecord(recordRaw);
        if (!walletDeviceRecordMatchesContext(record, context)) {
          throw new WalletCryptoError("DEVICE_SESSION_INVALID");
        }
        owned = { raw: recordRaw, ownershipToken: record.ownershipToken };
      } catch {
        if (activeBinding !== null && !this.invalidated) this.invalidate("CLIENT_INVALIDATED");
        throw new WalletCryptoError("DEVICE_SESSION_INVALID");
      }
    }
    this.clearDeviceRecordMonitor();
    try {
      await store.compareAndSwap(context.walletAddress, owned.raw, null);
    } catch (error) {
      if (activeBinding !== null && !this.invalidated) this.invalidate("CLIENT_INVALIDATED");
      if (error instanceof WalletDeviceSessionError) throw new WalletCryptoError(error.code);
      throw new WalletCryptoError("DEVICE_SESSION_FAILED");
    }
    let reply: WalletWorkerReply;
    try {
      reply = await this.send({
        kind: "revoke-device-session",
        requestId: this.allocateRequestId(),
        binding: activeBinding,
        recordRaw: owned.raw,
        ownershipToken: owned.ownershipToken,
      });
    } catch (error) {
      if (activeBinding !== null && !this.invalidated) this.invalidate("CLIENT_INVALIDATED");
      throw error;
    }
    const valid = activeBinding === null
      ? reply.type === "device-session-revoked"
      : reply.type === "locked" && reply.generation === activeBinding.generation + 1;
    if (!valid) {
      this.invalidate("WORKER_FAILED");
      throw new WalletCryptoError("WORKER_FAILED");
    }
    this.activeDevice = null;
    if (activeBinding !== null) this.invalidate("CLIENT_INVALIDATED");
  }

  prepareSignatureVaultCreate(
    signature: unknown,
    suppliedContext: WalletWorkerContext,
    rememberDevice = true,
    deviceTtlMs = WALLET_DEVICE_SESSION_DEFAULT_TTL_MS,
  ): Promise<SignatureVaultPreparation> {
    return this.prepareSignatureVault("prepare-signature-vault-create", signature, suppliedContext, null, rememberDevice, deviceTtlMs);
  }

  async deriveSignatureVaultCredentials(
    signature: unknown,
    suppliedContext: WalletWorkerContext,
  ): Promise<{ walletAuthId: string; authToken: string }> {
    if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
    let normalizedSignature: unknown;
    let context: WalletWorkerContext;
    try {
      normalizedSignature = normalizeWalletSignature(signature);
      context = normalizeWalletWorkerContext(suppliedContext);
    } catch {
      throw new WalletCryptoError("SIGNATURE_VAULT_INVALID");
    }
    const reply = await this.send({
      kind: "derive-signature-vault-credentials",
      requestId: this.allocateRequestId(),
      signature: normalizedSignature,
      context,
    });
    if (reply.type !== "signature-vault-credentials") {
      this.invalidate("WORKER_FAILED");
      throw new WalletCryptoError("WORKER_FAILED");
    }
    return { walletAuthId: reply.walletAuthId, authToken: reply.authToken };
  }

  prepareSignatureVaultOpen(
    signature: unknown,
    vaultRaw: string,
    suppliedContext: WalletWorkerContext,
    rememberDevice = true,
    deviceTtlMs = WALLET_DEVICE_SESSION_DEFAULT_TTL_MS,
  ): Promise<SignatureVaultPreparation> {
    return this.prepareSignatureVault("prepare-signature-vault-open", signature, suppliedContext, vaultRaw, rememberDevice, deviceTtlMs);
  }

  async commitSignatureVault(preparation: SignatureVaultPreparation): Promise<WalletSessionBinding> {
    const active = this.requireSignaturePreparation(preparation, "prepared");
    let reply: WalletWorkerReply;
    try {
      reply = await this.send({
        kind: "commit-signature-vault",
        requestId: this.allocateRequestId(),
        binding: active.public.binding,
        preparationToken: active.public.preparationToken,
        vaultRaw: active.public.vaultRaw,
        device: active.public.device,
      });
    } catch (error) {
      if (!this.invalidated) this.invalidate("CLIENT_INVALIDATED");
      throw error;
    }
    if (reply.type !== "signature-vault-committed") {
      this.invalidate("WORKER_FAILED");
      throw new WalletCryptoError("WORKER_FAILED");
    }
    active.phase = "committed";
    return this.publishBinding(active.public.binding, active.context);
  }

  async abortSignatureVault(preparation: SignatureVaultPreparation): Promise<void> {
    const active = this.requireSignaturePreparation(preparation, "prepared");
    const reply = await this.send({
      kind: "abort-signature-vault",
      requestId: this.allocateRequestId(),
      binding: active.public.binding,
      preparationToken: active.public.preparationToken,
      vaultRaw: active.public.vaultRaw,
      device: active.public.device,
    });
    if (reply.type !== "locked" || reply.generation !== active.public.binding.generation + 1) {
      this.invalidate("WORKER_FAILED");
      throw new WalletCryptoError("WORKER_FAILED");
    }
    this.signaturePreparation = null;
    this.invalidate("CLIENT_INVALIDATED");
  }

  async finalizeSignatureVault(
    preparation: SignatureVaultPreparation,
    rememberDevice = true,
  ): Promise<{ remembered: boolean }> {
    const active = this.requireSignaturePreparation(preparation, ["committed", "publishing"]);
    const device = active.public.device;
    if (active.phase === "committed") {
      const publicationReady = await this.send({
        kind: "begin-signature-vault-device-publication",
        requestId: this.allocateRequestId(),
        binding: active.public.binding,
        preparationToken: active.public.preparationToken,
        vaultRaw: active.public.vaultRaw,
        device,
      });
      if (publicationReady.type !== "signature-vault-device-publication-ready") {
        this.invalidate("WORKER_FAILED");
        throw new WalletCryptoError("WORKER_FAILED");
      }
      active.phase = "publishing";
    }
    let devicePublication: "published" | "discard" | "unknown" = "discard";
    if (rememberDevice && device !== null) {
      try {
        const store = this.deviceRecordStore();
        const changed = await store.compareAndSwap(
          active.context.walletAddress,
          device.priorRecordRaw,
          device.recordRaw,
        );
        const currentRaw = store.readRaw
          ? store.readRaw(active.context.walletAddress)
          : store.read(active.context.walletAddress)?.raw ?? null;
        devicePublication = currentRaw === device.recordRaw
          ? "published"
          : changed ? "unknown" : "discard";
      } catch {
        try {
          const store = this.deviceRecordStore();
          const currentRaw = store.readRaw
            ? store.readRaw(active.context.walletAddress)
            : store.read(active.context.walletAddress)?.raw ?? null;
          devicePublication = currentRaw === device.recordRaw ? "published" : "unknown";
        } catch {
          devicePublication = "unknown";
        }
      }
    }
    const reply = await this.send({
      kind: "finalize-signature-vault",
      requestId: this.allocateRequestId(),
      binding: active.public.binding,
      preparationToken: active.public.preparationToken,
      vaultRaw: active.public.vaultRaw,
      device,
      devicePublication,
    });
    const expectedRemember = devicePublication === "published";
    if (reply.type !== "signature-vault-finalized" || reply.remembered !== expectedRemember) {
      this.invalidate("WORKER_FAILED");
      throw new WalletCryptoError("WORKER_FAILED");
    }
    this.signaturePreparation = null;
    if (!reply.remembered || device === null) return { remembered: false };
    try {
      const store = this.deviceRecordStore();
      if (!this.replaceDeviceRecordMonitor(
        store,
        active.context.walletAddress,
        device.recordRaw,
        device.ownershipToken,
        active.public.binding,
      )) {
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
      this.activeDevice = {
        walletAddress: active.context.walletAddress,
        raw: device.recordRaw,
        ownershipToken: device.ownershipToken,
        binding: { ...active.public.binding },
      };
      return { remembered: true };
    } catch {
      if (!this.invalidated && !this.locking) this.invalidate("CLIENT_INVALIDATED");
      throw new WalletCryptoError("DEVICE_SESSION_FAILED");
    }
  }

  lock(): Promise<void> {
    if (this.invalidated) return Promise.resolve();
    if (this.lockPromise) return this.lockPromise;
    this.locking = true;
    this.lockPromise = this.performLock();
    return this.lockPromise;
  }

  private async performLock(): Promise<void> {
    if (this.opening) {
      this.invalidate("CLIENT_INVALIDATED");
      return;
    }
    const binding = this.binding;
    if (!binding) {
      this.invalidate("CLIENT_INVALIDATED");
      return;
    }
    let reply: WalletWorkerReply;
    try {
      reply = await this.send({ kind: "lock", requestId: this.allocateRequestId(), binding });
    } catch (error) {
      if (!this.invalidated) this.invalidate("CLIENT_INVALIDATED");
      throw error;
    }
    if (reply.type !== "locked") {
      this.invalidate("WORKER_FAILED");
      throw new WalletCryptoError("WORKER_FAILED");
    }
    if (reply.generation !== binding.generation + 1) {
      this.invalidate("WORKER_FAILED");
      throw new WalletCryptoError("WORKER_FAILED");
    }
    this.binding = null;
    this.invalidate("CLIENT_INVALIDATED");
  }

  publicConfig() { return this.noInputOperation("public-config"); }
  recoveryAuthTag() { return this.noInputOperation("recovery-auth-tag"); }
  deriveProofSigner(inputJson: string) { return this.jsonOperation("derive-proof-signer", inputJson); }
  encryptLocalState(inputJson: string) { return this.jsonOperation("encrypt-local-state", inputJson); }
  decryptLocalState(inputJson: string) { return this.jsonOperation("decrypt-local-state", inputJson); }
  buildDepositSubmissionPlan(inputJson: string) { return this.jsonOperation("build-deposit-submission-plan", inputJson); }
  buildOrderRequest(inputJson: string) { return this.jsonOperation("build-order-request", inputJson); }
  buildCancelRequest(inputJson: string) { return this.jsonOperation("build-cancel-request", inputJson); }
  buildStatusRequests(inputJson: string) { return this.jsonOperation("build-status-requests", inputJson); }
  buildWithdrawRequest(inputJson: string) { return this.jsonOperation("build-withdraw-request", inputJson); }
  buildResidualRecovery(inputJson: string) { return this.jsonOperation("build-residual-recovery", inputJson); }
  createRecoverySnapshot(inputJson: string) { return this.jsonOperation("create-recovery-snapshot", inputJson); }
  decryptRecoveryArtifact(inputJson: string) { return this.jsonOperation("decrypt-recovery-artifact", inputJson); }
  signStrk20ExitClaim(inputJson: string) { return this.jsonOperation("sign-strk20-exit-claim", inputJson); }

  dispose() {
    this.invalidate("CLIENT_INVALIDATED");
  }

  private requireBinding(): WalletSessionBinding {
    if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
    if (this.locking) throw new WalletCryptoError("CLIENT_INVALIDATED");
    if (!this.binding) {
      if (this.signaturePreparation?.phase === "prepared") {
        throw new WalletCryptoError("SIGNATURE_VAULT_FAILED");
      }
      throw new WalletCryptoError("SESSION_LOCKED");
    }
    return this.binding;
  }

  private async noInputOperation(kind: "public-config" | "recovery-auth-tag"): Promise<string> {
    const binding = this.requireBinding();
    const reply = await this.send({
      kind,
      requestId: this.allocateRequestId(),
      binding,
    });
    return this.requireResult(reply);
  }

  private async jsonOperation(
    kind:
      | "derive-proof-signer"
      | "encrypt-local-state"
      | "decrypt-local-state"
      | "build-deposit-submission-plan"
      | "build-order-request"
      | "build-cancel-request"
      | "build-status-requests"
      | "build-withdraw-request"
      | "build-residual-recovery"
      | "create-recovery-snapshot"
      | "decrypt-recovery-artifact"
      | "sign-strk20-exit-claim",
    inputJson: string,
  ): Promise<string> {
    const binding = this.requireBinding();
    const reply = await this.send({
      kind,
      requestId: this.allocateRequestId(),
      binding,
      inputJson,
    });
    return this.requireResult(reply);
  }

  private requireResult(reply: WalletWorkerReply): string {
    if (reply.type === "result") return reply.result;
    this.invalidate("WORKER_FAILED");
    throw new WalletCryptoError("WORKER_FAILED");
  }

  private normalizedContext(suppliedContext: WalletWorkerContext): WalletWorkerContext {
    let context: WalletWorkerContext;
    try {
      context = normalizeWalletWorkerContext(suppliedContext);
    } catch {
      throw new WalletCryptoError("INVALID_CONTEXT");
    }
    this.validateContextTime(context);
    return context;
  }

  private async prepareSignatureVault(
    kind: "prepare-signature-vault-create" | "prepare-signature-vault-open",
    signature: unknown,
    suppliedContext: WalletWorkerContext,
    vaultRaw: string | null,
    rememberDevice: boolean,
    deviceTtlMs: number,
  ): Promise<SignatureVaultPreparation> {
    if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
    if (this.opening) throw new WalletCryptoError("SESSION_ACTIVE");
    if (this.opened || this.signaturePreparation) {
      this.invalidate("CLIENT_INVALIDATED");
      throw new WalletCryptoError("SESSION_ACTIVE");
    }
    const context = this.normalizedContext(suppliedContext);
    if (typeof rememberDevice !== "boolean" || !Number.isSafeInteger(deviceTtlMs) || deviceTtlMs <= 0) {
      throw new WalletCryptoError("SIGNATURE_VAULT_INVALID");
    }
    let normalizedSignature: unknown;
    try {
      normalizedSignature = normalizeWalletSignature(signature);
      if (kind === "prepare-signature-vault-open"
        && (typeof vaultRaw !== "string" || vaultRaw.length === 0 || vaultRaw.length > 4_096)) {
        throw new Error("invalid");
      }
    } catch {
      throw new WalletCryptoError("SIGNATURE_VAULT_INVALID");
    }
    let deviceRequested = rememberDevice;
    let priorDeviceRecordRaw: string | null = null;
    if (deviceRequested) {
      try {
        const store = this.deviceRecordStore();
        priorDeviceRecordRaw = store.readRaw
          ? store.readRaw(context.walletAddress)
          : store.read(context.walletAddress)?.raw ?? null;
      } catch {
        deviceRequested = false;
      }
    }
    const expectedContextToken = walletWorkerContextToken(context);
    const expectedGeneration = this.nextUnlockGeneration++;
    this.opening = true;
    try {
      const requestId = this.allocateRequestId();
      const base = {
        requestId,
        signature: normalizedSignature,
        context,
        rememberDevice: deviceRequested,
        deviceTtlMs,
        priorDeviceRecordRaw,
      } as const;
      const reply = await this.send(kind === "prepare-signature-vault-create"
        ? { kind, ...base }
        : { kind, ...base, vaultRaw: vaultRaw as string });
      if (reply.type !== "signature-vault-prepared"
        || reply.binding.generation !== expectedGeneration
        || reply.binding.contextToken !== expectedContextToken
        || walletWorkerContextToken(reply.context) !== expectedContextToken
        || (reply.device !== null && reply.device.priorRecordRaw !== priorDeviceRecordRaw)) {
        this.invalidate("WORKER_FAILED");
        throw new WalletCryptoError("WORKER_FAILED");
      }
      const prepared = Object.freeze({
        binding: Object.freeze({ ...reply.binding }),
        preparationToken: reply.preparationToken,
        vaultRaw: reply.vaultRaw,
        walletAuthId: reply.walletAuthId,
        authToken: reply.authToken,
        device: reply.device === null ? null : Object.freeze({ ...reply.device }),
      });
      this.signaturePreparation = { public: prepared, context, phase: "prepared" };
      return prepared;
    } catch (error) {
      if (error instanceof WalletCryptoError) throw error;
      throw new WalletCryptoError("SIGNATURE_VAULT_FAILED");
    } finally {
      this.opening = false;
    }
  }

  private requireSignaturePreparation(
    preparation: SignatureVaultPreparation,
    phase: "prepared" | "committed" | readonly ("prepared" | "committed" | "publishing")[],
  ) {
    const active = this.signaturePreparation;
    const phaseMatches = active !== null
      && (typeof phase === "string" ? active.phase === phase : phase.includes(active.phase));
    if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
    if (!active || !phaseMatches
      || preparation !== active.public
      || preparation.preparationToken !== active.public.preparationToken
      || preparation.vaultRaw !== active.public.vaultRaw) {
      throw new WalletCryptoError("SIGNATURE_VAULT_INVALID");
    }
    return active;
  }

  private deviceRecordStore(): WalletDeviceRecordStore {
    if (this.configuredDeviceRecordStore) return this.configuredDeviceRecordStore;
    if (typeof localStorage === "undefined") throw new WalletCryptoError("DEVICE_SESSION_FAILED");
    return createWalletDeviceRecordStore(localStorage);
  }

  private publishBinding(binding: WalletSessionBinding, context: WalletWorkerContext): WalletSessionBinding {
    this.binding = Object.freeze({ ...binding });
    try {
      this.scheduleExpiry(context.expiresAtMs);
    } catch {
      this.invalidate("WORKER_FAILED");
      throw new WalletCryptoError("WORKER_FAILED");
    }
    if (this.invalidated || this.locking) throw new WalletCryptoError(this.unavailableCode);
    this.opened = true;
    return { ...this.binding };
  }

  private replaceDeviceRecordMonitor(
    store: WalletDeviceRecordStore,
    walletAddress: string,
    expectedRaw: string,
    ownershipToken: string,
    binding: WalletSessionBinding,
  ): boolean {
    const previousUnsubscribe = this.deviceRecordUnsubscribe;
    let nextUnsubscribe: (() => void) | null = null;
    let changed = false;
    let armed = false;
    try {
      nextUnsubscribe = store.subscribe(walletAddress, (nextRaw) => {
        if (nextRaw === expectedRaw || this.invalidated) return;
        changed = true;
        if (armed) this.handleDeviceRecordInvalidation(binding, expectedRaw, ownershipToken);
      });
      const current = store.readRaw ? store.readRaw(walletAddress) : store.read(walletAddress)?.raw ?? null;
      if (current !== expectedRaw) changed = true;
    } catch {
      try { nextUnsubscribe?.(); } catch { /* terminal cleanup continues */ }
      if (!this.invalidated) this.invalidate("CLIENT_INVALIDATED");
      return false;
    }
    if (changed) {
      try { nextUnsubscribe(); } catch { /* terminal cleanup continues */ }
      this.handleDeviceRecordInvalidation(binding, expectedRaw, ownershipToken);
      return false;
    }
    this.deviceRecordUnsubscribe = nextUnsubscribe;
    armed = true;
    if (previousUnsubscribe && previousUnsubscribe !== nextUnsubscribe) {
      try {
        previousUnsubscribe();
      } catch {
        this.deviceRecordUnsubscribe = () => {
          try { nextUnsubscribe?.(); } finally { previousUnsubscribe(); }
        };
        this.invalidate("CLIENT_INVALIDATED");
        return false;
      }
    }
    return true;
  }

  private handleDeviceRecordInvalidation(
    binding: WalletSessionBinding,
    recordRaw: string,
    ownershipToken: string,
  ) {
    if (this.invalidated || this.locking) return;
    this.locking = true;
    this.clearDeviceRecordMonitor();
    void this.revokeStaleDeviceSession(binding, recordRaw, ownershipToken);
  }

  private async revokeStaleDeviceSession(
    binding: WalletSessionBinding,
    recordRaw: string,
    ownershipToken: string,
  ) {
    try {
      const reply = await this.send({
        kind: "revoke-device-session",
        requestId: this.allocateRequestId(),
        binding,
        recordRaw,
        ownershipToken,
      });
      if (reply.type !== "locked" || reply.generation !== binding.generation + 1) {
        throw new WalletCryptoError("DEVICE_SESSION_FAILED");
      }
    } catch {
      // exact owned-key cleanup is attempted before terminal client invalidation
    } finally {
      if (!this.invalidated) this.invalidate("CLIENT_INVALIDATED");
    }
  }

  private clearDeviceRecordMonitor() {
    const unsubscribe = this.deviceRecordUnsubscribe;
    this.deviceRecordUnsubscribe = null;
    try { unsubscribe?.(); } catch { /* terminal cleanup continues */ }
  }

  private async abortPreparedDeviceSession(prepared: {
    binding: WalletSessionBinding;
    ownershipToken: string;
  }) {
    if (this.invalidated) return;
    try {
      const reply = await this.send({
        kind: "abort-device-session",
        requestId: this.allocateRequestId(),
        binding: prepared.binding,
        ownershipToken: prepared.ownershipToken,
      });
      if (reply.type !== "locked" || reply.generation !== prepared.binding.generation + 1) {
        this.invalidate("WORKER_FAILED");
        return;
      }
      this.invalidate("CLIENT_INVALIDATED");
    } catch {
      if (!this.invalidated) this.invalidate("WORKER_FAILED");
    }
  }

  private allocateRequestId(): number {
    if (this.invalidated) throw new WalletCryptoError(this.unavailableCode);
    if (this.nextRequestId > WALLET_WORKER_MAX_REQUEST_ID) {
      this.invalidate("REQUEST_LIMIT");
      throw new WalletCryptoError("REQUEST_LIMIT");
    }
    const allocated = this.nextRequestId;
    this.nextRequestId += 1;
    return allocated;
  }

  private send(request: WalletWorkerRequest, transfer: Transferable[] = []): Promise<WalletWorkerReply> {
    if (this.invalidated) return Promise.reject(new WalletCryptoError(this.unavailableCode));
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { timer: null, resolve, reject };
      this.pending.set(request.requestId, pending);
      try {
        const timer = this.setTimer(() => this.invalidate("WORKER_TIMEOUT"), this.timeoutMs);
        pending.timer = timer;
        if (this.invalidated) {
          this.clearTimerSafely(timer);
          return;
        }
        this.worker.postMessage(request, transfer);
      } catch {
        this.invalidate("WORKER_FAILED");
      }
    });
  }

  private invalidate(code: WalletCryptoErrorCode) {
    if (this.invalidated) return;
    this.invalidated = true;
    this.unavailableCode = code === "SESSION_EXPIRED" ? "SESSION_EXPIRED" : "CLIENT_INVALIDATED";
    this.binding = null;
    this.opened = false;
    this.activeDevice = null;
    this.signaturePreparation = null;
    this.clearDeviceRecordMonitor();
    if (this.expiryTimer !== null) {
      this.clearTimerSafely(this.expiryTimer);
      this.expiryTimer = null;
    }
    try { this.worker.removeEventListener("message", this.onMessage); } catch { /* terminal cleanup continues */ }
    try { this.worker.removeEventListener("error", this.onWorkerFailure); } catch { /* terminal cleanup continues */ }
    try { this.worker.removeEventListener("messageerror", this.onWorkerFailure); } catch { /* terminal cleanup continues */ }
    try { this.worker.terminate(); } catch { /* terminal cleanup continues */ }
    for (const pending of this.pending.values()) {
      if (pending.timer !== null) this.clearTimerSafely(pending.timer);
      pending.reject(new WalletCryptoError(code));
    }
    this.pending.clear();
    const observer = this.onInvalidated;
    this.onInvalidated = null;
    try { observer?.(code); } catch { /* terminal cleanup must not depend on an observer */ }
  }

  private clearTimerSafely(timer: ReturnType<typeof setTimeout>) {
    try {
      this.clearTimer(timer);
    } catch {
      // timer cleanup cannot restore an invalidated client
    }
  }

  private readNow(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new WalletCryptoError("INVALID_CONTEXT");
    return value;
  }

  private validateContextTime(context: WalletWorkerContext) {
    const current = this.readNow();
    if (context.expiresAtMs <= current) throw new WalletCryptoError("SESSION_EXPIRED");
    if (context.expiresAtMs - current > WALLET_WORKER_MAX_SESSION_LIFETIME_MS) {
      throw new WalletCryptoError("INVALID_CONTEXT");
    }
  }

  private scheduleExpiry(expiresAtMs: number) {
    if (this.expiryTimer !== null) this.clearTimerSafely(this.expiryTimer);
    const schedule = () => {
      if (this.invalidated) return;
      let remaining: number;
      try {
        remaining = expiresAtMs - this.readNow();
      } catch {
        this.invalidate("WORKER_FAILED");
        return;
      }
      if (remaining <= 0) {
        this.invalidate("SESSION_EXPIRED");
        return;
      }
      this.expiryTimer = this.setTimer(schedule, Math.min(remaining, 0x7fff_ffff));
    };
    schedule();
  }
}

export function createWalletCryptoClient(options: WalletCryptoClientOptions = {}) {
  return new WalletCryptoClient(options);
}
