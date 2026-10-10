import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error the browser project omits node types; vitest reads the generated wasm.
import { readFileSync } from "node:fs";
import { legacyWalletWasm as walletWasm } from "../test/legacyWalletWasm";
import {
  createWalletSignatureVaultWorkerService,
  isWalletSignatureVaultRecord,
  isEncryptedLocalStoreRecord,
  MAX_WALLET_SIGNATURE_HEX_DIGITS,
  normalizeWalletSignature,
  stableJsonStringify,
  walletSignatureVaultAuthToken,
  walletSignatureVaultId,
  type WalletSignatureVaultContext,
  type WalletSignatureVaultPublicContext,
} from "./walletLocalCrypto";
import {
  decryptLocalStore,
  decryptSeedWithWalletSignature,
  encryptLocalStore,
  encryptSeedWithWalletSignature,
} from "../test/legacyWalletCrypto";

const seedHex = "11".repeat(32);
walletWasm.initSync({ module: readFileSync("public/wallet/zylith_wallet_wasm_bg.wasm") });
const signatureContext: WalletSignatureVaultContext = {
  signature: ["0x1", "0x2"],
  walletAddress: "0xabc",
  chainId: "0x534e5f5345504f4c4941",
  deploymentId: "0x123",
  origin: "https://app.zylith.fi",
  messageVersion: 2,
};

const vaultKatContext = { ...signatureContext, signature: { a: ["0x0002", " Sig "], _: 3n, A: "0X0001" } };
const vaultPublicContext: WalletSignatureVaultPublicContext = {
  walletAddress: signatureContext.walletAddress,
  chainId: signatureContext.chainId,
  vaultDeploymentId: signatureContext.deploymentId,
  origin: signatureContext.origin,
  messageVersion: signatureContext.messageVersion,
};
const vaultKatAad = "0000000a000000247a796c6974682f77616c6c65742d7369676e61747572652d7661756c742f6161642f76330000000200030000000200020000000c484b44462d5348412d3235360000000b4145532d3235362d47434d000000200000000000000000000000000000000000000000000000000000000000000abc0000002000000000000000000000000000000000000000000000534e5f5345504f4c49410000002000000000000000000000000000000000000000000000000000000000000001230000001568747470733a2f2f6170702e7a796c6974682e6669000000020002";

afterEach(() => vi.restoreAllMocks());

describe("wallet storage v3 and closed local state", () => {
  it("uses one canonical signature hex-digit bound for bigint and string inputs", () => {
    expect(MAX_WALLET_SIGNATURE_HEX_DIGITS).toBe(256);
    for (const digits of [254, 255, 256]) {
      const canonical = `0x${"f".repeat(digits)}`;
      for (const input of [canonical, BigInt(canonical)]) {
        const normalized = normalizeWalletSignature(input);
        expect(normalized).toBe(canonical);
        expect(normalizeWalletSignature(normalized)).toBe(canonical);
      }
    }
    const firstRejected = `0x${"f".repeat(MAX_WALLET_SIGNATURE_HEX_DIGITS + 1)}`;
    expect(() => normalizeWalletSignature(firstRejected)).toThrow(/invalid signature/i);
    expect(() => normalizeWalletSignature(BigInt(firstRejected))).toThrow(/invalid signature/i);
  });

  it("normalizes a generated bounded signature corpus idempotently", () => {
    let state = 0x6d2b79f5;
    const next = () => {
      state = Math.imul(state ^ (state >>> 15), 1 | state);
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state);
      return (state ^ (state >>> 14)) >>> 0;
    };
    const atom = () => {
      const value = next();
      return value % 3 === 0 ? BigInt(value) : value % 3 === 1 ? value : `0x${value.toString(16).padStart(8, "0")}`;
    };
    for (let sample = 0; sample < 256; sample += 1) {
      const signature = sample % 2 === 0
        ? [atom(), atom(), { r: atom(), s: atom() }]
        : { a: atom(), proof_1: [atom(), atom()], z: atom() };
      const once = normalizeWalletSignature(signature);
      expect(normalizeWalletSignature(once)).toEqual(once);
    }
  });

  it("round-trips a generated seed corpus through the exact worker vault codec", async () => {
    let state = 0xa5a5_5a5a;
    for (let sample = 0; sample < 32; sample += 1) {
      const seed = new Uint8Array(32);
      for (let index = 0; index < seed.byteLength; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        seed[index] = state >>> 24;
      }
      const service = createWalletSignatureVaultWorkerService({
        randomBytes: (length) => length === 32 ? new Uint8Array(seed) : new Uint8Array(12).fill(sample),
      });
      const created = await service.create(vaultKatContext.signature, vaultPublicContext);
      const opened = await service.open(created.vaultRaw, vaultKatContext.signature, vaultPublicContext);
      expect(opened.seed).toEqual(seed);
      expect(base64ToBytes(JSON.parse(created.vaultRaw).ciphertext)).toHaveLength(80);
      created.seed.fill(0);
      opened.seed.fill(0);
      seed.fill(0);
    }
  });

  it("creates and opens the exact v3 vault without converting the seed to a JavaScript string", async () => {
    const seed = hexToBytes(seedHex);
    const nonce = hexToBytes("000102030405060708090a0b");
    const service = createWalletSignatureVaultWorkerService({
      randomBytes: (length) => new Uint8Array(length === 32 ? seed : nonce),
    });
    const created = await service.create(vaultKatContext.signature, vaultPublicContext);
    expect(created.seed).toEqual(seed);
    expect(created.vaultRaw).not.toContain(seedHex);
    expect(JSON.parse(created.vaultRaw)).toMatchObject({
      version: 3,
      deployment_id: signatureContext.deploymentId,
      nonce: "AAECAwQFBgcICQoL",
      ciphertext: "LsHn4kqB/KDZThd5hEoSCRZFb8ffMajvhZgWtIL3/EZ1ayK8FEw7mWy0wFxaJucgA2NWiHAs5imy9YQAYfb+jD58XkG2twdfmeoA6Ve45Tg=",
    });
    expect(created.authToken).toBe("0f6af4e0101267ab33fcd61065bfe2c951d189e8741e1b73c5df0c3709e69f6e");
    expect(created.walletAuthId).toBe("0x8b8ff2601b68bbf0f3566b5c28d1487eb864e0d70416b60f7bb683dda95d5639");

    const opened = await service.open(created.vaultRaw, vaultKatContext.signature, vaultPublicContext);
    expect(opened.seed).toEqual(seed);
    expect(opened.vaultRaw).toBe(created.vaultRaw);
    created.seed.fill(0);
    opened.seed.fill(0);
  });

  it("transfers only a successful root seed while always wiping the generated nonce", async () => {
    const seed = new Uint8Array(32).fill(0x4a);
    const nonce = new Uint8Array(12).fill(0x3b);
    const service = createWalletSignatureVaultWorkerService({
      randomBytes: (length) => length === seed.length ? seed : nonce,
    });

    const created = await service.create(vaultKatContext.signature, vaultPublicContext);
    expect(created.seed).toBe(seed);
    expect(created.seed).toEqual(new Uint8Array(32).fill(0x4a));
    expect(nonce).toEqual(new Uint8Array(12));
    created.seed.fill(0);
  });

  it("wipes generated, plaintext, nonce, and aad buffers when worker-side vault encryption fails", async () => {
    const generated: Uint8Array[] = [];
    let plaintext!: Uint8Array;
    let aad!: Uint8Array;
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(async (algorithm, _key, data) => {
      plaintext = data as Uint8Array;
      aad = (algorithm as AesGcmParams).additionalData as Uint8Array;
      throw new Error("raw cryptographic detail");
    });
    const service = createWalletSignatureVaultWorkerService({
      randomBytes: (length) => {
        const output = new Uint8Array(length).fill(7);
        generated.push(output);
        return output;
      },
    });

    await expect(service.create(vaultKatContext.signature, vaultPublicContext)).rejects.toThrow();
    expect(generated.every((buffer) => buffer.every((byte) => byte === 0))).toBe(true);
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(aad.every((byte) => byte === 0)).toBe(true);
  });

  it.each(["throw", "wrong length", "wrong type"] as const)(
    "wipes generated vault randomness and returns one fixed error when the nonce source has %s",
    async (failure) => {
      const seed = new Uint8Array(32).fill(0x5a);
      const generatedNonces: Array<Uint8Array | Uint16Array> = [];
      let calls = 0;
      const service = createWalletSignatureVaultWorkerService({
        randomBytes: ((length: number) => {
          calls += 1;
          if (calls === 1) return seed;
          if (failure === "throw") throw new Error("private random source detail");
          if (failure === "wrong length") {
            const nonce = new Uint8Array(length - 1).fill(0x6b);
            generatedNonces.push(nonce);
            return nonce;
          }
          const nonce = new Uint16Array(length / 2).fill(0x7c7c);
          generatedNonces.push(nonce);
          return nonce as never;
        }) as (length: number) => Uint8Array,
      });

      await expect(service.create(vaultKatContext.signature, vaultPublicContext)).rejects.toEqual(
        new Error("Wallet signature vault cryptography failed"),
      );
      expect(seed).toEqual(new Uint8Array(32));
      for (const nonce of generatedNonces) {
        expect(Array.from(nonce)).toEqual(Array(nonce.length).fill(0));
      }
    },
  );

  it("wipes invalid decrypted plaintext before rejecting a worker-side vault open", async () => {
    const vault = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    const invalidPlaintext = new TextEncoder().encode("AA".repeat(32));
    let nonce!: Uint8Array;
    let ciphertext!: Uint8Array;
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (algorithm, _key, data) => {
      nonce = (algorithm as AesGcmParams).iv as Uint8Array;
      ciphertext = data as Uint8Array;
      return invalidPlaintext.buffer;
    });
    const service = createWalletSignatureVaultWorkerService();

    await expect(service.open(JSON.stringify(vault), signatureContext.signature, vaultPublicContext)).rejects.toThrow(/invalid/i);
    expect(invalidPlaintext.every((byte) => byte === 0)).toBe(true);
    expect(nonce.every((byte) => byte === 0)).toBe(true);
    expect(ciphertext.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects sparse signature arrays whose named properties disguise missing entries", async () => {
    const sparse = new Array(1);
    Object.assign(sparse, { extra: "0x1" });
    await expect(walletSignatureVaultAuthToken({ ...signatureContext, signature: sparse })).rejects.toThrow(/invalid signature/i);
  });

  it("sorts numeric-looking signature keys in ASCII order", () => {
    expect(stableJsonStringify({ "2": "0x2", "10": "0x1", A: "0x3" })).toBe('{"10":"0x1","2":"0x2","A":"0x3"}');
  });

  it.each(["3.0", "3e0"])("rejects noncanonical vault integer token %s before seed return", async (token) => {
    const record = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    await expect(decryptSeedWithWalletSignature(JSON.stringify(record).replace('"version":3', `"version":${token}`), signatureContext)).rejects.toThrow(/migration required/i);
  });
  it.each(["2.0", "2e0"])("rejects noncanonical vault message token %s before seed return", async (token) => {
    const record = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    await expect(decryptSeedWithWalletSignature(JSON.stringify(record).replace('"message_version":2', `"message_version":${token}`), signatureContext)).rejects.toThrow(/migration required/i);
  });
  it("matches the independent v3 key, auth, id, aad and fixed-nonce ciphertext KAT", async () => {
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      new Uint8Array(array!.buffer, array!.byteOffset, array!.byteLength).set(hexToBytes("000102030405060708090a0b"));
      return array;
    });
    const vault = await encryptSeedWithWalletSignature(seedHex, vaultKatContext);
    expect(vault).toMatchObject({ version: 3, key_schedule_version: 2, kdf: "HKDF-SHA-256", algorithm: "AES-256-GCM", nonce: "AAECAwQFBgcICQoL" });
    expect(vault.ciphertext).toBe("LsHn4kqB/KDZThd5hEoSCRZFb8ffMajvhZgWtIL3/EZ1ayK8FEw7mWy0wFxaJucgA2NWiHAs5imy9YQAYfb+jD58XkG2twdfmeoA6Ve45Tg=");
    expect(await walletSignatureVaultAuthToken(vaultKatContext)).toBe("0f6af4e0101267ab33fcd61065bfe2c951d189e8741e1b73c5df0c3709e69f6e");
    expect(await walletSignatureVaultId(vaultKatContext)).toBe("0x8b8ff2601b68bbf0f3566b5c28d1487eb864e0d70416b60f7bb683dda95d5639");
    const key = await crypto.subtle.importKey("raw", hexToBytes("c687c6c606d82d5cd08c24bc0879970be8eb513585bd3a397b3bf8585ed0fc57"), "AES-GCM", false, ["decrypt"]);
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(vault.nonce), additionalData: hexToBytes(vaultKatAad) }, key, base64ToBytes(vault.ciphertext)))).toBe(seedHex);
  });

  it("separates the fixed salt and clears mutable KDF buffers while retaining a nonextractable AES key", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const derive = crypto.subtle.deriveBits.bind(crypto.subtle);
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits").mockImplementation(async (params, key, length) => {
      return derive({ ...(params as HkdfParams), salt: new TextEncoder().encode("zylith/wallet-signature-vault/hkdf-sha256/other") }, key, length);
    });
    const vault = await encryptSeedWithWalletSignature(seedHex, vaultKatContext);
    expect(await walletSignatureVaultAuthToken(vaultKatContext)).not.toBe("0f6af4e0101267ab33fcd61065bfe2c951d189e8741e1b73c5df0c3709e69f6e");
    for (const call of deriveBits.mock.calls) {
      const params = call[0] as HkdfParams;
      expect(Array.from(params.salt as Uint8Array).every((byte) => byte === 0)).toBe(true);
      expect(Array.from(params.info as Uint8Array).every((byte) => byte === 0)).toBe(true);
    }
    const aesCall = importKey.mock.calls.findIndex((call) => call[2] === "AES-GCM");
    const aesKey = await importKey.mock.results[aesCall].value as CryptoKey;
    expect(aesKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", aesKey)).rejects.toBeTruthy();
    for (const call of importKey.mock.calls) {
      if (call[0] === "raw") expect(Array.from(call[1] as Uint8Array).every((byte) => byte === 0)).toBe(true);
    }
    deriveBits.mockRestore();
    await expect(decryptSeedWithWalletSignature(vault, vaultKatContext)).rejects.toBeTruthy();
  });

  it("clears mutable signature, salt and info buffers when HKDF fails", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const deriveBits = vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("HKDF failed"));
    await expect(walletSignatureVaultAuthToken(vaultKatContext)).rejects.toThrow("HKDF failed");
    expect(Array.from(importKey.mock.calls[0][1] as Uint8Array).every((byte) => byte === 0)).toBe(true);
    const params = deriveBits.mock.calls[0][0] as HkdfParams;
    expect(Array.from(params.salt as Uint8Array).every((byte) => byte === 0)).toBe(true);
    expect(Array.from(params.info as Uint8Array).every((byte) => byte === 0)).toBe(true);
  });

  it("uses ASCII signature ordering and canonical numeric spellings independently of locale", async () => {
    vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => { throw new Error("locale-dependent ordering"); });
    const equivalent = { ...vaultKatContext, signature: { A: 1, a: [2n, "sig"], _: "0x3" }, walletAddress: "0x000ABC", chainId: "000534E5F5345504F4C4941", deploymentId: "0x000123", origin: "https://APP.ZYLITH.FI:443" };
    expect(await walletSignatureVaultAuthToken(equivalent)).toBe("0f6af4e0101267ab33fcd61065bfe2c951d189e8741e1b73c5df0c3709e69f6e");
  });

  it.each(["walletAddress", "chainId", "deploymentId"])("rejects invalid nonzero field context %s", async (field) => {
    for (const invalid of ["", "0x0", "0x00", "-0x1", "+0x1", " 0x1", "0x1 ", "0xg", "0x800000000000011000000000000000000000000000000000000000000000001"]) {
      await expect(walletSignatureVaultAuthToken({ ...signatureContext, [field]: invalid })).rejects.toThrow();
    }
  });

  it.each(["https://app.zylith.fi/", "https://app.zylith.fi/a", "https://app.zylith.fi?x", "https://app.zylith.fi#x", "https://user@app.zylith.fi", " https://app.zylith.fi", "https://app.zylith.fi ", "https://app.zylith.fi\n", "https://app.zylith.fi\\a", "http://app.zylith.fi", "data:text/plain,x", "zylith://local", "null", "http://localhost.evil"])("rejects ambiguous or nonproduction origin %s", async (origin) => {
    await expect(walletSignatureVaultAuthToken({ ...signatureContext, origin })).rejects.toThrow();
  });

  it.each(["http://localhost", "http://localhost:5173", "http://127.0.0.1:3000", "http://[::1]:5173"])("supports only the explicit loopback development exception %s", async (origin) => {
    await expect(walletSignatureVaultAuthToken({ ...signatureContext, origin })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([-1, 1.5, NaN, Infinity, -1n, Number.MAX_SAFE_INTEGER + 1, "", "   ", {}, [], new Date(), null, true, undefined].map((value) => [value]))("rejects empty or unsupported signature material %s", async (signature) => {
    await expect(walletSignatureVaultAuthToken({ ...signatureContext, signature })).rejects.toThrow();
  });

  it("rejects the old local record and emits only the closed account-bound v2 state schema", async () => {
    const store = await encryptLocalStore({ value: 1 }, seedHex, walletWasm);
    expect(store).toMatchObject({ version: 2, key_schedule_version: 2, kdf: "zylith-wallet-hkdf-sha256-v2", algorithm: "AES-256-GCM", purpose: "wallet-state" });
    expect(isEncryptedLocalStoreRecord({ version: 1, key_schedule_version: 2, algorithm: "AES-GCM", nonce: store.nonce, ciphertext: store.ciphertext })).toBe(false);
  });
});

describe("walletLocalCrypto", () => {
  it.each([
    ["2.0", "0FeP8DMQuUqEHTnVbWpjNL6xBiwy9ICZ+M5uOIRsq/2R0LhJNKxMolpSgThOQf64FWU7rDVV+jfv5x15ZiIeOZvl02ZkSZM4mmHf17FGYA+S7aWLkdPCoLzvO/HwANc="],
    ["2e0", "0FeP8DMQuUqEHTnVJmpjNL6xBiwy9ICZ+M5uOIRsq/2R0LhJNKxMolpSgThOQf64FWU7rDVV+jfv5x15ZiIeOZvl02ZkSZM4mmHf17FGYPGWBX4e8thepMRK4JIvxlw="],
  ])("keeps generic local JSON decrypt independent of application version tokens %s", async (_token, ciphertext) => {
    const store = {
      version: 2 as const, key_schedule_version: 2 as const, kdf: "zylith-wallet-hkdf-sha256-v2" as const, algorithm: "AES-256-GCM" as const,
      account_id: "3142846eff7f5cd3bea9c020fcf9eb1e07554647daa520b0d065a0ac86292bc0", purpose: "wallet-state" as const,
      nonce: "AAECAwQFBgcICQoL", ciphertext,
    };
    await expect(decryptLocalStore(store, "01".repeat(32), walletWasm)).resolves.toEqual({
      version: 2, key_schedule_version: 2, notes: [], orders: [], scanned_seq: 0,
    });
  });

  it("stamps both seed and local-store envelopes and rejects incompatible versions before decrypting", async () => {
    const vault = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    const store = await encryptLocalStore({ value: 1 }, seedHex, walletWasm);
    expect(vault).toMatchObject({ key_schedule_version: 2 });
    expect(store).toMatchObject({ key_schedule_version: 2 });
    for (const version of [undefined, 1, 3, "2", 2.5, null, true, {}, []]) {
      await expect(decryptSeedWithWalletSignature({ ...vault, key_schedule_version: version } as never, signatureContext)).rejects.toThrow(/migration required/i);
      await expect(decryptLocalStore({ ...store, key_schedule_version: version } as never, seedHex, walletWasm)).rejects.toThrow(/migration required/i);
    }
  });

  it("binds local stores to the schedule's own account and the closed wallet-state purpose", async () => {
    const store = await encryptLocalStore(
      { orders: ["0xabc"], count: 1 },
      seedHex,
      walletWasm,
    );

    await expect(
      decryptLocalStore(store, seedHex, walletWasm),
    ).resolves.toEqual({ orders: ["0xabc"], count: 1 });
    await expect(
      decryptLocalStore(store, "12".repeat(32), walletWasm),
    ).rejects.toBeTruthy();
    await expect(
      decryptLocalStore({ ...store, purpose: "notes" } as never, seedHex, walletWasm),
    ).rejects.toBeTruthy();
  });

  it("refuses to create a local store larger than the reader accepts", async () => {
    await expect(
      encryptLocalStore(
        { value: "a".repeat(4 * 1024 * 1024) },
        seedHex,
        walletWasm,
      ),
    ).rejects.toThrow(/too large/i);
  });

  it("domain-separates vault encryption, lookup, and authorization", async () => {
    const vault = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    const authToken = await walletSignatureVaultAuthToken(signatureContext);
    const vaultId = await walletSignatureVaultId(signatureContext);
    const expectedId = await sha256Hex(
      `zylith/wallet-signature-vault/id/v3:${authToken}`,
    );

    expect(vault.version).toBe(3);
    expect(vaultId).toBe(`0x${expectedId}`);
    await expect(
      decryptSeedWithWalletSignature(vault, signatureContext),
    ).resolves.toBe(seedHex);

    const exposedLookupKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(vaultId.slice(2)),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    await expect(
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(vault.nonce), additionalData: hexToBytes(vaultKatAad) },
        exposedLookupKey,
        base64ToBytes(vault.ciphertext),
      ),
    ).rejects.toBeTruthy();
    const tokenKey = await crypto.subtle.importKey("raw", hexToBytes(authToken), "AES-GCM", false, ["decrypt"]);
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(vault.nonce), additionalData: hexToBytes(vaultKatAad) }, tokenKey, base64ToBytes(vault.ciphertext))).rejects.toBeTruthy();
  });

  it("separates each public context and the wallet signature while rejecting unsupported message versions", async () => {
    const token = await walletSignatureVaultAuthToken(signatureContext);
    for (const changed of [
      { walletAddress: "0xdef" }, { chainId: "0x1" }, { deploymentId: "0x456" }, { origin: "https://other.example" }, { signature: ["0x1", "0x3"] },
    ]) {
      expect(await walletSignatureVaultAuthToken({ ...signatureContext, ...changed })).not.toBe(token);
      expect(await walletSignatureVaultId({ ...signatureContext, ...changed })).not.toBe(await walletSignatureVaultId(signatureContext));
    }
    for (const version of [1, 3, "2", null, 2.5]) await expect(walletSignatureVaultAuthToken({ ...signatureContext, messageVersion: version } as never)).rejects.toThrow();
  });

  it("rejects missing, extra, duplicate, legacy and noncanonical vault fields before seed return", async () => {
    const vault = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    for (const field of Object.keys(vault)) {
      const missing = { ...vault } as Record<string, unknown>;
      delete missing[field];
      expect(isWalletSignatureVaultRecord(missing)).toBe(false);
      await expect(decryptSeedWithWalletSignature(missing as never, signatureContext)).rejects.toThrow(/migration required/i);
    }
    for (const alteration of [
      { version: 2 }, { version: 4 }, { key_schedule_version: 1 }, { kdf: "wallet-signature-sha256-v2" }, { algorithm: "AES-GCM" }, { message_version: 1 },
      { wallet_address: "0x0abc" }, { chain_id: "0x0" }, { deployment_id: "0xABC" }, { origin: "https://APP.ZYLITH.FI" },
      { ciphertext: vault.ciphertext.slice(0, -1) }, { ciphertext: vault.ciphertext.slice(0, -2) + "h=" }, { nonce: " " + vault.nonce }, { extra: 1 },
    ]) {
      await expect(decryptSeedWithWalletSignature({ ...vault, ...alteration } as never, signatureContext)).rejects.toThrow(/migration required/i);
    }
    for (const duplicate of ['"version":3', '"key_schedule_\\u0076ersion":2', '"wallet_address":"0xabc"']) {
      await expect(decryptSeedWithWalletSignature(JSON.stringify(vault).replace("{", `{${duplicate},`), signatureContext)).rejects.toThrow(/migration required/i);
    }
    const bytes = base64ToBytes(vault.ciphertext);
    bytes[0] ^= 1;
    await expect(decryptSeedWithWalletSignature({ ...vault, ciphertext: bytesToBase64(bytes) }, signatureContext)).rejects.toBeTruthy();
  });

  it("keeps the local key and AES operations inside generated wasm", async () => {
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("browser seed hashing"));
    vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("browser local kdf"));
    vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("browser local aes"));
    vi.spyOn(crypto.subtle, "decrypt").mockRejectedValue(new Error("browser local aes"));
    const store = await encryptLocalStore({ count: 1 }, "00".repeat(32), walletWasm);
    expect(store.account_id).toBe("572a6b66c69d65e185bb78512b704b47be6d75b2595df4aeea988bffaa9889be");
    await expect(decryptLocalStore(store, "00".repeat(32), walletWasm)).resolves.toEqual({ count: 1 });
  });

  it("opens the independent fixed-nonce local KAT through generated wasm", async () => {
    const record = { version: 2, key_schedule_version: 2, kdf: "zylith-wallet-hkdf-sha256-v2", algorithm: "AES-256-GCM", account_id: "572a6b66c69d65e185bb78512b704b47be6d75b2595df4aeea988bffaa9889be", purpose: "wallet-state", nonce: "AAECAwQFBgcICQoL", ciphertext: "0ejOU+vTAH0Uz/aV2Jg287Xl6wCx2lHnOJqXQ+2AQhbkByXGLlXYbcUE+qj8Iw==" };
    await expect(decryptLocalStore(record as never, "00".repeat(32), walletWasm)).resolves.toEqual({ count: 1, orders: ["0xabc"] });
    for (const body of [JSON.stringify(record).replace("{", '{"purpose":"wallet-state",'), JSON.stringify(record).replace("{", '{"key_schedule_\\u0076ersion":2,')]) {
      await expect(decryptLocalStore(body, "00".repeat(32), walletWasm)).rejects.toThrow(/migration required/i);
    }
    const seed = hexToBytes("00".repeat(32));
    const session = new walletWasm.WalletSession(seed, "0x1", "0x1");
    seed.fill(0);
    try {
      for (const raw of [
        `{"value":{"outer":{"a":1,"a":2}}}`,
        `{"value":[{"outer":{"a":1,"\\u0061":2}}]}`,
      ]) expect(() => session.encryptLocalState(raw)).toThrow();
    } finally {
      session.lock();
      session.free();
    }
  });

  it("rejects partial wallet-signature vault records", () => {
    expect(
      isWalletSignatureVaultRecord({
        version: 2,
        kdf: "wallet-signature-sha256-v2",
      } as never),
    ).toBe(false);
    expect(
      isWalletSignatureVaultRecord({
        version: 2,
        kdf: "wallet-signature-sha256-v2",
        algorithm: "AES-GCM",
        wallet_address: "0xabc",
        chain_id: "0x534e5f5345504f4c4941",
        deployment_id: "0x123",
        origin: "https://app.zylith.fi",
        message_version: 2,
        nonce: "AA==",
        ciphertext: "AA==",
      } as never),
    ).toBe(false);
    expect(
      isWalletSignatureVaultRecord({
        version: 2,
        kdf: "wallet-signature-sha256-v2",
        algorithm: "AES-GCM",
        wallet_address: "0xabc",
        chain_id: "0x534e5f5345504f4c4941",
        deployment_id: "0x123",
        origin: "https://app.zylith.fi",
        message_version: 2,
        nonce: "AA==",
        ciphertext: "AA==",
        unsupported_passphrase_hint: "removed",
      } as never),
    ).toBe(false);
  });

  it("accepts only the one vault format and bounded ciphertext", () => {
    const vault = {
      version: 3,
      key_schedule_version: 2,
      kdf: "HKDF-SHA-256",
      algorithm: "AES-256-GCM",
      wallet_address: "0xabc",
      chain_id: "0x534e5f5345504f4c4941",
      deployment_id: "0x123",
      origin: "https://app.zylith.fi",
      message_version: 2,
      nonce: bytesToBase64(new Uint8Array(12)),
      ciphertext: bytesToBase64(new Uint8Array(80)),
    };
    expect(isWalletSignatureVaultRecord(vault as never)).toBe(true);
    expect(
      isWalletSignatureVaultRecord({ ...vault, message_version: 1 } as never),
    ).toBe(false);
    expect(
      isWalletSignatureVaultRecord({ ...vault, kdf: "wallet-signature-sha256-v1" } as never),
    ).toBe(false);
    expect(isWalletSignatureVaultRecord({ ...vault, nonce: "AA==" } as never)).toBe(false);
    expect(isWalletSignatureVaultRecord({ ...vault, ciphertext: "not-base64" } as never)).toBe(false);
    expect(isEncryptedLocalStoreRecord({
      version: 2,
      key_schedule_version: 2,
      kdf: "zylith-wallet-hkdf-sha256-v2",
      algorithm: "AES-256-GCM",
      account_id: "11".repeat(32), purpose: "wallet-state",
      nonce: vault.nonce,
      ciphertext: bytesToBase64(new Uint8Array(16)),
    })).toBe(true);
    expect(isEncryptedLocalStoreRecord({
      version: 2,
      key_schedule_version: 2,
      kdf: "zylith-wallet-hkdf-sha256-v2",
      algorithm: "AES-256-GCM",
      account_id: "11".repeat(32), purpose: "wallet-state",
      nonce: "AA==",
      ciphertext: bytesToBase64(new Uint8Array(16)),
    })).toBe(false);
  });

  it("rejects incomplete wallet-signature vault contexts", async () => {
    await expect(
      encryptSeedWithWalletSignature(seedHex, {
        ...signatureContext,
        signature: "",
      }),
    ).rejects.toThrow(/invalid signature/);
    await expect(
      walletSignatureVaultAuthToken({
        ...signatureContext,
        deploymentId: "   ",
      }),
    ).rejects.toThrow("Wallet signature vault context is incomplete");
  });

  it("bounds wallet-provided signature structures", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.signature = cyclic;
    await expect(
      walletSignatureVaultAuthToken({ ...signatureContext, signature: cyclic }),
    ).rejects.toThrow("invalid signature");
    await expect(
      walletSignatureVaultAuthToken({
        ...signatureContext,
        signature: Array.from({ length: 17 }, (_, index) => `0x${index + 1}`),
      }),
    ).rejects.toThrow("invalid signature");
  });

  it("rejects wallet-signature vaults outside the original wallet and deployment domain", async () => {
    const vault = await encryptSeedWithWalletSignature(seedHex, signatureContext);
    await expect(
      decryptSeedWithWalletSignature(vault, {
        ...signatureContext,
        walletAddress: "0xdef",
      }),
    ).rejects.toThrow("Connected Starknet wallet does not match this wallet session");
    await expect(
      decryptSeedWithWalletSignature(vault, {
        ...signatureContext,
        chainId: "0x534e5f4d41494e",
      }),
    ).rejects.toThrow("Connected Starknet wallet does not match this wallet session");
    await expect(
      decryptSeedWithWalletSignature(vault, {
        ...signatureContext,
        deploymentId: "0x456",
      }),
    ).rejects.toThrow("Connected Starknet wallet does not match this wallet session");
    await expect(
      decryptSeedWithWalletSignature(vault, {
        ...signatureContext,
        origin: "https://evil.example",
      }),
    ).rejects.toThrow("Connected Starknet wallet does not match this wallet session");
  });

  it("canonicalizes JSON object keys and omits undefined object fields", () => {
    expect(stableJsonStringify({ b: 2, a: 1, missing: undefined })).toBe(
      '{"a":1,"b":2}',
    );
    expect(stableJsonStringify([{ b: 2, a: 1 }, undefined])).toBe(
      '[{"a":1,"b":2},null]',
    );
  });
});

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function hexToBytes(value: string) {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function bytesToBase64(value: Uint8Array) {
  return btoa(String.fromCharCode(...value));
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
