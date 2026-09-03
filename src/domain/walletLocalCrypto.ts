export type WalletSignatureVaultRecord = {
  version: 4;
  kdf: "wallet-signature-sha256-v2";
  algorithm: "AES-GCM";
  wallet_address: string;
  chain_id: string;
  deployment_id: string;
  origin: string;
  message_version: 2;
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
  messageVersion: 2;
};

export type EncryptedLocalStore = {
  version: 1;
  algorithm: "AES-GCM";
  nonce: string;
  ciphertext: string;
};

const WALLET_SIGNATURE_VAULT_KEYS = new Set([
  "version",
  "kdf",
  "algorithm",
  "wallet_address",
  "chain_id",
  "deployment_id",
  "origin",
  "message_version",
  "nonce",
  "ciphertext",
]);

export async function encryptSeedWithWalletSignature(
  seedHex: string,
  context: WalletSignatureVaultContext,
): Promise<WalletSignatureVaultRecord> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const normalizedContext = normalizeWalletSignatureVaultContext(context);
  const key = await deriveWalletSignatureVaultKey(normalizedContext);
  const plaintext = new TextEncoder().encode(seedHex);
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      plaintext,
    );
    return {
      version: 4,
      kdf: "wallet-signature-sha256-v2",
      algorithm: "AES-GCM",
      wallet_address: normalizedContext.walletAddress,
      chain_id: normalizedContext.chainId,
      deployment_id: normalizedContext.deploymentId,
      origin: normalizedContext.origin,
      message_version: normalizedContext.messageVersion,
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptSeedWithWalletSignature(
  vault: WalletSignatureVaultRecord,
  context: WalletSignatureVaultContext,
): Promise<string> {
  const normalizedContext = normalizeWalletSignatureVaultContext(context);
  if (
    vault.wallet_address !== normalizedContext.walletAddress ||
    vault.chain_id !== normalizedContext.chainId ||
    vault.deployment_id !== normalizedContext.deploymentId ||
    vault.origin !== normalizedContext.origin ||
    vault.message_version !== normalizedContext.messageVersion
  ) {
    throw new Error("Connected Starknet wallet does not match this wallet session");
  }
  const key = await deriveWalletSignatureVaultKey(normalizedContext);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(vault.nonce) },
      key,
      base64ToBytes(vault.ciphertext),
    ),
  );
  try {
    const seedHex = new TextDecoder().decode(plaintext);
    if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
      throw new Error("Wallet session decrypted to an invalid seed");
    }
    return seedHex;
  } finally {
    plaintext.fill(0);
  }
}

export async function walletSignatureVaultId(
  context: WalletSignatureVaultContext,
): Promise<string> {
  const authToken = await walletSignatureVaultAuthToken(context);
  const digest = await sha256(
    `zylith/wallet-signature-vault/id/v2:${authToken}`,
  );
  return `0x${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export async function walletSignatureVaultAuthToken(
  context: WalletSignatureVaultContext,
): Promise<string> {
  const normalizedContext = normalizeWalletSignatureVaultContext(context);
  const digest = await sha256(
    `zylith/wallet-signature-vault/auth/v2:${walletSignatureVaultKeyMaterial(normalizedContext)}`,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function isWalletSignatureVaultRecord(
  vault: VaultRecord | null | undefined,
): vault is WalletSignatureVaultRecord {
  return (
    isPlainObject(vault) &&
    Object.keys(vault).every((key) => WALLET_SIGNATURE_VAULT_KEYS.has(key)) &&
    vault?.version === 4 &&
    vault.kdf === "wallet-signature-sha256-v2" &&
    vault.algorithm === "AES-GCM" &&
    typeof vault.wallet_address === "string" &&
    typeof vault.chain_id === "string" &&
    typeof vault.deployment_id === "string" &&
    typeof vault.origin === "string" &&
    vault.message_version === 2 &&
    typeof vault.nonce === "string" &&
    typeof vault.ciphertext === "string"
  );
}

export function walletSignatureVaultMetadataMatches(
  vault: WalletSignatureVaultRecord,
  context: WalletSignatureVaultContext,
): boolean {
  let normalizedContext: WalletSignatureVaultContext;
  try {
    normalizedContext = normalizeWalletSignatureVaultContext(context);
  } catch {
    return false;
  }
  return (
    vault.wallet_address === normalizedContext.walletAddress &&
    vault.chain_id === normalizedContext.chainId &&
    vault.deployment_id === normalizedContext.deploymentId &&
    vault.origin === normalizedContext.origin &&
    vault.message_version === normalizedContext.messageVersion
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function encryptLocalStore(
  value: unknown,
  seedHex: string,
  accountId: string,
  label: string,
): Promise<EncryptedLocalStore> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveLocalStoreKey(seedHex, accountId, label);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      plaintext,
    );
    return {
      version: 1,
      algorithm: "AES-GCM",
      nonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    };
  } finally {
    plaintext.fill(0);
  }
}

export async function decryptLocalStore<T>(
  store: EncryptedLocalStore,
  seedHex: string,
  accountId: string,
  label: string,
): Promise<T> {
  const key = await deriveLocalStoreKey(seedHex, accountId, label);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(store.nonce) },
      key,
      base64ToBytes(store.ciphertext),
    ),
  );
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } finally {
    plaintext.fill(0);
  }
}

export function stableJsonStringify(value: unknown): string {
  if (value === undefined) return "";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value
      .map((entry) =>
        entry === undefined ? "null" : stableJsonStringify(entry)
      )
      .join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(
      ([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`
    )
    .join(",")}}`;
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveLocalStoreKey(
  seedHex: string,
  accountId: string,
  label: string,
) {
  const domain = new TextEncoder().encode(
    `zylith/local-store/${label}/${accountId}/`,
  );
  const seedBytes = new TextEncoder().encode(seedHex);
  const materialInput = new Uint8Array(domain.length + seedBytes.length);
  materialInput.set(domain);
  materialInput.set(seedBytes, domain.length);
  try {
    const material = new Uint8Array(
      await crypto.subtle.digest("SHA-256", materialInput),
    );
    try {
      return await crypto.subtle.importKey("raw", material, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
    } finally {
      material.fill(0);
    }
  } finally {
    seedBytes.fill(0);
    materialInput.fill(0);
  }
}

async function deriveWalletSignatureVaultKey(
  context: WalletSignatureVaultContext,
) {
  const material = new Uint8Array(
    await sha256(
      `zylith/wallet-signature-vault/encryption/v2:${walletSignatureVaultKeyMaterial(context)}`,
    ),
  );
  try {
    return await crypto.subtle.importKey("raw", material, "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  } finally {
    material.fill(0);
  }
}

function sha256(value: string) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

function normalizeWalletSignatureVaultContext(
  context: WalletSignatureVaultContext,
): WalletSignatureVaultContext {
  const normalized = {
    signature: normalizeSignatureMaterial(context.signature),
    walletAddress: normalizeContextText(context.walletAddress),
    chainId: normalizeContextText(context.chainId),
    deploymentId: normalizeContextText(context.deploymentId),
    origin: context.origin.trim().toLowerCase(),
    messageVersion: 2 as const,
  };
  if (
    !normalized.walletAddress ||
    !normalized.chainId ||
    !normalized.deploymentId ||
    !normalized.origin ||
    !signatureMaterialPresent(normalized.signature)
  ) {
    throw new Error("Wallet signature vault context is incomplete");
  }
  return normalized;
}

function walletSignatureVaultKeyMaterial(context: WalletSignatureVaultContext) {
  return stableJsonStringify({
    protocol: "zylith/wallet-signature-vault/v2",
    signature: normalizeSignatureMaterial(context.signature),
    wallet_address: context.walletAddress,
    chain_id: context.chainId,
    deployment_id: context.deploymentId,
    origin: context.origin,
    message_version: context.messageVersion,
  });
}

function normalizeSignatureMaterial(value: unknown): unknown {
  if (typeof value === "bigint") return `0x${value.toString(16)}`;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value.trim().toLowerCase();
  if (Array.isArray(value)) return value.map(normalizeSignatureMaterial);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeSignatureMaterial(entry)]),
  );
}

function normalizeContextText(value: string) {
  return value.trim().toLowerCase();
}

function signatureMaterialPresent(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "bigint") return true;
  if (Array.isArray(value)) return value.some(signatureMaterialPresent);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(signatureMaterialPresent);
}
