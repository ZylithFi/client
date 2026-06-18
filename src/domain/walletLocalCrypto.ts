export type VaultRecord = {
  version: 1;
  kdf: "pbkdf2-sha256";
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
};

export type EncryptedLocalStore = {
  version: 1;
  algorithm: "AES-GCM";
  nonce: string;
  ciphertext: string;
};

const PBKDF2_ITERATIONS = 310_000;

export async function encryptSeed(
  seedHex: string,
  passphrase: string,
): Promise<VaultRecord> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(passphrase, salt);
  const plaintext = new TextEncoder().encode(seedHex);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    plaintext,
  );
  return {
    version: 1,
    kdf: "pbkdf2-sha256",
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptSeed(
  vault: VaultRecord,
  passphrase: string,
): Promise<string> {
  const salt = base64ToBytes(vault.salt);
  const nonce = base64ToBytes(vault.nonce);
  const ciphertext = base64ToBytes(vault.ciphertext);
  const key = await deriveVaultKey(passphrase, salt, vault.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce },
    key,
    ciphertext,
  );
  const seedHex = new TextDecoder().decode(plaintext);
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    throw new Error("Zylith wallet decrypted to an invalid seed");
  }
  return seedHex;
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
}

export async function decryptLocalStore<T>(
  store: EncryptedLocalStore,
  seedHex: string,
  accountId: string,
  label: string,
): Promise<T> {
  const key = await deriveLocalStoreKey(seedHex, accountId, label);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(store.nonce) },
    key,
    base64ToBytes(store.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
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
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `zylith/local-store/${label}/${accountId}/${seedHex}`,
    ),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function deriveVaultKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: asArrayBuffer(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
