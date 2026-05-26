use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use zylith_core::{
    AssetId, BatchId, DepositIntent, DepositSubmissionPlan, EncryptedMakerAttributionArtifact,
    Note, OrderCommitment, OrderIntent, OrderSubmission, OutputCiphertextBundle,
    OutputNoteMerkleProof, OutputNoteRecord, PrivateExecutionKeyRegistry, PrivateOrderPayload,
    RecoveryArtifact, RecoveryArtifactKind, RecoverySeed, RenewalParentCancelPlanRequest,
    RenewalParentCancelSubmissionPlan, SettlementOutputWithdrawalPlanRequest,
    SettlementOutputWithdrawalSubmissionPlan, SpendAuthorization, TrustedOrderIngressRequest,
    WithdrawalSubmissionPlan, build_deposit_submission_plan, build_order_submission,
    build_renewal_parent_cancel_submission_plan,
    build_settlement_output_withdrawal_submission_plan, build_withdrawal_submission_plan,
    create_recovery_artifact, decrypt_maker_attribution_artifact, decrypt_output_note_for_owner,
    decrypt_output_recovery_record, decrypt_recovery_artifact_payload, derive_account_id,
    derive_order_cancellation_secret, derive_recovery_auth_tag, derive_user_keys,
    funding_input_set_commitment, funding_nullifier_set_commitment,
    note_recognition_public_key_from_raw_key_hex, nullifier_from_note_secret,
    renewal_cancel_auth_key_felt_from_raw_key_hex, renewal_cancel_authority_from_raw_key_hex,
    renewal_parent_commitment, renewal_parent_secret_commitment, sign_order_authorization,
    spend_auth_key_felt_from_raw_key_hex, spend_authority_from_raw_key_hex,
    verify_output_note_membership, withdraw_auth_key_felt_from_raw_key_hex,
    withdraw_authority_from_raw_key_hex,
};

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn zylith_wallet_generate_seed_hex() -> String {
    RecoverySeed::generate().to_hex()
}

#[wasm_bindgen]
pub fn zylith_wallet_generate_mnemonic() -> Result<String, JsValue> {
    RecoverySeed::generate().to_mnemonic().map_err(js_error)
}

#[wasm_bindgen]
pub fn zylith_wallet_seed_hex_to_mnemonic(seed_hex: &str) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    seed.to_mnemonic().map_err(js_error)
}

#[wasm_bindgen]
pub fn zylith_wallet_mnemonic_to_seed_hex(phrase: &str) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_mnemonic(phrase).map_err(js_error)?;
    Ok(seed.to_hex())
}

#[wasm_bindgen]
pub fn zylith_wallet_derive_public_config(seed_hex: &str) -> Result<String, JsValue> {
    to_json(&derive_public_config(seed_hex)?)
}

#[wasm_bindgen]
pub fn zylith_wallet_recovery_auth_tag(seed_hex: &str) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    Ok(derive_recovery_auth_tag(
        &derive_account_id(&seed),
        &hex::encode(keys.recovery_key),
    ))
}

#[wasm_bindgen]
pub fn zylith_wallet_build_deposit_submission_plan(input_json: &str) -> Result<String, JsValue> {
    let request: BuildDepositSubmissionPlanRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let owner_key_hex = hex::encode(keys.note_recognition_key);
    let spend_key_hex = hex::encode(keys.spend_auth_key);
    let withdraw_key_hex = hex::encode(keys.withdraw_auth_key);
    let intent = DepositIntent {
        asset_id: request.asset_id,
        amount: request.amount,
        deposit_nonce: request.deposit_nonce,
        recipient_owner_public_key: note_recognition_public_key_from_raw_key_hex(&owner_key_hex)
            .map_err(js_error)?,
        recipient_spend_authority: spend_authority_from_raw_key_hex(&spend_key_hex)
            .map_err(js_error)?,
        recipient_withdraw_authority: withdraw_authority_from_raw_key_hex(&withdraw_key_hex)
            .map_err(js_error)?,
    };
    let plan = build_deposit_submission_plan(
        &intent,
        &request.deposit_router_address,
        &request.token_address,
        &request.shielded_asset_adapter_address,
    )
    .map_err(js_error)?;
    to_json(&plan)
}

#[wasm_bindgen]
pub fn zylith_wallet_build_private_order_submission(input_json: &str) -> Result<String, JsValue> {
    let request: BuildPrivateOrderSubmissionRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let spend_key_hex = hex::encode(keys.spend_auth_key);
    let owner_key_hex = hex::encode(keys.note_recognition_key);
    let withdraw_key_hex = hex::encode(keys.withdraw_auth_key);
    let order_cancel_key_hex = hex::encode(keys.order_cancellation_key);
    let spend_auth_key_felt = spend_auth_key_felt_from_raw_key_hex(&spend_key_hex);
    let spend_authority = spend_authority_from_raw_key_hex(&spend_key_hex).map_err(js_error)?;
    let owner_public_key =
        note_recognition_public_key_from_raw_key_hex(&owner_key_hex).map_err(js_error)?;
    let withdraw_authority =
        withdraw_authority_from_raw_key_hex(&withdraw_key_hex).map_err(js_error)?;
    let funding_notes = if request.funding_notes.is_empty() {
        vec![request.funding_note.clone()]
    } else {
        request.funding_notes.clone()
    };
    let funding_commitments = funding_notes
        .iter()
        .map(|note| note.commitment())
        .collect::<Result<Vec<_>, _>>()
        .map_err(js_error)?;
    let funding_nullifiers = funding_notes
        .iter()
        .zip(funding_commitments.iter())
        .map(|(note, commitment)| nullifier_from_note_secret(commitment, &note.blinding))
        .collect::<Result<Vec<_>, _>>()
        .map_err(js_error)?;
    let funding_note_ref = funding_input_set_commitment(&funding_commitments).map_err(js_error)?;
    let funding_nullifier =
        funding_nullifier_set_commitment(&funding_nullifiers).map_err(js_error)?;

    let mut order = request.order;
    order.funding_note_ref = funding_note_ref;
    order.funding_nullifier = funding_nullifier;
    order.recipient_owner_public_key = owner_public_key;
    order.recipient_spend_authority = spend_authority;
    order.recipient_withdraw_authority = withdraw_authority.clone();
    order.recipient_residual_withdraw_authority = withdraw_authority;

    let order_commitment = order.commitment().map_err(js_error)?;
    let funding_authorization =
        sign_order_authorization(&spend_auth_key_felt, &order_commitment).map_err(js_error)?;
    let payload = PrivateOrderPayload {
        order,
        funding_note: request.funding_note,
        funding_notes,
        funding_authorization,
    };
    let order_submission =
        build_order_submission(&payload, &request.registry, &order_cancel_key_hex)
            .map_err(js_error)?;
    let cancellation_secret =
        derive_order_cancellation_secret(&order_cancel_key_hex, &order_commitment)
            .map_err(js_error)?;
    let ingress_request = TrustedOrderIngressRequest {
        order_submission: order_submission.clone(),
        padding: request.padding,
    };
    to_json(&BuildPrivateOrderSubmissionResponse {
        order_commitment,
        cancellation_secret,
        order_submission,
        ingress_request,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_build_strategy_parent(input_json: &str) -> Result<String, JsValue> {
    let request: BuildStrategyParentRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let order_cancel_key_hex = hex::encode(keys.order_cancellation_key);
    let parent_cancel_authority =
        renewal_cancel_authority_from_raw_key_hex(&order_cancel_key_hex).map_err(js_error)?;
    let parent_secret_commitment =
        renewal_parent_secret_commitment(&request.parent_authorization_secret).map_err(js_error)?;
    let parent_order_commitment =
        renewal_parent_commitment(&parent_secret_commitment, &parent_cancel_authority)
            .map_err(js_error)?;
    to_json(&BuildStrategyParentResponse {
        parent_authorization_secret: request.parent_authorization_secret,
        parent_secret_commitment,
        parent_cancel_authority,
        parent_order_commitment,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_build_renewal_parent_cancel_submission_plan(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: BuildRenewalParentCancelSubmissionPlanRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let order_cancel_key_hex = hex::encode(keys.order_cancellation_key);
    let renewal_cancel_auth_key =
        renewal_cancel_auth_key_felt_from_raw_key_hex(&order_cancel_key_hex);
    let plan = build_renewal_parent_cancel_submission_plan(RenewalParentCancelPlanRequest {
        chain_id: request.chain_id,
        auction_verifier_address: request.auction_verifier_address,
        parent_secret_commitment: request.parent_secret_commitment,
        parent_cancel_authority: request.parent_cancel_authority,
        renewal_cancel_auth_key,
        prior_renewal_entries: request.prior_renewal_entries,
    })
    .map_err(js_error)?;
    to_json(&plan)
}

#[wasm_bindgen]
pub fn zylith_wallet_scan_output_bundle(
    seed_hex: &str,
    bundle_json: &str,
) -> Result<String, JsValue> {
    scan_output_bundle(seed_hex, bundle_json, None)
}

#[wasm_bindgen]
pub fn zylith_wallet_scan_output_bundle_with_root(
    seed_hex: &str,
    bundle_json: &str,
    expected_output_note_root: &str,
) -> Result<String, JsValue> {
    scan_output_bundle(seed_hex, bundle_json, Some(expected_output_note_root))
}

fn scan_output_bundle(
    seed_hex: &str,
    bundle_json: &str,
    expected_output_note_root: Option<&str>,
) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let note_recognition_key_hex = hex::encode(keys.note_recognition_key);
    let note_owner_public_key =
        note_recognition_public_key_from_raw_key_hex(&note_recognition_key_hex)
            .map_err(js_error)?;
    let spend_authority =
        spend_authority_from_raw_key_hex(&hex::encode(keys.spend_auth_key)).map_err(js_error)?;
    let bundle: OutputCiphertextBundle = from_json(bundle_json)?;
    let mut notes = Vec::new();
    for (output_index, ciphertext) in bundle.ciphertexts.iter().enumerate() {
        let mut payload = decrypt_output_note_for_owner(&note_recognition_key_hex, ciphertext)
            .map_err(js_error)?;
        if payload.is_none()
            && let Some(record) = ciphertext.recovery.as_ref()
        {
            payload = decrypt_output_recovery_record(
                &spend_authority,
                &note_owner_public_key,
                &bundle.batch_id,
                output_index,
                record,
            )
            .map_err(js_error)?;
        }
        if let Some(payload) = payload {
            let note_commitment = payload.note.commitment().map_err(js_error)?;
            if payload.output_note.note_commitment != note_commitment {
                return Err(js_error("output-note payload commitment mismatch"));
            }
            if let Some(expected_root) = expected_output_note_root {
                verify_output_note_membership(
                    &payload.output_note,
                    &payload.output_proof,
                    expected_root,
                )
                .map_err(js_error)?;
            }
            notes.push(ScannedNote {
                batch_id: bundle.batch_id.clone(),
                note_commitment: note_commitment.0,
                note: payload.note,
                output_note: payload.output_note,
                output_proof: payload.output_proof,
            });
        }
    }
    to_json(&ScannedNoteList { notes })
}

#[wasm_bindgen]
pub fn zylith_wallet_create_recovery_snapshot(input_json: &str) -> Result<String, JsValue> {
    let request: CreateRecoverySnapshotRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let payload: serde_json::Value =
        serde_json::from_str(&request.payload_json).map_err(js_error)?;
    let artifact = create_recovery_artifact(
        &seed,
        RecoveryArtifactKind::Snapshot,
        request.sequence,
        request.created_at_unix_ms,
        &payload,
    )
    .map_err(js_error)?;
    to_json(&artifact)
}

#[wasm_bindgen]
pub fn zylith_wallet_decrypt_recovery_artifact(
    seed_hex: &str,
    artifact_json: &str,
) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let artifact: RecoveryArtifact = from_json(artifact_json)?;
    let payload = decrypt_recovery_artifact_payload(&seed, &artifact).map_err(js_error)?;
    serde_json::to_string(&payload).map_err(js_error)
}

#[wasm_bindgen]
pub fn zylith_wallet_decrypt_maker_attribution_artifact(
    seed_hex: &str,
    artifact_json: &str,
) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let note_recognition_key_hex = hex::encode(keys.note_recognition_key);
    let artifact: EncryptedMakerAttributionArtifact = from_json(artifact_json)?;
    let payload = decrypt_maker_attribution_artifact(&note_recognition_key_hex, &artifact)
        .map_err(js_error)?
        .ok_or_else(|| js_error("maker attribution artifact does not belong to this wallet"))?;
    to_json(&payload)
}

#[wasm_bindgen]
pub fn zylith_wallet_build_withdrawal_submission_plan(input_json: &str) -> Result<String, JsValue> {
    let request: BuildWithdrawalSubmissionPlanRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let withdraw_key_hex = hex::encode(keys.withdraw_auth_key);
    let withdraw_auth_key_felt = withdraw_auth_key_felt_from_raw_key_hex(&withdraw_key_hex);
    let plan = build_withdrawal_submission_plan(
        &request.note_commitment,
        &withdraw_auth_key_felt,
        &request.recipient,
        &request.shielded_asset_adapter_address,
        &request.chain_id,
    )
    .map_err(js_error)?;
    to_json(&plan)
}

#[wasm_bindgen]
pub fn zylith_wallet_build_settlement_output_withdrawal_submission_plan(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: BuildSettlementOutputWithdrawalSubmissionPlanRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let withdraw_key_hex = hex::encode(keys.withdraw_auth_key);
    let withdraw_auth_key_felt = withdraw_auth_key_felt_from_raw_key_hex(&withdraw_key_hex);
    let plan =
        build_settlement_output_withdrawal_submission_plan(SettlementOutputWithdrawalPlanRequest {
            batch_id: &request.batch_id,
            output_note: &request.output_note,
            output_proof: &request.output_proof,
            withdraw_auth_key_felt: &withdraw_auth_key_felt,
            recipient: &request.recipient,
            auction_verifier_address: &request.auction_verifier_address,
            shielded_asset_adapter_address: &request.shielded_asset_adapter_address,
            chain_id: &request.chain_id,
        })
        .map_err(js_error)?;
    to_json(&plan)
}

fn derive_public_config(seed_hex: &str) -> Result<WalletPublicConfig, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let spend_key_hex = hex::encode(keys.spend_auth_key);
    let note_key_hex = hex::encode(keys.note_recognition_key);
    let withdraw_key_hex = hex::encode(keys.withdraw_auth_key);
    Ok(WalletPublicConfig {
        account_id: derive_account_id(&seed),
        spend_authority: spend_authority_from_raw_key_hex(&spend_key_hex).map_err(js_error)?,
        note_recognition_public_key: note_recognition_public_key_from_raw_key_hex(&note_key_hex)
            .map_err(js_error)?,
        withdraw_authority: withdraw_authority_from_raw_key_hex(&withdraw_key_hex)
            .map_err(js_error)?,
    })
}

fn from_json<T: for<'de> Deserialize<'de>>(value: &str) -> Result<T, JsValue> {
    serde_json::from_str(value).map_err(js_error)
}

fn to_json<T: Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(js_error)
}

fn js_error(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}

mod u128_decimal {
    use serde::de::{self, Visitor};
    use serde::{Deserializer, Serializer};
    use std::fmt;

    pub fn serialize<S>(value: &u128, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u128, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(U128DecimalVisitor)
    }

    struct U128DecimalVisitor;

    impl<'de> Visitor<'de> for U128DecimalVisitor {
        type Value = u128;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a u128 decimal string or integer")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(value as u128)
        }

        fn visit_u128<E>(self, value: u128) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            Ok(value)
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            if value != value.trim() {
                return Err(E::custom(
                    "u128 string must not include surrounding whitespace",
                ));
            }
            if value.is_empty() {
                return Err(E::custom("empty u128 string"));
            }
            value
                .parse::<u128>()
                .map_err(|error| E::custom(format!("invalid u128: {error}")))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WalletPublicConfig {
    pub account_id: String,
    pub spend_authority: String,
    pub note_recognition_public_key: String,
    pub withdraw_authority: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildDepositSubmissionPlanRequest {
    pub seed_hex: String,
    pub asset_id: AssetId,
    #[serde(with = "u128_decimal")]
    pub amount: u128,
    pub deposit_nonce: u64,
    pub deposit_router_address: String,
    pub token_address: String,
    pub shielded_asset_adapter_address: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildPrivateOrderSubmissionRequest {
    pub seed_hex: String,
    pub registry: PrivateExecutionKeyRegistry,
    pub funding_note: Note,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub funding_notes: Vec<Note>,
    pub order: OrderIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct BuildPrivateOrderSubmissionResponse {
    pub order_commitment: OrderCommitment,
    pub cancellation_secret: String,
    pub order_submission: OrderSubmission,
    pub ingress_request: TrustedOrderIngressRequest,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildStrategyParentRequest {
    pub seed_hex: String,
    pub parent_authorization_secret: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct BuildStrategyParentResponse {
    pub parent_authorization_secret: String,
    pub parent_secret_commitment: String,
    pub parent_cancel_authority: String,
    pub parent_order_commitment: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildRenewalParentCancelSubmissionPlanRequest {
    pub seed_hex: String,
    pub chain_id: String,
    pub auction_verifier_address: String,
    pub parent_secret_commitment: String,
    pub parent_cancel_authority: String,
    #[serde(default)]
    pub prior_renewal_entries: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateRecoverySnapshotRequest {
    pub seed_hex: String,
    pub sequence: u64,
    pub created_at_unix_ms: u64,
    pub payload_json: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScannedNote {
    pub batch_id: BatchId,
    pub note_commitment: String,
    pub note: Note,
    pub output_note: OutputNoteRecord,
    pub output_proof: OutputNoteMerkleProof,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScannedNoteList {
    pub notes: Vec<ScannedNote>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildWithdrawalSubmissionPlanRequest {
    pub seed_hex: String,
    pub note_commitment: String,
    pub recipient: String,
    pub shielded_asset_adapter_address: String,
    pub chain_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildSettlementOutputWithdrawalSubmissionPlanRequest {
    pub seed_hex: String,
    pub batch_id: BatchId,
    pub output_note: OutputNoteRecord,
    pub output_proof: OutputNoteMerkleProof,
    pub recipient: String,
    pub auction_verifier_address: String,
    pub shielded_asset_adapter_address: String,
    pub chain_id: String,
}

#[allow(dead_code)]
fn _assert_wasm_return_types(
    _: DepositSubmissionPlan,
    _: WithdrawalSubmissionPlan,
    _: SettlementOutputWithdrawalSubmissionPlan,
    _: RenewalParentCancelSubmissionPlan,
    _: SpendAuthorization,
) {
}

#[cfg(test)]
mod tests {
    use super::{
        BuildPrivateOrderSubmissionRequest, derive_public_config,
        zylith_wallet_build_private_order_submission, zylith_wallet_build_strategy_parent,
        zylith_wallet_create_recovery_snapshot, zylith_wallet_decrypt_recovery_artifact,
        zylith_wallet_generate_mnemonic, zylith_wallet_mnemonic_to_seed_hex,
        zylith_wallet_recovery_auth_tag, zylith_wallet_scan_output_bundle,
        zylith_wallet_seed_hex_to_mnemonic,
    };
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use zylith_core::{
        AssetId, BatchId, Note, NoteCommitment, Nullifier, OrderIntent, OrderSide, OrderType,
        OutputCiphertextBundle, PairId, PrivateExecutionKeyPublicConfig,
        PrivateExecutionKeyRegistry, RecoverySeed, RelayMode, TimeInForce, derive_user_keys,
        encrypt_note_for_owner, note_recognition_public_key_from_raw_key_hex,
        spend_authority_from_raw_key_hex, withdraw_authority_from_raw_key_hex,
    };

    #[test]
    fn public_config_is_deterministic() {
        let seed = "11".repeat(32);
        let first = derive_public_config(&seed).expect("first");
        let second = derive_public_config(&seed).expect("second");

        assert_eq!(first, second);
        assert!(!first.account_id.is_empty());
    }

    #[test]
    fn scans_ecdh_output_bundle_for_seed_owned_notes() {
        let seed = RecoverySeed([3_u8; 32]);
        let keys = derive_user_keys(&seed);
        let owner_public_key =
            note_recognition_public_key_from_raw_key_hex(&hex::encode(keys.note_recognition_key))
                .expect("owner key");
        let note = Note {
            asset_id: AssetId("STRK".into()),
            amount: 7,
            owner_public_key: owner_public_key.clone(),
            spend_authority: spend_authority_from_raw_key_hex(&hex::encode(keys.spend_auth_key))
                .expect("spend authority"),
            withdraw_authority: withdraw_authority_from_raw_key_hex(&hex::encode(
                keys.withdraw_auth_key,
            ))
            .expect("withdraw authority"),
            blinding: "0x123".into(),
            nonce: 1,
            metadata_commitment: "0x456".into(),
        };
        let ciphertext =
            encrypt_note_for_owner("batch-1", 0, &note, &owner_public_key).expect("encrypt note");
        let bundle = OutputCiphertextBundle::from_ciphertexts(
            BatchId("batch-1".into()),
            "da",
            vec![ciphertext],
        )
        .expect("bundle");

        let scanned = zylith_wallet_scan_output_bundle(
            &seed.to_hex(),
            &serde_json::to_string(&bundle).unwrap(),
        )
        .expect("scan");
        let value: serde_json::Value = serde_json::from_str(&scanned).expect("json");

        assert_eq!(value["notes"].as_array().unwrap().len(), 1);
        assert_eq!(value["notes"][0]["note"]["asset_id"], "STRK");
    }

    #[test]
    fn recovery_snapshot_roundtrip_uses_seed_bound_auth() {
        let seed = RecoverySeed([4_u8; 32]);
        let auth_a = zylith_wallet_recovery_auth_tag(&seed.to_hex()).expect("auth tag");
        let auth_b = zylith_wallet_recovery_auth_tag(&seed.to_hex()).expect("auth tag");
        assert_eq!(auth_a, auth_b);

        let payload = serde_json::json!({
            "version": 1,
            "notes": [{"note_commitment": "0x1"}],
            "strategies": []
        });
        let artifact_json = zylith_wallet_create_recovery_snapshot(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "sequence": 7_u64,
                "created_at_unix_ms": 1_700_000_000_000_u64,
                "payload_json": payload.to_string()
            })
            .to_string(),
        )
        .expect("artifact");
        let recovered = zylith_wallet_decrypt_recovery_artifact(&seed.to_hex(), &artifact_json)
            .expect("recovered");
        let recovered_json: serde_json::Value = serde_json::from_str(&recovered).expect("json");
        assert_eq!(recovered_json["version"], 1);
        assert_eq!(recovered_json["notes"][0]["note_commitment"], "0x1");
    }

    #[test]
    fn recovery_mnemonic_roundtrip_uses_24_words() {
        let phrase = zylith_wallet_generate_mnemonic().expect("mnemonic");
        assert_eq!(phrase.split_whitespace().count(), 24);
        let seed = zylith_wallet_mnemonic_to_seed_hex(&phrase).expect("seed hex");
        let phrase_again = zylith_wallet_seed_hex_to_mnemonic(&seed).expect("mnemonic");
        assert_eq!(phrase, phrase_again);
    }

    #[test]
    fn builds_private_order_submission_from_seed_and_funding_note() {
        let seed = RecoverySeed([9_u8; 32]);
        let keys = derive_user_keys(&seed);
        let owner_public_key =
            note_recognition_public_key_from_raw_key_hex(&hex::encode(keys.note_recognition_key))
                .expect("owner key");
        let spend_authority = spend_authority_from_raw_key_hex(&hex::encode(keys.spend_auth_key))
            .expect("spend authority");
        let withdraw_authority =
            withdraw_authority_from_raw_key_hex(&hex::encode(keys.withdraw_auth_key))
                .expect("withdraw authority");
        let funding_note = Note {
            asset_id: AssetId("USDC".into()),
            amount: 1_000,
            owner_public_key,
            spend_authority,
            withdraw_authority,
            blinding: "0x234".into(),
            nonce: 1,
            metadata_commitment: "0x345".into(),
        };
        let request = BuildPrivateOrderSubmissionRequest {
            seed_hex: seed.to_hex(),
            registry: PrivateExecutionKeyRegistry {
                keys: vec![PrivateExecutionKeyPublicConfig {
                    key_id: "ingress-0".into(),
                    public_key: sample_p256_public_key(),
                }],
            },
            funding_note,
            funding_notes: vec![],
            order: OrderIntent {
                pair_id: PairId("STRK/USDC".into()),
                batch_id: BatchId("STRK-USDC-7".into()),
                side: OrderSide::Buy,
                order_type: OrderType::LimitBatch,
                relay_mode: RelayMode::SelfRelay,
                maker_curve: None,
                limit_price: 2,
                amount: 10,
                min_fill: 1,
                time_in_force: TimeInForce::CurrentBatchOnly,
                expiry_epoch: 7,
                order_nonce: 42,
                parent_order_commitment: "0x0".into(),
                parent_child_index: 0,
                parent_secret_commitment: "0x0".into(),
                parent_cancel_authority: "0x0".into(),
                parent_authorization_secret: "0x0".into(),
                funding_note_ref: NoteCommitment("0x0".into()),
                funding_nullifier: Nullifier("0x0".into()),
                recipient_owner_public_key: String::new(),
                recipient_spend_authority: "0x0".into(),
                recipient_withdraw_authority: "0x0".into(),
                recipient_residual_withdraw_authority: "0x0".into(),
                auditor_view_allowed: false,
            },
            padding: Some("0".repeat(64)),
        };

        let encoded =
            zylith_wallet_build_private_order_submission(&serde_json::to_string(&request).unwrap())
                .expect("build order");
        let value: serde_json::Value = serde_json::from_str(&encoded).expect("json");

        assert!(
            value["order_commitment"]
                .as_str()
                .unwrap()
                .starts_with("0x")
        );
        assert_eq!(
            value["ingress_request"]["order_submission"]["order_bundle"]["shares"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn builds_strategy_parent_material_from_seed_authority() {
        let seed = RecoverySeed([5_u8; 32]);
        let request = serde_json::json!({
            "seed_hex": seed.to_hex(),
            "parent_authorization_secret": "0x1234",
        });

        let first = zylith_wallet_build_strategy_parent(&request.to_string()).expect("first");
        let second = zylith_wallet_build_strategy_parent(&request.to_string()).expect("second");
        let value: serde_json::Value = serde_json::from_str(&first).expect("json");

        assert_eq!(first, second);
        assert_eq!(value["parent_authorization_secret"], "0x1234");
        assert!(
            value["parent_order_commitment"]
                .as_str()
                .unwrap()
                .starts_with("0x")
        );
        assert_ne!(value["parent_order_commitment"], "0x0");
    }

    fn sample_p256_public_key() -> String {
        let secret = p256::SecretKey::from_slice(&[7_u8; 32]).expect("secret");
        hex::encode(secret.public_key().to_encoded_point(false).as_bytes())
    }
}
