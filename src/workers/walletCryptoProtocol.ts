import {
  WalletDeviceSessionError,
  inspectWalletDeviceRecord,
  normalizeWalletDeviceOrigin,
  type WalletDeviceWorkerService,
} from "../domain/walletDeviceSession";
import {
  normalizeWalletSignature,
  isWalletSignatureVaultRecord,
  type WalletSignatureVaultWorkerService,
} from "../domain/walletLocalCrypto";
import { parseWalletJson } from "../domain/walletVersion";

export const WALLET_WORKER_MAX_REQUEST_ID = 0x7fff_ffff;
export const WALLET_WORKER_MAX_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_OPERATION_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_CLASSIFIED_RESULT_BASE64_CHARS = 4 * Math.ceil(MAX_OPERATION_INPUT_BYTES / 3);
const MAX_CLASSIFIED_OUTCOME_CHARS = MAX_CLASSIFIED_RESULT_BASE64_CHARS + 64;
const MAX_TIMER_DELAY_MS = 0x7fff_ffff;
const STARKNET_FIELD_MODULUS = BigInt(
  "0x0800000000000011000000000000000000000000000000000000000000000001",
);

export type WalletWorkerState =
  | "ABSENT"
  | "BOOTING"
  | "LOCKED"
  | "OPENING"
  | "OPEN"
  | "INVALIDATING"
  | "TERMINATED";

export type WalletCryptoErrorCode =
  | "INVALID_MESSAGE"
  | "INVALID_SEED"
  | "INVALID_CONTEXT"
  | "SESSION_MISMATCH"
  | "SESSION_LOCKED"
  | "SESSION_ACTIVE"
  | "SESSION_EXPIRED"
  | "OPERATION_FAILED"
  | "MIGRATION_REQUIRED"
  | "WORKER_FAILED"
  | "WORKER_TIMEOUT"
  | "REQUEST_LIMIT"
  | "CLIENT_INVALIDATED"
  | "DEVICE_SESSION_MISSING"
  | "DEVICE_SESSION_EXPIRED"
  | "DEVICE_SESSION_INVALID"
  | "DEVICE_SESSION_FAILED"
  | "SIGNATURE_VAULT_INVALID"
  | "SIGNATURE_VAULT_FAILED";

export type WalletWorkerTerminalCode =
  | "INVALID_MESSAGE"
  | "SESSION_ACTIVE"
  | "SESSION_EXPIRED"
  | "WORKER_FAILED"
  | "CLIENT_INVALIDATED";

export const WALLET_CRYPTO_ERROR_MESSAGES: Readonly<Record<WalletCryptoErrorCode, string>> = {
  INVALID_MESSAGE: "Invalid wallet worker message.",
  INVALID_SEED: "Invalid wallet seed transfer.",
  INVALID_CONTEXT: "Invalid wallet session context.",
  SESSION_MISMATCH: "Wallet session context changed.",
  SESSION_LOCKED: "Wallet session is locked.",
  SESSION_ACTIVE: "Wallet session is already open.",
  SESSION_EXPIRED: "Wallet session expired.",
  OPERATION_FAILED: "Wallet operation failed.",
  MIGRATION_REQUIRED: "Wallet data migration is required.",
  WORKER_FAILED: "Wallet security worker failed.",
  WORKER_TIMEOUT: "Wallet security worker timed out.",
  REQUEST_LIMIT: "Wallet security worker request limit reached.",
  CLIENT_INVALIDATED: "Wallet security worker is unavailable.",
  DEVICE_SESSION_MISSING: "Remembered wallet session is unavailable.",
  DEVICE_SESSION_EXPIRED: "Remembered wallet session expired.",
  DEVICE_SESSION_INVALID: "Remembered wallet session is invalid.",
  DEVICE_SESSION_FAILED: "Remembered wallet session failed.",
  SIGNATURE_VAULT_INVALID: "Wallet signature vault is invalid.",
  SIGNATURE_VAULT_FAILED: "Wallet signature vault operation failed.",
};

export interface WalletWorkerContext {
  walletAddress: string;
  chainId: string;
  deploymentId: string;
  vaultDeploymentId: string;
  origin: string;
  manifestIdentity: string;
  manifestVersion: string;
  expiresAtMs: number;
}

export interface WalletSessionBinding {
  sessionId: string;
  generation: number;
  contextToken: string;
}

interface RequestBase {
  requestId: number;
}

export interface UnlockWalletRequest extends RequestBase {
  kind: "unlock";
  seed: Uint8Array;
  context: WalletWorkerContext;
}

export interface UnlockAndSealDeviceRequest extends RequestBase {
  kind: "unlock-and-seal-device";
  seed: Uint8Array;
  context: WalletWorkerContext;
  ttlMs: number;
  priorRecordRaw: string | null;
}

export interface UnlockFromDeviceRequest extends RequestBase {
  kind: "unlock-from-device";
  context: WalletWorkerContext;
  recordRaw: string;
}

export interface CommitDeviceSessionRequest extends RequestBase {
  kind: "commit-device-session";
  binding: WalletSessionBinding;
  ownershipToken: string;
  priorRecordRaw: string | null;
}

export interface AbortDeviceSessionRequest extends RequestBase {
  kind: "abort-device-session";
  binding: WalletSessionBinding;
  ownershipToken: string;
}

export interface RevokeDeviceSessionRequest extends RequestBase {
  kind: "revoke-device-session";
  binding: WalletSessionBinding | null;
  recordRaw: string;
  ownershipToken: string;
}

export interface SignatureVaultDevicePreparation {
  recordRaw: string;
  ownershipToken: string;
  expiresAtMs: number;
  priorRecordRaw: string | null;
}

interface PrepareSignatureVaultBase extends RequestBase {
  signature: unknown;
  context: WalletWorkerContext;
  rememberDevice: boolean;
  deviceTtlMs: number;
  priorDeviceRecordRaw: string | null;
}

export interface PrepareSignatureVaultCreateRequest extends PrepareSignatureVaultBase {
  kind: "prepare-signature-vault-create";
}

export interface PrepareSignatureVaultOpenRequest extends PrepareSignatureVaultBase {
  kind: "prepare-signature-vault-open";
  vaultRaw: string;
}

export interface DeriveSignatureVaultCredentialsRequest extends RequestBase {
  kind: "derive-signature-vault-credentials";
  signature: unknown;
  context: WalletWorkerContext;
}

interface SignatureVaultPreparedRequestBase extends RequestBase {
  binding: WalletSessionBinding;
  preparationToken: string;
  vaultRaw: string;
  device: SignatureVaultDevicePreparation | null;
}

export interface CommitSignatureVaultRequest extends SignatureVaultPreparedRequestBase {
  kind: "commit-signature-vault";
}

export interface AbortSignatureVaultRequest extends SignatureVaultPreparedRequestBase {
  kind: "abort-signature-vault";
}

export interface BeginSignatureVaultDevicePublicationRequest extends SignatureVaultPreparedRequestBase {
  kind: "begin-signature-vault-device-publication";
}

export interface FinalizeSignatureVaultRequest extends SignatureVaultPreparedRequestBase {
  kind: "finalize-signature-vault";
  devicePublication: "published" | "discard" | "unknown";
}

export interface LockWalletRequest extends RequestBase {
  kind: "lock";
  binding: WalletSessionBinding;
}

type NoInputOperationKind = "public-config" | "recovery-auth-tag";

type JsonInputOperationKind =
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
  | "sign-strk20-exit-claim";

export interface NoInputWalletOperationRequest extends RequestBase {
  kind: NoInputOperationKind;
  binding: WalletSessionBinding;
}

export interface JsonInputWalletOperationRequest extends RequestBase {
  kind: JsonInputOperationKind;
  binding: WalletSessionBinding;
  inputJson: string;
}

export type WalletWorkerRequest =
  | UnlockWalletRequest
  | UnlockAndSealDeviceRequest
  | UnlockFromDeviceRequest
  | CommitDeviceSessionRequest
  | AbortDeviceSessionRequest
  | RevokeDeviceSessionRequest
  | PrepareSignatureVaultCreateRequest
  | PrepareSignatureVaultOpenRequest
  | DeriveSignatureVaultCredentialsRequest
  | CommitSignatureVaultRequest
  | AbortSignatureVaultRequest
  | BeginSignatureVaultDevicePublicationRequest
  | FinalizeSignatureVaultRequest
  | LockWalletRequest
  | NoInputWalletOperationRequest
  | JsonInputWalletOperationRequest;

interface SafeError {
  code: WalletCryptoErrorCode;
  message: string;
}

export type WalletWorkerReply =
  | {
      type: "unlocked";
      requestId: number;
      binding: WalletSessionBinding;
      context: WalletWorkerContext;
    }
  | {
      type: "device-session-prepared";
      requestId: number;
      binding: WalletSessionBinding;
      context: WalletWorkerContext;
      recordRaw: string;
      ownershipToken: string;
      expiresAtMs: number;
    }
  | { type: "device-session-committed"; requestId: number }
  | { type: "device-session-revoked"; requestId: number }
  | {
      type: "signature-vault-prepared";
      requestId: number;
      binding: WalletSessionBinding;
      context: WalletWorkerContext;
      preparationToken: string;
      vaultRaw: string;
      walletAuthId: string;
      authToken: string;
      device: SignatureVaultDevicePreparation | null;
    }
  | {
      type: "signature-vault-credentials";
      requestId: number;
      walletAuthId: string;
      authToken: string;
    }
  | { type: "signature-vault-committed"; requestId: number }
  | { type: "signature-vault-device-publication-ready"; requestId: number }
  | { type: "signature-vault-finalized"; requestId: number; remembered: boolean }
  | { type: "locked"; requestId: number; generation: number }
  | { type: "result"; requestId: number; result: string }
  | { type: "error"; requestId: number; error: SafeError }
  | { type: "fatal"; error: SafeError };

export interface WalletSessionLike {
  lock(): void;
  free?(): void;
  publicConfig(): string;
  recoveryAuthTag(): string;
  deriveProofSigner(inputJson: string): string;
  encryptLocalState(inputJson: string): string;
  decryptLocalState(inputJson: string): string;
  decryptLocalStateClassified(inputJson: string): string;
  buildDepositSubmissionPlan(inputJson: string): string;
  buildOrderRequest(inputJson: string): string;
  buildCancelRequest(inputJson: string): string;
  buildStatusRequests(inputJson: string): string;
  buildWithdrawRequest(inputJson: string): string;
  buildResidualRecovery(inputJson: string): string;
  createRecoverySnapshot(inputJson: string): string;
  decryptRecoveryArtifact(inputJson: string): string;
  decryptRecoveryArtifactClassified(inputJson: string): string;
  signStrk20ExitClaim(inputJson: string): string;
}

export interface WalletSessionModule {
  default(input?: unknown): Promise<unknown>;
  WalletSession: new (
    seed: Uint8Array,
    chainId: string,
    deploymentId: string,
  ) => WalletSessionLike;
}

export interface WalletCryptoWorkerDispatcherOptions {
  loadWalletModule: () => Promise<WalletSessionModule>;
  randomBytes?: (length: number) => Uint8Array;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  beforePublish?: () => void;
  onAsyncTerminal?: (code: WalletWorkerTerminalCode) => void;
  deviceSessions?: WalletDeviceWorkerService;
  signatureVault?: WalletSignatureVaultWorkerService;
}

export interface WalletCryptoWorkerDispatcher {
  readonly state: WalletWorkerState;
  readonly terminalReason: WalletWorkerTerminalCode | null;
  dispatch(value: unknown): Promise<WalletWorkerReply>;
  terminate(code?: WalletWorkerTerminalCode): void;
}

const NO_INPUT_OPERATIONS = new Set<NoInputOperationKind>([
  "public-config",
  "recovery-auth-tag",
]);

const JSON_INPUT_OPERATIONS = new Set<JsonInputOperationKind>([
  "derive-proof-signer",
  "encrypt-local-state",
  "decrypt-local-state",
  "build-deposit-submission-plan",
  "build-order-request",
  "build-cancel-request",
  "build-status-requests",
  "build-withdraw-request",
  "build-residual-recovery",
  "create-recovery-snapshot",
  "decrypt-recovery-artifact",
  "sign-strk20-exit-claim",
]);

const ERROR_CODES = new Set<WalletCryptoErrorCode>(
  Object.keys(WALLET_CRYPTO_ERROR_MESSAGES) as WalletCryptoErrorCode[],
);
const WORKER_ERROR_CODES = new Set<WalletCryptoErrorCode>([
  "SESSION_ACTIVE",
  "SESSION_MISMATCH",
  "SESSION_LOCKED",
  "SESSION_EXPIRED",
  "INVALID_CONTEXT",
  "OPERATION_FAILED",
  "MIGRATION_REQUIRED",
  "DEVICE_SESSION_MISSING",
  "DEVICE_SESSION_EXPIRED",
  "DEVICE_SESSION_INVALID",
  "DEVICE_SESSION_FAILED",
  "SIGNATURE_VAULT_INVALID",
  "SIGNATURE_VAULT_FAILED",
]);
const WORKER_FATAL_CODES = new Set<WalletCryptoErrorCode>([
  "INVALID_MESSAGE",
  "SESSION_ACTIVE",
  "SESSION_EXPIRED",
  "WORKER_FAILED",
  "CLIENT_INVALIDATED",
]);

function ownDataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor) || !descriptor.enumerable) return null;
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  return value as Record<string, unknown>;
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

interface Uint8ArrayDetails {
  view: Uint8Array;
  buffer: ArrayBuffer | SharedArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

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

function storageByteLength(value: unknown): number | null {
  return arrayBufferByteLength(value) ?? sharedArrayBufferByteLength(value);
}

function inspectUint8Array(value: unknown): Uint8ArrayDetails | null {
  if (!ArrayBuffer.isView(value)) return null;
  try {
    if (TYPED_ARRAY_TAG_GETTER?.call(value) !== "Uint8Array") return null;
    const buffer = TYPED_ARRAY_BUFFER_GETTER?.call(value) as unknown;
    if (storageByteLength(buffer) === null) return null;
    return {
      view: value as Uint8Array,
      buffer: buffer as ArrayBuffer | SharedArrayBuffer,
      byteOffset: TYPED_ARRAY_BYTE_OFFSET_GETTER?.call(value) as number,
      byteLength: TYPED_ARRAY_BYTE_LENGTH_GETTER?.call(value) as number,
    };
  } catch {
    return null;
  }
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const record = ownDataRecord(value);
  if (!record) throw new Error("invalid");
  const keys = Object.keys(record);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    throw new Error("invalid");
  }
  return record;
}

function requestId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > WALLET_WORKER_MAX_REQUEST_ID) {
    throw new Error("invalid");
  }
  return value as number;
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > WALLET_WORKER_MAX_REQUEST_ID) {
    throw new Error("invalid");
  }
  return value as number;
}

function boundedString(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error("invalid");
  }
  return value;
}

function canonicalNonzeroFelt(value: unknown): string {
  const source = boundedString(value, 66);
  if (!/^(?:0x)?[0-9a-fA-F]+$/.test(source)) throw new Error("invalid");
  const parsed = BigInt(source.startsWith("0x") ? source : `0x${source}`);
  if (parsed === 0n || parsed >= STARKNET_FIELD_MODULUS) throw new Error("invalid");
  return `0x${parsed.toString(16)}`;
}

function normalizedOrigin(value: unknown): string {
  return normalizeWalletDeviceOrigin(value);
}

function manifestIdentity(value: unknown): string {
  const source = boundedString(value, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(source)) throw new Error("invalid");
  return source;
}

function positiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("invalid");
  return value as number;
}

export function normalizeWalletWorkerContext(value: unknown): WalletWorkerContext {
  const record = exactRecord(value, [
    "walletAddress",
    "chainId",
    "deploymentId",
    "vaultDeploymentId",
    "origin",
    "manifestIdentity",
    "manifestVersion",
    "expiresAtMs",
  ]);
  return {
    walletAddress: canonicalNonzeroFelt(record.walletAddress),
    chainId: canonicalNonzeroFelt(record.chainId),
    deploymentId: canonicalNonzeroFelt(record.deploymentId),
    vaultDeploymentId: canonicalNonzeroFelt(record.vaultDeploymentId),
    origin: normalizedOrigin(record.origin),
    manifestIdentity: manifestIdentity(record.manifestIdentity),
    manifestVersion: record.manifestVersion === "1" ? "1" : (() => { throw new Error("invalid"); })(),
    expiresAtMs: positiveSafeInteger(record.expiresAtMs),
  };
}

export function walletWorkerContextToken(context: WalletWorkerContext): string {
  return JSON.stringify([
    context.walletAddress,
    context.chainId,
    context.deploymentId,
    context.vaultDeploymentId,
    context.origin,
    context.manifestIdentity,
    context.manifestVersion,
    context.expiresAtMs,
  ]);
}

function parseBinding(value: unknown): WalletSessionBinding {
  const record = exactRecord(value, ["sessionId", "generation", "contextToken"]);
  const sessionId = boundedString(record.sessionId, 128);
  if (!/^wcs_[0-9a-f]{32}$/.test(sessionId)) throw new Error("invalid");
  return {
    sessionId,
    generation: generation(record.generation),
    contextToken: boundedString(record.contextToken, 2_048),
  };
}

function parseOperationInput(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_OPERATION_INPUT_BYTES) {
    throw new Error("invalid");
  }
  return value;
}

type ClassifiedDecryptOutcome =
  | { status: "OK"; result: string }
  | { status: "MIGRATION_REQUIRED" }
  | { status: "DATA_INVALID" };

function parseClassifiedDecryptOutcome(source: unknown): ClassifiedDecryptOutcome {
  if (typeof source !== "string" || source.length > MAX_CLASSIFIED_OUTCOME_CHARS) throw new Error("invalid");
  const parsed = parseWalletJson(source);
  const root = ownDataRecord(parsed);
  if (!root || typeof root.status !== "string") throw new Error("invalid");
  if (root.status === "OK") {
    const record = exactRecord(root, ["status", "result_b64"]);
    return { status: "OK", result: decodeClassifiedResult(record.result_b64) };
  }
  if (root.status === "MIGRATION_REQUIRED" || root.status === "DATA_INVALID") {
    exactRecord(root, ["status"]);
    return { status: root.status };
  }
  throw new Error("invalid");
}

function decodeClassifiedResult(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CLASSIFIED_RESULT_BASE64_CHARS
    || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) throw new Error("invalid");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("invalid");
  }
  if (binary.length > MAX_OPERATION_INPUT_BYTES || btoa(binary) !== value) throw new Error("invalid");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("invalid");
  } finally {
    bytes.fill(0);
  }
}

export function parseWalletWorkerRequest(value: unknown): WalletWorkerRequest {
  const root = ownDataRecord(value);
  if (!root || typeof root.kind !== "string") throw new Error("invalid");
  if (root.kind === "unlock") {
    const record = exactRecord(root, ["kind", "requestId", "seed", "context"]);
    const seed = inspectUint8Array(record.seed);
    if (
      !seed
      || arrayBufferByteLength(seed.buffer) !== 32
      || seed.byteOffset !== 0
      || seed.byteLength !== 32
    ) {
      throw new Error("invalid");
    }
    return {
      kind: "unlock",
      requestId: requestId(record.requestId),
      seed: seed.view,
      context: normalizeWalletWorkerContext(record.context),
    };
  }
  if (root.kind === "unlock-and-seal-device") {
    const record = exactRecord(root, ["kind", "requestId", "seed", "context", "ttlMs", "priorRecordRaw"]);
    const seed = inspectUint8Array(record.seed);
    if (
      !seed
      || arrayBufferByteLength(seed.buffer) !== 32
      || seed.byteOffset !== 0
      || seed.byteLength !== 32
      || !Number.isSafeInteger(record.ttlMs)
      || (record.ttlMs as number) <= 0
    ) throw new Error("invalid");
    return {
      kind: "unlock-and-seal-device",
      requestId: requestId(record.requestId),
      seed: seed.view,
      context: normalizeWalletWorkerContext(record.context),
      ttlMs: record.ttlMs as number,
      priorRecordRaw: nullableDeviceRecord(record.priorRecordRaw),
    };
  }
  if (root.kind === "unlock-from-device") {
    const record = exactRecord(root, ["kind", "requestId", "context", "recordRaw"]);
    return {
      kind: "unlock-from-device",
      requestId: requestId(record.requestId),
      context: normalizeWalletWorkerContext(record.context),
      recordRaw: deviceRecord(record.recordRaw),
    };
  }
  if (root.kind === "commit-device-session") {
    const record = exactRecord(root, ["kind", "requestId", "binding", "ownershipToken", "priorRecordRaw"]);
    return {
      kind: "commit-device-session",
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
      ownershipToken: deviceOwnershipToken(record.ownershipToken),
      priorRecordRaw: nullableDeviceRecord(record.priorRecordRaw),
    };
  }
  if (root.kind === "abort-device-session") {
    const record = exactRecord(root, ["kind", "requestId", "binding", "ownershipToken"]);
    return {
      kind: "abort-device-session",
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
      ownershipToken: deviceOwnershipToken(record.ownershipToken),
    };
  }
  if (root.kind === "revoke-device-session") {
    const record = exactRecord(root, ["kind", "requestId", "binding", "recordRaw", "ownershipToken"]);
    return {
      kind: "revoke-device-session",
      requestId: requestId(record.requestId),
      binding: record.binding === null ? null : parseBinding(record.binding),
      recordRaw: deviceRecord(record.recordRaw),
      ownershipToken: deviceOwnershipToken(record.ownershipToken),
    };
  }
  if (root.kind === "prepare-signature-vault-create" || root.kind === "prepare-signature-vault-open") {
    const fields = root.kind === "prepare-signature-vault-create"
      ? ["kind", "requestId", "signature", "context", "rememberDevice", "deviceTtlMs", "priorDeviceRecordRaw"]
      : ["kind", "requestId", "signature", "context", "vaultRaw", "rememberDevice", "deviceTtlMs", "priorDeviceRecordRaw"];
    const record = exactRecord(root, fields);
    if (typeof record.rememberDevice !== "boolean"
      || !Number.isSafeInteger(record.deviceTtlMs)
      || (record.deviceTtlMs as number) <= 0) throw new Error("invalid");
    const common = {
      requestId: requestId(record.requestId),
      signature: normalizeWalletSignature(record.signature),
      context: normalizeWalletWorkerContext(record.context),
      rememberDevice: record.rememberDevice,
      deviceTtlMs: record.deviceTtlMs as number,
      priorDeviceRecordRaw: nullableDeviceRecord(record.priorDeviceRecordRaw),
    };
    return root.kind === "prepare-signature-vault-create"
      ? { kind: root.kind, ...common }
      : { kind: root.kind, ...common, vaultRaw: signatureVaultRaw(record.vaultRaw) };
  }
  if (root.kind === "derive-signature-vault-credentials") {
    const record = exactRecord(root, ["kind", "requestId", "signature", "context"]);
    return {
      kind: root.kind,
      requestId: requestId(record.requestId),
      signature: normalizeWalletSignature(record.signature),
      context: normalizeWalletWorkerContext(record.context),
    };
  }
  if (root.kind === "commit-signature-vault"
    || root.kind === "abort-signature-vault"
    || root.kind === "begin-signature-vault-device-publication") {
    const record = exactRecord(root, ["kind", "requestId", "binding", "preparationToken", "vaultRaw", "device"]);
    return {
      kind: root.kind,
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
      preparationToken: signaturePreparationToken(record.preparationToken),
      vaultRaw: signatureVaultRaw(record.vaultRaw),
      device: parseSignatureDevicePreparation(record.device),
    };
  }
  if (root.kind === "finalize-signature-vault") {
    const record = exactRecord(root, ["kind", "requestId", "binding", "preparationToken", "vaultRaw", "device", "devicePublication"]);
    if (record.devicePublication !== "published"
      && record.devicePublication !== "discard"
      && record.devicePublication !== "unknown") throw new Error("invalid");
    return {
      kind: root.kind,
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
      preparationToken: signaturePreparationToken(record.preparationToken),
      vaultRaw: signatureVaultRaw(record.vaultRaw),
      device: parseSignatureDevicePreparation(record.device),
      devicePublication: record.devicePublication,
    };
  }
  if (root.kind === "lock") {
    const record = exactRecord(root, ["kind", "requestId", "binding"]);
    return {
      kind: "lock",
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
    };
  }
  if (NO_INPUT_OPERATIONS.has(root.kind as NoInputOperationKind)) {
    const record = exactRecord(root, ["kind", "requestId", "binding"]);
    return {
      kind: root.kind as NoInputOperationKind,
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
    };
  }
  if (JSON_INPUT_OPERATIONS.has(root.kind as JsonInputOperationKind)) {
    const record = exactRecord(root, ["kind", "requestId", "binding", "inputJson"]);
    return {
      kind: root.kind as JsonInputOperationKind,
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
      inputJson: parseOperationInput(record.inputJson),
    };
  }
  throw new Error("invalid");
}

function deviceRecord(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw new Error("invalid");
  return value;
}

function nullableDeviceRecord(value: unknown): string | null {
  return value === null ? null : deviceRecord(value);
}

function deviceOwnershipToken(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("invalid");
  return value;
}

function signatureVaultRaw(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) throw new Error("invalid");
  return value;
}

function signaturePreparationToken(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/.test(value)) throw new Error("invalid");
  return value;
}

function parseSignatureDevicePreparation(value: unknown): SignatureVaultDevicePreparation | null {
  if (value === null) return null;
  const record = exactRecord(value, ["recordRaw", "ownershipToken", "expiresAtMs", "priorRecordRaw"]);
  if (!Number.isSafeInteger(record.expiresAtMs) || (record.expiresAtMs as number) <= 0) throw new Error("invalid");
  return {
    recordRaw: deviceRecord(record.recordRaw),
    ownershipToken: deviceOwnershipToken(record.ownershipToken),
    expiresAtMs: record.expiresAtMs as number,
    priorRecordRaw: nullableDeviceRecord(record.priorRecordRaw),
  };
}

function validateSignatureVaultForContext(raw: string, context: WalletWorkerContext): void {
  let parsed: unknown;
  try {
    parsed = parseWalletJson(raw, ["version", "message_version"]);
  } catch {
    throw new Error("invalid");
  }
  if (!isWalletSignatureVaultRecord(parsed)
    || parsed.wallet_address !== context.walletAddress
    || parsed.chain_id !== context.chainId
    || parsed.deployment_id !== context.vaultDeploymentId
    || parsed.origin !== context.origin
    || parsed.message_version !== 2) throw new Error("invalid");
}

function validateSignatureDeviceForContext(
  device: SignatureVaultDevicePreparation | null,
  context: WalletWorkerContext,
): void {
  if (device === null) return;
  const details = inspectWalletDeviceRecord(device.recordRaw);
  if (details.ownershipToken !== device.ownershipToken
    || details.expiresAtMs !== device.expiresAtMs
    || details.walletAddress !== context.walletAddress
    || details.chainId !== context.chainId
    || details.deploymentId !== context.deploymentId
    || details.origin !== context.origin
    || details.manifestIdentity !== context.manifestIdentity
    || details.manifestVersion !== context.manifestVersion) throw new Error("invalid");
}

function safeError(code: WalletCryptoErrorCode): SafeError {
  return { code, message: WALLET_CRYPTO_ERROR_MESSAGES[code] };
}

function parseSafeError(value: unknown, allowedCodes: ReadonlySet<WalletCryptoErrorCode>): SafeError {
  const record = exactRecord(value, ["code", "message"]);
  if (typeof record.code !== "string" || !ERROR_CODES.has(record.code as WalletCryptoErrorCode)) {
    throw new Error("invalid");
  }
  const code = record.code as WalletCryptoErrorCode;
  if (!allowedCodes.has(code)) throw new Error("invalid");
  if (record.message !== WALLET_CRYPTO_ERROR_MESSAGES[code]) throw new Error("invalid");
  return safeError(code);
}

export function parseWalletWorkerReply(value: unknown): WalletWorkerReply {
  const root = ownDataRecord(value);
  if (!root || typeof root.type !== "string") throw new Error("invalid");
  if (root.type === "unlocked") {
    const record = exactRecord(root, ["type", "requestId", "binding", "context"]);
    return {
      type: "unlocked",
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
      context: normalizeWalletWorkerContext(record.context),
    };
  }
  if (root.type === "device-session-prepared") {
    const record = exactRecord(root, [
      "type", "requestId", "binding", "context", "recordRaw", "ownershipToken", "expiresAtMs",
    ]);
    if (!Number.isSafeInteger(record.expiresAtMs) || (record.expiresAtMs as number) <= 0) throw new Error("invalid");
    const context = normalizeWalletWorkerContext(record.context);
    const recordRaw = deviceRecord(record.recordRaw);
    const ownershipToken = deviceOwnershipToken(record.ownershipToken);
    const details = inspectWalletDeviceRecord(recordRaw);
    if (
      details.ownershipToken !== ownershipToken
      || details.expiresAtMs !== record.expiresAtMs
      || details.walletAddress !== context.walletAddress
      || details.chainId !== context.chainId
      || details.deploymentId !== context.deploymentId
      || details.origin !== context.origin
      || details.manifestIdentity !== context.manifestIdentity
      || details.manifestVersion !== context.manifestVersion
    ) throw new Error("invalid");
    return {
      type: "device-session-prepared",
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
      context,
      recordRaw,
      ownershipToken,
      expiresAtMs: record.expiresAtMs as number,
    };
  }
  if (root.type === "device-session-committed" || root.type === "device-session-revoked") {
    const record = exactRecord(root, ["type", "requestId"]);
    return { type: root.type, requestId: requestId(record.requestId) };
  }
  if (root.type === "signature-vault-prepared") {
    const record = exactRecord(root, [
      "type", "requestId", "binding", "context", "preparationToken", "vaultRaw",
      "walletAuthId", "authToken", "device",
    ]);
    if (typeof record.walletAuthId !== "string" || !/^0x[0-9a-f]{64}$/.test(record.walletAuthId)
      || typeof record.authToken !== "string" || !/^[0-9a-f]{64}$/.test(record.authToken)) throw new Error("invalid");
    const context = normalizeWalletWorkerContext(record.context);
    const vaultRaw = signatureVaultRaw(record.vaultRaw);
    const device = parseSignatureDevicePreparation(record.device);
    validateSignatureVaultForContext(vaultRaw, context);
    validateSignatureDeviceForContext(device, context);
    return {
      type: "signature-vault-prepared",
      requestId: requestId(record.requestId),
      binding: parseBinding(record.binding),
      context,
      preparationToken: signaturePreparationToken(record.preparationToken),
      vaultRaw,
      walletAuthId: record.walletAuthId,
      authToken: record.authToken,
      device,
    };
  }
  if (root.type === "signature-vault-credentials") {
    const record = exactRecord(root, ["type", "requestId", "walletAuthId", "authToken"]);
    if (typeof record.walletAuthId !== "string" || !/^0x[0-9a-f]{64}$/.test(record.walletAuthId)
      || typeof record.authToken !== "string" || !/^[0-9a-f]{64}$/.test(record.authToken)) throw new Error("invalid");
    return {
      type: root.type,
      requestId: requestId(record.requestId),
      walletAuthId: record.walletAuthId,
      authToken: record.authToken,
    };
  }
  if (root.type === "signature-vault-committed") {
    const record = exactRecord(root, ["type", "requestId"]);
    return { type: root.type, requestId: requestId(record.requestId) };
  }
  if (root.type === "signature-vault-device-publication-ready") {
    const record = exactRecord(root, ["type", "requestId"]);
    return { type: root.type, requestId: requestId(record.requestId) };
  }
  if (root.type === "signature-vault-finalized") {
    const record = exactRecord(root, ["type", "requestId", "remembered"]);
    if (typeof record.remembered !== "boolean") throw new Error("invalid");
    return { type: root.type, requestId: requestId(record.requestId), remembered: record.remembered };
  }
  if (root.type === "locked") {
    const record = exactRecord(root, ["type", "requestId", "generation"]);
    return { type: "locked", requestId: requestId(record.requestId), generation: generation(record.generation) };
  }
  if (root.type === "result") {
    const record = exactRecord(root, ["type", "requestId", "result"]);
    return {
      type: "result",
      requestId: requestId(record.requestId),
      result: typeof record.result === "string" ? record.result : (() => { throw new Error("invalid"); })(),
    };
  }
  if (root.type === "error") {
    const record = exactRecord(root, ["type", "requestId", "error"]);
    return {
      type: "error",
      requestId: requestId(record.requestId),
      error: parseSafeError(record.error, WORKER_ERROR_CODES),
    };
  }
  if (root.type === "fatal") {
    const record = exactRecord(root, ["type", "error"]);
    return {
      type: "fatal",
      error: parseSafeError(record.error, WORKER_FATAL_CODES),
    };
  }
  throw new Error("invalid");
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function sessionId(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new Error("invalid");
  const random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `wcs_${random}`;
}

function randomToken(randomBytes: (length: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) throw new Error("invalid");
  try {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } finally {
    bytes.fill(0);
  }
}

function bindingsEqual(left: WalletSessionBinding, right: WalletSessionBinding): boolean {
  return left.sessionId === right.sessionId
    && left.generation === right.generation
    && left.contextToken === right.contextToken;
}

export function createWalletCryptoWorkerDispatcher(
  options: WalletCryptoWorkerDispatcherOptions,
): WalletCryptoWorkerDispatcher {
  let state: WalletWorkerState = "ABSENT";
  let module: WalletSessionModule | null = null;
  let session: WalletSessionLike | null = null;
  let binding: WalletSessionBinding | null = null;
  let sessionContext: WalletWorkerContext | null = null;
  let successfulSessionOpened = false;
  let currentGeneration = 0;
  let lastRequestId = 0;
  let queue: Promise<void> = Promise.resolve();
  let lifecycleEpoch = 0;
  let terminalReason: WalletWorkerTerminalCode = "CLIENT_INVALIDATED";
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  const queuedUnlockSeeds = new Set<Uint8Array>();
  const pendingDeviceCleanups = new Set<Promise<void>>();
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));

  interface ActiveUnlock {
    epoch: number;
    receivedSeed: Uint8Array;
    wasmSeed: Uint8Array;
    nextSession: WalletSessionLike | null;
  }

  let activeUnlock: ActiveUnlock | null = null;
  let preparedDevice: {
    raw: string;
    ownershipToken: string;
    priorRecordRaw: string | null;
  } | null = null;
  let activeDevice: { raw: string; ownershipToken: string } | null = null;
  let preparedSignature: {
    phase: "prepared" | "committed" | "device-publishing";
    binding: WalletSessionBinding;
    preparationToken: string;
    vaultRaw: string;
    device: SignatureVaultDevicePreparation | null;
  } | null = null;

  function readNow(): number {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid");
    return value;
  }

  function wipeByteView(candidate: unknown) {
    try {
      const inspected = inspectUint8Array(candidate);
      if (inspected && (storageByteLength(inspected.buffer) ?? 0) > 0) {
        new Uint8Array(inspected.buffer).fill(0);
      }
    } catch {
      // a detached candidate has no bytes left to overwrite in this realm
    }
  }

  function destroyWalletSession(candidate: WalletSessionLike | null) {
    if (!candidate) return;
    try {
      candidate.lock();
    } catch {
      // lock failures cannot preserve a usable session reference
    }
    try {
      candidate.free?.();
    } catch {
      // wasm disposal failures remain inside the worker boundary
    }
  }

  function clearExpiryTimer() {
    if (expiryTimer === null) return;
    try {
      clearTimer(expiryTimer);
    } catch {
      // timer cleanup failure cannot prevent terminal session destruction
    }
    expiryTimer = null;
  }

  function cleanupActiveUnlock(active: ActiveUnlock) {
    wipeByteView(active.wasmSeed);
    wipeByteView(active.receivedSeed);
    destroyWalletSession(active.nextSession);
    active.nextSession = null;
    if (activeUnlock === active) activeUnlock = null;
  }

  function destroyPublishedSession(nextState: WalletWorkerState) {
    state = "INVALIDATING";
    const prior = session;
    session = null;
    binding = null;
    sessionContext = null;
    destroyWalletSession(prior);
    state = nextState;
  }

  function trackDeviceCleanup(cleanup: Promise<void>) {
    let tracked: Promise<void>;
    tracked = cleanup
      .catch(() => undefined)
      .finally(() => { pendingDeviceCleanups.delete(tracked); });
    pendingDeviceCleanups.add(tracked);
  }

  function terminate(code: WalletWorkerTerminalCode = "CLIENT_INVALIDATED") {
    if (state === "TERMINATED") return;
    terminalReason = code;
    lifecycleEpoch += 1;
    clearExpiryTimer();
    if (activeUnlock) cleanupActiveUnlock(activeUnlock);
    for (const seed of queuedUnlockSeeds) wipeByteView(seed);
    queuedUnlockSeeds.clear();
    const abandonedDevice = preparedDevice;
    preparedDevice = null;
    activeDevice = null;
    if (abandonedDevice && options.deviceSessions) {
      trackDeviceCleanup(options.deviceSessions.discard(
        abandonedDevice.raw,
        abandonedDevice.ownershipToken,
      ));
    }
    const abandonedSignature = preparedSignature;
    preparedSignature = null;
    if (abandonedSignature?.device
      && abandonedSignature.phase !== "device-publishing"
      && options.deviceSessions) {
      trackDeviceCleanup(options.deviceSessions.discard(
        abandonedSignature.device.recordRaw,
        abandonedSignature.device.ownershipToken,
      ));
    }
    destroyPublishedSession("TERMINATED");
    module = null;
  }

  function notifyAsyncTerminal(code: WalletWorkerTerminalCode) {
    try {
      options.onAsyncTerminal?.(code);
    } catch {
      // terminal cleanup must not depend on an observer
    }
  }

  function expireFromTimer() {
    if (state !== "OPEN" || !sessionContext) return;
    let current: number;
    try {
      current = readNow();
    } catch {
      terminate("WORKER_FAILED");
      notifyAsyncTerminal("WORKER_FAILED");
      return;
    }
    const remaining = sessionContext.expiresAtMs - current;
    if (remaining <= 0) {
      terminate("SESSION_EXPIRED");
      notifyAsyncTerminal("SESSION_EXPIRED");
      return;
    }
    expiryTimer = setTimer(expireFromTimer, Math.min(remaining, MAX_TIMER_DELAY_MS));
  }

  function scheduleExpiry() {
    clearExpiryTimer();
    expireFromTimer();
  }

  function wipeTransferredSeedCandidate(value: unknown) {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, "seed");
    } catch {
      return;
    }
    if (!descriptor || !("value" in descriptor)) return;
    const seed = inspectUint8Array(descriptor.value);
    if (seed) wipeByteView(seed.view);
  }

  function fatalReply(code: WalletWorkerTerminalCode): WalletWorkerReply {
    return { type: "fatal", error: safeError(code) };
  }

  function errorReply(request: WalletWorkerRequest, code: WalletCryptoErrorCode): WalletWorkerReply {
    return { type: "error", requestId: request.requestId, error: safeError(code) };
  }

  function validBinding(request: { binding: WalletSessionBinding }): boolean {
    return session !== null && binding !== null && bindingsEqual(request.binding, binding);
  }

  function deviceError(error: unknown): WalletCryptoErrorCode {
    return error instanceof WalletDeviceSessionError ? error.code : "DEVICE_SESSION_FAILED";
  }

  function contextTimeError(context: WalletWorkerContext): WalletCryptoErrorCode | null {
    const current = readNow();
    if (context.expiresAtMs <= current) return "SESSION_EXPIRED";
    if (context.expiresAtMs - current > WALLET_WORKER_MAX_SESSION_LIFETIME_MS) {
      return "INVALID_CONTEXT";
    }
    return null;
  }

  function stillOpening(epoch: number): boolean {
    return state !== "TERMINATED" && lifecycleEpoch === epoch;
  }

  async function unlock(
    request: UnlockWalletRequest,
    generationReserved = false,
    deferExpiry = false,
  ): Promise<WalletWorkerReply> {
    if (successfulSessionOpened || state === "OPEN") {
      wipeByteView(request.seed);
      terminate("SESSION_ACTIVE");
      return fatalReply("SESSION_ACTIVE");
    }

    let timeError: WalletCryptoErrorCode | null;
    try {
      timeError = contextTimeError(request.context);
    } catch {
      wipeByteView(request.seed);
      terminate("WORKER_FAILED");
      return fatalReply("WORKER_FAILED");
    }
    if (timeError) {
      wipeByteView(request.seed);
      if (timeError === "SESSION_EXPIRED") terminate("SESSION_EXPIRED");
      return errorReply(request, timeError);
    }

    if (!generationReserved) currentGeneration += 1;
    const epoch = lifecycleEpoch + 1;
    lifecycleEpoch = epoch;
    const active: ActiveUnlock = {
      epoch,
      receivedSeed: request.seed,
      wasmSeed: new Uint8Array(request.seed),
      nextSession: null,
    };
    activeUnlock = active;

    try {
      if (!module) {
        state = "BOOTING";
        let candidate: WalletSessionModule;
        try {
          candidate = await options.loadWalletModule();
          if (!stillOpening(epoch)) return fatalReply(terminalReason);
          await candidate.default();
          if (!stillOpening(epoch)) return fatalReply(terminalReason);
          module = candidate;
        } catch {
          if (!stillOpening(epoch)) return fatalReply(terminalReason);
          module = null;
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        }
      }

      if (!stillOpening(epoch)) return fatalReply(terminalReason);
      state = "OPENING";
      const nextSessionId = sessionId(randomBytes);
      if (!stillOpening(epoch)) return fatalReply(terminalReason);
      const nextSession = new module.WalletSession(
        active.wasmSeed,
        request.context.chainId,
        request.context.deploymentId,
      );
      active.nextSession = nextSession;
      if (!stillOpening(epoch)) return fatalReply(terminalReason);
      options.beforePublish?.();
      if (!stillOpening(epoch)) return fatalReply(terminalReason);

      const nextBinding: WalletSessionBinding = Object.freeze({
        sessionId: nextSessionId,
        generation: currentGeneration,
        contextToken: walletWorkerContextToken(request.context),
      });
      session = nextSession;
      active.nextSession = null;
      binding = nextBinding;
      sessionContext = Object.freeze({ ...request.context });
      state = "OPEN";
      if (!deferExpiry) scheduleExpiry();
      if (!stillOpening(epoch)) return fatalReply(terminalReason);
      successfulSessionOpened = true;
      return {
        type: "unlocked",
        requestId: request.requestId,
        binding: { ...nextBinding },
        context: { ...request.context },
      };
    } catch {
      if (state === "TERMINATED") return fatalReply(terminalReason);
      if (session) {
        terminate("WORKER_FAILED");
        return fatalReply("WORKER_FAILED");
      }
      destroyPublishedSession("LOCKED");
      return errorReply(request, "OPERATION_FAILED");
    } finally {
      cleanupActiveUnlock(active);
    }
  }

  async function unlockAndSealDevice(request: UnlockAndSealDeviceRequest): Promise<WalletWorkerReply> {
    if (successfulSessionOpened || state === "OPEN") {
      wipeByteView(request.seed);
      const abandoned = preparedDevice;
      preparedDevice = null;
      if (abandoned && options.deviceSessions) {
        try {
          await options.deviceSessions.discard(abandoned.raw, abandoned.ownershipToken);
        } catch {
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        }
      }
      terminate("SESSION_ACTIVE");
      return fatalReply("SESSION_ACTIVE");
    }
    currentGeneration += 1;
    if (!options.deviceSessions) {
      wipeByteView(request.seed);
      return errorReply(request, "DEVICE_SESSION_FAILED");
    }
    let prepared: Awaited<ReturnType<WalletDeviceWorkerService["prepare"]>>;
    try {
      prepared = await options.deviceSessions.prepare(request.seed, request.context, request.ttlMs);
    } catch (error) {
      wipeByteView(request.seed);
      return errorReply(request, deviceError(error));
    }
    const opened = await unlock({
      kind: "unlock",
      requestId: request.requestId,
      seed: request.seed,
      context: request.context,
    }, true);
    if (opened.type !== "unlocked") {
      try {
        await options.deviceSessions.discard(prepared.raw, prepared.ownershipToken);
      } catch {
        terminate("WORKER_FAILED");
        return fatalReply("WORKER_FAILED");
      }
      return opened;
    }
    clearExpiryTimer();
    preparedDevice = {
      raw: prepared.raw,
      ownershipToken: prepared.ownershipToken,
      priorRecordRaw: request.priorRecordRaw,
    };
    return {
      type: "device-session-prepared",
      requestId: request.requestId,
      binding: opened.binding,
      context: opened.context,
      recordRaw: prepared.raw,
      ownershipToken: prepared.ownershipToken,
      expiresAtMs: prepared.expiresAtMs,
    };
  }

  async function unlockFromDevice(request: UnlockFromDeviceRequest): Promise<WalletWorkerReply> {
    if (successfulSessionOpened || state === "OPEN") {
      terminate("SESSION_ACTIVE");
      return fatalReply("SESSION_ACTIVE");
    }
    currentGeneration += 1;
    if (!options.deviceSessions) return errorReply(request, "DEVICE_SESSION_FAILED");
    let seed: Uint8Array;
    try {
      seed = await options.deviceSessions.open(request.recordRaw, request.context);
    } catch (error) {
      return errorReply(request, deviceError(error));
    }
    const opened = await unlock({
      kind: "unlock",
      requestId: request.requestId,
      seed,
      context: request.context,
    }, true);
    if (opened.type === "unlocked") {
      const details = inspectWalletDeviceRecord(request.recordRaw);
      activeDevice = { raw: request.recordRaw, ownershipToken: details.ownershipToken };
    }
    return opened;
  }

  async function commitDeviceSession(request: CommitDeviceSessionRequest): Promise<WalletWorkerReply> {
    if (!options.deviceSessions || state !== "OPEN" || !validBinding(request)) {
      return errorReply(request, state === "OPEN" ? "SESSION_MISMATCH" : "SESSION_LOCKED");
    }
    if (
      !preparedDevice
      || preparedDevice.ownershipToken !== request.ownershipToken
      || preparedDevice.priorRecordRaw !== request.priorRecordRaw
    ) {
      return errorReply(request, "DEVICE_SESSION_INVALID");
    }
    const committed = preparedDevice;
    preparedDevice = null;
    activeDevice = { raw: committed.raw, ownershipToken: committed.ownershipToken };
    if (request.priorRecordRaw !== null) {
      try {
        await options.deviceSessions.retire(request.priorRecordRaw);
      } catch {
        // publication is already committed; an old key without its record is inert cleanup residue
      }
    }
    try {
      if (!sessionContext || readNow() >= sessionContext.expiresAtMs) {
        terminate("SESSION_EXPIRED");
        return errorReply(request, "SESSION_EXPIRED");
      }
      scheduleExpiry();
    } catch {
      terminate("WORKER_FAILED");
      return fatalReply("WORKER_FAILED");
    }
    return { type: "device-session-committed", requestId: request.requestId };
  }

  async function abortDeviceSession(request: AbortDeviceSessionRequest): Promise<WalletWorkerReply> {
    if (!options.deviceSessions || state !== "OPEN" || !validBinding(request)) {
      return errorReply(request, state === "OPEN" ? "SESSION_MISMATCH" : "SESSION_LOCKED");
    }
    if (!preparedDevice || preparedDevice.ownershipToken !== request.ownershipToken) {
      return errorReply(request, "DEVICE_SESSION_INVALID");
    }
    const abandoned = preparedDevice;
    preparedDevice = null;
    try {
      await options.deviceSessions.discard(abandoned.raw, abandoned.ownershipToken);
    } catch {
      terminate("WORKER_FAILED");
      return fatalReply("WORKER_FAILED");
    }
    currentGeneration += 1;
    terminate("CLIENT_INVALIDATED");
    return { type: "locked", requestId: request.requestId, generation: currentGeneration };
  }

  async function revokeDeviceSession(request: RevokeDeviceSessionRequest): Promise<WalletWorkerReply> {
    if (!options.deviceSessions) return errorReply(request, "DEVICE_SESSION_FAILED");
    if (state === "OPEN" && (request.binding === null || !validBinding({ binding: request.binding }))) {
      return errorReply(request, "SESSION_MISMATCH");
    }
    if (state !== "OPEN" && request.binding !== null) return errorReply(request, "SESSION_MISMATCH");
    const owned = state === "OPEN" && activeDevice !== null ? activeDevice : {
      raw: request.recordRaw,
      ownershipToken: request.ownershipToken,
    };
    try {
      if (owned !== null) await options.deviceSessions.discard(owned.raw, owned.ownershipToken);
      if (state === "OPEN") {
        activeDevice = null;
        currentGeneration += 1;
        terminate("CLIENT_INVALIDATED");
        return { type: "locked", requestId: request.requestId, generation: currentGeneration };
      }
      return { type: "device-session-revoked", requestId: request.requestId };
    } catch (error) {
      if (state === "OPEN") {
        activeDevice = null;
        currentGeneration += 1;
        terminate("CLIENT_INVALIDATED");
        return errorReply(request, deviceError(error));
      }
      return errorReply(request, deviceError(error));
    }
  }

  function signaturePreparationMatches(request: {
    binding: WalletSessionBinding;
    preparationToken: string;
    vaultRaw: string;
    device: SignatureVaultDevicePreparation | null;
  }): boolean {
    const expectedDevice = preparedSignature?.device ?? null;
    const deviceMatches = request.device === null || expectedDevice === null
      ? request.device === expectedDevice
      : request.device.recordRaw === expectedDevice.recordRaw
        && request.device.ownershipToken === expectedDevice.ownershipToken
        && request.device.expiresAtMs === expectedDevice.expiresAtMs
        && request.device.priorRecordRaw === expectedDevice.priorRecordRaw;
    return preparedSignature !== null
      && bindingsEqual(request.binding, preparedSignature.binding)
      && request.preparationToken === preparedSignature.preparationToken
      && request.vaultRaw === preparedSignature.vaultRaw
      && deviceMatches;
  }

  async function discardSignatureDevice(
    preparation: NonNullable<typeof preparedSignature>,
  ): Promise<void> {
    if (!preparation.device || !options.deviceSessions) return;
    await options.deviceSessions.discard(
      preparation.device.recordRaw,
      preparation.device.ownershipToken,
    );
  }

  async function prepareSignatureVault(
    request: PrepareSignatureVaultCreateRequest | PrepareSignatureVaultOpenRequest,
  ): Promise<WalletWorkerReply> {
    if (successfulSessionOpened || state === "OPEN") {
      const abandoned = preparedSignature;
      preparedSignature = null;
      if (abandoned && abandoned.phase !== "device-publishing") {
        try {
          await discardSignatureDevice(abandoned);
        } catch {
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        }
      }
      terminate("SESSION_ACTIVE");
      return fatalReply("SESSION_ACTIVE");
    }
    currentGeneration += 1;
    if (!options.signatureVault) return errorReply(request, "SIGNATURE_VAULT_FAILED");
    let timeError: WalletCryptoErrorCode | null;
    try {
      timeError = contextTimeError(request.context);
    } catch {
      return errorReply(request, "SIGNATURE_VAULT_FAILED");
    }
    if (timeError) return errorReply(request, timeError);
    let preparationToken: string;
    try {
      preparationToken = randomToken(randomBytes);
    } catch {
      return errorReply(request, "SIGNATURE_VAULT_FAILED");
    }

    let preparedVault: Awaited<ReturnType<WalletSignatureVaultWorkerService["create"]>> | null = null;
    try {
      const publicContext = {
        walletAddress: request.context.walletAddress,
        chainId: request.context.chainId,
        vaultDeploymentId: request.context.vaultDeploymentId,
        origin: request.context.origin,
        messageVersion: 2 as const,
      };
      preparedVault = request.kind === "prepare-signature-vault-create"
        ? await options.signatureVault.create(request.signature, publicContext)
        : await options.signatureVault.open(request.vaultRaw, request.signature, publicContext);
      const seed = inspectUint8Array(preparedVault.seed);
      if (!seed
        || arrayBufferByteLength(seed.buffer) !== 32
        || seed.byteOffset !== 0
        || seed.byteLength !== 32
        || !/^0x[0-9a-f]{64}$/.test(preparedVault.walletAuthId)
        || !/^[0-9a-f]{64}$/.test(preparedVault.authToken)) throw new Error("invalid");
      validateSignatureVaultForContext(preparedVault.vaultRaw, request.context);
    } catch {
      if (preparedVault) wipeByteView(preparedVault.seed);
      return errorReply(request, request.kind === "prepare-signature-vault-open"
        ? "SIGNATURE_VAULT_INVALID"
        : "SIGNATURE_VAULT_FAILED");
    }
    if (!preparedVault) return errorReply(request, "SIGNATURE_VAULT_FAILED");

    let device: SignatureVaultDevicePreparation | null = null;
    if (request.rememberDevice && options.deviceSessions) {
      try {
        const result = await options.deviceSessions.prepare(
          preparedVault.seed,
          request.context,
          request.deviceTtlMs,
        );
        device = {
          recordRaw: result.raw,
          ownershipToken: result.ownershipToken,
          expiresAtMs: result.expiresAtMs,
          priorRecordRaw: request.priorDeviceRecordRaw,
        };
      } catch {
        // remembering is optional; the signature-authenticated wallet remains usable without it
      }
    }

    const opened = await unlock({
      kind: "unlock",
      requestId: request.requestId,
      seed: preparedVault.seed,
      context: request.context,
    }, true, true);
    if (opened.type !== "unlocked") {
      if (device && options.deviceSessions) {
        try {
          await options.deviceSessions.discard(device.recordRaw, device.ownershipToken);
        } catch {
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        }
      }
      return opened;
    }
    preparedSignature = {
      phase: "prepared",
      binding: opened.binding,
      preparationToken,
      vaultRaw: preparedVault.vaultRaw,
      device,
    };
    return {
      type: "signature-vault-prepared",
      requestId: request.requestId,
      binding: opened.binding,
      context: opened.context,
      preparationToken,
      vaultRaw: preparedVault.vaultRaw,
      walletAuthId: preparedVault.walletAuthId,
      authToken: preparedVault.authToken,
      device,
    };
  }

  async function deriveSignatureVaultCredentials(
    request: DeriveSignatureVaultCredentialsRequest,
  ): Promise<WalletWorkerReply> {
    if (!options.signatureVault) return errorReply(request, "SIGNATURE_VAULT_FAILED");
    try {
      const result = await options.signatureVault.credentials(request.signature, {
        walletAddress: request.context.walletAddress,
        chainId: request.context.chainId,
        vaultDeploymentId: request.context.vaultDeploymentId,
        origin: request.context.origin,
        messageVersion: 2,
      });
      if (!/^0x[0-9a-f]{64}$/.test(result.walletAuthId)
        || !/^[0-9a-f]{64}$/.test(result.authToken)) throw new Error("invalid");
      return {
        type: "signature-vault-credentials",
        requestId: request.requestId,
        walletAuthId: result.walletAuthId,
        authToken: result.authToken,
      };
    } catch {
      return errorReply(request, "SIGNATURE_VAULT_FAILED");
    }
  }

  async function commitSignatureVault(request: CommitSignatureVaultRequest): Promise<WalletWorkerReply> {
    if (state !== "OPEN" || !validBinding(request)) {
      return errorReply(request, state === "OPEN" ? "SESSION_MISMATCH" : "SESSION_LOCKED");
    }
    if (!signaturePreparationMatches(request) || preparedSignature?.phase !== "prepared") {
      return errorReply(request, "SIGNATURE_VAULT_INVALID");
    }
    let current: number;
    try {
      current = readNow();
    } catch {
      terminate("WORKER_FAILED");
      return fatalReply("WORKER_FAILED");
    }
    if (!sessionContext || current >= sessionContext.expiresAtMs) {
      const abandoned = preparedSignature;
      preparedSignature = null;
      try {
        await discardSignatureDevice(abandoned);
      } catch {
        terminate("WORKER_FAILED");
        return fatalReply("WORKER_FAILED");
      }
      terminate("SESSION_EXPIRED");
      return errorReply(request, "SESSION_EXPIRED");
    }
    const committed = preparedSignature;
    committed.phase = "committed";
    try {
      scheduleExpiry();
    } catch {
      preparedSignature = null;
      try {
        await discardSignatureDevice(committed);
      } catch {
        // terminal failure already prevents use; cleanup remains best effort here
      }
      terminate("WORKER_FAILED");
      return fatalReply("WORKER_FAILED");
    }
    return { type: "signature-vault-committed", requestId: request.requestId };
  }

  async function abortSignatureVault(request: AbortSignatureVaultRequest): Promise<WalletWorkerReply> {
    if (state !== "OPEN" || !validBinding(request)) {
      return errorReply(request, state === "OPEN" ? "SESSION_MISMATCH" : "SESSION_LOCKED");
    }
    if (!signaturePreparationMatches(request) || preparedSignature?.phase !== "prepared") {
      return errorReply(request, "SIGNATURE_VAULT_INVALID");
    }
    const abandoned = preparedSignature;
    preparedSignature = null;
    try {
      await discardSignatureDevice(abandoned);
    } catch {
      terminate("WORKER_FAILED");
      return fatalReply("WORKER_FAILED");
    }
    currentGeneration += 1;
    terminate("CLIENT_INVALIDATED");
    return { type: "locked", requestId: request.requestId, generation: currentGeneration };
  }

  function beginSignatureVaultDevicePublication(
    request: BeginSignatureVaultDevicePublicationRequest,
  ): WalletWorkerReply {
    const expired = expireIfNeeded(request);
    if (expired) return expired;
    if (state !== "OPEN" || !validBinding(request)) {
      return errorReply(request, state === "OPEN" ? "SESSION_MISMATCH" : "SESSION_LOCKED");
    }
    if (!signaturePreparationMatches(request) || preparedSignature?.phase !== "committed") {
      return errorReply(request, "SIGNATURE_VAULT_INVALID");
    }
    preparedSignature.phase = "device-publishing";
    return { type: "signature-vault-device-publication-ready", requestId: request.requestId };
  }

  async function finalizeSignatureVault(request: FinalizeSignatureVaultRequest): Promise<WalletWorkerReply> {
    const expired = expireIfNeeded(request);
    if (expired) return expired;
    if (state !== "OPEN" || !validBinding(request)) {
      return errorReply(request, state === "OPEN" ? "SESSION_MISMATCH" : "SESSION_LOCKED");
    }
    if (!signaturePreparationMatches(request) || preparedSignature?.phase !== "device-publishing") {
      return errorReply(request, "SIGNATURE_VAULT_INVALID");
    }
    const completed = preparedSignature;
    preparedSignature = null;
    let remembered = request.devicePublication === "published" && completed.device !== null;
    if (completed.device && options.deviceSessions) {
      if (remembered) {
        activeDevice = {
          raw: completed.device.recordRaw,
          ownershipToken: completed.device.ownershipToken,
        };
        if (completed.device.priorRecordRaw !== null) {
          try {
            await options.deviceSessions.retire(completed.device.priorRecordRaw);
          } catch {
            // the new record is already published; old-key cleanup cannot undo that commit
          }
        }
      } else if (request.devicePublication === "discard") {
        try {
          await options.deviceSessions.discard(
            completed.device.recordRaw,
            completed.device.ownershipToken,
          );
        } catch {
          remembered = false;
        }
      }
    } else {
      remembered = false;
    }
    return { type: "signature-vault-finalized", requestId: request.requestId, remembered };
  }

  function expireIfNeeded(request: Exclude<WalletWorkerRequest, UnlockWalletRequest>): WalletWorkerReply | null {
    if (state !== "OPEN" || !sessionContext) return null;
    try {
      if (readNow() < sessionContext.expiresAtMs) return null;
    } catch {
      terminate("WORKER_FAILED");
      return fatalReply("WORKER_FAILED");
    }
    terminate("SESSION_EXPIRED");
    return errorReply(request, "SESSION_EXPIRED");
  }

  function invoke(request: NoInputWalletOperationRequest | JsonInputWalletOperationRequest): WalletWorkerReply {
    const expired = expireIfNeeded(request);
    if (expired) return expired;
    if (state !== "OPEN" || !session || !binding) return errorReply(request, "SESSION_LOCKED");
    if (!bindingsEqual(request.binding, binding)) return errorReply(request, "SESSION_MISMATCH");
    if (request.kind === "decrypt-local-state" || request.kind === "decrypt-recovery-artifact") {
      try {
        const encoded = request.kind === "decrypt-local-state"
          ? session.decryptLocalStateClassified(request.inputJson)
          : session.decryptRecoveryArtifactClassified(request.inputJson);
        const outcome = parseClassifiedDecryptOutcome(encoded);
        if (outcome.status === "MIGRATION_REQUIRED") {
          return errorReply(request, "MIGRATION_REQUIRED");
        }
        if (outcome.status === "DATA_INVALID") return errorReply(request, "OPERATION_FAILED");
        return { type: "result", requestId: request.requestId, result: outcome.result };
      } catch {
        terminate("WORKER_FAILED");
        return fatalReply("WORKER_FAILED");
      }
    }
    try {
      let result: string;
      switch (request.kind) {
        case "public-config": result = session.publicConfig(); break;
        case "recovery-auth-tag": result = session.recoveryAuthTag(); break;
        case "derive-proof-signer": result = session.deriveProofSigner(request.inputJson); break;
        case "encrypt-local-state": result = session.encryptLocalState(request.inputJson); break;
        case "build-deposit-submission-plan": result = session.buildDepositSubmissionPlan(request.inputJson); break;
        case "build-order-request": result = session.buildOrderRequest(request.inputJson); break;
        case "build-cancel-request": result = session.buildCancelRequest(request.inputJson); break;
        case "build-status-requests": result = session.buildStatusRequests(request.inputJson); break;
        case "build-withdraw-request": result = session.buildWithdrawRequest(request.inputJson); break;
        case "build-residual-recovery": result = session.buildResidualRecovery(request.inputJson); break;
        case "create-recovery-snapshot": result = session.createRecoverySnapshot(request.inputJson); break;
        case "sign-strk20-exit-claim": result = session.signStrk20ExitClaim(request.inputJson); break;
      }
      if (typeof result !== "string") throw new Error("invalid");
      return { type: "result", requestId: request.requestId, result };
    } catch {
      return errorReply(request, "OPERATION_FAILED");
    }
  }

  async function process(request: WalletWorkerRequest): Promise<WalletWorkerReply> {
    if (state === "TERMINATED") {
      if (request.kind === "unlock" || request.kind === "unlock-and-seal-device") wipeByteView(request.seed);
      return fatalReply(terminalReason);
    }
    if (preparedDevice && request.kind === "unlock") {
      wipeByteView(request.seed);
      const abandoned = preparedDevice;
      preparedDevice = null;
      if (options.deviceSessions) {
        try {
          await options.deviceSessions.discard(abandoned.raw, abandoned.ownershipToken);
        } catch {
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        }
      }
      terminate("SESSION_ACTIVE");
      return fatalReply("SESSION_ACTIVE");
    }
    if (request.kind === "derive-signature-vault-credentials") {
      return deriveSignatureVaultCredentials(request);
    }
    if (request.kind === "unlock") return unlock(request);
    if (request.kind === "unlock-and-seal-device") return unlockAndSealDevice(request);
    if (request.kind === "prepare-signature-vault-create" || request.kind === "prepare-signature-vault-open") {
      return prepareSignatureVault(request);
    }
    if (preparedDevice && request.kind !== "commit-device-session" && request.kind !== "abort-device-session") {
      if (request.kind === "unlock-from-device" && options.deviceSessions) {
        const abandoned = preparedDevice;
        preparedDevice = null;
        try {
          await options.deviceSessions.discard(abandoned.raw, abandoned.ownershipToken);
        } catch {
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        }
        terminate("SESSION_ACTIVE");
        return fatalReply("SESSION_ACTIVE");
      }
      if (request.kind === "lock" && options.deviceSessions && validBinding(request)) {
        const abandoned = preparedDevice;
        preparedDevice = null;
        try {
          await options.deviceSessions.discard(abandoned.raw, abandoned.ownershipToken);
        } catch {
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        }
        currentGeneration += 1;
        terminate("CLIENT_INVALIDATED");
        return { type: "locked", requestId: request.requestId, generation: currentGeneration };
      }
      return errorReply(request, "DEVICE_SESSION_FAILED");
    }
    if (preparedSignature?.phase === "prepared"
      && request.kind !== "commit-signature-vault"
      && request.kind !== "abort-signature-vault") {
      if (request.kind === "unlock-from-device") {
        const abandoned = preparedSignature;
        preparedSignature = null;
        try {
          await discardSignatureDevice(abandoned);
        } catch {
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        }
        terminate("SESSION_ACTIVE");
        return fatalReply("SESSION_ACTIVE");
      }
      return errorReply(request, "SIGNATURE_VAULT_FAILED");
    }
    if (preparedSignature?.phase === "committed"
      && request.kind === "unlock-from-device") {
      const abandoned = preparedSignature;
      preparedSignature = null;
      try {
        await discardSignatureDevice(abandoned);
      } catch {
        terminate("WORKER_FAILED");
        return fatalReply("WORKER_FAILED");
      }
      terminate("SESSION_ACTIVE");
      return fatalReply("SESSION_ACTIVE");
    }
    if (request.kind === "unlock-from-device") return unlockFromDevice(request);
    if (request.kind === "commit-device-session") return commitDeviceSession(request);
    if (request.kind === "abort-device-session") return abortDeviceSession(request);
    if (request.kind === "revoke-device-session") return revokeDeviceSession(request);
    if (request.kind === "commit-signature-vault") return commitSignatureVault(request);
    if (request.kind === "abort-signature-vault") return abortSignatureVault(request);
    if (request.kind === "begin-signature-vault-device-publication") {
      return beginSignatureVaultDevicePublication(request);
    }
    if (request.kind === "finalize-signature-vault") return finalizeSignatureVault(request);
    if (request.kind === "lock") {
      const expired = expireIfNeeded(request);
      if (expired) return expired;
      if (state !== "OPEN" || !session || !binding) return errorReply(request, "SESSION_LOCKED");
      if (!validBinding(request)) return errorReply(request, "SESSION_MISMATCH");
      currentGeneration += 1;
      terminate("CLIENT_INVALIDATED");
      return { type: "locked", requestId: request.requestId, generation: currentGeneration };
    }
    return invoke(request);
  }

  return {
    get state(): WalletWorkerState { return state; },
    get terminalReason(): WalletWorkerTerminalCode | null {
      return state === "TERMINATED" ? terminalReason : null;
    },
    dispatch(value: unknown): Promise<WalletWorkerReply> {
      if (state === "TERMINATED") {
        wipeTransferredSeedCandidate(value);
        return Promise.resolve(fatalReply(terminalReason));
      }
      let request: WalletWorkerRequest;
      try {
        request = parseWalletWorkerRequest(value);
      } catch {
        wipeTransferredSeedCandidate(value);
        terminate("INVALID_MESSAGE");
        return Promise.resolve(fatalReply("INVALID_MESSAGE"));
      }
      if (request.requestId <= lastRequestId) {
        if (request.kind === "unlock" || request.kind === "unlock-and-seal-device") wipeByteView(request.seed);
        terminate("INVALID_MESSAGE");
        return Promise.resolve(fatalReply("INVALID_MESSAGE"));
      }
      lastRequestId = request.requestId;
      if (request.kind === "unlock" || request.kind === "unlock-and-seal-device") queuedUnlockSeeds.add(request.seed);
      const next = queue
        .then(() => {
          if (request.kind === "unlock" || request.kind === "unlock-and-seal-device") queuedUnlockSeeds.delete(request.seed);
          return process(request);
        })
        .catch(() => {
          if (request.kind === "unlock" || request.kind === "unlock-and-seal-device") {
            queuedUnlockSeeds.delete(request.seed);
            wipeByteView(request.seed);
          }
          terminate("WORKER_FAILED");
          return fatalReply("WORKER_FAILED");
        });
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
    terminate,
  };
}

export interface WalletCryptoWorkerReplyScope {
  postMessage(message: unknown): void;
  close(): void;
}

export interface WalletCryptoWorkerReplySink {
  readonly closed: boolean;
  post(reply: WalletWorkerReply): void;
  fail(code: WalletWorkerTerminalCode): void;
}

function isTerminalReply(reply: WalletWorkerReply): boolean {
  return reply.type === "fatal"
    || reply.type === "locked"
    || (reply.type === "error" && reply.error.code === "SESSION_EXPIRED");
}

export function createWalletCryptoWorkerReplySink(
  scope: WalletCryptoWorkerReplyScope,
  terminateDispatcher: (code: WalletWorkerTerminalCode) => void,
): WalletCryptoWorkerReplySink {
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    try {
      scope.close();
    } catch {
      // the worker is already terminal even if its host close hook fails
    }
  }

  function post(reply: WalletWorkerReply) {
    if (closed) return;
    const terminal = isTerminalReply(reply);
    try {
      scope.postMessage(reply);
    } catch {
      try {
        terminateDispatcher("WORKER_FAILED");
      } catch {
        // reply failure remains terminal even if dispatcher cleanup also fails
      }
      close();
      return;
    }
    if (terminal) close();
  }

  function fail(code: WalletWorkerTerminalCode) {
    try {
      terminateDispatcher(code);
    } catch {
      // reply failure remains terminal even if dispatcher cleanup also fails
    }
    post({ type: "fatal", error: safeError(code) });
    close();
  }

  return {
    get closed() { return closed; },
    post,
    fail,
  };
}

export async function dispatchWalletCryptoWorkerMessage(
  dispatcher: WalletCryptoWorkerDispatcher,
  sink: WalletCryptoWorkerReplySink,
  value: unknown,
): Promise<void> {
  try {
    sink.post(await dispatcher.dispatch(value));
  } catch {
    sink.fail("WORKER_FAILED");
  }
}
