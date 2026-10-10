/** Test-only adapters for pre-WalletSession fixtures. */
import {
  createWalletSignatureVaultWorkerService,
  isEncryptedLocalStoreRecord,
  isWalletSignatureVaultRecord,
  requireLocalStoreCompatibility,
  walletSignatureVaultMetadataMatches,
  type EncryptedLocalStore,
  type WalletSignatureVaultContext,
  type WalletSignatureVaultRecord,
} from "../domain/walletLocalCrypto";
import {
  WalletMigrationRequiredError,
  parseWalletJson,
  requireWalletKeyScheduleVersion,
} from "../domain/walletVersion";
import type { LegacyWalletWasm } from "./legacyWalletWasm";

const MAX_LOCAL_STORE_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_STORE_RECORD_CHARS = Math.ceil(MAX_LOCAL_STORE_CIPHERTEXT_BYTES / 3) * 4 + 512;
const MAX_LOCAL_STORE_REQUEST_CHARS = MAX_LOCAL_STORE_CIPHERTEXT_BYTES - 16 + 256;

function seedBytes(seedHex: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error("Invalid wallet seed");
  return Uint8Array.from(seedHex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function seedHex(seed: Uint8Array): string {
  return Array.from(seed, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function publicVaultContext(context: WalletSignatureVaultContext) {
  return {
    walletAddress: context.walletAddress,
    chainId: context.chainId,
    vaultDeploymentId: context.deploymentId,
    origin: context.origin,
    messageVersion: context.messageVersion,
  } as const;
}

export async function encryptSeedWithWalletSignature(
  value: string,
  context: WalletSignatureVaultContext,
): Promise<WalletSignatureVaultRecord> {
  const seed = seedBytes(value);
  let supplied = false;
  try {
    const service = createWalletSignatureVaultWorkerService({
      randomBytes(length) {
        if (length === 32 && !supplied) {
          supplied = true;
          return seed.slice();
        }
        return crypto.getRandomValues(new Uint8Array(length));
      },
    });
    const result = await service.create(context.signature, publicVaultContext(context));
    result.seed.fill(0);
    return JSON.parse(result.vaultRaw) as WalletSignatureVaultRecord;
  } finally {
    seed.fill(0);
  }
}

export async function decryptSeedWithWalletSignature(
  vault: WalletSignatureVaultRecord | string,
  context: WalletSignatureVaultContext,
): Promise<string> {
  if (typeof vault === "string" && vault.length > 4096) throw new WalletMigrationRequiredError();
  const parsed = typeof vault === "string"
    ? parseWalletJson(vault, ["version", "message_version"])
    : vault;
  requireWalletKeyScheduleVersion(parsed);
  if (!isWalletSignatureVaultRecord(parsed)) throw new WalletMigrationRequiredError();
  if (!walletSignatureVaultMetadataMatches(parsed, context)) {
    throw new Error("Connected Starknet wallet does not match this wallet session");
  }
  const service = createWalletSignatureVaultWorkerService();
  const result = await service.open(
    JSON.stringify(parsed),
    context.signature,
    publicVaultContext(context),
  );
  try {
    return seedHex(result.seed);
  } finally {
    result.seed.fill(0);
  }
}

export async function encryptLocalStore(
  value: unknown,
  valueSeedHex: string,
  core: LegacyWalletWasm,
): Promise<EncryptedLocalStore> {
  const input = JSON.stringify({ seed_hex: valueSeedHex, value });
  if (input.length > MAX_LOCAL_STORE_REQUEST_CHARS) throw new Error("Local wallet state is too large");
  const record: unknown = JSON.parse(core.zylith_wallet_encrypt_local_state(input));
  if (!isEncryptedLocalStoreRecord(record)) throw new Error("Wallet returned invalid local state");
  return record;
}

export async function decryptLocalStore<T>(
  store: EncryptedLocalStore | string,
  valueSeedHex: string,
  core: LegacyWalletWasm,
  parseOutput: (output: string) => T = JSON.parse,
): Promise<T> {
  const raw = typeof store === "string" ? store : JSON.stringify(store);
  if (raw.length > MAX_LOCAL_STORE_RECORD_CHARS) throw new Error("Local wallet state is too large");
  requireLocalStoreCompatibility(raw);
  return parseOutput(core.zylith_wallet_decrypt_local_state(valueSeedHex, raw));
}
