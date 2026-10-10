import { describe, expect, it } from "vitest";
import * as walletWasm from "../public/wallet/zylith_wallet_wasm.js";

const FORBIDDEN_STATELESS_SECRET_EXPORTS = [
  "zylith_wallet_generate_seed_hex",
  "zylith_wallet_derive_public_config",
  "zylith_wallet_recovery_auth_tag",
  "zylith_wallet_derive_proof_signer",
  "zylith_wallet_encrypt_local_state",
  "zylith_wallet_decrypt_local_state",
  "zylith_wallet_build_deposit_submission_plan",
  "zylith_wallet_build_order_request",
  "zylith_wallet_build_cancel_request",
  "zylith_wallet_build_withdraw_request",
  "zylith_wallet_build_status_requests",
  "zylith_wallet_build_residual_recovery",
  "zylith_wallet_create_recovery_snapshot",
  "zylith_wallet_decrypt_recovery_artifact",
  "zylith_wallet_sign_strk20_exit_claim",
] as const;

describe("wallet WASM production export surface", () => {
  it("exposes WalletSession but no stateless secret operation", () => {
    expect(walletWasm.WalletSession).toBeTypeOf("function");
    for (const forbidden of FORBIDDEN_STATELESS_SECRET_EXPORTS) {
      expect(walletWasm).not.toHaveProperty(forbidden);
    }
  });
});
