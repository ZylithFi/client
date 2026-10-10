/**
 * Test-only compatibility adapter for fixtures written before WalletSession became the sole
 * production secret boundary. This module must never be imported by application code.
 */
import * as walletWasm from "../../public/wallet/zylith_wallet_wasm.js";

type JsonObject = Record<string, unknown>;

function seedBytes(seedHex: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error("invalid test wallet seed");
  return Uint8Array.from(seedHex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
}

function object(inputJson: string): JsonObject {
  const value: unknown = JSON.parse(inputJson);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid test wallet input");
  return value as JsonObject;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`invalid test wallet ${name}`);
  return value;
}

function without(input: JsonObject, ...fields: string[]): JsonObject {
  const result = { ...input };
  for (const field of fields) delete result[field];
  return result;
}

function sessionCall(
  seedHex: string,
  chainId: string,
  deploymentId: string,
  operation: (session: walletWasm.WalletSession) => string,
): string {
  const bytes = seedBytes(seedHex);
  let session: walletWasm.WalletSession | null = null;
  try {
    session = new walletWasm.WalletSession(bytes, chainId, deploymentId);
    return operation(session);
  } finally {
    bytes.fill(0);
    session?.lock();
    session?.free();
  }
}

function classifiedSessionCall(
  seedHex: string,
  operation: (session: walletWasm.WalletSession) => string,
): string {
  return sessionCall(seedHex, TEST_CHAIN, TEST_DEPLOYMENT, operation);
}

function unwrapClassified(resultJson: string): string {
  const result = object(resultJson);
  if (result.status === "MIGRATION_REQUIRED") throw new Error("wallet migration required");
  if (result.status !== "OK" || typeof result.result_b64 !== "string") {
    throw new Error("invalid encrypted wallet data");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(result.result_b64), (character) => character.charCodeAt(0)),
  );
}

const TEST_CHAIN = "0x1";
const TEST_DEPLOYMENT = "0x1";

export const legacyWalletWasm = {
  ...walletWasm,
  zylith_wallet_derive_public_config(seedHex: string) {
    return sessionCall(seedHex, TEST_CHAIN, TEST_DEPLOYMENT, (session) => session.publicConfig());
  },
  zylith_wallet_recovery_auth_tag(seedHex: string) {
    return sessionCall(seedHex, TEST_CHAIN, TEST_DEPLOYMENT, (session) => session.recoveryAuthTag());
  },
  zylith_wallet_derive_proof_signer(inputJson: string) {
    const input = object(inputJson);
    return sessionCall(
      text(input.seed_hex, "seed"),
      text(input.chain_id, "chain"),
      TEST_DEPLOYMENT,
      (session) => session.deriveProofSigner(JSON.stringify(without(input, "seed_hex", "chain_id"))),
    );
  },
  zylith_wallet_encrypt_local_state(inputJson: string) {
    if (inputJson.length > 4 * 1024 * 1024) throw new Error("local wallet state is too large");
    const input = object(inputJson);
    return sessionCall(
      text(input.seed_hex, "seed"),
      TEST_CHAIN,
      TEST_DEPLOYMENT,
      (session) => session.encryptLocalState(JSON.stringify(without(input, "seed_hex"))),
    );
  },
  zylith_wallet_decrypt_local_state(seedHex: string, recordJson: string) {
    return unwrapClassified(classifiedSessionCall(
      seedHex,
      (session) => session.decryptLocalStateClassified(recordJson),
    ));
  },
  test_wallet_decrypt_local_state_classified(seedHex: string, recordJson: string) {
    return classifiedSessionCall(seedHex, (session) => session.decryptLocalStateClassified(recordJson));
  },
  zylith_wallet_build_deposit_submission_plan(inputJson: string) {
    const input = object(inputJson);
    return sessionCall(
      text(input.seed_hex, "seed"),
      text(input.chain_id, "chain"),
      TEST_DEPLOYMENT,
      (session) => session.buildDepositSubmissionPlan(JSON.stringify(without(input, "seed_hex", "chain_id"))),
    );
  },
  zylith_wallet_build_order_request(inputJson: string) {
    return contextual(inputJson, (session, input) => session.buildOrderRequest(JSON.stringify(input)));
  },
  zylith_wallet_build_cancel_request(inputJson: string) {
    return contextual(inputJson, (session, input) => session.buildCancelRequest(JSON.stringify(input)));
  },
  zylith_wallet_build_withdraw_request(inputJson: string) {
    return contextual(inputJson, (session, input) => session.buildWithdrawRequest(JSON.stringify(input)));
  },
  zylith_wallet_build_status_requests(inputJson: string) {
    return contextual(inputJson, (session, input) => session.buildStatusRequests(JSON.stringify(input)));
  },
  zylith_wallet_build_residual_recovery(inputJson: string) {
    const input = object(inputJson);
    const note = input.note;
    if (!note || typeof note !== "object" || Array.isArray(note)) throw new Error("invalid test residual note");
    return sessionCall(
      text(input.seed_hex, "seed"),
      TEST_CHAIN,
      text((note as JsonObject).chain_context, "deployment"),
      (session) => session.buildResidualRecovery(JSON.stringify(without(input, "seed_hex"))),
    );
  },
  zylith_wallet_create_recovery_snapshot(inputJson: string) {
    const input = object(inputJson);
    return sessionCall(
      text(input.seed_hex, "seed"),
      TEST_CHAIN,
      TEST_DEPLOYMENT,
      (session) => session.createRecoverySnapshot(JSON.stringify(without(input, "seed_hex"))),
    );
  },
  zylith_wallet_decrypt_recovery_artifact(seedHex: string, artifactJson: string) {
    return unwrapClassified(classifiedSessionCall(
      seedHex,
      (session) => session.decryptRecoveryArtifactClassified(artifactJson),
    ));
  },
  test_wallet_decrypt_recovery_artifact_classified(seedHex: string, artifactJson: string) {
    return classifiedSessionCall(seedHex, (session) => session.decryptRecoveryArtifactClassified(artifactJson));
  },
  zylith_wallet_sign_strk20_exit_claim(inputJson: string) {
    const input = object(inputJson);
    return sessionCall(
      text(input.seed_hex, "seed"),
      text(input.chain_id, "chain"),
      text(input.exchange_address, "deployment"),
      (session) => session.signStrk20ExitClaim(JSON.stringify(without(input, "seed_hex", "chain_id", "exchange_address"))),
    );
  },
};

function contextual(
  inputJson: string,
  operation: (session: walletWasm.WalletSession, input: JsonObject) => string,
): string {
  const input = object(inputJson);
  const seedHex = text(input.seed_hex, "seed");
  const chainId = text(input.chain_id, "chain");
  const deploymentId = text(input.chain_context, "deployment");
  return sessionCall(
    seedHex,
    chainId,
    deploymentId,
    (session) => operation(session, without(input, "seed_hex", "chain_id", "chain_context")),
  );
}

export type LegacyWalletWasm = typeof legacyWalletWasm;
