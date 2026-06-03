use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wasm_bindgen::prelude::*;
use zylith_core::hash::{normalize_felt_hex, tagged_field_hex};
use zylith_core::{
    AssetId, BatchId, DepositIntent, DepositSubmissionPlan, EncryptedMakerAttributionArtifact,
    Note, NoteConsolidationWitness, NullifierHistoryBatch, NullifierSparseUpdateWitness,
    OrderCommitment, OrderIntent, OrderSubmission, OutputCiphertextBundle, OutputNoteMerkleProof,
    OutputNoteRecord, OutputRecoveryRecord, PrivateExecutionKeyRegistry, PrivateOrderPayload,
    RecoveryArtifact, RecoveryArtifactKind, RecoverySeed, RenewalParentCancelPlanRequest,
    RenewalParentCancelSubmissionPlan, SettlementOutputWithdrawalPlanRequest,
    SettlementOutputWithdrawalSubmissionPlan, SettlementOutputWithdrawalWitness,
    SpendAuthorization, TrustedOrderIngressRequest, WithdrawalSubmissionPlan,
    build_deposit_submission_plan, build_order_submission,
    build_renewal_parent_cancel_submission_plan,
    build_settlement_output_withdrawal_submission_plan, build_withdrawal_submission_plan,
    create_recovery_artifact, decrypt_maker_attribution_artifact, decrypt_output_note_for_owner,
    decrypt_output_recovery_record, decrypt_recovery_artifact_payload, derive_account_id,
    derive_order_cancellation_secret, derive_recovery_auth_tag, derive_user_keys,
    encrypt_output_note_for_owner, funding_input_set_commitment, funding_nullifier_set_commitment,
    note_consolidation_commitment, note_recognition_public_key_from_raw_key_hex,
    nullifier_from_note_secret, output_note_merkle_proof, output_note_merkle_root,
    output_note_metadata_commitment, output_recovery_key_tag_for_spend_authority,
    renewal_cancel_auth_key_felt_for_parent_from_raw_key_hex,
    renewal_cancel_authority_for_parent_from_raw_key_hex, renewal_parent_commitment,
    renewal_parent_secret_commitment, sign_note_consolidation_authorization,
    sign_order_authorization, sign_renewal_relay_package_authorization,
    sign_settlement_output_withdrawal_witness, spend_auth_key_felt_from_raw_key_hex,
    spend_authority_from_raw_key_hex, verify_output_note_membership,
    verify_renewal_relay_package_authorization, withdraw_auth_key_felt_from_raw_key_hex,
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
        renewal_package_id: None,
        renewal_package_commitment: None,
        renewal_relay_mode: None,
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
pub fn zylith_wallet_build_strategy_parent(input_json: &str) -> Result<String, JsValue> {
    let request: BuildStrategyParentRequest = from_json(input_json)?;
    let seed = RecoverySeed::from_hex(&request.seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let order_cancel_key_hex = hex::encode(keys.order_cancellation_key);
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
    let order_cancel_key_hex = hex::encode(keys.order_cancellation_key);
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
    let order_cancel_key_hex = hex::encode(keys.order_cancellation_key);
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
    let owner_key_hex = hex::encode(keys.note_recognition_key);
    let spend_key_hex = hex::encode(keys.spend_auth_key);
    let withdraw_key_hex = hex::encode(keys.withdraw_auth_key);
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
            nonce: output_index as u64,
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
    let spend_key_felt = spend_auth_key_felt_from_raw_key_hex(&hex::encode(keys.spend_auth_key));
    let spend_authority =
        spend_authority_from_raw_key_hex(&hex::encode(keys.spend_auth_key)).map_err(js_error)?;
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
    let seed = RecoverySeed::from_hex(seed_hex).map_err(js_error)?;
    let keys = derive_user_keys(&seed);
    let spend_authority =
        spend_authority_from_raw_key_hex(&hex::encode(keys.spend_auth_key)).map_err(js_error)?;
    let key_tags = (0..max_output_count as usize)
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
    let note_recognition_key_hex = hex::encode(keys.note_recognition_key);
    let note_owner_public_key =
        note_recognition_public_key_from_raw_key_hex(&note_recognition_key_hex)
            .map_err(js_error)?;
    let spend_authority =
        spend_authority_from_raw_key_hex(&hex::encode(keys.spend_auth_key)).map_err(js_error)?;
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
            output_note_preimage: &request.output_note_preimage,
            output_proof: &request.output_proof,
            prior_nullifier_root: &request.prior_nullifier_root,
            nullifier_history: &request.nullifier_history,
            nullifier_sparse_witness: request.nullifier_sparse_witness.as_ref(),
            new_nullifier_root: &request.new_nullifier_root,
            proof_artifact_commitment: &request.proof_artifact_commitment,
            withdraw_auth_key_felt: &withdraw_auth_key_felt,
            recipient: &request.recipient,
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
    let withdraw_key_hex = hex::encode(keys.withdraw_auth_key);
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
        &witness.recipient,
        &expected.recipient,
        "withdrawal witness changed recipient",
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
    #[serde(with = "u64_decimal")]
    pub deposit_nonce: u64,
    pub deposit_authority_address: String,
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
    pub expected_output_metadata_commitment: String,
    pub funding_note_commitments: Vec<String>,
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
    #[serde(default)]
    pub renewal_cancel_sparse_witness: Option<zylith_core::NullifierSparseUpdateWitness>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildRenewalRelayPackageAuthorizationRequest {
    pub seed_hex: String,
    pub package_commitment: String,
    pub parent_secret_commitment: String,
    pub parent_cancel_authority: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildRenewalRelayPackageAuthorizationResponse {
    pub signer_public_key: String,
    pub signature_r: String,
    pub signature_s: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuildNoteConsolidationDraftRequest {
    pub seed_hex: String,
    pub consolidation_id: BatchId,
    pub input_notes: Vec<Note>,
    #[serde(default)]
    pub target_amounts: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignNoteConsolidationWitnessRequest {
    pub seed_hex: String,
    pub expected_draft: BuildNoteConsolidationDraftResponse,
    pub witness: NoteConsolidationWitness,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CreateRecoverySnapshotRequest {
    pub seed_hex: String,
    pub sequence: u64,
    pub created_at_unix_ms: u64,
    pub payload_json: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScannedNote {
    pub batch_id: BatchId,
    pub note_commitment: String,
    pub note: Note,
    pub output_note: OutputNoteRecord,
    pub output_proof: OutputNoteMerkleProof,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScannedNoteList {
    pub notes: Vec<ScannedNote>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OutputRecoveryKeyTagList {
    pub key_tags: Vec<String>,
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
    pub output_note_preimage: Note,
    pub output_proof: OutputNoteMerkleProof,
    pub prior_nullifier_root: String,
    #[serde(default)]
    pub nullifier_history: Vec<NullifierHistoryBatch>,
    #[serde(default)]
    pub nullifier_sparse_witness: Option<NullifierSparseUpdateWitness>,
    pub new_nullifier_root: String,
    pub proof_artifact_commitment: String,
    pub recipient: String,
    pub auction_verifier_address: String,
    pub shielded_asset_adapter_address: String,
    pub chain_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SignSettlementOutputWithdrawalWitnessRequest {
    pub seed_hex: String,
    pub expected: ExpectedSettlementOutputWithdrawalWitness,
    pub witness: SettlementOutputWithdrawalWitness,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExpectedSettlementOutputWithdrawalWitness {
    pub batch_id: BatchId,
    pub output_note: OutputNoteRecord,
    pub output_note_preimage: Note,
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
        BuildNoteConsolidationDraftResponse, BuildPrivateOrderSubmissionRequest,
        derive_public_config, renewal_package_commitment_from_json, validate_order_before_signing,
        verify_renewal_relay_package_value, zylith_wallet_build_deposit_submission_plan,
        zylith_wallet_build_note_consolidation_draft, zylith_wallet_build_private_order_submission,
        zylith_wallet_build_strategy_parent, zylith_wallet_create_recovery_snapshot,
        zylith_wallet_decrypt_recovery_artifact, zylith_wallet_generate_mnemonic,
        zylith_wallet_mnemonic_to_seed_hex, zylith_wallet_recovery_auth_tag,
        zylith_wallet_scan_output_bundle, zylith_wallet_seed_hex_to_mnemonic,
        zylith_wallet_sign_note_consolidation_witness,
        zylith_wallet_sign_renewal_relay_package_authorization,
        zylith_wallet_sign_settlement_output_withdrawal_witness,
        zylith_wallet_verify_renewal_relay_package,
    };
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use zylith_core::{
        AssetId, BatchId, ConsumedInput, Note, NoteCommitment, NoteConsolidationWitness, Nullifier,
        OrderIntent, OrderSide, OrderType, OutputCiphertextBundle, OutputNoteMerkleProof,
        OutputNoteRecord, PairId, PrivateExecutionKeyPublicConfig, PrivateExecutionKeyRegistry,
        RecoverySeed, RelayMode, SettlementOutputWithdrawalWitness, SpendAuthorization,
        TimeInForce, deposit_root_from_note, derive_user_keys, encrypt_note_for_owner,
        note_recognition_public_key_from_raw_key_hex, nullifier_from_note_secret,
        nullifier_sparse_update_witnesses_for_consumed_inputs,
        settlement_note_root_after_deposit_roots, spend_authority_from_raw_key_hex,
        withdraw_authority_from_raw_key_hex,
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
            recipient: "0x789".into(),
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
            "recipient": "0x789",
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
        malicious.recipient = "0x999".into();
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
            funding_note,
            funding_notes: vec![],
            order: OrderIntent {
                pair_id: PairId("STRK/USDC".into()),
                batch_id: BatchId("STRK-USDC-7".into()),
                side: OrderSide::Buy,
                order_type: OrderType::LimitBatch,
                relay_mode: RelayMode::ZylithRelay,
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
        assert_ne!(signed.spend_authorization.signature_r, "0x0");
        assert_ne!(signed.output_ciphertext_bundle_ref, "0x0");

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
