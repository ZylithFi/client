import { WALLET_KEY_SCHEDULE_VERSION, WalletMigrationRequiredError, parseWalletJson, requireWalletKeyScheduleVersion } from "./walletVersion";

export type WalletSignatureMessageVersion = 2;
export type WalletSignatureVaultRecord = {
  version: 3;
  key_schedule_version: 2;
  kdf: "HKDF-SHA-256";
  algorithm: "AES-256-GCM";
  wallet_address: string;
  chain_id: string;
  deployment_id: string;
  origin: string;
  message_version: WalletSignatureMessageVersion;
  nonce: string;
  ciphertext: string;
};
export type VaultRecord = WalletSignatureVaultRecord;
export type WalletSignatureVaultContext = {
  signature: unknown;
  walletAddress: string;
  chainId: string;
  deploymentId: string;
  origin: string;
  messageVersion: WalletSignatureMessageVersion;
};
export type WalletSignatureVaultPublicContext = {
  walletAddress: string;
  chainId: string;
  vaultDeploymentId: string;
  origin: string;
  messageVersion: WalletSignatureMessageVersion;
};
export type WalletSignatureVaultWorkerResult = {
  seed: Uint8Array<ArrayBuffer>;
  vaultRaw: string;
  walletAuthId: string;
  authToken: string;
};
export type WalletSignatureVaultCredentials = {
  walletAuthId: string;
  authToken: string;
};
export interface WalletSignatureVaultWorkerService {
  credentials(signature: unknown, context: WalletSignatureVaultPublicContext): Promise<WalletSignatureVaultCredentials>;
  create(signature: unknown, context: WalletSignatureVaultPublicContext): Promise<WalletSignatureVaultWorkerResult>;
  open(vaultRaw: string, signature: unknown, context: WalletSignatureVaultPublicContext): Promise<WalletSignatureVaultWorkerResult>;
}
export type EncryptedLocalStore = {
  version: 2;
  key_schedule_version: 2;
  kdf: "zylith-wallet-hkdf-sha256-v2";
  algorithm: "AES-256-GCM";
  account_id: string;
  purpose: "wallet-state";
  nonce: string;
  ciphertext: string;
};
const MAX_LOCAL_STORE_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_STORE_RECORD_CHARS = Math.ceil(MAX_LOCAL_STORE_CIPHERTEXT_BYTES / 3) * 4 + 512;
export const MAX_WALLET_SIGNATURE_HEX_DIGITS = 256;
const FIELD_PRIME = 0x800000000000011000000000000000000000000000000000000000000000001n;
const VAULT_PROTOCOL = "zylith/wallet-signature-vault/v3";
const VAULT_SALT = "zylith/wallet-signature-vault/hkdf-sha256/v3";
const VAULT_FIELDS = ["version", "key_schedule_version", "kdf", "algorithm", "wallet_address", "chain_id", "deployment_id", "origin", "message_version", "nonce", "ciphertext"];
const LOCAL_FIELDS = ["version", "key_schedule_version", "kdf", "algorithm", "account_id", "purpose", "nonce", "ciphertext"];

function signatureVaultContext(
  signature: unknown,
  context: WalletSignatureVaultPublicContext,
): WalletSignatureVaultContext {
  return normalizeWalletSignatureVaultContext({
    signature,
    walletAddress: context.walletAddress,
    chainId: context.chainId,
    deploymentId: context.vaultDeploymentId,
    origin: context.origin,
    messageVersion: context.messageVersion,
  });
}

function exactRandomBytes(
  randomBytes: (length: number) => Uint8Array,
  length: number,
): Uint8Array<ArrayBuffer> {
  let candidate: unknown;
  try {
    candidate = randomBytes(length);
  } catch {
    throw new Error("Wallet signature vault cryptography failed");
  }
  try {
    if (Object.getPrototypeOf(candidate) !== Uint8Array.prototype
      || !(candidate instanceof Uint8Array)
      || !(candidate.buffer instanceof ArrayBuffer)
      || candidate.byteOffset !== 0
      || candidate.byteLength !== length
      || candidate.buffer.byteLength !== length) throw new Error("invalid");
    return candidate as Uint8Array<ArrayBuffer>;
  } catch {
    try {
      if (ArrayBuffer.isView(candidate)) {
        const view = candidate as ArrayBufferView;
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength).fill(0);
      }
    } catch { /* an invalid source has no trusted mutable bytes */ }
    throw new Error("Wallet signature vault cryptography failed");
  }
}

function seedAscii(seed: Uint8Array): Uint8Array<ArrayBuffer> {
  if (seed.byteLength !== 32) throw new Error("Wallet signature vault cryptography failed");
  const output = new Uint8Array(64);
  for (let index = 0; index < seed.byteLength; index += 1) {
    const byte = seed[index];
    const high = byte >>> 4;
    const low = byte & 15;
    output[index * 2] = 48 + high + (((9 - high) >> 31) & 39);
    output[index * 2 + 1] = 48 + low + (((9 - low) >> 31) & 39);
  }
  return output;
}

function seedFromHexAscii(plaintext: Uint8Array): Uint8Array<ArrayBuffer> {
  if (plaintext.byteLength !== 64) throw new Error("Wallet signature vault is invalid");
  const output = new Uint8Array(32);
  let invalid = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    const highByte = plaintext[index * 2];
    const lowByte = plaintext[index * 2 + 1];
    const highDigit = highByte - 48;
    const lowDigit = lowByte - 48;
    const highAlpha = highByte - 97;
    const lowAlpha = lowByte - 97;
    const highIsDigit = ((highDigit | (9 - highDigit)) >>> 31) ^ 1;
    const lowIsDigit = ((lowDigit | (9 - lowDigit)) >>> 31) ^ 1;
    const highIsAlpha = ((highAlpha | (5 - highAlpha)) >>> 31) ^ 1;
    const lowIsAlpha = ((lowAlpha | (5 - lowAlpha)) >>> 31) ^ 1;
    invalid |= 1 ^ (highIsDigit | highIsAlpha);
    invalid |= 1 ^ (lowIsDigit | lowIsAlpha);
    const high = highDigit * highIsDigit + (highAlpha + 10) * highIsAlpha;
    const low = lowDigit * lowIsDigit + (lowAlpha + 10) * lowIsAlpha;
    output[index] = (high << 4) | low;
  }
  if (invalid !== 0) {
    output.fill(0);
    throw new Error("Wallet signature vault is invalid");
  }
  return output;
}

async function encryptSeedBytesWithWalletSignature(
  seed: Uint8Array,
  normalized: WalletSignatureVaultContext,
  nonce: Uint8Array<ArrayBuffer>,
): Promise<WalletSignatureVaultRecord> {
  let plaintext: Uint8Array<ArrayBuffer> | null = null;
  let aad: Uint8Array<ArrayBuffer> | null = null;
  try {
    plaintext = seedAscii(seed);
    aad = vaultAad(normalized);
    const key = await deriveVaultEncryptionKey(normalized);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      key,
      plaintext,
    ));
    try {
      if (ciphertext.byteLength !== 80) throw new Error("Wallet signature vault cryptography failed");
      return {
        version: 3,
        key_schedule_version: WALLET_KEY_SCHEDULE_VERSION,
        kdf: "HKDF-SHA-256",
        algorithm: "AES-256-GCM",
        wallet_address: normalized.walletAddress,
        chain_id: normalized.chainId,
        deployment_id: normalized.deploymentId,
        origin: normalized.origin,
        message_version: normalized.messageVersion,
        nonce: bytesToBase64(nonce),
        ciphertext: bytesToBase64(ciphertext),
      };
    } finally {
      ciphertext.fill(0);
    }
  } finally {
    plaintext?.fill(0);
    aad?.fill(0);
  }
}

async function openSeedBytesWithWalletSignature(
  vaultRaw: string,
  normalized: WalletSignatureVaultContext,
): Promise<{ seed: Uint8Array<ArrayBuffer>; vault: WalletSignatureVaultRecord }> {
  if (vaultRaw.length > 4096) throw new Error("Wallet signature vault is invalid");
  let vault: unknown;
  try {
    vault = parseWalletJson(vaultRaw, ["version", "message_version"]);
  } catch {
    throw new Error("Wallet signature vault is invalid");
  }
  if (!isWalletSignatureVaultRecord(vault) || !walletSignatureVaultMetadataMatches(vault, normalized)) {
    throw new Error("Wallet signature vault is invalid");
  }
  let aad: Uint8Array<ArrayBuffer> | null = null;
  let nonce: Uint8Array<ArrayBuffer> | null = null;
  let ciphertext: Uint8Array<ArrayBuffer> | null = null;
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  let seed: Uint8Array<ArrayBuffer> | null = null;
  let seedOwnershipTransferred = false;
  try {
    aad = vaultAad(normalized);
    nonce = base64ToBytes(vault.nonce);
    ciphertext = base64ToBytes(vault.ciphertext);
    const key = await deriveVaultEncryptionKey(normalized);
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      key,
      ciphertext,
    ));
    seed = seedFromHexAscii(plaintext);
    const result = { seed, vault };
    seedOwnershipTransferred = true;
    return result;
  } catch {
    throw new Error("Wallet signature vault is invalid");
  } finally {
    if (!seedOwnershipTransferred) seed?.fill(0);
    plaintext?.fill(0);
    aad?.fill(0);
    nonce?.fill(0);
    ciphertext?.fill(0);
  }
}

export function createWalletSignatureVaultWorkerService(options: {
  randomBytes?: (length: number) => Uint8Array;
} = {}): WalletSignatureVaultWorkerService {
  const randomBytes = options.randomBytes ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));
  const publicResult = async (
    seed: Uint8Array<ArrayBuffer>,
    vault: WalletSignatureVaultRecord,
    normalized: WalletSignatureVaultContext,
  ): Promise<WalletSignatureVaultWorkerResult> => {
    const authToken = await walletSignatureVaultAuthToken(normalized);
    const walletAuthId = await walletSignatureVaultIdFromAuthToken(authToken);
    return { seed, vaultRaw: JSON.stringify(vault), walletAuthId, authToken };
  };
  return {
    async credentials(signature, context) {
      const normalized = signatureVaultContext(signature, context);
      const authToken = await walletSignatureVaultAuthToken(normalized);
      const walletAuthId = await walletSignatureVaultIdFromAuthToken(authToken);
      return { walletAuthId, authToken };
    },
    async create(signature, context) {
      const normalized = signatureVaultContext(signature, context);
      let seed: Uint8Array<ArrayBuffer> | null = null;
      let nonce: Uint8Array<ArrayBuffer> | null = null;
      let seedOwnershipTransferred = false;
      try {
        seed = exactRandomBytes(randomBytes, 32);
        nonce = exactRandomBytes(randomBytes, 12);
        const vault = await encryptSeedBytesWithWalletSignature(seed, normalized, nonce);
        const result = await publicResult(seed, vault, normalized);
        seedOwnershipTransferred = true;
        return result;
      } catch {
        throw new Error("Wallet signature vault cryptography failed");
      } finally {
        nonce?.fill(0);
        if (!seedOwnershipTransferred) seed?.fill(0);
      }
    },
    async open(vaultRaw, signature, context) {
      const normalized = signatureVaultContext(signature, context);
      let opened: Awaited<ReturnType<typeof openSeedBytesWithWalletSignature>> | null = null;
      let seedOwnershipTransferred = false;
      try {
        opened = await openSeedBytesWithWalletSignature(vaultRaw, normalized);
        const result = await publicResult(opened.seed, opened.vault, normalized);
        seedOwnershipTransferred = true;
        return result;
      } finally {
        if (opened && !seedOwnershipTransferred) opened.seed.fill(0);
      }
    },
  };
}

export async function walletSignatureVaultAuthToken(context: WalletSignatureVaultContext): Promise<string> {
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    bytes = await deriveVaultBytes(normalizeWalletSignatureVaultContext(context), "auth-token");
    return hex(bytes);
  } finally { bytes?.fill(0); }
}

export async function walletSignatureVaultId(context: WalletSignatureVaultContext): Promise<string> {
  const token = await walletSignatureVaultAuthToken(context);
  return walletSignatureVaultIdFromAuthToken(token);
}

async function walletSignatureVaultIdFromAuthToken(token: string): Promise<string> {
  let input: Uint8Array<ArrayBuffer> | null = null;
  let digest: Uint8Array | undefined;
  try {
    input = new TextEncoder().encode(`zylith/wallet-signature-vault/id/v3:${token}`);
    digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
    return `0x${hex(digest)}`;
  } finally {
    input?.fill(0);
    digest?.fill(0);
  }
}

export function isWalletSignatureVaultRecord(vault: unknown): vault is WalletSignatureVaultRecord {
  if (!isPlainObject(vault) || !exactFields(vault, VAULT_FIELDS)) return false;
  try {
    return vault.version === 3 && vault.key_schedule_version === 2 && vault.kdf === "HKDF-SHA-256" && vault.algorithm === "AES-256-GCM"
      && vault.wallet_address === normalizeField(vault.wallet_address) && vault.chain_id === normalizeField(vault.chain_id) && vault.deployment_id === normalizeField(vault.deployment_id)
      && vault.origin === canonicalVaultOrigin(vault.origin) && vault.message_version === 2
      && validBase64Bytes(vault.nonce, 12, 12) && validBase64Bytes(vault.ciphertext, 80, 80);
  } catch { return false; }
}

export function isEncryptedLocalStoreRecord(value: unknown): value is EncryptedLocalStore {
  return hasLocalStoreMetadata(value)
    && validBase64Bytes(value.nonce, 12, 12) && validBase64Bytes(value.ciphertext, 16, MAX_LOCAL_STORE_CIPHERTEXT_BYTES);
}

function hasLocalStoreMetadata(value: unknown): value is EncryptedLocalStore {
  return isPlainObject(value) && exactFields(value, LOCAL_FIELDS)
    && value.version === 2 && value.key_schedule_version === 2 && value.kdf === "zylith-wallet-hkdf-sha256-v2" && value.algorithm === "AES-256-GCM"
    && typeof value.account_id === "string" && /^[0-9a-f]{64}$/.test(value.account_id) && value.purpose === "wallet-state"
    && typeof value.nonce === "string" && typeof value.ciphertext === "string";
}

/** checks compatibility before a write can replace a concurrently restored legacy record. */
export function requireLocalStoreCompatibility(input: unknown): EncryptedLocalStore {
  if (typeof input === "string" && input.length > MAX_LOCAL_STORE_RECORD_CHARS) throw new Error("Local wallet state is too large");
  const record = typeof input === "string" ? parseWalletJson(input, ["version"]) : input;
  requireWalletKeyScheduleVersion(record);
  if (!hasLocalStoreMetadata(record)) throw new WalletMigrationRequiredError();
  return record;
}

export function walletSignatureVaultMetadataMatches(vault: WalletSignatureVaultRecord, context: WalletSignatureVaultContext): boolean {
  try {
    const normalized = normalizeWalletSignatureVaultContext(context);
    return isWalletSignatureVaultRecord(vault) && vault.wallet_address === normalized.walletAddress && vault.chain_id === normalized.chainId
      && vault.deployment_id === normalized.deploymentId && vault.origin === normalized.origin && vault.message_version === normalized.messageVersion;
  } catch { return false; }
}

export function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => entry === undefined ? "null" : stableJsonStringify(entry)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => asciiCompare(left, right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`).join(",")}}`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function validBase64Bytes(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string" || !value || value.length > Math.ceil(max / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    const binary = atob(value);
    return binary.length >= min && binary.length <= max && btoa(binary) === value;
  } catch { return false; }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).length === fields.length && Object.keys(value).every((key) => fields.includes(key));
}

function asciiCompare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function hex(bytes: Uint8Array): string { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function text(value: string): Uint8Array<ArrayBuffer> { return new TextEncoder().encode(value); }
function u16(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function encodeFrame(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((total, part) => total + 4 + part.byteLength, 4);
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  view.setUint32(0, parts.length, false);
  let offset = 4;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    out.set(part, offset + 4);
    offset += 4 + part.length;
  }
  return out;
}

function normalizeField(value: unknown): string {
  if (typeof value !== "string" || value.length > 256 || !/^(?:0x)?[0-9a-fA-F]+$/.test(value)) throw new Error("Wallet signature vault context is incomplete");
  const digits = value.replace(/^0x/, "").replace(/^0+/, "");
  if (!digits || digits.length > 64 || BigInt(`0x${digits}`) >= FIELD_PRIME) throw new Error("Wallet signature vault context is incomplete");
  return `0x${BigInt(`0x${digits}`).toString(16)}`;
}

export function normalizeWalletSignatureVaultAddress(value: unknown): string {
  return normalizeField(value);
}

function canonicalVaultOrigin(input: unknown): string {
  if (typeof input !== "string" || input.length > 256 || /[\s\\]/u.test(input) || !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+$/.test(input)) throw new Error("Invalid wallet vault origin");
  const url = new URL(input);
  const local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(input);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.origin === "null") throw new Error("Invalid wallet vault origin");
  const origin = url.origin.toLowerCase();
  if (origin.length > 256) throw new Error("Invalid wallet vault origin");
  return origin;
}

function normalizeWalletSignatureVaultContext(context: WalletSignatureVaultContext): WalletSignatureVaultContext {
  if (context.messageVersion !== 2) throw new Error("Wallet signature vault context is incomplete");
  return {
    signature: normalizeWalletSignature(context.signature),
    walletAddress: normalizeField(context.walletAddress), chainId: normalizeField(context.chainId), deploymentId: normalizeField(context.deploymentId),
    origin: canonicalVaultOrigin(context.origin), messageVersion: context.messageVersion,
  };
}

export function normalizeWalletSignature(signature: unknown): unknown {
  return normalizeSignatureValue(signature, 0, new WeakSet(), { count: 0 });
}

function normalizeSignatureValue(value: unknown, depth: number, seen: WeakSet<object>, budget: { count: number }): unknown {
  const invalid = () => new Error("Connected Starknet wallet returned an invalid signature");
  if (++budget.count > 64 || depth > 6) throw invalid();
  if (typeof value === "bigint") {
    const digits = value.toString(16);
    if (value < 0n || digits.length > MAX_WALLET_SIGNATURE_HEX_DIGITS) throw invalid();
    return `0x${digits}`;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw invalid();
    return `0x${value.toString(16)}`;
  }
  if (typeof value === "string") {
    if (value.length > MAX_WALLET_SIGNATURE_HEX_DIGITS + 2) throw invalid();
    const normalized = value.trim().toLowerCase();
    if (!normalized) throw invalid();
    if (/^0x[0-9a-f]+$/.test(normalized)) {
      const digits = normalized.slice(2);
      if (digits.length > MAX_WALLET_SIGNATURE_HEX_DIGITS) throw invalid();
      return `0x${BigInt(normalized).toString(16)}`;
    }
    if (normalized.length > MAX_WALLET_SIGNATURE_HEX_DIGITS) throw invalid();
    return normalized;
  }
  if (!value || typeof value !== "object" || seen.has(value)) throw invalid();
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (!value.length || value.length > 16 || keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw invalid();
      return value.map((entry) => normalizeSignatureValue(entry, depth + 1, seen, budget));
    }
    if (!isPlainObject(value)) throw invalid();
    const entries = Object.entries(value);
    if (!entries.length || entries.length > 16) throw invalid();
    return Object.fromEntries(entries.sort(([left], [right]) => asciiCompare(left, right)).map(([key, entry]) => {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key)) throw invalid();
      return [key, normalizeSignatureValue(entry, depth + 1, seen, budget)];
    }));
  } finally { seen.delete(value); }
}

function publicParts(context: WalletSignatureVaultContext): Uint8Array<ArrayBuffer>[] {
  const fieldBytes = (felt: string) => Uint8Array.from(felt.slice(2).padStart(64, "0").match(/../g)!, (byte) => Number.parseInt(byte, 16));
  return [fieldBytes(context.walletAddress), fieldBytes(context.chainId), fieldBytes(context.deploymentId), text(context.origin), u16(context.messageVersion)];
}

function vaultAad(context: WalletSignatureVaultContext): Uint8Array<ArrayBuffer> {
  return encodeFrame([text("zylith/wallet-signature-vault/aad/v3"), u16(3), u16(2), text("HKDF-SHA-256"), text("AES-256-GCM"), ...publicParts(context)]);
}

async function deriveVaultBytes(context: WalletSignatureVaultContext, purpose: "encryption-key" | "auth-token"): Promise<Uint8Array<ArrayBuffer>> {
  let signature: Uint8Array<ArrayBuffer> | null = null;
  let salt: Uint8Array<ArrayBuffer> | null = null;
  let info: Uint8Array<ArrayBuffer> | null = null;
  try {
    signature = text(stableJsonStringify(context.signature));
    salt = text(VAULT_SALT);
    info = encodeFrame([text(VAULT_PROTOCOL), text(purpose), ...publicParts(context)]);
    if (signature.byteLength > 128 * 1024) throw new Error("Connected Starknet wallet returned an invalid signature");
    const ikm = await crypto.subtle.importKey("raw", signature, "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, ikm, 256));
  } finally {
    signature?.fill(0);
    salt?.fill(0);
    info?.fill(0);
  }
}

async function deriveVaultEncryptionKey(context: WalletSignatureVaultContext): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    bytes = await deriveVaultBytes(context, "encryption-key");
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally { bytes?.fill(0); }
}
