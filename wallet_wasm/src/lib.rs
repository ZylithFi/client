use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

const MAX_OUTPUT_RECOVERY_KEY_TAGS_PER_CALL: u32 = 4_096;
use zylith_core::hash::{normalize_felt_hex, tagged_field_hex};
use zylith_core::{
    AssetId, BatchId, DepositIntent, DepositSubmissionPlan, EncryptedLiquidityAttributionArtifact,
    LiquidityPositionBacking, LiquidityPositionCommitment, LiquidityPositionCurvePolicy,
    LiquidityPositionLifecycleAuthorization, LiquidityPositionOpenFunding,
    LiquidityPositionOracleGuard, LiquidityPositionRotationPolicy, LiquidityPositionState,
    LiquidityPositionStateUpdate, LiquidityPositionStatus, LiquidityPositionTransitionKind,
    LiquidityPositionTransitionWitness, Note, NoteConsolidationWitness, NullifierHistoryBatch,
    NullifierSparseUpdateWitness, OrderCommitment, OrderIngressClientTelemetry, OrderIntent,
    OrderSubmission, OutputCiphertextBundle, OutputNoteMerkleProof, OutputNoteRecord,
    OutputRecoveryRecord, PairId, PrivateExecutionKeyRegistry, PrivateLiquidityPosition,
    PrivateOrderPayload, RecoveryArtifact, RecoveryArtifactKind, RecoverySeed,
    RenewalParentCancelPlanRequest, RenewalParentCancelSubmissionPlan,
    SettlementOutputWithdrawalPlanRequest, SettlementOutputWithdrawalSubmissionPlan,
    SettlementOutputWithdrawalWitness, SpendAuthorization, Strk20ExitClaimMessage,
    TrustedLiquidityPositionIngressRequest, TrustedOrderIngressRequest,
    build_deposit_submission_plan, build_order_submission,
    build_renewal_parent_cancel_submission_plan,
    build_settlement_output_withdrawal_submission_plan, close_liquidity_position,
    create_recovery_artifact, decrypt_liquidity_attribution_artifact,
    decrypt_output_note_for_owner, decrypt_output_recovery_record,
    decrypt_recovery_artifact_payload, derive_account_id, derive_order_cancellation_secret,
    derive_recovery_auth_tag, derive_user_keys, encrypt_output_note_for_owner,
    funding_input_set_commitment, funding_nullifier_set_commitment,
    liquidity_position_lifecycle_id, liquidity_position_private_authority,
    liquidity_position_root_transition, liquidity_position_transition_commitment,
    note_consolidation_commitment, note_recognition_public_key_from_raw_key_hex,
    nullifier_from_note_secret, open_liquidity_position, output_note_merkle_proof,
    output_note_merkle_root, output_note_metadata_commitment,
    output_recovery_key_tag_for_spend_authority, reconfigure_liquidity_position,
    renewal_cancel_auth_key_felt_for_parent_from_raw_key_hex,
    renewal_cancel_authority_for_parent_from_raw_key_hex, renewal_parent_commitment,
    renewal_parent_secret_commitment, sign_liquidity_position_transition,
    sign_note_consolidation_authorization, sign_order_authorization,
    sign_renewal_relay_package_authorization, sign_settlement_output_withdrawal_witness,
    sign_strk20_exit_claim_authorization, spend_auth_key_felt_from_raw_key_hex,
    spend_authority_from_raw_key_hex, verify_liquidity_position_state_update,
    verify_liquidity_position_transition_witness, verify_output_note_membership,
    verify_renewal_relay_package_authorization, withdraw_auth_key_felt_from_raw_key_hex,
    withdraw_authority_from_raw_key_hex,
};

fn empty_order_ingress_telemetry() -> OrderIngressClientTelemetry {
    OrderIngressClientTelemetry {
        version: 1,
        client_build_ms: None,
        private_submission_delay_ms: None,
        client_elapsed_before_private_ingress_ms: None,
        private_ingress_roundtrip_ms: None,
        client_elapsed_before_coordinator_ms: None,
        batch_time_remaining_before_private_ingress_ms: None,
        batch_time_remaining_before_coordinator_ms: None,
        submission_safety_buffer_ms: None,
    }
}

fn secret_hex(bytes: &[u8]) -> Zeroizing<String> {
    Zeroizing::new(hex::encode(bytes))
}

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn zylith_wallet_generate_seed_hex() -> String {
    RecoverySeed::generate().to_hex()
}

#[wasm_bindgen]
pub fn zylith_wallet_derive_public_config(seed_hex: &str) -> Result<String, JsValue> {
    to_json(&derive_public_config(seed_hex)?)
}

#[wasm_bindgen]
pub fn zylith_wallet_recovery_auth_tag(seed_hex: &str) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let recovery_key_hex = secret_hex(&keys.recovery_key);
    Ok(derive_recovery_auth_tag(
        &derive_account_id(&seed),
        &recovery_key_hex,
    ))
}

#[wasm_bindgen]
pub fn zylith_wallet_build_deposit_submission_plan(input_json: &str) -> Result<String, JsValue> {
    let request: BuildDepositSubmissionPlanRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let owner_key_hex = secret_hex(&keys.note_recognition_key);
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
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
        &request.deposit_authority_address,
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
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let owner_key_hex = secret_hex(&keys.note_recognition_key);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
    let order_cancel_key_hex = secret_hex(&keys.order_cancellation_key);
    let spend_auth_key_felt = spend_auth_key_felt_from_raw_key_hex(&spend_key_hex);
    let spend_authority = spend_authority_from_raw_key_hex(&spend_key_hex).map_err(js_error)?;
    let owner_public_key =
        note_recognition_public_key_from_raw_key_hex(&owner_key_hex).map_err(js_error)?;
    let withdraw_authority =
        withdraw_authority_from_raw_key_hex(&withdraw_key_hex).map_err(js_error)?;
    if request.funding_notes.is_empty() {
        return Err(js_error("private order requires at least one funding note"));
    }
    let funding_notes = request.funding_notes.clone();
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
    validate_order_before_signing(&order).map_err(js_error)?;

    let order_commitment = order.commitment().map_err(js_error)?;
    let expected_output_metadata_commitment = output_note_metadata_commitment(
        &order.batch_id.0,
        &order_commitment,
        &order.funding_note_ref,
        &order.pair_id,
        &order.recipient_spend_authority,
        &order.recipient_withdraw_authority,
    )
    .map_err(js_error)?;
    let funding_authorization =
        sign_order_authorization(&spend_auth_key_felt, &order_commitment).map_err(js_error)?;
    let payload = PrivateOrderPayload {
        order,
        funding_note: funding_notes[0].clone(),
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
        renewal_package_id: None,
        renewal_package_commitment: None,
        renewal_relay_mode: None,
        renewal_slot_order_commitment: None,
        renewal_slot_pair: None,
        renewal_slot_batch_id: None,
        renewal_slot_epoch_id: None,
        ingress_telemetry: empty_order_ingress_telemetry(),
        padding: request.padding,
    };
    to_json(&BuildPrivateOrderSubmissionResponse {
        order_commitment,
        cancellation_secret,
        expected_output_metadata_commitment,
        funding_note_commitments: funding_commitments
            .into_iter()
            .map(|commitment| commitment.0)
            .collect(),
        order_submission,
        ingress_request,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_build_private_liquidity_position_open(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: BuildPrivateLiquidityPositionOpenRequest = from_json(input_json)?;
    if request.epoch_id == 0 {
        return Err(js_error("liquidity position epoch must be non-zero"));
    }
    if request.expiry_epoch <= request.epoch_id {
        return Err(js_error(
            "liquidity position expiry must be after its open epoch",
        ));
    }
    if request.funding_notes.is_empty() {
        return Err(js_error(
            "liquidity position open requires private funding notes",
        ));
    }

    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let account_id = derive_account_id(&seed);
    let owner_key_hex = secret_hex(&keys.note_recognition_key);
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
    let spend_auth_key_felt = spend_auth_key_felt_from_raw_key_hex(&spend_key_hex);
    let owner_authority =
        liquidity_position_private_authority(&spend_auth_key_felt).map_err(js_error)?;
    let owner_public_key =
        note_recognition_public_key_from_raw_key_hex(&owner_key_hex).map_err(js_error)?;
    let withdraw_authority =
        withdraw_authority_from_raw_key_hex(&withdraw_key_hex).map_err(js_error)?;

    let mut input_base = 0_u128;
    let mut input_quote = 0_u128;
    let mut funding_note_commitments = Vec::with_capacity(request.funding_notes.len());
    for note in &request.funding_notes {
        note.nullifier(&keys).map_err(js_error)?;
        if note.owner_public_key != owner_public_key {
            return Err(js_error(
                "liquidity position funding note owner does not match wallet",
            ));
        }
        if note.spend_authority != owner_authority {
            return Err(js_error(
                "liquidity position funding note spend authority does not match wallet",
            ));
        }
        let note_commitment = note.commitment().map_err(js_error)?;
        funding_note_commitments.push(note_commitment.0);
        if note.asset_id == request.base_asset_id {
            input_base = input_base
                .checked_add(note.amount)
                .ok_or_else(|| js_error("liquidity position base input total overflows"))?;
        } else if note.asset_id == request.quote_asset_id {
            input_quote = input_quote
                .checked_add(note.amount)
                .ok_or_else(|| js_error("liquidity position quote input total overflows"))?;
        } else {
            return Err(js_error(
                "liquidity position funding note asset is not in the pair",
            ));
        }
    }
    if input_base < request.base_reserve || input_quote < request.quote_reserve {
        return Err(js_error(
            "liquidity position funding notes do not cover requested reserves",
        ));
    }

    let position_id = tagged_field_hex(
        "zylith/liquidity-position-id-v1",
        &serde_json::json!({
            "account_id": account_id,
            "pair_id": request.pair_id.0,
            "batch_id": request.batch_id.0,
            "epoch_id": request.epoch_id,
            "position_nonce": request.position_nonce,
            "funding_note_commitments": funding_note_commitments,
        }),
    )
    .map_err(js_error)?;
    let position_blinding = tagged_field_hex(
        "zylith/liquidity-position-blinding-v1",
        &serde_json::json!({
            "spend_key": spend_auth_key_felt,
            "position_id": position_id,
            "position_nonce": request.position_nonce,
        }),
    )
    .map_err(js_error)?;
    let position_metadata_commitment = tagged_field_hex(
        "zylith/liquidity-position-metadata-v1",
        &serde_json::json!({
            "account_id": account_id,
            "pair_id": request.pair_id.0,
            "batch_id": request.batch_id.0,
            "epoch_id": request.epoch_id,
            "position_nonce": request.position_nonce,
        }),
    )
    .map_err(js_error)?;
    let position = PrivateLiquidityPosition {
        version: zylith_core::LIQUIDITY_POSITION_VERSION,
        position_id,
        backing: LiquidityPositionBacking::PrivateReserve,
        status: LiquidityPositionStatus::Active,
        pair_id: request.pair_id.clone(),
        base_asset_id: request.base_asset_id.clone(),
        quote_asset_id: request.quote_asset_id.clone(),
        owner_authority: owner_authority.clone(),
        base_reserve: request.base_reserve,
        quote_reserve: request.quote_reserve,
        price_lower_bound: request.price_lower_bound,
        price_upper_bound: request.price_upper_bound,
        max_fill_base_per_batch: request.max_fill_base_per_batch,
        curve_policy: request.curve_policy.clone(),
        oracle_guard: request.oracle_guard.clone(),
        rotation_policy: request.rotation_policy.clone(),
        opened_epoch: request.epoch_id,
        expiry_epoch: request.expiry_epoch,
        blinding: position_blinding,
        metadata_commitment: position_metadata_commitment,
    };
    let position_commitment = position.commitment().map_err(js_error)?;
    let transition = liquidity_position_root_transition(
        LiquidityPositionTransitionKind::Open,
        None,
        Some(&position),
    )
    .map_err(js_error)?;
    let authorization = sign_liquidity_position_transition(
        &spend_auth_key_felt,
        LiquidityPositionTransitionKind::Open,
        &position.position_id,
        None,
        Some(&position_commitment),
        request.epoch_id,
        0,
        0,
    )
    .map_err(js_error)?;
    let change_note_context = LiquidityPositionOpenChangeNoteContext {
        seed: &seed,
        request: &request,
        owner_public_key: &owner_public_key,
        spend_authority: &owner_authority,
        withdraw_authority: &withdraw_authority,
        position_id: &position.position_id,
    };
    let change_notes = build_liquidity_position_open_change_notes(
        &change_note_context,
        input_base - request.base_reserve,
        input_quote - request.quote_reserve,
    )?;
    let open_funding = LiquidityPositionOpenFunding {
        input_notes: request.funding_notes,
        change_notes: change_notes.clone(),
        authorization,
    };
    open_liquidity_position(&position, &open_funding).map_err(js_error)?;

    let prior_root = request
        .prior_liquidity_position_root
        .clone()
        .unwrap_or_else(|| "0x0".into());
    let state_update = match request.state_update {
        Some(update) => {
            let new_root =
                verify_liquidity_position_state_update(&prior_root, &update).map_err(js_error)?;
            if update.prior_commitment.is_some()
                || update.output_commitment.as_ref() != Some(&position_commitment)
                || update.position_id != position.position_id
            {
                return Err(js_error(
                    "liquidity position open state witness does not match the position",
                ));
            }
            if new_root == prior_root {
                return Err(js_error(
                    "liquidity position open state witness did not advance the root",
                ));
            }
            update
        }
        None => {
            if zylith_core::hash::normalize_felt_hex(&prior_root).map_err(js_error)? != "0x0" {
                return Err(js_error(
                    "liquidity position open requires a sparse state witness for non-empty roots",
                ));
            }
            let mut state = LiquidityPositionState::new();
            let (_empty_root, _new_root, update) = state.open(&position).map_err(js_error)?;
            update
        }
    };
    let transition_witness = LiquidityPositionTransitionWitness {
        transition,
        prior_position: None,
        output_position: Some(position.clone()),
        state_update,
        epoch: request.epoch_id,
        fill: None,
        open_funding: Some(open_funding),
        output_notes: Vec::new(),
        base_amount: 0,
        quote_amount: 0,
        lifecycle_authorization: None,
    };
    let transition_commitment =
        liquidity_position_transition_commitment(&transition_witness).map_err(js_error)?;
    let lifecycle_id = liquidity_position_lifecycle_id(
        &request.pair_id,
        &request.batch_id,
        request.epoch_id,
        &transition_commitment,
    )
    .map_err(js_error)?;
    let ingress_request = TrustedLiquidityPositionIngressRequest {
        pair_id: request.pair_id,
        batch_id: request.batch_id,
        epoch_id: request.epoch_id,
        transition_witness: transition_witness.clone(),
        ingress_telemetry: empty_order_ingress_telemetry(),
        padding: request.padding,
    };

    to_json(&BuildPrivateLiquidityPositionOpenResponse {
        lifecycle_id,
        position,
        position_commitment,
        transition_commitment,
        funding_note_commitments,
        change_notes,
        transition_witness,
        ingress_request,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_authorize_liquidity_position_open(
    input_json: &str,
) -> Result<String, JsValue> {
    authorize_liquidity_position_lifecycle(input_json, LiquidityPositionTransitionKind::Open)
}

struct LiquidityPositionOpenChangeNoteContext<'a> {
    seed: &'a RecoverySeed,
    request: &'a BuildPrivateLiquidityPositionOpenRequest,
    owner_public_key: &'a str,
    spend_authority: &'a str,
    withdraw_authority: &'a str,
    position_id: &'a str,
}

fn build_liquidity_position_open_change_notes(
    context: &LiquidityPositionOpenChangeNoteContext<'_>,
    base_change: u128,
    quote_change: u128,
) -> Result<Vec<Note>, JsValue> {
    let mut notes = Vec::new();
    if base_change > 0 {
        notes.push(liquidity_position_open_change_note(
            context.seed,
            context.request,
            &context.request.base_asset_id,
            base_change,
            context.owner_public_key,
            context.spend_authority,
            context.withdraw_authority,
            context.position_id,
            0,
        )?);
    }
    if quote_change > 0 {
        notes.push(liquidity_position_open_change_note(
            context.seed,
            context.request,
            &context.request.quote_asset_id,
            quote_change,
            context.owner_public_key,
            context.spend_authority,
            context.withdraw_authority,
            context.position_id,
            notes.len() as u64,
        )?);
    }
    Ok(notes)
}

fn derived_child_note_nonce(parent_nonce: u64, output_index: u64) -> u64 {
    let nonce = parent_nonce.wrapping_mul(10).wrapping_add(output_index + 1);
    if nonce == 0 { output_index + 1 } else { nonce }
}

#[allow(clippy::too_many_arguments)]
fn liquidity_position_open_change_note(
    seed: &RecoverySeed,
    request: &BuildPrivateLiquidityPositionOpenRequest,
    asset_id: &AssetId,
    amount: u128,
    owner_public_key: &str,
    spend_authority: &str,
    withdraw_authority: &str,
    position_id: &str,
    output_index: u64,
) -> Result<Note, JsValue> {
    let nonce = derived_child_note_nonce(request.position_nonce, output_index);
    let blinding = tagged_field_hex(
        "zylith/liquidity-position-open-change-blinding-v1",
        &serde_json::json!({
            "account_id": derive_account_id(seed),
            "position_id": position_id,
            "asset_id": asset_id.0,
            "amount": amount,
            "output_index": output_index,
            "position_nonce": request.position_nonce,
        }),
    )
    .map_err(js_error)?;
    let metadata_commitment = tagged_field_hex(
        "zylith/liquidity-position-open-change-metadata-v1",
        &serde_json::json!({
            "position_id": position_id,
            "asset_id": asset_id.0,
            "amount": amount,
            "output_index": output_index,
            "spend_authority": spend_authority,
            "withdraw_authority": withdraw_authority,
        }),
    )
    .map_err(js_error)?;
    Ok(Note {
        asset_id: asset_id.clone(),
        amount,
        owner_public_key: owner_public_key.into(),
        spend_authority: spend_authority.into(),
        withdraw_authority: withdraw_authority.into(),
        blinding,
        nonce,
        metadata_commitment,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_prepare_private_liquidity_position_reconfigure(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: PreparePrivateLiquidityPositionReconfigureRequest = from_json(input_json)?;
    let prepared = prepare_liquidity_position_reconfigure(&request)?;
    to_json(&prepared)
}

#[wasm_bindgen]
pub fn zylith_wallet_build_private_liquidity_position_reconfigure(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: BuildPrivateLiquidityPositionReconfigureRequest = from_json(input_json)?;
    let prepared = prepare_liquidity_position_reconfigure(&request.lifecycle)?;
    build_liquidity_position_lifecycle_response(
        LiquidityPositionTransitionKind::Reconfigure,
        &request.lifecycle.seed_hex,
        &request.lifecycle.pair_id,
        &request.lifecycle.batch_id,
        request.lifecycle.epoch_id,
        prepared.prior_position.clone(),
        prepared.output_position.clone(),
        Vec::new(),
        0,
        0,
        request.prior_liquidity_position_root,
        request.state_update,
        request.padding,
        prepared.lifecycle_authorization,
    )
}

#[wasm_bindgen]
pub fn zylith_wallet_prepare_private_liquidity_position_close(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: PreparePrivateLiquidityPositionCloseRequest = from_json(input_json)?;
    let prepared = prepare_liquidity_position_close(&request)?;
    to_json(&prepared)
}

#[wasm_bindgen]
pub fn zylith_wallet_build_private_liquidity_position_close(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: BuildPrivateLiquidityPositionCloseRequest = from_json(input_json)?;
    let prepared = prepare_liquidity_position_close(&request.lifecycle)?;
    build_liquidity_position_lifecycle_response(
        LiquidityPositionTransitionKind::Close,
        &request.lifecycle.seed_hex,
        &request.lifecycle.pair_id,
        &request.lifecycle.batch_id,
        request.lifecycle.epoch_id,
        prepared.prior_position.clone(),
        None,
        prepared.output_notes.clone(),
        0,
        0,
        request.prior_liquidity_position_root,
        request.state_update,
        request.padding,
        prepared.lifecycle_authorization,
    )
}

fn prepare_liquidity_position_reconfigure(
    request: &PreparePrivateLiquidityPositionReconfigureRequest,
) -> Result<PreparedPrivateLiquidityPositionLifecycleResponse, JsValue> {
    let material = wallet_liquidity_position_material(&request.seed_hex)?;
    validate_lifecycle_envelope(
        &request.pair_id,
        &request.batch_id,
        request.epoch_id,
        &request.prior_position,
        &material,
    )?;
    if request.expiry_epoch < request.epoch_id {
        return Err(js_error(
            "liquidity position reconfigure expiry must cover the lifecycle epoch",
        ));
    }
    let prior_commitment = request.prior_position.commitment().map_err(js_error)?;
    let mut output_position = request.prior_position.clone();
    output_position.price_lower_bound = request.price_lower_bound;
    output_position.price_upper_bound = request.price_upper_bound;
    output_position.max_fill_base_per_batch = request.max_fill_base_per_batch;
    output_position.curve_policy = request.curve_policy.clone();
    output_position.oracle_guard = request.oracle_guard.clone();
    output_position.rotation_policy = request.rotation_policy.clone();
    output_position.expiry_epoch = request.expiry_epoch;
    output_position.blinding = lifecycle_position_blinding(
        "reconfigure",
        &material.account_id,
        &request.batch_id,
        request.epoch_id,
        request.lifecycle_nonce,
        &request.prior_position,
        &prior_commitment,
    )?;
    output_position.metadata_commitment = lifecycle_position_metadata(
        "reconfigure",
        &material.account_id,
        &request.batch_id,
        request.epoch_id,
        request.lifecycle_nonce,
        &output_position,
    )?;
    let output_commitment = output_position.commitment().map_err(js_error)?;
    let authorization = sign_liquidity_position_transition(
        &material.spend_auth_key_felt,
        LiquidityPositionTransitionKind::Reconfigure,
        &request.prior_position.position_id,
        Some(&prior_commitment),
        Some(&output_commitment),
        request.epoch_id,
        0,
        0,
    )
    .map_err(js_error)?;
    reconfigure_liquidity_position(
        &request.prior_position,
        &output_position,
        request.epoch_id,
        &authorization,
    )
    .map_err(js_error)?;
    Ok(PreparedPrivateLiquidityPositionLifecycleResponse {
        kind: "reconfigure".into(),
        position_id: normalize_felt_hex(&request.prior_position.position_id).map_err(js_error)?,
        prior_position: request.prior_position.clone(),
        prior_position_commitment: prior_commitment,
        output_position: Some(output_position),
        output_position_commitment: Some(output_commitment),
        output_notes: Vec::new(),
        base_amount: 0,
        quote_amount: 0,
        lifecycle_authorization: authorization,
    })
}

fn prepare_liquidity_position_close(
    request: &PreparePrivateLiquidityPositionCloseRequest,
) -> Result<PreparedPrivateLiquidityPositionLifecycleResponse, JsValue> {
    let material = wallet_liquidity_position_material(&request.seed_hex)?;
    validate_lifecycle_envelope(
        &request.pair_id,
        &request.batch_id,
        request.epoch_id,
        &request.prior_position,
        &material,
    )?;
    let prior_commitment = request.prior_position.commitment().map_err(js_error)?;
    let base_amount = request.prior_position.base_reserve;
    let quote_amount = request.prior_position.quote_reserve;
    let output_notes = build_liquidity_position_lifecycle_output_notes(
        "close",
        &material,
        &request.batch_id,
        request.epoch_id,
        request.lifecycle_nonce,
        &request.prior_position,
        base_amount,
        quote_amount,
    )?;
    let authorization = sign_liquidity_position_transition(
        &material.spend_auth_key_felt,
        LiquidityPositionTransitionKind::Close,
        &request.prior_position.position_id,
        Some(&prior_commitment),
        None,
        request.epoch_id,
        base_amount,
        quote_amount,
    )
    .map_err(js_error)?;
    close_liquidity_position(
        &request.prior_position,
        request.epoch_id,
        output_notes.clone(),
        &authorization,
    )
    .map_err(js_error)?;
    Ok(PreparedPrivateLiquidityPositionLifecycleResponse {
        kind: "close".into(),
        position_id: normalize_felt_hex(&request.prior_position.position_id).map_err(js_error)?,
        prior_position: request.prior_position.clone(),
        prior_position_commitment: prior_commitment,
        output_position: None,
        output_position_commitment: None,
        output_notes,
        base_amount,
        quote_amount,
        lifecycle_authorization: authorization,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_liquidity_position_lifecycle_response(
    kind: LiquidityPositionTransitionKind,
    seed_hex: &str,
    pair_id: &PairId,
    batch_id: &BatchId,
    epoch_id: u64,
    prior_position: PrivateLiquidityPosition,
    output_position: Option<PrivateLiquidityPosition>,
    output_notes: Vec<Note>,
    witness_base_amount: u128,
    witness_quote_amount: u128,
    prior_liquidity_position_root: String,
    state_update: LiquidityPositionStateUpdate,
    padding: Option<String>,
    lifecycle_authorization: LiquidityPositionLifecycleAuthorization,
) -> Result<String, JsValue> {
    let material = wallet_liquidity_position_material(seed_hex)?;
    validate_lifecycle_envelope(pair_id, batch_id, epoch_id, &prior_position, &material)?;
    let transition =
        liquidity_position_root_transition(kind, Some(&prior_position), output_position.as_ref())
            .map_err(js_error)?;
    let prior_root = normalize_felt_hex(&prior_liquidity_position_root).map_err(js_error)?;
    let new_root =
        verify_liquidity_position_state_update(&prior_root, &state_update).map_err(js_error)?;
    if normalize_felt_hex(&state_update.position_id).map_err(js_error)?
        != normalize_felt_hex(&prior_position.position_id).map_err(js_error)?
        || state_update.prior_commitment != transition.consumed_position_commitment
        || state_update.output_commitment != transition.output_position_commitment
    {
        return Err(js_error(
            "liquidity position lifecycle state witness does not match the transition",
        ));
    }
    if new_root == prior_root {
        return Err(js_error(
            "liquidity position lifecycle state witness did not advance the root",
        ));
    }
    let transition_witness = LiquidityPositionTransitionWitness {
        transition,
        prior_position: Some(prior_position),
        output_position,
        state_update,
        epoch: epoch_id,
        fill: None,
        open_funding: None,
        output_notes,
        base_amount: witness_base_amount,
        quote_amount: witness_quote_amount,
        lifecycle_authorization: Some(lifecycle_authorization),
    };
    verify_liquidity_position_transition_witness(&prior_root, &transition_witness)
        .map_err(js_error)?;
    let transition_commitment =
        liquidity_position_transition_commitment(&transition_witness).map_err(js_error)?;
    let lifecycle_id =
        liquidity_position_lifecycle_id(pair_id, batch_id, epoch_id, &transition_commitment)
            .map_err(js_error)?;
    let ingress_request = TrustedLiquidityPositionIngressRequest {
        pair_id: pair_id.clone(),
        batch_id: batch_id.clone(),
        epoch_id,
        transition_witness: transition_witness.clone(),
        ingress_telemetry: empty_order_ingress_telemetry(),
        padding,
    };
    to_json(&BuildPrivateLiquidityPositionLifecycleResponse {
        lifecycle_id,
        position_id: normalize_felt_hex(
            &transition_witness
                .prior_position
                .as_ref()
                .expect("transition witness has prior position")
                .position_id,
        )
        .map_err(js_error)?,
        prior_position_commitment: transition_witness
            .transition
            .consumed_position_commitment
            .clone()
            .ok_or_else(|| js_error("liquidity position lifecycle is missing prior commitment"))?,
        output_position: transition_witness.output_position.clone(),
        output_position_commitment: transition_witness
            .transition
            .output_position_commitment
            .clone(),
        transition_commitment,
        output_notes: transition_witness.output_notes.clone(),
        transition_witness,
        ingress_request,
    })
}

struct WalletLiquidityPositionMaterial {
    account_id: String,
    owner_public_key: String,
    spend_authority: String,
    withdraw_authority: String,
    spend_auth_key_felt: String,
}

fn wallet_liquidity_position_material(
    seed_hex: &str,
) -> Result<WalletLiquidityPositionMaterial, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let owner_key_hex = secret_hex(&keys.note_recognition_key);
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
    let spend_auth_key_felt = spend_auth_key_felt_from_raw_key_hex(&spend_key_hex);
    let spend_authority =
        liquidity_position_private_authority(&spend_auth_key_felt).map_err(js_error)?;
    Ok(WalletLiquidityPositionMaterial {
        account_id: derive_account_id(&seed),
        owner_public_key: note_recognition_public_key_from_raw_key_hex(&owner_key_hex)
            .map_err(js_error)?,
        spend_authority,
        withdraw_authority: withdraw_authority_from_raw_key_hex(&withdraw_key_hex)
            .map_err(js_error)?,
        spend_auth_key_felt,
    })
}

fn validate_lifecycle_envelope(
    pair_id: &PairId,
    batch_id: &BatchId,
    epoch_id: u64,
    prior_position: &PrivateLiquidityPosition,
    material: &WalletLiquidityPositionMaterial,
) -> Result<(), JsValue> {
    if epoch_id == 0 {
        return Err(js_error(
            "liquidity position lifecycle epoch must be non-zero",
        ));
    }
    if batch_id.0.trim().is_empty() {
        return Err(js_error(
            "liquidity position lifecycle batch id is required",
        ));
    }
    if &prior_position.pair_id != pair_id {
        return Err(js_error(
            "liquidity position lifecycle pair does not match the prior position",
        ));
    }
    if epoch_id < prior_position.opened_epoch {
        return Err(js_error(
            "liquidity position lifecycle epoch is before the position opened",
        ));
    }
    if normalize_felt_hex(&prior_position.owner_authority).map_err(js_error)?
        != normalize_felt_hex(&material.spend_authority).map_err(js_error)?
    {
        return Err(js_error(
            "liquidity position lifecycle prior position is not owned by this wallet",
        ));
    }
    prior_position.validate().map_err(js_error)
}

fn lifecycle_position_blinding(
    kind: &str,
    account_id: &str,
    batch_id: &BatchId,
    epoch_id: u64,
    lifecycle_nonce: u64,
    prior_position: &PrivateLiquidityPosition,
    prior_commitment: &LiquidityPositionCommitment,
) -> Result<String, JsValue> {
    tagged_field_hex(
        "zylith/liquidity-position-lifecycle-blinding-v1",
        &serde_json::json!({
            "kind": kind,
            "account_id": account_id,
            "batch_id": batch_id.0,
            "epoch_id": epoch_id,
            "lifecycle_nonce": lifecycle_nonce,
            "position_id": &prior_position.position_id,
            "prior_commitment": prior_commitment.0,
        }),
    )
    .map_err(js_error)
}

fn lifecycle_position_metadata(
    kind: &str,
    account_id: &str,
    batch_id: &BatchId,
    epoch_id: u64,
    lifecycle_nonce: u64,
    output_position: &PrivateLiquidityPosition,
) -> Result<String, JsValue> {
    tagged_field_hex(
        "zylith/liquidity-position-lifecycle-metadata-v1",
        &serde_json::json!({
            "kind": kind,
            "account_id": account_id,
            "batch_id": batch_id.0,
            "epoch_id": epoch_id,
            "lifecycle_nonce": lifecycle_nonce,
            "position_id": &output_position.position_id,
            "price_lower_bound": output_position.price_lower_bound.to_string(),
            "price_upper_bound": output_position.price_upper_bound.to_string(),
            "max_fill_base_per_batch": output_position.max_fill_base_per_batch.to_string(),
            "expiry_epoch": output_position.expiry_epoch,
        }),
    )
    .map_err(js_error)
}

#[allow(clippy::too_many_arguments)]
fn build_liquidity_position_lifecycle_output_notes(
    kind: &str,
    material: &WalletLiquidityPositionMaterial,
    batch_id: &BatchId,
    epoch_id: u64,
    lifecycle_nonce: u64,
    position: &PrivateLiquidityPosition,
    base_amount: u128,
    quote_amount: u128,
) -> Result<Vec<Note>, JsValue> {
    let mut notes = Vec::new();
    if base_amount > 0 {
        notes.push(liquidity_position_lifecycle_output_note(
            kind,
            material,
            batch_id,
            epoch_id,
            lifecycle_nonce,
            position,
            &position.base_asset_id,
            base_amount,
            0,
        )?);
    }
    if quote_amount > 0 {
        notes.push(liquidity_position_lifecycle_output_note(
            kind,
            material,
            batch_id,
            epoch_id,
            lifecycle_nonce,
            position,
            &position.quote_asset_id,
            quote_amount,
            notes.len() as u64,
        )?);
    }
    Ok(notes)
}

#[allow(clippy::too_many_arguments)]
fn liquidity_position_lifecycle_output_note(
    kind: &str,
    material: &WalletLiquidityPositionMaterial,
    batch_id: &BatchId,
    epoch_id: u64,
    lifecycle_nonce: u64,
    position: &PrivateLiquidityPosition,
    asset_id: &AssetId,
    amount: u128,
    output_index: u64,
) -> Result<Note, JsValue> {
    let nonce = derived_child_note_nonce(lifecycle_nonce, output_index);
    let position_commitment = position.commitment().map_err(js_error)?;
    let blinding = tagged_field_hex(
        "zylith/liquidity-position-lifecycle-output-blinding-v1",
        &serde_json::json!({
            "kind": kind,
            "account_id": &material.account_id,
            "batch_id": batch_id.0,
            "epoch_id": epoch_id,
            "lifecycle_nonce": lifecycle_nonce,
            "position_id": &position.position_id,
            "position_commitment": position_commitment.0,
            "asset_id": asset_id.0,
            "amount": amount.to_string(),
            "output_index": output_index,
        }),
    )
    .map_err(js_error)?;
    let metadata_commitment = tagged_field_hex(
        "zylith/liquidity-position-lifecycle-output-metadata-v1",
        &serde_json::json!({
            "kind": kind,
            "position_id": &position.position_id,
            "asset_id": asset_id.0,
            "amount": amount.to_string(),
            "output_index": output_index,
            "spend_authority": &material.spend_authority,
            "withdraw_authority": &material.withdraw_authority,
        }),
    )
    .map_err(js_error)?;
    Ok(Note {
        asset_id: asset_id.clone(),
        amount,
        owner_public_key: material.owner_public_key.clone(),
        spend_authority: material.spend_authority.clone(),
        withdraw_authority: material.withdraw_authority.clone(),
        blinding,
        nonce,
        metadata_commitment,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_authorize_liquidity_position_reconfigure(
    input_json: &str,
) -> Result<String, JsValue> {
    authorize_liquidity_position_lifecycle(input_json, LiquidityPositionTransitionKind::Reconfigure)
}

#[wasm_bindgen]
pub fn zylith_wallet_authorize_liquidity_position_close(
    input_json: &str,
) -> Result<String, JsValue> {
    authorize_liquidity_position_lifecycle(input_json, LiquidityPositionTransitionKind::Close)
}

fn authorize_liquidity_position_lifecycle(
    input_json: &str,
    kind: LiquidityPositionTransitionKind,
) -> Result<String, JsValue> {
    let request: AuthorizeLiquidityPositionLifecycleRequest = from_json(input_json)?;
    validate_liquidity_position_lifecycle_request(&kind, &request)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let spend_auth_key_felt = spend_auth_key_felt_from_raw_key_hex(&spend_key_hex);
    let authorization = sign_liquidity_position_transition(
        &spend_auth_key_felt,
        kind,
        &request.position_id,
        request.prior_position_commitment.as_ref(),
        request.output_position_commitment.as_ref(),
        request.epoch,
        request.base_amount,
        request.quote_amount,
    )
    .map_err(js_error)?;
    to_json(&authorization)
}

fn validate_liquidity_position_lifecycle_request(
    kind: &LiquidityPositionTransitionKind,
    request: &AuthorizeLiquidityPositionLifecycleRequest,
) -> Result<(), JsValue> {
    let has_prior = request.prior_position_commitment.is_some();
    let has_output = request.output_position_commitment.is_some();
    let has_amount = request.base_amount > 0 || request.quote_amount > 0;
    match kind {
        LiquidityPositionTransitionKind::Open => {
            if has_prior || !has_output {
                return Err(js_error(
                    "liquidity position open requires only an output position commitment",
                ));
            }
            if has_amount {
                return Err(js_error(
                    "liquidity position open authorization amounts must be zero",
                ));
            }
        }
        LiquidityPositionTransitionKind::Reconfigure => {
            if !has_prior || !has_output {
                return Err(js_error(
                    "liquidity position reconfigure requires prior and output commitments",
                ));
            }
            if has_amount {
                return Err(js_error(
                    "liquidity position reconfigure authorization amounts must be zero",
                ));
            }
        }
        LiquidityPositionTransitionKind::Close => {
            if !has_prior || has_output {
                return Err(js_error(
                    "liquidity position close requires only a prior position commitment",
                ));
            }
        }
        LiquidityPositionTransitionKind::Update => {
            return Err(js_error(
                "liquidity position auction fills are protocol-derived and are not wallet lifecycle actions",
            ));
        }
    }
    Ok(())
}

#[wasm_bindgen]
pub fn zylith_wallet_build_strategy_parent(input_json: &str) -> Result<String, JsValue> {
    let request: BuildStrategyParentRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let order_cancel_key_hex = secret_hex(&keys.order_cancellation_key);
    let parent_secret_commitment =
        renewal_parent_secret_commitment(&request.parent_authorization_secret).map_err(js_error)?;
    let parent_cancel_authority = renewal_cancel_authority_for_parent_from_raw_key_hex(
        &order_cancel_key_hex,
        &parent_secret_commitment,
    )
    .map_err(js_error)?;
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
    let order_cancel_key_hex = secret_hex(&keys.order_cancellation_key);
    let renewal_cancel_auth_key = renewal_cancel_auth_key_felt_for_parent_from_raw_key_hex(
        &order_cancel_key_hex,
        &request.parent_secret_commitment,
    );
    let plan = build_renewal_parent_cancel_submission_plan(RenewalParentCancelPlanRequest {
        chain_id: request.chain_id,
        auction_verifier_address: request.auction_verifier_address,
        parent_secret_commitment: request.parent_secret_commitment,
        parent_cancel_authority: request.parent_cancel_authority,
        renewal_cancel_auth_key,
        prior_renewal_entries: request.prior_renewal_entries,
        renewal_cancel_sparse_witness: request.renewal_cancel_sparse_witness,
    })
    .map_err(js_error)?;
    to_json(&plan)
}

#[wasm_bindgen]
pub fn zylith_wallet_sign_renewal_relay_package_authorization(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: BuildRenewalRelayPackageAuthorizationRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let order_cancel_key_hex = secret_hex(&keys.order_cancellation_key);
    let parent_cancel_authority = renewal_cancel_authority_for_parent_from_raw_key_hex(
        &order_cancel_key_hex,
        &request.parent_secret_commitment,
    )
    .map_err(js_error)?;
    if parent_cancel_authority != request.parent_cancel_authority {
        return Err(js_error("relay package authority does not match wallet"));
    }
    let renewal_cancel_auth_key = renewal_cancel_auth_key_felt_for_parent_from_raw_key_hex(
        &order_cancel_key_hex,
        &request.parent_secret_commitment,
    );
    let authorization = sign_renewal_relay_package_authorization(
        &renewal_cancel_auth_key,
        &request.package_commitment,
        &parent_cancel_authority,
    )
    .map_err(js_error)?;
    to_json(&BuildRenewalRelayPackageAuthorizationResponse {
        signer_public_key: parent_cancel_authority,
        signature_r: authorization.signature_r,
        signature_s: authorization.signature_s,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_verify_renewal_relay_package(package_json: &str) -> Result<String, JsValue> {
    let package: serde_json::Value = from_json(package_json)?;
    verify_renewal_relay_package_value(&package).map_err(js_error)?;
    Ok("{\"verified\":true}".into())
}

fn verify_renewal_relay_package_value(package: &serde_json::Value) -> Result<(), String> {
    let package_commitment = package
        .get("package_commitment")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "renewal package commitment is missing".to_string())?;
    let parent_cancel_authority = package
        .get("parent_cancel_authority")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "renewal package cancellation authority is missing".to_string())?;
    let authorization = package
        .get("relay_authorization")
        .cloned()
        .ok_or_else(|| "renewal package authorization is missing".to_string())?;
    let authorization: BuildRenewalRelayPackageAuthorizationResponse =
        serde_json::from_value(authorization).map_err(|error| error.to_string())?;
    if authorization.signer_public_key != parent_cancel_authority {
        return Err("renewal package authorization signer mismatch".into());
    }
    let expected_commitment = renewal_package_commitment_from_json(package)?;
    if package_commitment.trim().to_ascii_lowercase() != expected_commitment {
        return Err("renewal package commitment does not match package body".into());
    }
    let verified = verify_renewal_relay_package_authorization(
        parent_cancel_authority,
        package_commitment,
        &SpendAuthorization {
            signature_r: authorization.signature_r,
            signature_s: authorization.signature_s,
        },
    )
    .map_err(|error| error.to_string())?;
    if !verified {
        return Err("renewal package authorization signature is invalid".into());
    }
    Ok(())
}

#[wasm_bindgen]
pub fn zylith_wallet_build_note_consolidation_draft(input_json: &str) -> Result<String, JsValue> {
    let request: BuildNoteConsolidationDraftRequest = from_json(input_json)?;
    if request.input_notes.is_empty() {
        return Err(js_error("note consolidation requires input notes"));
    }
    if request.target_amounts.is_empty() {
        return Err(js_error("note consolidation requires target amounts"));
    }
    let target_amounts = request
        .target_amounts
        .iter()
        .map(|amount| {
            amount
                .parse::<u128>()
                .map_err(|error| js_error(format!("invalid target amount: {error}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let owner_key_hex = secret_hex(&keys.note_recognition_key);
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
    let owner_public_key =
        note_recognition_public_key_from_raw_key_hex(&owner_key_hex).map_err(js_error)?;
    let spend_authority = spend_authority_from_raw_key_hex(&spend_key_hex).map_err(js_error)?;
    let withdraw_authority =
        withdraw_authority_from_raw_key_hex(&withdraw_key_hex).map_err(js_error)?;
    let asset_id = request.input_notes[0].asset_id.clone();
    let input_commitments = request
        .input_notes
        .iter()
        .map(|note| {
            if note.asset_id != asset_id {
                return Err(js_error("note consolidation inputs must share an asset"));
            }
            if note.spend_authority != spend_authority {
                return Err(js_error(
                    "note consolidation inputs must be owned by this wallet",
                ));
            }
            note.commitment()
                .map(|commitment| commitment.0)
                .map_err(js_error)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let input_total = request.input_notes.iter().try_fold(0_u128, |total, note| {
        total
            .checked_add(note.amount)
            .ok_or_else(|| js_error("note consolidation input total overflows"))
    })?;
    let output_total = target_amounts.iter().try_fold(0_u128, |total, amount| {
        if *amount == 0 {
            return Err(js_error(
                "note consolidation target amount must be non-zero",
            ));
        }
        total
            .checked_add(*amount)
            .ok_or_else(|| js_error("note consolidation target total overflows"))
    })?;
    if input_total != output_total {
        return Err(js_error(
            "note consolidation input and target totals must match",
        ));
    }

    let mut output_note_preimages = Vec::with_capacity(request.target_amounts.len());
    let mut output_notes = Vec::with_capacity(request.target_amounts.len());
    for (output_index, amount) in target_amounts.iter().enumerate() {
        let blinding = tagged_field_hex(
            "zylith/consolidation-output-blinding",
            &serde_json::json!({
                "account_id": derive_account_id(&seed),
                "consolidation_id": request.consolidation_id.0,
                "input_commitments": input_commitments,
                "output_index": output_index,
                "amount": amount,
            }),
        )
        .map_err(js_error)?;
        let metadata_commitment = tagged_field_hex(
            "zylith/consolidation-output-metadata",
            &serde_json::json!({
                "consolidation_id": request.consolidation_id.0,
                "output_index": output_index,
                "asset_id": asset_id.0,
                "amount": amount,
                "spend_authority": spend_authority,
                "withdraw_authority": withdraw_authority,
            }),
        )
        .map_err(js_error)?;
        let note = Note {
            asset_id: asset_id.clone(),
            amount: *amount,
            owner_public_key: owner_public_key.clone(),
            spend_authority: spend_authority.clone(),
            withdraw_authority: withdraw_authority.clone(),
            blinding,
            nonce: (output_index as u64).saturating_add(1),
            metadata_commitment,
        };
        let output_note = OutputNoteRecord {
            note_commitment: note.commitment().map_err(js_error)?,
            asset_id: asset_id.clone(),
            amount: *amount,
            withdraw_authority: withdraw_authority.clone(),
        };
        output_note_preimages.push(note);
        output_notes.push(output_note);
    }

    let mut ciphertexts = Vec::with_capacity(output_notes.len());
    let mut outputs = Vec::with_capacity(output_notes.len());
    for (output_index, (note, output_note)) in output_note_preimages
        .iter()
        .zip(output_notes.iter())
        .enumerate()
    {
        let proof = output_note_merkle_proof(&output_notes, &output_note.note_commitment)
            .map_err(js_error)?;
        ciphertexts.push(
            encrypt_output_note_for_owner(
                &request.consolidation_id.0,
                output_index,
                note,
                output_note,
                &proof,
                &owner_public_key,
            )
            .map_err(js_error)?,
        );
        outputs.push(ScannedNote {
            batch_id: request.consolidation_id.clone(),
            note_commitment: output_note.note_commitment.0.clone(),
            note: note.clone(),
            output_note: output_note.clone(),
            output_proof: proof,
        });
    }

    let output_bundle = OutputCiphertextBundle::from_ciphertexts(
        request.consolidation_id.clone(),
        format!(
            "zylith-consolidation://{}/output-bundle",
            request.consolidation_id.0
        ),
        ciphertexts,
    )
    .map_err(js_error)?;
    let output_note_root = output_note_merkle_root(&output_notes, &output_bundle.bundle_commitment)
        .map_err(js_error)?;
    let output_recovery_records = output_bundle
        .ciphertexts
        .iter()
        .take(output_notes.len())
        .map(|ciphertext| {
            ciphertext
                .recovery
                .clone()
                .ok_or_else(|| js_error("note consolidation output missing recovery record"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let output_recovery_dummy_commitments = output_bundle
        .ciphertexts
        .iter()
        .skip(output_notes.len())
        .map(|ciphertext| {
            ciphertext
                .recovery
                .as_ref()
                .map(|recovery| recovery.commitment.clone())
                .ok_or_else(|| js_error("note consolidation dummy output missing recovery record"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    to_json(&BuildNoteConsolidationDraftResponse {
        consolidation_id: request.consolidation_id,
        input_notes: request.input_notes,
        output_notes,
        output_note_preimages,
        output_recovery_records,
        output_recovery_dummy_commitments,
        output_note_root,
        output_ciphertext_bundle_ref: output_bundle.bundle_commitment.clone(),
        output_bundle,
        outputs,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_sign_note_consolidation_witness(input_json: &str) -> Result<String, JsValue> {
    let request: SignNoteConsolidationWitnessRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let spend_key_felt = spend_auth_key_felt_from_raw_key_hex(&spend_key_hex);
    let spend_authority = spend_authority_from_raw_key_hex(&spend_key_hex).map_err(js_error)?;
    let mut witness = request.witness;
    validate_note_consolidation_witness_intent(
        &witness,
        &request.expected_draft,
        &spend_authority,
    )?;
    let consolidation_commitment = note_consolidation_commitment(&witness).map_err(js_error)?;
    witness.spend_authorization =
        sign_note_consolidation_authorization(&spend_key_felt, &consolidation_commitment)
            .map_err(js_error)?;
    to_json(&witness)
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

#[wasm_bindgen]
pub fn zylith_wallet_output_recovery_key_tags(
    seed_hex: &str,
    batch_id: &str,
    max_output_count: u32,
) -> Result<String, JsValue> {
    zylith_wallet_output_recovery_key_tags_range(seed_hex, batch_id, 0, max_output_count)
}

#[wasm_bindgen]
pub fn zylith_wallet_output_recovery_key_tags_range(
    seed_hex: &str,
    batch_id: &str,
    start_output_index: u32,
    output_count: u32,
) -> Result<String, JsValue> {
    if output_count > MAX_OUTPUT_RECOVERY_KEY_TAGS_PER_CALL {
        return Err(js_error("too many output recovery key tags requested"));
    }
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let spend_authority = spend_authority_from_raw_key_hex(&spend_key_hex).map_err(js_error)?;
    let start = start_output_index as usize;
    let count = output_count as usize;
    let key_tags = (start..start + count)
        .map(|output_index| {
            output_recovery_key_tag_for_spend_authority(&spend_authority, batch_id, output_index)
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(js_error)?;
    to_json(&OutputRecoveryKeyTagList { key_tags })
}

#[wasm_bindgen]
pub fn zylith_wallet_decrypt_output_recovery_record(
    seed_hex: &str,
    batch_id: &str,
    output_index: u32,
    record_json: &str,
    expected_output_note_root: &str,
) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let note_recognition_key_hex = secret_hex(&keys.note_recognition_key);
    let note_owner_public_key =
        note_recognition_public_key_from_raw_key_hex(&note_recognition_key_hex)
            .map_err(js_error)?;
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let spend_authority = spend_authority_from_raw_key_hex(&spend_key_hex).map_err(js_error)?;
    let record: OutputRecoveryRecord = from_json(record_json)?;
    let payload = decrypt_output_recovery_record(
        &spend_authority,
        &note_owner_public_key,
        &BatchId(batch_id.into()),
        output_index as usize,
        &record,
    )
    .map_err(js_error)?
    .ok_or_else(|| js_error("output recovery record does not belong to this wallet"))?;
    if !expected_output_note_root.trim().is_empty() {
        verify_output_note_membership(
            &payload.output_note,
            &payload.output_proof,
            expected_output_note_root,
        )
        .map_err(js_error)?;
    }
    to_json(&payload)
}

fn scan_output_bundle(
    seed_hex: &str,
    bundle_json: &str,
    expected_output_note_root: Option<&str>,
) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let note_recognition_key_hex = secret_hex(&keys.note_recognition_key);
    let note_owner_public_key =
        note_recognition_public_key_from_raw_key_hex(&note_recognition_key_hex)
            .map_err(js_error)?;
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let spend_authority = spend_authority_from_raw_key_hex(&spend_key_hex).map_err(js_error)?;
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
pub fn zylith_wallet_decrypt_liquidity_attribution_artifact(
    seed_hex: &str,
    artifact_json: &str,
) -> Result<String, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let note_recognition_key_hex = secret_hex(&keys.note_recognition_key);
    let artifact: EncryptedLiquidityAttributionArtifact = from_json(artifact_json)?;
    let payload = decrypt_liquidity_attribution_artifact(&note_recognition_key_hex, &artifact)
        .map_err(js_error)?
        .ok_or_else(|| js_error("liquidity attribution artifact does not belong to this wallet"))?;
    to_json(&payload)
}

#[wasm_bindgen]
pub fn zylith_wallet_build_settlement_output_withdrawal_submission_plan(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: BuildSettlementOutputWithdrawalSubmissionPlanRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
    let withdraw_auth_key_felt = withdraw_auth_key_felt_from_raw_key_hex(&withdraw_key_hex);
    let plan =
        build_settlement_output_withdrawal_submission_plan(SettlementOutputWithdrawalPlanRequest {
            batch_id: &request.batch_id,
            output_note: &request.output_note,
            output_note_preimage: &request.output_note_preimage,
            output_proof: &request.output_proof,
            prior_nullifier_root: &request.prior_nullifier_root,
            nullifier_history: &request.nullifier_history,
            nullifier_sparse_witness: request.nullifier_sparse_witness.as_ref(),
            new_nullifier_root: &request.new_nullifier_root,
            proof_artifact_commitment: &request.proof_artifact_commitment,
            withdraw_auth_key_felt: &withdraw_auth_key_felt,
            strk20_exit_commitment: &request.strk20_exit_commitment,
            auction_verifier_address: &request.auction_verifier_address,
            shielded_asset_adapter_address: &request.shielded_asset_adapter_address,
            chain_id: &request.chain_id,
        })
        .map_err(js_error)?;
    to_json(&plan)
}

#[wasm_bindgen]
pub fn zylith_wallet_sign_settlement_output_withdrawal_witness(
    input_json: &str,
) -> Result<String, JsValue> {
    let request: SignSettlementOutputWithdrawalWitnessRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
    let withdraw_auth_key_felt = withdraw_auth_key_felt_from_raw_key_hex(&withdraw_key_hex);
    let withdraw_authority =
        withdraw_authority_from_raw_key_hex(&withdraw_key_hex).map_err(js_error)?;
    let mut witness = request.witness;
    validate_settlement_output_withdrawal_witness_intent(
        &witness,
        &request.expected,
        &withdraw_authority,
    )?;
    witness.withdraw_authorization =
        sign_settlement_output_withdrawal_witness(&withdraw_auth_key_felt, &witness)
            .map_err(js_error)?;
    to_json(&witness)
}

#[wasm_bindgen]
pub fn zylith_wallet_sign_strk20_exit_claim(input_json: &str) -> Result<String, JsValue> {
    let request: SignStrk20ExitClaimRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
    let withdraw_auth_key_felt = withdraw_auth_key_felt_from_raw_key_hex(&withdraw_key_hex);
    let signed = sign_strk20_exit_claim_authorization(
        &withdraw_auth_key_felt,
        Strk20ExitClaimMessage {
            chain_id: &request.chain_id,
            bridge_address: &request.bridge_address,
            privacy_pool_address: &request.privacy_pool_address,
            auction_verifier_address: &request.auction_verifier_address,
            asset_id: &request.asset_id,
            token_address: &request.token_address,
            amount: &request.amount,
            exit_commitment: &request.exit_commitment,
            open_note_id: &request.open_note_id,
        },
    )
    .map_err(js_error)?;
    to_json(&signed)
}

fn validate_note_consolidation_witness_intent(
    witness: &NoteConsolidationWitness,
    expected: &BuildNoteConsolidationDraftResponse,
    wallet_spend_authority: &str,
) -> Result<(), JsValue> {
    ensure_eq(
        &witness.consolidation_id.0,
        &expected.consolidation_id.0,
        "note consolidation witness changed consolidation id",
    )?;
    ensure_note_list_matches(
        &witness.input_notes,
        &expected.input_notes,
        "note consolidation witness changed input notes",
    )?;
    ensure_output_list_matches(
        &witness.output_notes,
        &expected.output_notes,
        "note consolidation witness changed output notes",
    )?;
    ensure_note_list_matches(
        &witness.output_note_preimages,
        &expected.output_note_preimages,
        "note consolidation witness changed output note preimages",
    )?;
    ensure_json_eq(
        &witness.output_recovery_records,
        &expected.output_recovery_records,
        "note consolidation witness changed recovery records",
    )?;
    ensure_eq(
        &witness.output_recovery_dummy_commitments,
        &expected.output_recovery_dummy_commitments,
        "note consolidation witness changed recovery padding",
    )?;
    ensure_normalized_eq(
        &witness.output_ciphertext_bundle_ref,
        &expected.output_ciphertext_bundle_ref,
        "note consolidation witness changed output bundle reference",
    )?;
    let output_root =
        output_note_merkle_root(&witness.output_notes, &witness.output_ciphertext_bundle_ref)
            .map_err(js_error)?;
    ensure_normalized_eq(
        &output_root,
        &expected.output_note_root,
        "note consolidation witness changed output note root",
    )?;
    let input_total = witness.input_notes.iter().try_fold(0_u128, |total, note| {
        if normalize_felt_hex(&note.spend_authority).map_err(js_error)?
            != normalize_felt_hex(wallet_spend_authority).map_err(js_error)?
        {
            return Err(js_error(
                "note consolidation witness input is not owned by this wallet",
            ));
        }
        total
            .checked_add(note.amount)
            .ok_or_else(|| js_error("note consolidation input total overflows"))
    })?;
    let output_total = witness
        .output_note_preimages
        .iter()
        .try_fold(0_u128, |total, note| {
            if normalize_felt_hex(&note.spend_authority).map_err(js_error)?
                != normalize_felt_hex(wallet_spend_authority).map_err(js_error)?
            {
                return Err(js_error(
                    "note consolidation witness output is not owned by this wallet",
                ));
            }
            total
                .checked_add(note.amount)
                .ok_or_else(|| js_error("note consolidation output total overflows"))
        })?;
    if input_total != output_total {
        return Err(js_error(
            "note consolidation witness changed input/output value totals",
        ));
    }
    Ok(())
}

fn validate_settlement_output_withdrawal_witness_intent(
    witness: &SettlementOutputWithdrawalWitness,
    expected: &ExpectedSettlementOutputWithdrawalWitness,
    wallet_withdraw_authority: &str,
) -> Result<(), JsValue> {
    ensure_eq(
        &witness.batch_id.0,
        &expected.batch_id.0,
        "withdrawal witness changed batch id",
    )?;
    ensure_normalized_eq(
        &witness.auction_verifier_address,
        &expected.auction_verifier_address,
        "withdrawal witness changed verifier",
    )?;
    ensure_normalized_eq(
        &witness.shielded_asset_adapter_address,
        &expected.shielded_asset_adapter_address,
        "withdrawal witness changed shielded adapter",
    )?;
    ensure_normalized_eq(
        &witness.chain_id,
        &expected.chain_id,
        "withdrawal witness changed chain id",
    )?;
    ensure_normalized_eq(
        &witness.strk20_exit_commitment,
        &expected.strk20_exit_commitment,
        "withdrawal witness changed STRK20 exit commitment",
    )?;
    ensure_output_matches(
        &witness.output_note,
        &expected.output_note,
        "withdrawal witness changed output note",
    )?;
    ensure_note_matches(
        &witness.output_note_preimage,
        &expected.output_note_preimage,
        "withdrawal witness changed output note preimage",
    )?;
    ensure_json_eq(
        &witness.output_proof,
        &expected.output_proof,
        "withdrawal witness changed output proof",
    )?;
    let commitment = witness
        .output_note_preimage
        .commitment()
        .map_err(js_error)?;
    if commitment != witness.output_note.note_commitment {
        return Err(js_error(
            "withdrawal witness note preimage does not match output note commitment",
        ));
    }
    ensure_normalized_eq(
        &witness.output_note.withdraw_authority,
        wallet_withdraw_authority,
        "withdrawal witness output note is not withdrawable by this wallet",
    )?;
    ensure_normalized_eq(
        &witness.output_note_preimage.withdraw_authority,
        wallet_withdraw_authority,
        "withdrawal witness note preimage is not withdrawable by this wallet",
    )?;
    Ok(())
}

fn ensure_eq<T: PartialEq + std::fmt::Debug>(
    actual: &T,
    expected: &T,
    message: &str,
) -> Result<(), JsValue> {
    if actual == expected {
        Ok(())
    } else {
        Err(js_error(message))
    }
}

fn ensure_normalized_eq(actual: &str, expected: &str, message: &str) -> Result<(), JsValue> {
    if normalize_felt_hex(actual).map_err(js_error)?
        == normalize_felt_hex(expected).map_err(js_error)?
    {
        Ok(())
    } else {
        Err(js_error(message))
    }
}

fn ensure_json_eq<T: Serialize>(actual: &T, expected: &T, message: &str) -> Result<(), JsValue> {
    let actual = serde_json::to_value(actual).map_err(js_error)?;
    let expected = serde_json::to_value(expected).map_err(js_error)?;
    if actual == expected {
        Ok(())
    } else {
        Err(js_error(message))
    }
}

fn ensure_note_list_matches(
    actual: &[Note],
    expected: &[Note],
    message: &str,
) -> Result<(), JsValue> {
    if actual.len() != expected.len() {
        return Err(js_error(message));
    }
    for (actual_note, expected_note) in actual.iter().zip(expected.iter()) {
        ensure_note_matches(actual_note, expected_note, message)?;
    }
    Ok(())
}

fn ensure_output_list_matches(
    actual: &[OutputNoteRecord],
    expected: &[OutputNoteRecord],
    message: &str,
) -> Result<(), JsValue> {
    if actual.len() != expected.len() {
        return Err(js_error(message));
    }
    for (actual_output, expected_output) in actual.iter().zip(expected.iter()) {
        ensure_output_matches(actual_output, expected_output, message)?;
    }
    Ok(())
}

fn ensure_note_matches(actual: &Note, expected: &Note, message: &str) -> Result<(), JsValue> {
    if actual.asset_id != expected.asset_id
        || actual.amount != expected.amount
        || actual.nonce != expected.nonce
    {
        return Err(js_error(message));
    }
    ensure_eq(
        &actual.owner_public_key,
        &expected.owner_public_key,
        message,
    )?;
    ensure_normalized_eq(&actual.spend_authority, &expected.spend_authority, message)?;
    ensure_normalized_eq(
        &actual.withdraw_authority,
        &expected.withdraw_authority,
        message,
    )?;
    ensure_normalized_eq(&actual.blinding, &expected.blinding, message)?;
    ensure_normalized_eq(
        &actual.metadata_commitment,
        &expected.metadata_commitment,
        message,
    )?;
    ensure_normalized_eq(
        &actual.commitment().map_err(js_error)?.0,
        &expected.commitment().map_err(js_error)?.0,
        message,
    )
}

fn ensure_output_matches(
    actual: &OutputNoteRecord,
    expected: &OutputNoteRecord,
    message: &str,
) -> Result<(), JsValue> {
    if actual.asset_id != expected.asset_id || actual.amount != expected.amount {
        return Err(js_error(message));
    }
    ensure_normalized_eq(
        &actual.note_commitment.0,
        &expected.note_commitment.0,
        message,
    )?;
    ensure_normalized_eq(
        &actual.withdraw_authority,
        &expected.withdraw_authority,
        message,
    )
}

fn derive_public_config(seed_hex: &str) -> Result<WalletPublicConfig, JsValue> {
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let spend_key_hex = secret_hex(&keys.spend_auth_key);
    let note_key_hex = secret_hex(&keys.note_recognition_key);
    let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
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
    #[cfg(not(target_arch = "wasm32"))]
    {
        let _ = error;
        JsValue::NULL
    }
    #[cfg(target_arch = "wasm32")]
    JsValue::from_str(&error.to_string())
}

fn validate_order_before_signing(order: &OrderIntent) -> Result<(), zylith_core::ProtocolError> {
    order.validate_relay_mode()
}

fn renewal_package_commitment_from_json(package: &serde_json::Value) -> Result<String, String> {
    let mut value = package.clone();
    let object = value
        .as_object_mut()
        .ok_or_else(|| "renewal package must be an object".to_string())?;
    object.remove("package_commitment");
    object.remove("relay_authorization");
    object.remove("access_token");
    let canonical = stable_json_string(&value)?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(format!("0x{}", hex::encode(digest)))
}

fn stable_json_string(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Null => Ok("null".into()),
        serde_json::Value::Bool(value) => Ok(if *value { "true" } else { "false" }.into()),
        serde_json::Value::Number(value) => Ok(value.to_string()),
        serde_json::Value::String(value) => {
            serde_json::to_string(value).map_err(|error| error.to_string())
        }
        serde_json::Value::Array(values) => {
            let mut out = String::from("[");
            for (index, entry) in values.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&stable_json_string(entry)?);
            }
            out.push(']');
            Ok(out)
        }
        serde_json::Value::Object(values) => {
            let mut sorted = values.iter().collect::<Vec<_>>();
            sorted.sort_by_key(|(key, _)| *key);
            let mut out = String::from("{");
            for (index, (key, entry)) in sorted.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).map_err(|error| error.to_string())?);
                out.push(':');
                out.push_str(&stable_json_string(entry)?);
            }
            out.push('}');
            Ok(out)
        }
    }
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

mod u64_decimal {
    use serde::de::{self, Visitor};
    use serde::{Deserializer, Serializer};
    use std::fmt;

    pub fn serialize<S>(value: &u64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<u64, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(U64DecimalVisitor)
    }

    struct U64DecimalVisitor;

    impl<'de> Visitor<'de> for U64DecimalVisitor {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a u64 decimal string or integer")
        }

        fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
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
                    "u64 string must not include surrounding whitespace",
                ));
            }
            if value.is_empty() {
                return Err(E::custom("empty u64 string"));
            }
            value
                .parse::<u64>()
                .map_err(|error| E::custom(format!("invalid u64: {error}")))
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalletPublicConfig {
    pub account_id: String,
    pub spend_authority: String,
    pub note_recognition_public_key: String,
    pub withdraw_authority: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildDepositSubmissionPlanRequest {
    pub seed_hex: String,
    pub asset_id: AssetId,
    #[serde(with = "u128_decimal")]
    pub amount: u128,
    #[serde(with = "u64_decimal")]
    pub deposit_nonce: u64,
    pub deposit_authority_address: String,
    pub token_address: String,
    pub shielded_asset_adapter_address: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildPrivateOrderSubmissionRequest {
    pub seed_hex: String,
    pub registry: PrivateExecutionKeyRegistry,
    pub funding_notes: Vec<Note>,
    pub order: OrderIntent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildPrivateLiquidityPositionOpenRequest {
    pub seed_hex: String,
    pub pair_id: PairId,
    pub batch_id: BatchId,
    #[serde(with = "u64_decimal")]
    pub epoch_id: u64,
    pub funding_notes: Vec<Note>,
    pub base_asset_id: AssetId,
    pub quote_asset_id: AssetId,
    #[serde(with = "u128_decimal")]
    pub base_reserve: u128,
    #[serde(with = "u128_decimal")]
    pub quote_reserve: u128,
    #[serde(with = "u128_decimal")]
    pub price_lower_bound: u128,
    #[serde(with = "u128_decimal")]
    pub price_upper_bound: u128,
    #[serde(with = "u128_decimal")]
    pub max_fill_base_per_batch: u128,
    pub curve_policy: LiquidityPositionCurvePolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oracle_guard: Option<LiquidityPositionOracleGuard>,
    pub rotation_policy: LiquidityPositionRotationPolicy,
    #[serde(with = "u64_decimal")]
    pub expiry_epoch: u64,
    #[serde(with = "u64_decimal")]
    pub position_nonce: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_liquidity_position_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_update: Option<LiquidityPositionStateUpdate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct BuildPrivateLiquidityPositionOpenResponse {
    pub lifecycle_id: String,
    pub position: PrivateLiquidityPosition,
    pub position_commitment: LiquidityPositionCommitment,
    pub transition_commitment: String,
    pub funding_note_commitments: Vec<String>,
    pub change_notes: Vec<Note>,
    pub transition_witness: LiquidityPositionTransitionWitness,
    pub ingress_request: TrustedLiquidityPositionIngressRequest,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparePrivateLiquidityPositionReconfigureRequest {
    pub seed_hex: String,
    pub pair_id: PairId,
    pub batch_id: BatchId,
    #[serde(with = "u64_decimal")]
    pub epoch_id: u64,
    pub prior_position: PrivateLiquidityPosition,
    #[serde(with = "u128_decimal")]
    pub price_lower_bound: u128,
    #[serde(with = "u128_decimal")]
    pub price_upper_bound: u128,
    #[serde(with = "u128_decimal")]
    pub max_fill_base_per_batch: u128,
    pub curve_policy: LiquidityPositionCurvePolicy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oracle_guard: Option<LiquidityPositionOracleGuard>,
    pub rotation_policy: LiquidityPositionRotationPolicy,
    #[serde(with = "u64_decimal")]
    pub expiry_epoch: u64,
    #[serde(with = "u64_decimal")]
    pub lifecycle_nonce: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildPrivateLiquidityPositionReconfigureRequest {
    #[serde(flatten)]
    pub lifecycle: PreparePrivateLiquidityPositionReconfigureRequest,
    pub prior_liquidity_position_root: String,
    pub state_update: LiquidityPositionStateUpdate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparePrivateLiquidityPositionCloseRequest {
    pub seed_hex: String,
    pub pair_id: PairId,
    pub batch_id: BatchId,
    #[serde(with = "u64_decimal")]
    pub epoch_id: u64,
    pub prior_position: PrivateLiquidityPosition,
    #[serde(with = "u64_decimal")]
    pub lifecycle_nonce: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildPrivateLiquidityPositionCloseRequest {
    #[serde(flatten)]
    pub lifecycle: PreparePrivateLiquidityPositionCloseRequest,
    pub prior_liquidity_position_root: String,
    pub state_update: LiquidityPositionStateUpdate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct PreparedPrivateLiquidityPositionLifecycleResponse {
    pub kind: String,
    pub position_id: String,
    pub prior_position: PrivateLiquidityPosition,
    pub prior_position_commitment: LiquidityPositionCommitment,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_position: Option<PrivateLiquidityPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_position_commitment: Option<LiquidityPositionCommitment>,
    pub output_notes: Vec<Note>,
    #[serde(with = "u128_decimal")]
    pub base_amount: u128,
    #[serde(with = "u128_decimal")]
    pub quote_amount: u128,
    pub lifecycle_authorization: LiquidityPositionLifecycleAuthorization,
}

#[derive(Clone, Serialize)]
pub struct BuildPrivateLiquidityPositionLifecycleResponse {
    pub lifecycle_id: String,
    pub position_id: String,
    pub prior_position_commitment: LiquidityPositionCommitment,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_position: Option<PrivateLiquidityPosition>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_position_commitment: Option<LiquidityPositionCommitment>,
    pub transition_commitment: String,
    pub output_notes: Vec<Note>,
    pub transition_witness: LiquidityPositionTransitionWitness,
    pub ingress_request: TrustedLiquidityPositionIngressRequest,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizeLiquidityPositionLifecycleRequest {
    pub seed_hex: String,
    pub position_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prior_position_commitment: Option<LiquidityPositionCommitment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_position_commitment: Option<LiquidityPositionCommitment>,
    #[serde(with = "u64_decimal")]
    pub epoch: u64,
    #[serde(with = "u128_decimal")]
    pub base_amount: u128,
    #[serde(with = "u128_decimal")]
    pub quote_amount: u128,
}

#[derive(Clone, Serialize)]
pub struct BuildPrivateOrderSubmissionResponse {
    pub order_commitment: OrderCommitment,
    pub cancellation_secret: String,
    pub expected_output_metadata_commitment: String,
    pub funding_note_commitments: Vec<String>,
    pub order_submission: OrderSubmission,
    pub ingress_request: TrustedOrderIngressRequest,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildStrategyParentRequest {
    pub seed_hex: String,
    pub parent_authorization_secret: String,
}

#[derive(Clone, Serialize)]
pub struct BuildStrategyParentResponse {
    pub parent_authorization_secret: String,
    pub parent_secret_commitment: String,
    pub parent_cancel_authority: String,
    pub parent_order_commitment: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildRenewalParentCancelSubmissionPlanRequest {
    pub seed_hex: String,
    pub chain_id: String,
    pub auction_verifier_address: String,
    pub parent_secret_commitment: String,
    pub parent_cancel_authority: String,
    pub prior_renewal_entries: Vec<String>,
    pub renewal_cancel_sparse_witness: Option<zylith_core::NullifierSparseUpdateWitness>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildRenewalRelayPackageAuthorizationRequest {
    pub seed_hex: String,
    pub package_commitment: String,
    pub parent_secret_commitment: String,
    pub parent_cancel_authority: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildRenewalRelayPackageAuthorizationResponse {
    pub signer_public_key: String,
    pub signature_r: String,
    pub signature_s: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildNoteConsolidationDraftRequest {
    pub seed_hex: String,
    pub consolidation_id: BatchId,
    pub input_notes: Vec<Note>,
    pub target_amounts: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildNoteConsolidationDraftResponse {
    pub consolidation_id: BatchId,
    pub input_notes: Vec<Note>,
    pub output_notes: Vec<OutputNoteRecord>,
    pub output_note_preimages: Vec<Note>,
    pub output_recovery_records: Vec<OutputRecoveryRecord>,
    pub output_recovery_dummy_commitments: Vec<String>,
    pub output_note_root: String,
    pub output_ciphertext_bundle_ref: String,
    pub output_bundle: OutputCiphertextBundle,
    pub outputs: Vec<ScannedNote>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignNoteConsolidationWitnessRequest {
    pub seed_hex: String,
    pub expected_draft: BuildNoteConsolidationDraftResponse,
    pub witness: NoteConsolidationWitness,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRecoverySnapshotRequest {
    pub seed_hex: String,
    pub sequence: u64,
    pub created_at_unix_ms: u64,
    pub payload_json: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScannedNote {
    pub batch_id: BatchId,
    pub note_commitment: String,
    pub note: Note,
    pub output_note: OutputNoteRecord,
    pub output_proof: OutputNoteMerkleProof,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScannedNoteList {
    pub notes: Vec<ScannedNote>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputRecoveryKeyTagList {
    pub key_tags: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildSettlementOutputWithdrawalSubmissionPlanRequest {
    pub seed_hex: String,
    pub batch_id: BatchId,
    pub output_note: OutputNoteRecord,
    pub output_note_preimage: Note,
    pub output_proof: OutputNoteMerkleProof,
    pub prior_nullifier_root: String,
    pub nullifier_history: Vec<NullifierHistoryBatch>,
    pub nullifier_sparse_witness: Option<NullifierSparseUpdateWitness>,
    pub new_nullifier_root: String,
    pub proof_artifact_commitment: String,
    pub strk20_exit_commitment: String,
    pub auction_verifier_address: String,
    pub shielded_asset_adapter_address: String,
    pub chain_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignSettlementOutputWithdrawalWitnessRequest {
    pub seed_hex: String,
    pub expected: ExpectedSettlementOutputWithdrawalWitness,
    pub witness: SettlementOutputWithdrawalWitness,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignStrk20ExitClaimRequest {
    pub seed_hex: String,
    pub chain_id: String,
    pub bridge_address: String,
    pub privacy_pool_address: String,
    pub auction_verifier_address: String,
    pub asset_id: String,
    pub token_address: String,
    pub amount: String,
    pub exit_commitment: String,
    pub open_note_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedSettlementOutputWithdrawalWitness {
    pub batch_id: BatchId,
    pub output_note: OutputNoteRecord,
    pub output_note_preimage: Note,
    pub output_proof: OutputNoteMerkleProof,
    pub strk20_exit_commitment: String,
    pub auction_verifier_address: String,
    pub shielded_asset_adapter_address: String,
    pub chain_id: String,
}

#[allow(dead_code)]
fn _assert_wasm_return_types(
    _: DepositSubmissionPlan,
    _: SettlementOutputWithdrawalSubmissionPlan,
    _: RenewalParentCancelSubmissionPlan,
    _: SpendAuthorization,
) {
}

#[cfg(test)]
mod tests {
    use super::{
        AuthorizeLiquidityPositionLifecycleRequest, BuildNoteConsolidationDraftRequest,
        BuildNoteConsolidationDraftResponse, BuildPrivateOrderSubmissionRequest,
        BuildRenewalParentCancelSubmissionPlanRequest,
        BuildRenewalRelayPackageAuthorizationResponse,
        BuildSettlementOutputWithdrawalSubmissionPlanRequest, BuildStrategyParentRequest,
        SignStrk20ExitClaimRequest, derive_public_config, renewal_package_commitment_from_json,
        secret_hex, validate_order_before_signing, verify_renewal_relay_package_value,
        zylith_wallet_authorize_liquidity_position_close,
        zylith_wallet_authorize_liquidity_position_open,
        zylith_wallet_build_deposit_submission_plan, zylith_wallet_build_note_consolidation_draft,
        zylith_wallet_build_private_liquidity_position_close,
        zylith_wallet_build_private_liquidity_position_open,
        zylith_wallet_build_private_liquidity_position_reconfigure,
        zylith_wallet_build_private_order_submission, zylith_wallet_build_strategy_parent,
        zylith_wallet_create_recovery_snapshot, zylith_wallet_decrypt_recovery_artifact,
        zylith_wallet_output_recovery_key_tags, zylith_wallet_output_recovery_key_tags_range,
        zylith_wallet_prepare_private_liquidity_position_close,
        zylith_wallet_prepare_private_liquidity_position_reconfigure,
        zylith_wallet_recovery_auth_tag, zylith_wallet_scan_output_bundle,
        zylith_wallet_sign_note_consolidation_witness,
        zylith_wallet_sign_renewal_relay_package_authorization,
        zylith_wallet_sign_settlement_output_withdrawal_witness,
        zylith_wallet_sign_strk20_exit_claim, zylith_wallet_verify_renewal_relay_package,
    };
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use zylith_core::{
        AssetId, BatchId, ConsumedInput, LiquidityPositionBacking, LiquidityPositionCommitment,
        LiquidityPositionCurveKind, LiquidityPositionCurvePolicy,
        LiquidityPositionLifecycleAuthorization, LiquidityPositionRotationPolicy,
        LiquidityPositionState, LiquidityPositionStatus, LiquidityPositionTransitionKind,
        LiquidityPositionTransitionWitness, Note, NoteCommitment, NoteConsolidationWitness,
        Nullifier, OrderIntent, OrderSide, OrderType, OutputCiphertextBundle,
        OutputNoteMerkleProof, OutputNoteRecord, PairId, PrivateExecutionKeyPublicConfig,
        PrivateExecutionKeyRegistry, PrivateLiquidityPosition, RecoverySeed, RelayMode,
        SettlementOutputWithdrawalWitness, SpendAuthorization, TimeInForce, deposit_root_from_note,
        derive_user_keys, encrypt_note_for_owner, liquidity_position_private_authority,
        note_recognition_public_key_from_raw_key_hex, nullifier_from_note_secret,
        nullifier_sparse_update_witnesses_for_consumed_inputs,
        settlement_note_root_after_deposit_roots, spend_auth_key_felt_from_raw_key_hex,
        spend_authority_from_raw_key_hex, verify_liquidity_position_transition_authorization,
        verify_liquidity_position_transition_witness, withdraw_authority_from_raw_key_hex,
    };

    fn owned_test_liquidity_position(
        seed: &RecoverySeed,
        position_id: &str,
        blinding: &str,
    ) -> PrivateLiquidityPosition {
        let keys = derive_user_keys(seed);
        let spend_key_hex = secret_hex(&keys.spend_auth_key);
        let owner_authority = liquidity_position_private_authority(
            &spend_auth_key_felt_from_raw_key_hex(&spend_key_hex),
        )
        .expect("position authority");
        PrivateLiquidityPosition {
            version: zylith_core::LIQUIDITY_POSITION_VERSION,
            position_id: position_id.into(),
            backing: LiquidityPositionBacking::PrivateReserve,
            status: LiquidityPositionStatus::Active,
            pair_id: PairId("STRK/USDC".into()),
            base_asset_id: AssetId("STRK".into()),
            quote_asset_id: AssetId("USDC".into()),
            owner_authority,
            base_reserve: 10_000,
            quote_reserve: 1_000_000,
            price_lower_bound: 90,
            price_upper_bound: 120,
            max_fill_base_per_batch: 1_000,
            curve_policy: LiquidityPositionCurvePolicy {
                kind: LiquidityPositionCurveKind::StaticRange,
                band_count: 3,
                spread_bps: 40,
                target_base_ratio_bps: 5_000,
                inventory_skew_bps: 0,
                max_price_deviation_bps: 0,
            },
            oracle_guard: None,
            rotation_policy: LiquidityPositionRotationPolicy {
                max_price_rotation_bps: 0,
                max_depth_rotation_bps: 0,
                skip_epoch_bps: 0,
            },
            opened_epoch: 7,
            expiry_epoch: 27,
            blinding: blinding.into(),
            metadata_commitment: "0x0".into(),
        }
    }

    #[test]
    fn wasm_request_types_reject_unknown_unsupported_fields() {
        let mut parent = serde_json::to_value(BuildStrategyParentRequest {
            seed_hex: "11".repeat(32),
            parent_authorization_secret: "22".repeat(32),
        })
        .expect("parent request json");
        parent["unsupported_parent_order_id"] = serde_json::json!("unexpected");
        assert!(serde_json::from_value::<BuildStrategyParentRequest>(parent).is_err());

        let mut claim = serde_json::to_value(SignStrk20ExitClaimRequest {
            seed_hex: "11".repeat(32),
            chain_id: "0x534e5f5345504f4c4941".into(),
            bridge_address: "0x1".into(),
            privacy_pool_address: "0x2".into(),
            auction_verifier_address: "0x3".into(),
            asset_id: "STRK".into(),
            token_address: "0x4".into(),
            amount: "1".into(),
            exit_commitment: "0x5".into(),
            open_note_id: "0x6".into(),
        })
        .expect("claim request json");
        claim["unsupported_recipient_address"] = serde_json::json!("0x123");
        assert!(serde_json::from_value::<SignStrk20ExitClaimRequest>(claim).is_err());

        let mut relay_auth = serde_json::to_value(BuildRenewalRelayPackageAuthorizationResponse {
            signer_public_key: "0x1".into(),
            signature_r: "0x2".into(),
            signature_s: "0x3".into(),
        })
        .expect("relay auth json");
        relay_auth["unsupported_access_token"] = serde_json::json!("unexpected");
        assert!(
            serde_json::from_value::<BuildRenewalRelayPackageAuthorizationResponse>(relay_auth)
                .is_err()
        );

        let mut cancel = serde_json::json!({
            "seed_hex": "11".repeat(32),
            "chain_id": "0x534e5f5345504f4c4941",
            "auction_verifier_address": "0x1",
            "parent_secret_commitment": "0x2",
            "parent_cancel_authority": "0x3",
            "prior_renewal_entries": []
        });
        cancel
            .as_object_mut()
            .unwrap()
            .remove("prior_renewal_entries");
        assert!(
            serde_json::from_value::<BuildRenewalParentCancelSubmissionPlanRequest>(cancel)
                .is_err()
        );

        let note = Note {
            asset_id: AssetId("STRK".into()),
            amount: 1,
            owner_public_key: "ab".repeat(32),
            spend_authority: "0x1".into(),
            withdraw_authority: "0x2".into(),
            blinding: "0x3".into(),
            nonce: 1,
            metadata_commitment: "0x4".into(),
        };
        let mut consolidation = serde_json::to_value(BuildNoteConsolidationDraftRequest {
            seed_hex: "11".repeat(32),
            consolidation_id: BatchId("consolidation-test".into()),
            input_notes: vec![note.clone()],
            target_amounts: vec!["1".into()],
        })
        .expect("consolidation request json");
        consolidation
            .as_object_mut()
            .unwrap()
            .remove("target_amounts");
        assert!(
            serde_json::from_value::<BuildNoteConsolidationDraftRequest>(consolidation).is_err()
        );

        let mut withdrawal =
            serde_json::to_value(BuildSettlementOutputWithdrawalSubmissionPlanRequest {
                seed_hex: "11".repeat(32),
                batch_id: BatchId("batch-1".into()),
                output_note: OutputNoteRecord {
                    note_commitment: NoteCommitment("0x5".into()),
                    asset_id: note.asset_id.clone(),
                    amount: note.amount,
                    withdraw_authority: note.withdraw_authority.clone(),
                },
                output_note_preimage: note,
                output_proof: OutputNoteMerkleProof {
                    merkle_path: vec![],
                    merkle_directions: vec![],
                },
                prior_nullifier_root: "0x6".into(),
                nullifier_history: vec![],
                nullifier_sparse_witness: None,
                new_nullifier_root: "0x7".into(),
                proof_artifact_commitment: "0x8".into(),
                strk20_exit_commitment: "0x9".into(),
                auction_verifier_address: "0xa".into(),
                shielded_asset_adapter_address: "0xb".into(),
                chain_id: "0x534e5f5345504f4c4941".into(),
            })
            .expect("withdrawal request json");
        withdrawal
            .as_object_mut()
            .unwrap()
            .remove("nullifier_history");
        assert!(
            serde_json::from_value::<BuildSettlementOutputWithdrawalSubmissionPlanRequest>(
                withdrawal
            )
            .is_err()
        );
    }

    #[test]
    fn public_config_is_deterministic() {
        let seed = "11".repeat(32);
        let first = derive_public_config(&seed).expect("first");
        let second = derive_public_config(&seed).expect("second");

        assert_eq!(first, second);
        assert!(!first.account_id.is_empty());
    }

    #[test]
    fn output_recovery_key_tags_can_be_paged_by_output_index() {
        let seed = "11".repeat(32);
        let batch_id = "batch-strk-usdc-42";
        let prefix = zylith_wallet_output_recovery_key_tags(&seed, batch_id, 8).expect("prefix");
        let range =
            zylith_wallet_output_recovery_key_tags_range(&seed, batch_id, 4, 4).expect("range");
        let prefix: serde_json::Value = serde_json::from_str(&prefix).expect("prefix json");
        let range: serde_json::Value = serde_json::from_str(&range).expect("range json");

        assert_eq!(
            &prefix["key_tags"].as_array().expect("prefix tags")[4..8],
            range["key_tags"].as_array().expect("range tags")
        );
    }

    #[test]
    fn output_recovery_key_tags_reject_oversized_requests() {
        let seed = "11".repeat(32);
        assert!(
            zylith_wallet_output_recovery_key_tags(&seed, "batch-strk-usdc-42", 4_097).is_err()
        );
    }

    #[test]
    fn deposit_plan_accepts_decimal_string_u64_nonce() {
        let seed = "11".repeat(32);
        let payload = serde_json::json!({
            "seed_hex": seed,
            "asset_id": "ETH",
            "amount": "1000000000000000",
            "deposit_nonce": "18446744073709551615",
            "deposit_authority_address": "0x123",
            "token_address": "0x456",
            "shielded_asset_adapter_address": "0x789"
        });

        let plan = zylith_wallet_build_deposit_submission_plan(&payload.to_string())
            .expect("deposit plan");
        let json: serde_json::Value = serde_json::from_str(&plan).expect("plan json");

        assert_eq!(json["note"]["nonce"], "18446744073709551615");
        assert_eq!(
            json["encoded_args"]["funding_commitments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            json["encoded_args"]["deposit_roots"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            json["encoded_args"]["encrypted_note_activations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            json["encoded_args"]["note_commitments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            json["encoded_args"]["asset_ids"].as_array().unwrap().len(),
            1
        );
        assert_eq!(json["encoded_args"]["amounts"].as_array().unwrap().len(), 1);
        assert_eq!(
            json["encoded_args"]["withdraw_authorities"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
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
    fn signs_settlement_output_withdrawal_witness() {
        let seed = RecoverySeed([12_u8; 32]);
        let keys = derive_user_keys(&seed);
        let note = Note {
            asset_id: AssetId("USDC".into()),
            amount: 12,
            owner_public_key: note_recognition_public_key_from_raw_key_hex(&hex::encode(
                keys.note_recognition_key,
            ))
            .expect("owner key"),
            spend_authority: spend_authority_from_raw_key_hex(&hex::encode(keys.spend_auth_key))
                .expect("spend authority"),
            withdraw_authority: withdraw_authority_from_raw_key_hex(&hex::encode(
                keys.withdraw_auth_key,
            ))
            .expect("withdraw authority"),
            blinding: "0x1234".into(),
            nonce: 9,
            metadata_commitment: "0x4567".into(),
        };
        let note_commitment = note.commitment().expect("note commitment");
        let nullifier =
            nullifier_from_note_secret(&note_commitment, &note.blinding).expect("nullifier");
        let consumed = ConsumedInput {
            note_commitment: note_commitment.clone(),
            nullifier,
        };
        let (prior_nullifier_root, new_nullifier_root, mut witnesses) =
            nullifier_sparse_update_witnesses_for_consumed_inputs(&[], &[consumed])
                .expect("sparse witness");
        let witness = SettlementOutputWithdrawalWitness {
            batch_id: BatchId("batch-1".into()),
            auction_verifier_address: "0x123".into(),
            shielded_asset_adapter_address: "0x456".into(),
            chain_id: "0x534e5f5345504f4c4941".into(),
            strk20_exit_commitment: "0xabc123".into(),
            prior_nullifier_root,
            output_note: OutputNoteRecord {
                note_commitment,
                asset_id: note.asset_id.clone(),
                amount: note.amount,
                withdraw_authority: note.withdraw_authority.clone(),
            },
            output_note_preimage: note,
            output_proof: OutputNoteMerkleProof {
                merkle_path: vec![],
                merkle_directions: vec![],
            },
            withdraw_authorization: SpendAuthorization {
                signature_r: "0x0".into(),
                signature_s: "0x0".into(),
            },
            nullifier_history: vec![],
            nullifier_sparse_witness: Some(witnesses.pop().expect("one witness")),
            new_nullifier_root,
        };
        let expected = serde_json::json!({
            "batch_id": "batch-1",
            "output_note": witness.output_note.clone(),
            "output_note_preimage": witness.output_note_preimage.clone(),
            "output_proof": witness.output_proof.clone(),
            "strk20_exit_commitment": "0xabc123",
            "auction_verifier_address": "0x123",
            "shielded_asset_adapter_address": "0x456",
            "chain_id": "0x534e5f5345504f4c4941"
        });
        let signed = zylith_wallet_sign_settlement_output_withdrawal_witness(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "expected": expected.clone(),
                "witness": witness.clone(),
            })
            .to_string(),
        )
        .expect("signed witness");
        let signed: SettlementOutputWithdrawalWitness =
            serde_json::from_str(&signed).expect("signed json");

        assert_ne!(signed.withdraw_authorization.signature_r, "0x0");
        assert_ne!(signed.withdraw_authorization.signature_s, "0x0");

        let mut malicious = witness;
        malicious.strk20_exit_commitment = "0x999".into();
        let rejected = zylith_wallet_sign_settlement_output_withdrawal_witness(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "expected": expected,
                "witness": malicious,
            })
            .to_string(),
        );
        assert!(rejected.is_err());
    }

    #[test]
    fn signs_strk20_exit_claim_authorization() {
        let seed = RecoverySeed([12_u8; 32]);
        let signed = zylith_wallet_sign_strk20_exit_claim(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "chain_id": "0x534e5f5345504f4c4941",
                "bridge_address": "0x456",
                "privacy_pool_address": "0x789",
                "auction_verifier_address": "0xabc",
                "asset_id": "STRK",
                "token_address": "0xdef",
                "amount": "200",
                "exit_commitment": "0xabc123",
                "open_note_id": "0xdef456",
            })
            .to_string(),
        )
        .expect("claim signed");
        let signed: SpendAuthorization = serde_json::from_str(&signed).expect("signed json");
        assert_ne!(signed.signature_r, "0x0");
        assert_ne!(signed.signature_s, "0x0");

        let other = zylith_wallet_sign_strk20_exit_claim(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "chain_id": "0x534e5f5345504f4c4941",
                "bridge_address": "0x456",
                "privacy_pool_address": "0x789",
                "auction_verifier_address": "0xabc",
                "asset_id": "STRK",
                "token_address": "0xdef",
                "amount": "200",
                "exit_commitment": "0xabc123",
                "open_note_id": "0xdef457",
            })
            .to_string(),
        )
        .expect("other claim signed");
        let other: SpendAuthorization = serde_json::from_str(&other).expect("other json");
        assert_ne!(signed.signature_r, other.signature_r);
    }

    #[test]
    fn wallet_authorizes_liquidity_position_lifecycle_actions() {
        let seed = RecoverySeed([13_u8; 32]);
        let keys = derive_user_keys(&seed);
        let spend_key_hex = secret_hex(&keys.spend_auth_key);
        let lp_owner_authority = liquidity_position_private_authority(
            &spend_auth_key_felt_from_raw_key_hex(&spend_key_hex),
        )
        .expect("lp owner authority");
        let position_id = "0x123456";
        let prior = LiquidityPositionCommitment("0xabc123".into());
        let output = LiquidityPositionCommitment("0xdef456".into());

        let open_request = AuthorizeLiquidityPositionLifecycleRequest {
            seed_hex: seed.to_hex(),
            position_id: position_id.into(),
            prior_position_commitment: None,
            output_position_commitment: Some(output.clone()),
            epoch: 7,
            base_amount: 0,
            quote_amount: 0,
        };
        let open_json = serde_json::to_string(&open_request).expect("open request json");
        let open_auth = zylith_wallet_authorize_liquidity_position_open(&open_json)
            .expect("open authorization");
        let open_auth: LiquidityPositionLifecycleAuthorization =
            serde_json::from_str(&open_auth).expect("open auth json");
        verify_liquidity_position_transition_authorization(
            &lp_owner_authority,
            LiquidityPositionTransitionKind::Open,
            position_id,
            None,
            Some(&output),
            7,
            0,
            0,
            &open_auth,
        )
        .expect("open auth verifies");

        let close_request = AuthorizeLiquidityPositionLifecycleRequest {
            seed_hex: seed.to_hex(),
            position_id: position_id.into(),
            prior_position_commitment: Some(prior),
            output_position_commitment: None,
            epoch: 9,
            base_amount: 1_000,
            quote_amount: 2_000,
        };
        let close_json = serde_json::to_string(&close_request).expect("close request json");
        let close_auth = zylith_wallet_authorize_liquidity_position_close(&close_json)
            .expect("close authorization");
        let close_auth: LiquidityPositionLifecycleAuthorization =
            serde_json::from_str(&close_auth).expect("close auth json");
        assert_ne!(open_auth.signature_s, close_auth.signature_s);

        let invalid_open = AuthorizeLiquidityPositionLifecycleRequest {
            prior_position_commitment: Some(LiquidityPositionCommitment("0x333".into())),
            ..open_request
        };
        assert!(
            zylith_wallet_authorize_liquidity_position_open(
                &serde_json::to_string(&invalid_open).expect("invalid open json")
            )
            .is_err()
        );
    }

    #[test]
    fn wallet_builds_private_liquidity_position_open_from_normal_notes() {
        let seed = RecoverySeed([14_u8; 32]);
        let keys = derive_user_keys(&seed);
        let owner_key_hex = secret_hex(&keys.note_recognition_key);
        let spend_key_hex = secret_hex(&keys.spend_auth_key);
        let withdraw_key_hex = secret_hex(&keys.withdraw_auth_key);
        let owner_public_key =
            note_recognition_public_key_from_raw_key_hex(&owner_key_hex).expect("owner key");
        let spend_authority =
            spend_authority_from_raw_key_hex(&spend_key_hex).expect("spend authority");
        let withdraw_authority =
            withdraw_authority_from_raw_key_hex(&withdraw_key_hex).expect("withdraw authority");
        let base_note = Note {
            asset_id: AssetId("STRK".into()),
            amount: 11_000,
            owner_public_key: owner_public_key.clone(),
            spend_authority: spend_authority.clone(),
            withdraw_authority: withdraw_authority.clone(),
            blinding: "0x101".into(),
            nonce: 1,
            metadata_commitment: "0x0".into(),
        };
        let quote_note = Note {
            asset_id: AssetId("USDC".into()),
            amount: 1_000_000,
            owner_public_key,
            spend_authority: spend_authority.clone(),
            withdraw_authority,
            blinding: "0x102".into(),
            nonce: 2,
            metadata_commitment: "0x0".into(),
        };
        let request = serde_json::json!({
            "seed_hex": seed.to_hex(),
            "pair_id": "STRK/USDC",
            "batch_id": "batch-strk-usdc-7",
            "epoch_id": "7",
            "funding_notes": [base_note, quote_note],
            "base_asset_id": "STRK",
            "quote_asset_id": "USDC",
            "base_reserve": "10000",
            "quote_reserve": "1000000",
            "price_lower_bound": "90",
            "price_upper_bound": "120",
            "max_fill_base_per_batch": "1000",
            "curve_policy": {
                "kind": "StaticRange",
                "band_count": "3",
                "spread_bps": "40",
                "target_base_ratio_bps": "5000",
                "inventory_skew_bps": "0",
                "max_price_deviation_bps": "0"
            },
            "rotation_policy": {
                "max_price_rotation_bps": "0",
                "max_depth_rotation_bps": "0",
                "skip_epoch_bps": "0"
            },
            "expiry_epoch": "27",
            "position_nonce": u64::MAX.to_string(),
            "prior_liquidity_position_root": "0x0",
            "padding": "0000"
        });
        let response = zylith_wallet_build_private_liquidity_position_open(&request.to_string())
            .expect("build LP open");
        let json: serde_json::Value = serde_json::from_str(&response).expect("response json");

        let lifecycle_id = json["lifecycle_id"].as_str().expect("lifecycle id");
        assert_eq!(lifecycle_id.len(), 64);
        assert!(lifecycle_id.chars().all(|char| char.is_ascii_hexdigit()));
        assert_eq!(json["position"]["owner_authority"], spend_authority);
        assert!(json.get("authority_secret").is_none());
        assert!(
            json["transition_witness"]["open_funding"]["authorization"]
                .get("authority_secret")
                .is_none()
        );
        assert!(
            json["ingress_request"]["transition_witness"]["open_funding"]["authorization"]
                .get("signature_r")
                .is_some()
        );
        assert_eq!(
            json["change_notes"].as_array().expect("change notes").len(),
            1
        );
        let witness: LiquidityPositionTransitionWitness =
            serde_json::from_value(json["ingress_request"]["transition_witness"].clone())
                .expect("decode transition witness");
        verify_liquidity_position_transition_witness("0x0", &witness)
            .expect("LP open witness verifies");
    }

    #[test]
    fn wallet_builds_private_liquidity_position_lifecycle_actions() {
        let seed = RecoverySeed([15_u8; 32]);
        let prior = owned_test_liquidity_position(&seed, "0x701", "0x801");
        let prior_root = LiquidityPositionState::from_positions(std::slice::from_ref(&prior))
            .expect("prior state")
            .root()
            .expect("prior root");

        let reconfigure_request = serde_json::json!({
            "seed_hex": seed.to_hex(),
            "pair_id": "STRK/USDC",
            "batch_id": "batch-strk-usdc-8",
            "epoch_id": "8",
            "prior_position": prior.clone(),
            "price_lower_bound": "95",
            "price_upper_bound": "130",
            "max_fill_base_per_batch": "500",
            "curve_policy": {
                "kind": "StaticRange",
                "band_count": "3",
                "spread_bps": "30",
                "target_base_ratio_bps": "5000",
                "inventory_skew_bps": "0",
                "max_price_deviation_bps": "0"
            },
            "rotation_policy": {
                "max_price_rotation_bps": "10",
                "max_depth_rotation_bps": "10",
                "skip_epoch_bps": "0"
            },
            "expiry_epoch": "30",
            "lifecycle_nonce": "81"
        });
        let reconfigure_preview = zylith_wallet_prepare_private_liquidity_position_reconfigure(
            &reconfigure_request.to_string(),
        )
        .expect("prepare reconfigure");
        let reconfigure_preview: serde_json::Value =
            serde_json::from_str(&reconfigure_preview).expect("reconfigure preview json");
        let reconfigured: PrivateLiquidityPosition =
            serde_json::from_value(reconfigure_preview["output_position"].clone())
                .expect("reconfigured position");
        let reconfigured_commitment: LiquidityPositionCommitment =
            serde_json::from_value(reconfigure_preview["output_position_commitment"].clone())
                .expect("reconfigured commitment");
        let state = LiquidityPositionState::from_positions(std::slice::from_ref(&prior))
            .expect("state service");
        let (_, _, reconfigure_update) = state
            .replacement_update(
                &prior.position_id,
                prior.commitment().expect("prior commitment"),
                reconfigured_commitment,
            )
            .expect("reconfigure state update");
        let mut reconfigure_build = reconfigure_request.as_object().unwrap().clone();
        reconfigure_build.insert(
            "prior_liquidity_position_root".into(),
            serde_json::Value::String(prior_root.clone()),
        );
        reconfigure_build.insert(
            "state_update".into(),
            serde_json::to_value(reconfigure_update).expect("state update json"),
        );
        reconfigure_build.insert("padding".into(), serde_json::Value::String("0000".into()));
        let reconfigure_response = zylith_wallet_build_private_liquidity_position_reconfigure(
            &serde_json::Value::Object(reconfigure_build).to_string(),
        )
        .expect("build reconfigure");
        let reconfigure_response: serde_json::Value =
            serde_json::from_str(&reconfigure_response).expect("reconfigure response json");
        let reconfigure_witness: LiquidityPositionTransitionWitness =
            serde_json::from_value(reconfigure_response["transition_witness"].clone())
                .expect("reconfigure witness");
        verify_liquidity_position_transition_witness(&prior_root, &reconfigure_witness)
            .expect("reconfigure witness verifies");
        assert_eq!(
            reconfigure_witness.output_position.as_ref(),
            Some(&reconfigured)
        );

        let close_prior = owned_test_liquidity_position(&seed, "0x703", "0x803");
        let close_prior_root =
            LiquidityPositionState::from_positions(std::slice::from_ref(&close_prior))
                .expect("close prior state")
                .root()
                .expect("close prior root");
        let close_request = serde_json::json!({
            "seed_hex": seed.to_hex(),
            "pair_id": "STRK/USDC",
            "batch_id": "batch-strk-usdc-10",
            "epoch_id": "10",
            "prior_position": close_prior.clone(),
            "lifecycle_nonce": u64::MAX.to_string()
        });
        let close_preview =
            zylith_wallet_prepare_private_liquidity_position_close(&close_request.to_string())
                .expect("prepare close");
        let close_preview: serde_json::Value =
            serde_json::from_str(&close_preview).expect("close preview json");
        assert_eq!(
            close_preview["output_notes"]
                .as_array()
                .expect("close output notes")
                .len(),
            2
        );
        let close_state =
            LiquidityPositionState::from_positions(std::slice::from_ref(&close_prior))
                .expect("close state service");
        let (_, close_root, close_update) = close_state
            .removal_update(
                &close_prior.position_id,
                close_prior.commitment().expect("close prior commitment"),
            )
            .expect("close state update");
        assert_eq!(close_root, "0x0");
        let mut close_build = close_request.as_object().unwrap().clone();
        close_build.insert(
            "prior_liquidity_position_root".into(),
            serde_json::Value::String(close_prior_root.clone()),
        );
        close_build.insert(
            "state_update".into(),
            serde_json::to_value(close_update).expect("state update json"),
        );
        let close_response = zylith_wallet_build_private_liquidity_position_close(
            &serde_json::Value::Object(close_build).to_string(),
        )
        .expect("build close");
        let close_response: serde_json::Value =
            serde_json::from_str(&close_response).expect("close response json");
        assert!(close_response.get("output_position").is_none());
        let close_witness: LiquidityPositionTransitionWitness =
            serde_json::from_value(close_response["transition_witness"].clone())
                .expect("close witness");
        verify_liquidity_position_transition_witness(&close_prior_root, &close_witness)
            .expect("close witness verifies");
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
    fn builds_private_order_submission_from_seed_and_funding_notes() {
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
            funding_notes: vec![funding_note],
            order: OrderIntent {
                pair_id: PairId("STRK/USDC".into()),
                batch_id: BatchId("STRK-USDC-7".into()),
                side: OrderSide::Buy,
                order_type: OrderType::LimitBatch,
                relay_mode: RelayMode::SelfRelay,
                liquidity_curve: None,
                limit_price: 2,
                amount: 10,
                min_fill: 1,
                time_in_force: TimeInForce::CurrentBatchOnly,
                expiry_epoch: 7,
                order_nonce: u64::MAX,
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

        let mut request_json = serde_json::to_value(&request).expect("request json");
        request_json["order"]["expiry_epoch"] = serde_json::json!("7");
        request_json["order"]["order_nonce"] = serde_json::json!("18446744073709551615");
        request_json["order"]["parent_child_index"] = serde_json::json!("0");
        let mut empty_request_json = request_json.clone();
        empty_request_json["funding_notes"] = serde_json::json!([]);
        assert!(
            zylith_wallet_build_private_order_submission(&empty_request_json.to_string()).is_err(),
            "empty funding notes are rejected"
        );
        let encoded = zylith_wallet_build_private_order_submission(&request_json.to_string())
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
    fn rejects_invalid_direct_order_relay_mode_before_signing() {
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
            funding_notes: vec![funding_note],
            order: OrderIntent {
                pair_id: PairId("STRK/USDC".into()),
                batch_id: BatchId("STRK-USDC-7".into()),
                side: OrderSide::Buy,
                order_type: OrderType::LimitBatch,
                relay_mode: RelayMode::ZylithRelay,
                liquidity_curve: None,
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
            padding: None,
        };

        let error =
            validate_order_before_signing(&request.order).expect_err("invalid relay mode rejected");
        assert!(error.to_string().to_lowercase().contains("relay"));
    }

    #[test]
    fn builds_and_signs_note_consolidation_draft() {
        let seed = RecoverySeed([8_u8; 32]);
        let keys = derive_user_keys(&seed);
        let owner_public_key =
            note_recognition_public_key_from_raw_key_hex(&hex::encode(keys.note_recognition_key))
                .expect("owner key");
        let spend_authority = spend_authority_from_raw_key_hex(&hex::encode(keys.spend_auth_key))
            .expect("spend authority");
        let withdraw_authority =
            withdraw_authority_from_raw_key_hex(&hex::encode(keys.withdraw_auth_key))
                .expect("withdraw authority");
        let input_notes = vec![
            Note {
                asset_id: AssetId("USDC".into()),
                amount: 100,
                owner_public_key: owner_public_key.clone(),
                spend_authority: spend_authority.clone(),
                withdraw_authority: withdraw_authority.clone(),
                blinding: "0x111".into(),
                nonce: 1,
                metadata_commitment: "0x211".into(),
            },
            Note {
                asset_id: AssetId("USDC".into()),
                amount: 200,
                owner_public_key,
                spend_authority,
                withdraw_authority,
                blinding: "0x112".into(),
                nonce: 2,
                metadata_commitment: "0x212".into(),
            },
        ];
        let draft_json = zylith_wallet_build_note_consolidation_draft(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "consolidation_id": "consolidation-test",
                "input_notes": input_notes,
                "target_amounts": ["300"]
            })
            .to_string(),
        )
        .expect("draft");
        let draft: BuildNoteConsolidationDraftResponse =
            serde_json::from_str(&draft_json).expect("draft json");
        let input_commitments = draft
            .input_notes
            .iter()
            .map(|note| note.commitment().expect("input commitment"))
            .collect::<Vec<_>>();
        let consumed_inputs = draft
            .input_notes
            .iter()
            .zip(input_commitments.iter())
            .map(|(note, commitment)| ConsumedInput {
                note_commitment: commitment.clone(),
                nullifier: nullifier_from_note_secret(commitment, &note.blinding)
                    .expect("nullifier"),
            })
            .collect::<Vec<_>>();
        let (prior_nullifier_root, new_nullifier_root, nullifier_sparse_witnesses) =
            nullifier_sparse_update_witnesses_for_consumed_inputs(&[], &consumed_inputs)
                .expect("sparse witnesses");
        let deposit_roots = draft
            .input_notes
            .iter()
            .map(|note| deposit_root_from_note(note).expect("deposit root"))
            .collect::<Vec<_>>();
        let prior_note_root =
            settlement_note_root_after_deposit_roots(&deposit_roots).expect("prior note root");
        let expected_draft = draft.clone();
        let witness = NoteConsolidationWitness {
            consolidation_id: draft.consolidation_id.clone(),
            auction_verifier_address: "0x1234".into(),
            prior_note_root,
            prior_nullifier_root,
            input_notes: draft.input_notes,
            spend_authorization: SpendAuthorization {
                signature_r: "0x0".into(),
                signature_s: "0x0".into(),
            },
            note_membership_witnesses: Vec::new(),
            nullifier_history: Vec::new(),
            nullifier_sparse_witnesses,
            output_notes: draft.output_notes,
            output_note_preimages: draft.output_note_preimages,
            output_recovery_records: draft.output_recovery_records,
            output_recovery_dummy_commitments: draft.output_recovery_dummy_commitments,
            output_ciphertext_bundle_ref: draft.output_ciphertext_bundle_ref,
            new_nullifier_root,
        };

        let signed_json = zylith_wallet_sign_note_consolidation_witness(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "expected_draft": expected_draft.clone(),
                "witness": witness.clone()
            })
            .to_string(),
        )
        .expect("signed witness");
        let signed: NoteConsolidationWitness =
            serde_json::from_str(&signed_json).expect("signed json");

        assert_eq!(signed.output_notes.len(), 1);
        assert_eq!(signed.output_notes[0].amount, 300);
        assert_eq!(signed.output_note_preimages[0].nonce, 1);
        assert_ne!(signed.spend_authorization.signature_r, "0x0");
        assert_ne!(signed.output_ciphertext_bundle_ref, "0x0");

        let mut unsupported_expected_draft =
            serde_json::to_value(expected_draft.clone()).expect("expected draft json");
        unsupported_expected_draft["unsupported_consolidation_mode"] =
            serde_json::json!("unexpected");
        let unsupported_expected = zylith_wallet_sign_note_consolidation_witness(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "expected_draft": unsupported_expected_draft,
                "witness": witness.clone()
            })
            .to_string(),
        );
        assert!(unsupported_expected.is_err());

        let mut malicious = witness;
        malicious.output_note_preimages[0].amount += 1;
        let rejected = zylith_wallet_sign_note_consolidation_witness(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "expected_draft": expected_draft,
                "witness": malicious
            })
            .to_string(),
        );
        assert!(rejected.is_err());
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

    #[test]
    fn verifies_renewal_relay_package_commitment_and_authorization() {
        let seed = RecoverySeed([12_u8; 32]);
        let parent = zylith_wallet_build_strategy_parent(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "parent_authorization_secret": "0x123456",
            })
            .to_string(),
        )
        .expect("parent");
        let parent: serde_json::Value = serde_json::from_str(&parent).expect("parent json");
        let parent_secret_commitment = parent["parent_secret_commitment"].as_str().unwrap();
        let parent_cancel_authority = parent["parent_cancel_authority"].as_str().unwrap();
        let mut package = serde_json::json!({
            "version": 1,
            "package_id": "pkg-1",
            "package_commitment": "",
            "created_at_unix_ms": 1_u64,
            "pair": "STRK/USDC",
            "start_epoch": 1_u64,
            "end_epoch": 1_u64,
            "slot_count": 1_u64,
            "relay_mode": "SelfRelay",
            "parent_cancel_authority": parent_cancel_authority,
            "parent_cancel_marker": "0xcancel",
            "relay_policy": {
                "prover_url": "https://prover.example",
                "coordinator_url": "https://coordinator.example",
                "submission_safety_buffer_ms": 1000_u64,
                "max_submission_delay_ms": 0_u64
            },
            "slots": [{
                "slot_id": "pkg-1:1",
                "pair": "STRK/USDC",
                "batch_id": "STRK-USDC-1",
                "epoch_id": 1_u64,
                "parent_child_index": 1_u64,
                "order_commitment": "0x123",
                "funding_note_commitments": ["0xlabel"],
                "ingress_request": {"order_submission": {}}
            }]
        });
        let commitment = renewal_package_commitment_from_json(&package).expect("commitment");
        package["package_commitment"] = serde_json::Value::String(commitment.clone());
        let authorization = zylith_wallet_sign_renewal_relay_package_authorization(
            &serde_json::json!({
                "seed_hex": seed.to_hex(),
                "package_commitment": commitment,
                "parent_secret_commitment": parent_secret_commitment,
                "parent_cancel_authority": parent_cancel_authority,
            })
            .to_string(),
        )
        .expect("authorization");
        package["relay_authorization"] =
            serde_json::from_str(&authorization).expect("authorization json");
        package["access_token"] = serde_json::Value::String("relay-token".into());

        let verified = zylith_wallet_verify_renewal_relay_package(&package.to_string())
            .expect("verified package");
        assert_eq!(verified, "{\"verified\":true}");

        package["slots"][0]["batch_id"] = serde_json::Value::String("STRK-USDC-2".into());
        assert!(verify_renewal_relay_package_value(&package).is_err());
    }

    fn sample_p256_public_key() -> String {
        let secret = p256::SecretKey::from_slice(&[7_u8; 32]).expect("secret");
        hex::encode(secret.public_key().to_encoded_point(false).as_bytes())
    }
}
