//! the browser wallet's cryptography. a wallet session imports one raw seed buffer, while
//! operation inputs and outputs use strict json and never return the seed.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use serde::{Deserialize, Serialize};
use starknet_crypto::Felt;
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};
use zylith_core::exchange::{
    NoteAccumulator, NoteFields, NoteMembership, OrderQuery, OrderTerms, OutputRecord,
    PrivateRequest, RecoveredOutput, RecoveryCapacity, RecoveryExit, ResidualNote,
    ResidualRecoveryInput, SealedRequest, Signature, StatusRequest, WalletKeys, WithdrawalQuery,
    asset_id, build_residual_recovery, chunk_status, output_tree_root, pair_id,
    preview_residual_recovery, public_key, random_felt, recover_order_outputs,
    recover_order_residual, residual_recovery_amounts, residual_recovery_authorization_message,
    residual_recovery_calldata, seal_request, short_string, sign_message, sponge,
    withdrawal_status_message,
};
use zylith_core::hash::felt_hex;
use zylith_core::wallet_crypto::{
    ProofSignerDerivationContext, WALLET_KEY_SCHEDULE_VERSION, WalletFieldPurpose,
    WalletKeyScheduleV2,
};
use zylith_core::{
    AssetId, DepositDerivationContext, DepositIntent, DepositSubmissionPlan,
    PrivateExecutionKeyRegistry, RecoveryArtifact, RecoveryArtifactKind, RecoverySeed,
    SpendAuthorization, Strk20ExitClaimMessage, WalletDataError,
    build_wallet_deposit_submission_plan, create_recovery_artifact,
    decrypt_recovery_artifact_payload, decrypt_recovery_artifact_payload_classified,
    derive_wallet_recovery_auth_tag, sign_strk20_exit_claim_authorization,
};

#[cfg(test)]
#[derive(Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct LocalStateInput<'a> {
    seed_hex: String,
    #[serde(borrow)]
    #[zeroize(skip)]
    value: &'a serde_json::value::RawValue,
}

/// the local aes key and operations stay within rust while a strict json value is sealed.
#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_encrypt_local_state(input_json: &str) -> Result<String, JsValue> {
    if input_json.len() > zylith_core::MAX_WALLET_STATE_REQUEST_BYTES {
        return Err(js_error("local wallet state is too large"));
    }
    unique_wallet_json(input_json)?;
    let input: LocalStateInput<'_> = serde_json::from_str(input_json)
        .map_err(|_| js_error("invalid local wallet state input"))?;
    let record = zylith_core::encrypt_wallet_state(&seed(&input.seed_hex)?, input.value.get())
        .map_err(js_error)?;
    to_json(&record)
}

/// opens only an exact account-bound v2 record and returns recursively unique json.
#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_decrypt_local_state(
    seed_hex: &str,
    record_json: &str,
) -> Result<String, JsValue> {
    let value = zylith_core::decrypt_wallet_state_classified(&seed(seed_hex)?, record_json)
        .map_err(legacy_wallet_data_error)?;
    to_json(&value)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionLocalStateInput {
    value: serde_json::Value,
}

fn validate_local_state_input(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(value, &["value"])
}

fn validate_wallet_state_record(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "version",
            "key_schedule_version",
            "kdf",
            "algorithm",
            "account_id",
            "purpose",
            "nonce",
            "ciphertext",
        ],
    )
}

impl WalletSession {
    fn encrypt_local_state_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        if input_json.len() > zylith_core::MAX_WALLET_STATE_REQUEST_BYTES {
            return Err(INVALID_SESSION_OPERATION_ERROR);
        }
        let input: SessionLocalStateInput =
            session_json_validated(input_json, validate_local_state_input)?;
        let value =
            serde_json::to_string(&input.value).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        let record = zylith_core::encrypt_wallet_state(seed, &value)
            .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        session_output(&record)
    }

    fn decrypt_local_state_inner(&self, record_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let _: zylith_core::WalletStateRecord =
            session_json_validated(record_json, validate_wallet_state_record)?;
        let value = zylith_core::decrypt_wallet_state(seed, record_json)
            .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        session_output(&value)
    }

    fn decrypt_local_state_classified_inner(
        &self,
        record_json: &str,
    ) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let result =
            zylith_core::decrypt_wallet_state_classified(seed, record_json).and_then(|value| {
                serde_json::to_string(&value).map_err(|_| WalletDataError::DataInvalid)
            });
        classified_decrypt_output(result)
    }
}

#[wasm_bindgen]
impl WalletSession {
    #[wasm_bindgen(js_name = encryptLocalState)]
    pub fn encrypt_local_state(&self, input_json: &str) -> Result<String, JsValue> {
        self.encrypt_local_state_inner(input_json).map_err(js_error)
    }

    #[wasm_bindgen(js_name = decryptLocalState)]
    pub fn decrypt_local_state(&self, record_json: &str) -> Result<String, JsValue> {
        self.decrypt_local_state_inner(record_json)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = decryptLocalStateClassified)]
    pub fn decrypt_local_state_classified(&self, record_json: &str) -> Result<String, JsValue> {
        self.decrypt_local_state_classified_inner(record_json)
            .map_err(js_error)
    }
}

#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
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

#[cfg(test)]
fn seed(seed_hex: &str) -> Result<RecoverySeed, JsValue> {
    RecoverySeed::from_hex(seed_hex).map_err(js_error)
}

#[cfg(test)]
fn wallet_keys(seed_hex: &str) -> Result<WalletKeys, JsValue> {
    WalletKeys::from_seed(&seed(seed_hex)?).map_err(js_error)
}

fn felt(value: &str) -> Result<Felt, JsValue> {
    Felt::from_hex(value).map_err(|_| js_error(format!("{value} is not a hex felt")))
}

#[cfg(test)]
fn envelope_context(
    chain_id: &str,
    chain_context: &str,
) -> Result<zylith_core::private_envelope::PrivateEnvelopeContext, JsValue> {
    Ok(zylith_core::private_envelope::PrivateEnvelopeContext {
        chain_id: felt(chain_id)?,
        deployment_id: felt(chain_context)?,
    })
}

const STARKNET_FIELD_MODULUS: [u8; 32] = [
    0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
];
const LOCKED_SESSION_ERROR: &str = "wallet session is locked";
const INVALID_SESSION_ERROR: &str = "invalid wallet session";
const INVALID_SESSION_OPERATION_ERROR: &str = "invalid wallet session operation";

fn classified_decrypt_output(
    result: Result<String, WalletDataError>,
) -> Result<String, &'static str> {
    let value = match result {
        Ok(result) => serde_json::json!({
            "status": "OK",
            "result_b64": BASE64_STANDARD.encode(result.as_bytes()),
        }),
        Err(WalletDataError::MigrationRequired) => {
            serde_json::json!({"status": "MIGRATION_REQUIRED"})
        }
        Err(WalletDataError::DataInvalid) => serde_json::json!({"status": "DATA_INVALID"}),
    };
    serde_json::to_string(&value).map_err(|_| INVALID_SESSION_OPERATION_ERROR)
}

#[cfg(test)]
fn legacy_wallet_data_error(error: WalletDataError) -> JsValue {
    match error {
        WalletDataError::MigrationRequired => js_error("wallet migration required"),
        WalletDataError::DataInvalid => js_error(INVALID_SESSION_OPERATION_ERROR),
    }
}

fn canonical_felt(value: &str) -> Result<Felt, &'static str> {
    let digits = value.strip_prefix("0x").unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|digit| digit.is_ascii_hexdigit()) {
        return Err(INVALID_SESSION_ERROR);
    }
    let digits = digits.trim_start_matches('0');
    if digits.len() > 64 {
        return Err(INVALID_SESSION_ERROR);
    }
    let mut bytes = [0_u8; 32];
    for (index, digit) in digits.bytes().rev().enumerate() {
        let nibble = match digit {
            b'0'..=b'9' => digit - b'0',
            b'a'..=b'f' => digit - b'a' + 10,
            b'A'..=b'F' => digit - b'A' + 10,
            _ => return Err(INVALID_SESSION_ERROR),
        };
        bytes[31 - index / 2] |= nibble << ((index % 2) * 4);
    }
    if bytes >= STARKNET_FIELD_MODULUS {
        return Err(INVALID_SESSION_ERROR);
    }
    Ok(Felt::from_bytes_be(&bytes))
}

fn canonical_session_felt(value: &str) -> Result<Felt, &'static str> {
    let parsed = canonical_felt(value)?;
    (parsed != Felt::ZERO)
        .then_some(parsed)
        .ok_or(INVALID_SESSION_ERROR)
}

fn session_json_validated<T: for<'de> Deserialize<'de>>(
    source: &str,
    validate: fn(&serde_json::Value) -> Result<(), &'static str>,
) -> Result<T, &'static str> {
    let value = unique_wallet_json(source).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    validate(&value)?;
    serde_json::from_value(value).map_err(|_| INVALID_SESSION_OPERATION_ERROR)
}

fn validate_object_fields(value: &serde_json::Value, allowed: &[&str]) -> Result<(), &'static str> {
    let object = value.as_object().ok_or(INVALID_SESSION_OPERATION_ERROR)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(INVALID_SESSION_OPERATION_ERROR);
    }
    Ok(())
}

fn validate_array_items(
    value: Option<&serde_json::Value>,
    validate: fn(&serde_json::Value) -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    for item in value
        .and_then(serde_json::Value::as_array)
        .ok_or(INVALID_SESSION_OPERATION_ERROR)?
    {
        validate(item)?;
    }
    Ok(())
}

fn validate_note_fields(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "asset_id",
            "amount",
            "owner_public_key",
            "spend_authority",
            "withdraw_authority",
            "blinding",
            "nonce",
            "metadata_commitment",
        ],
    )
}

fn validate_execution_key(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(value, &["key_id", "algorithm", "public_key"])
}

fn validate_execution_registry(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(value, &["keys"])?;
    validate_array_items(value.get("keys"), validate_execution_key)
}

fn validate_order_query(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(value, &["order_id", "after_seq"])
}

fn validate_note_membership(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "subtree_path",
            "subtree_directions",
            "accumulator_path",
            "accumulator_directions",
        ],
    )
}

fn validate_recovery_capacity(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "generation",
            "status",
            "total",
            "consumed_base",
            "pool_quote",
            "scale",
        ],
    )
}

fn validate_order_owner(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "owner_public_key",
            "spend_authority",
            "withdraw_authority",
            "cancel_authority",
            "nonce",
        ],
    )
}

fn validate_residual_note(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "chain_context",
            "input_asset_id",
            "pair_id",
            "sell",
            "external",
            "remaining",
            "limit",
            "funding",
            "reserved",
            "reserved_offset",
            "reserved_seq",
            "expiry_ms",
            "order_id",
            "generation",
            "owner",
            "blinding",
        ],
    )?;
    validate_order_owner(value.get("owner").ok_or(INVALID_SESSION_OPERATION_ERROR)?)
}

fn validate_recovery_payload(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &["key_schedule_version", "algorithm", "nonce", "ciphertext"],
    )
}

fn validate_recovery_artifact(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "key_schedule_version",
            "artifact_id",
            "account_id",
            "kind",
            "sequence",
            "created_at_unix_ms",
            "payload",
        ],
    )?;
    validate_recovery_payload(
        value
            .get("payload")
            .ok_or(INVALID_SESSION_OPERATION_ERROR)?,
    )
}

fn validate_order_input_value(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "pair",
            "sell",
            "external",
            "amount",
            "limit",
            "expiry_ms",
            "funding",
            "registry",
        ],
    )?;
    validate_array_items(value.get("funding"), validate_note_fields)?;
    validate_execution_registry(
        value
            .get("registry")
            .ok_or(INVALID_SESSION_OPERATION_ERROR)?,
    )
}

fn validate_cancel_input_value(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(value, &["order_id", "registry"])?;
    validate_execution_registry(
        value
            .get("registry")
            .ok_or(INVALID_SESSION_OPERATION_ERROR)?,
    )
}

fn validate_withdraw_input_value(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(value, &["note", "exit_commitment", "registry"])?;
    validate_note_fields(value.get("note").ok_or(INVALID_SESSION_OPERATION_ERROR)?)?;
    validate_execution_registry(
        value
            .get("registry")
            .ok_or(INVALID_SESSION_OPERATION_ERROR)?,
    )
}

fn validate_status_input_value(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(value, &["registry", "orders", "nullifiers"])?;
    validate_execution_registry(
        value
            .get("registry")
            .ok_or(INVALID_SESSION_OPERATION_ERROR)?,
    )?;
    validate_array_items(value.get("orders"), validate_order_query)
}

fn validate_residual_input_value(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "note_root",
            "note",
            "membership",
            "output_asset_id",
            "fee_bps",
            "capacity",
            "input_exit_commitment",
            "output_exit_commitment",
        ],
    )?;
    validate_residual_note(value.get("note").ok_or(INVALID_SESSION_OPERATION_ERROR)?)?;
    validate_note_membership(
        value
            .get("membership")
            .ok_or(INVALID_SESSION_OPERATION_ERROR)?,
    )?;
    validate_recovery_capacity(
        value
            .get("capacity")
            .ok_or(INVALID_SESSION_OPERATION_ERROR)?,
    )
}

fn session_output<T: Serialize>(value: &T) -> Result<String, &'static str> {
    serde_json::to_string(value).map_err(|_| INVALID_SESSION_OPERATION_ERROR)
}

fn public_config_for_seed(seed: &RecoverySeed) -> Result<WalletPublicConfig, &'static str> {
    let schedule = WalletKeyScheduleV2::from_seed(seed);
    let keys = WalletKeys::from_seed(seed).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    Ok(WalletPublicConfig {
        key_schedule_version: WALLET_KEY_SCHEDULE_VERSION,
        account_id: schedule.account_id(),
        spend_authority: felt_hex(&public_key(&keys.spend_key)),
        owner_tag: felt_hex(
            &schedule
                .owner_tag()
                .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
        ),
        withdraw_authority: felt_hex(&public_key(&keys.withdraw_key)),
    })
}

/// an unlocked wallet bound to one immutable chain and deployment context.
///
/// the session deliberately has no debug representation that could grow to expose retained
/// secret state.
///
/// ```compile_fail
/// use std::fmt::Debug;
/// use zylith_wallet_wasm::WalletSession;
/// fn requires_debug<T: Debug>() {}
/// requires_debug::<WalletSession>();
/// ```
#[wasm_bindgen]
pub struct WalletSession {
    seed: Option<RecoverySeed>,
    chain_id: Felt,
    deployment_id: Felt,
}

impl WalletSession {
    fn try_new(
        seed_bytes: Vec<u8>,
        chain_id: &str,
        deployment_id: &str,
    ) -> Result<Self, &'static str> {
        let seed = RecoverySeed::from_bytes(seed_bytes).map_err(|_| INVALID_SESSION_ERROR)?;
        let chain_id = canonical_session_felt(chain_id)?;
        let deployment_id = canonical_session_felt(deployment_id)?;
        Ok(Self {
            seed: Some(seed),
            chain_id,
            deployment_id,
        })
    }

    fn seed_ref(&self) -> Result<&RecoverySeed, &'static str> {
        self.seed.as_ref().ok_or(LOCKED_SESSION_ERROR)
    }

    fn wipe_seed(&mut self) {
        if let Some(seed) = self.seed.as_mut() {
            seed.zeroize();
        }
        self.seed = None;
    }

    fn context(&self) -> zylith_core::private_envelope::PrivateEnvelopeContext {
        zylith_core::private_envelope::PrivateEnvelopeContext {
            chain_id: self.chain_id,
            deployment_id: self.deployment_id,
        }
    }

    fn public_config_inner(&self) -> Result<String, &'static str> {
        session_output(&public_config_for_seed(self.seed_ref()?)?)
    }

    fn recovery_auth_tag_inner(&self) -> Result<String, &'static str> {
        Ok(derive_wallet_recovery_auth_tag(self.seed_ref()?))
    }
}

impl Drop for WalletSession {
    fn drop(&mut self) {
        self.wipe_seed();
    }
}

#[wasm_bindgen]
impl WalletSession {
    #[wasm_bindgen(constructor)]
    pub fn new(
        seed_bytes: Vec<u8>,
        chain_id: &str,
        deployment_id: &str,
    ) -> Result<WalletSession, JsValue> {
        Self::try_new(seed_bytes, chain_id, deployment_id).map_err(js_error)
    }

    pub fn lock(&mut self) {
        self.wipe_seed();
    }

    #[wasm_bindgen(js_name = isLocked)]
    pub fn is_locked(&self) -> bool {
        self.seed.is_none()
    }

    #[wasm_bindgen(js_name = publicConfig)]
    pub fn public_config(&self) -> Result<String, JsValue> {
        self.public_config_inner().map_err(js_error)
    }

    #[wasm_bindgen(js_name = recoveryAuthTag)]
    pub fn recovery_auth_tag(&self) -> Result<String, JsValue> {
        self.recovery_auth_tag_inner().map_err(js_error)
    }
}

/// A sealed request and the per-request response root used to derive fresh response keys.
#[derive(Serialize)]
pub struct Sealed {
    pub sealed: SealedRequest,
    pub response_key: String,
}

fn seal(
    registry: &PrivateExecutionKeyRegistry,
    context: zylith_core::private_envelope::PrivateEnvelopeContext,
    request: PrivateRequest,
) -> Result<Sealed, JsValue> {
    let (sealed, response_key) = seal_request(registry, context, &request).map_err(js_error)?;
    Ok(Sealed {
        sealed,
        response_key: hex::encode(response_key.as_slice()),
    })
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_generate_seed_hex() -> String {
    RecoverySeed::generate().to_hex()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalletPublicConfig {
    #[serde(
        deserialize_with = "zylith_core::wallet_crypto::deserialize_wallet_key_schedule_version"
    )]
    pub key_schedule_version: u16,
    pub account_id: String,
    pub spend_authority: String,
    pub owner_tag: String,
    pub withdraw_authority: String,
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_derive_public_config(seed_hex: &str) -> Result<String, JsValue> {
    let seed = seed(seed_hex)?;
    to_json(&public_config_for_seed(&seed).map_err(js_error)?)
}

#[cfg(test)]
#[derive(Deserialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct ProofSignerInput {
    seed_hex: String,
    chain_id: String,
    proof_signer_class_hash: String,
}

#[derive(Serialize, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
struct ProofSignerOutput {
    key_schedule_version: u16,
    proof_signer_private_key: String,
    proof_signer_salt: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionProofSignerInput {
    proof_signer_class_hash: String,
}

fn proof_signer_for_seed(
    seed: &RecoverySeed,
    chain_id: Felt,
    proof_signer_class_hash: &str,
) -> Result<ProofSignerOutput, &'static str> {
    let chain_id = felt_hex(&chain_id);
    let context = ProofSignerDerivationContext::from_hex(&chain_id, proof_signer_class_hash)
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let schedule = WalletKeyScheduleV2::from_seed(seed);
    let context = context.parts();
    Ok(ProofSignerOutput {
        key_schedule_version: WALLET_KEY_SCHEDULE_VERSION,
        proof_signer_private_key: felt_hex(
            &schedule
                .derive_nonzero_stark_scalar(WalletFieldPurpose::ProofSignerKey, &context)
                .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
        ),
        proof_signer_salt: felt_hex(
            &schedule
                .derive_nonzero_field(WalletFieldPurpose::ProofSignerSalt, &context)
                .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
        ),
    })
}

impl WalletSession {
    fn derive_proof_signer_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionProofSignerInput = session_json_validated(input_json, |value| {
            validate_object_fields(value, &["proof_signer_class_hash"])
        })?;
        session_output(&proof_signer_for_seed(
            seed,
            self.chain_id,
            &input.proof_signer_class_hash,
        )?)
    }
}

#[wasm_bindgen]
impl WalletSession {
    #[wasm_bindgen(js_name = deriveProofSigner)]
    pub fn derive_proof_signer(&self, input_json: &str) -> Result<String, JsValue> {
        self.derive_proof_signer_inner(input_json).map_err(js_error)
    }
}

/// derives v2 signer material from the canonical chain and selected account class.
#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_derive_proof_signer(input_json: &str) -> Result<String, JsValue> {
    let invalid = || js_error("invalid v2 proof signer derivation input");
    let input: ProofSignerInput =
        serde_json::from_value(unique_wallet_json(input_json).map_err(|_| invalid())?)
            .map_err(|_| invalid())?;
    let seed = seed(&input.seed_hex).map_err(|_| invalid())?;
    let chain_id = canonical_session_felt(&input.chain_id).map_err(|_| invalid())?;
    to_json(
        &proof_signer_for_seed(&seed, chain_id, &input.proof_signer_class_hash)
            .map_err(|_| invalid())?,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MarketIdsInput {
    pub pair: String,
    pub base_asset: String,
    pub quote_asset: String,
}

#[derive(Serialize)]
pub struct MarketIdsOutput {
    pub pair_id: String,
    pub base_asset_id: String,
    pub quote_asset_id: String,
}

/// the canonical protocol ids for a manifest market.
#[wasm_bindgen]
pub fn zylith_wallet_market_ids(input_json: &str) -> Result<String, JsValue> {
    let input: MarketIdsInput = from_json(input_json)?;
    to_json(&MarketIdsOutput {
        pair_id: format!("{:#x}", pair_id(&input.pair)),
        base_asset_id: format!("{:#x}", asset_id(&input.base_asset)),
        quote_asset_id: format!("{:#x}", asset_id(&input.quote_asset)),
    })
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_recovery_auth_tag(seed_hex: &str) -> Result<String, JsValue> {
    let seed = seed(seed_hex)?;
    Ok(derive_wallet_recovery_auth_tag(&seed))
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DepositRequest {
    pub seed_hex: String,
    pub chain_id: String,
    pub bridge_address: String,
    pub asset_id: AssetId,
    #[serde(with = "u128_decimal")]
    pub amount: u128,
    #[serde(with = "u64_decimal")]
    pub deposit_nonce: u64,
}

/// a deposit plan and the note it creates, as the exchange sees it.
#[derive(Serialize)]
pub struct DepositResponse {
    #[serde(flatten)]
    pub plan: DepositSubmissionPlan,
    pub note_fields: NoteFields,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionDepositRequest {
    bridge_address: String,
    asset_id: AssetId,
    #[serde(with = "u128_decimal")]
    amount: u128,
    #[serde(with = "u64_decimal")]
    deposit_nonce: u64,
}

fn deposit_for_seed(
    seed: &RecoverySeed,
    chain_id: Felt,
    request: SessionDepositRequest,
) -> Result<DepositResponse, &'static str> {
    let context = DepositDerivationContext::from_hex(&felt_hex(&chain_id), &request.bridge_address)
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let keys = WalletKeys::from_seed(seed).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let intent = DepositIntent {
        asset_id: request.asset_id,
        amount: request.amount,
        deposit_nonce: request.deposit_nonce,
        recipient_owner_public_key: felt_hex(&keys.owner_public_key),
        recipient_spend_authority: felt_hex(&public_key(&keys.spend_key)),
        recipient_withdraw_authority: felt_hex(&public_key(&keys.withdraw_key)),
    };
    let plan = build_wallet_deposit_submission_plan(seed, &context, &intent)
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let note_fields =
        NoteFields::from_note(&plan.note).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    Ok(DepositResponse { plan, note_fields })
}

impl WalletSession {
    fn build_deposit_submission_plan_inner(
        &self,
        input_json: &str,
    ) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionDepositRequest = session_json_validated(input_json, |value| {
            validate_object_fields(
                value,
                &["bridge_address", "asset_id", "amount", "deposit_nonce"],
            )
        })?;
        session_output(&deposit_for_seed(seed, self.chain_id, input)?)
    }
}

#[wasm_bindgen]
impl WalletSession {
    #[wasm_bindgen(js_name = buildDepositSubmissionPlan)]
    pub fn build_deposit_submission_plan(&self, input_json: &str) -> Result<String, JsValue> {
        self.build_deposit_submission_plan_inner(input_json)
            .map_err(js_error)
    }
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_build_deposit_submission_plan(input_json: &str) -> Result<String, JsValue> {
    let request: DepositRequest = from_json(input_json)?;
    let seed = seed(&request.seed_hex)?;
    let chain_id = canonical_session_felt(&request.chain_id).map_err(js_error)?;
    to_json(
        &deposit_for_seed(
            &seed,
            chain_id,
            SessionDepositRequest {
                bridge_address: request.bridge_address,
                asset_id: request.asset_id,
                amount: request.amount,
                deposit_nonce: request.deposit_nonce,
            },
        )
        .map_err(js_error)?,
    )
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderInput {
    pub seed_hex: String,
    /// the exchange's address, which every signature binds.
    pub chain_context: String,
    pub chain_id: String,
    /// the pair's manifest name, such as strk/usdc.
    pub pair: String,
    pub sell: bool,
    pub external: bool,
    #[serde(with = "u128_decimal")]
    pub amount: u128,
    #[serde(with = "u128_decimal")]
    pub limit: u128,
    pub expiry_ms: u64,
    pub funding: Vec<NoteFields>,
    pub registry: PrivateExecutionKeyRegistry,
}

/// a sealed order and what the wallet keeps to follow it and recover its outputs.
#[derive(Serialize)]
pub struct OrderOutput {
    pub order_id: String,
    pub terms: OrderTerms,
    pub nullifiers: Vec<String>,
    #[serde(flatten)]
    pub sealed: Sealed,
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_build_order_request(input_json: &str) -> Result<String, JsValue> {
    let input: OrderInput = from_json(input_json)?;
    let keys = wallet_keys(&input.seed_hex)?;
    let context = envelope_context(&input.chain_id, &input.chain_context)?;
    to_json(
        &order_for_keys(
            &keys,
            context,
            SessionOrderInput {
                pair: input.pair,
                sell: input.sell,
                external: input.external,
                amount: input.amount,
                limit: input.limit,
                expiry_ms: input.expiry_ms,
                funding: input.funding,
                registry: input.registry,
            },
        )
        .map_err(js_error)?,
    )
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelInput {
    pub seed_hex: String,
    pub chain_context: String,
    pub chain_id: String,
    pub order_id: String,
    pub registry: PrivateExecutionKeyRegistry,
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_build_cancel_request(input_json: &str) -> Result<String, JsValue> {
    let input: CancelInput = from_json(input_json)?;
    let keys = wallet_keys(&input.seed_hex)?;
    let context = envelope_context(&input.chain_id, &input.chain_context)?;
    to_json(
        &cancel_for_keys(
            &keys,
            context,
            SessionCancelInput {
                order_id: input.order_id,
                registry: input.registry,
            },
        )
        .map_err(js_error)?,
    )
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WithdrawInput {
    pub seed_hex: String,
    pub chain_context: String,
    pub chain_id: String,
    pub note: NoteFields,
    /// reuse the exit a retried withdrawal already chose; a fresh one otherwise.
    #[serde(default)]
    pub exit_commitment: Option<String>,
    pub registry: PrivateExecutionKeyRegistry,
}

#[derive(Serialize)]
pub struct WithdrawOutput {
    pub nullifier: String,
    pub exit_commitment: String,
    #[serde(flatten)]
    pub sealed: Sealed,
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_build_withdraw_request(input_json: &str) -> Result<String, JsValue> {
    let input: WithdrawInput = from_json(input_json)?;
    let keys = wallet_keys(&input.seed_hex)?;
    let context = envelope_context(&input.chain_id, &input.chain_context)?;
    to_json(
        &withdraw_for_keys(
            &keys,
            context,
            SessionWithdrawInput {
                note: input.note,
                exit_commitment: input.exit_commitment,
                registry: input.registry,
            },
        )
        .map_err(js_error)?,
    )
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusInput {
    pub registry: PrivateExecutionKeyRegistry,
    pub seed_hex: String,
    pub chain_context: String,
    pub chain_id: String,
    pub orders: Vec<OrderQuery>,
    pub nullifiers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionOrderInput {
    pair: String,
    sell: bool,
    external: bool,
    #[serde(with = "u128_decimal")]
    amount: u128,
    #[serde(with = "u128_decimal")]
    limit: u128,
    expiry_ms: u64,
    funding: Vec<NoteFields>,
    registry: PrivateExecutionKeyRegistry,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionCancelInput {
    order_id: String,
    registry: PrivateExecutionKeyRegistry,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionWithdrawInput {
    note: NoteFields,
    #[serde(default)]
    exit_commitment: Option<String>,
    registry: PrivateExecutionKeyRegistry,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionStatusInput {
    registry: PrivateExecutionKeyRegistry,
    orders: Vec<OrderQuery>,
    nullifiers: Vec<String>,
}

fn order_for_keys(
    keys: &WalletKeys,
    context: zylith_core::private_envelope::PrivateEnvelopeContext,
    input: SessionOrderInput,
) -> Result<OrderOutput, &'static str> {
    let request = keys
        .order(
            context.deployment_id,
            pair_id(&input.pair),
            input.sell,
            input.external,
            input.amount,
            input.limit,
            input.expiry_ms,
            input.funding,
        )
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    Ok(OrderOutput {
        order_id: felt_hex(&request.order_id()),
        nullifiers: request
            .funding
            .iter()
            .map(|note| felt_hex(&note.nullifier()))
            .collect(),
        terms: request.terms.clone(),
        sealed: seal(&input.registry, context, PrivateRequest::Order(request))
            .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
    })
}

fn cancel_for_keys(
    keys: &WalletKeys,
    context: zylith_core::private_envelope::PrivateEnvelopeContext,
    input: SessionCancelInput,
) -> Result<Sealed, &'static str> {
    let order_id = canonical_felt(&input.order_id).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let request = keys
        .cancel(context.deployment_id, order_id)
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    seal(&input.registry, context, PrivateRequest::Cancel(request))
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)
}

fn withdraw_for_keys(
    keys: &WalletKeys,
    context: zylith_core::private_envelope::PrivateEnvelopeContext,
    input: SessionWithdrawInput,
) -> Result<WithdrawOutput, &'static str> {
    let exit_commitment = match &input.exit_commitment {
        Some(exit) => canonical_felt(exit).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
        None => random_felt(),
    };
    let request = keys
        .withdraw(context.deployment_id, input.note, exit_commitment)
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    Ok(WithdrawOutput {
        nullifier: felt_hex(&request.note.nullifier()),
        exit_commitment: felt_hex(&exit_commitment),
        sealed: seal(&input.registry, context, PrivateRequest::Withdraw(request))
            .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
    })
}

fn status_for_keys(
    keys: &WalletKeys,
    context: zylith_core::private_envelope::PrivateEnvelopeContext,
    input: SessionStatusInput,
) -> Result<Vec<Sealed>, &'static str> {
    let withdrawals = input
        .nullifiers
        .iter()
        .map(|nullifier| {
            let nullifier =
                canonical_felt(nullifier).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
            Ok(WithdrawalQuery {
                nullifier,
                authorization: sign_message(
                    &keys.withdraw_key,
                    &withdrawal_status_message(context.deployment_id, nullifier),
                )
                .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    chunk_status(StatusRequest {
        orders: input.orders,
        withdrawals,
    })
    .into_iter()
    .map(|status| {
        seal(&input.registry, context, PrivateRequest::Status(status))
            .map_err(|_| INVALID_SESSION_OPERATION_ERROR)
    })
    .collect()
}

impl WalletSession {
    fn build_order_request_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionOrderInput =
            session_json_validated(input_json, validate_order_input_value)?;
        let keys = WalletKeys::from_seed(seed).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        session_output(&order_for_keys(&keys, self.context(), input)?)
    }

    fn build_cancel_request_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionCancelInput =
            session_json_validated(input_json, validate_cancel_input_value)?;
        let keys = WalletKeys::from_seed(seed).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        session_output(&cancel_for_keys(&keys, self.context(), input)?)
    }

    fn build_withdraw_request_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionWithdrawInput =
            session_json_validated(input_json, validate_withdraw_input_value)?;
        let keys = WalletKeys::from_seed(seed).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        session_output(&withdraw_for_keys(&keys, self.context(), input)?)
    }

    fn build_status_requests_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionStatusInput =
            session_json_validated(input_json, validate_status_input_value)?;
        let keys = WalletKeys::from_seed(seed).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        session_output(&status_for_keys(&keys, self.context(), input)?)
    }
}

#[wasm_bindgen]
impl WalletSession {
    #[wasm_bindgen(js_name = buildOrderRequest)]
    pub fn build_order_request(&self, input_json: &str) -> Result<String, JsValue> {
        self.build_order_request_inner(input_json).map_err(js_error)
    }

    #[wasm_bindgen(js_name = buildCancelRequest)]
    pub fn build_cancel_request(&self, input_json: &str) -> Result<String, JsValue> {
        self.build_cancel_request_inner(input_json)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = buildWithdrawRequest)]
    pub fn build_withdraw_request(&self, input_json: &str) -> Result<String, JsValue> {
        self.build_withdraw_request_inner(input_json)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = buildStatusRequests)]
    pub fn build_status_requests(&self, input_json: &str) -> Result<String, JsValue> {
        self.build_status_requests_inner(input_json)
            .map_err(js_error)
    }
}

/// the fingerprint a deployment manifest pins for an execution key registry.
#[wasm_bindgen]
pub fn zylith_wallet_registry_fingerprint(registry_json: &str) -> Result<String, JsValue> {
    let registry: PrivateExecutionKeyRegistry = from_json(registry_json)?;
    registry.fingerprint().map_err(js_error)
}

/// the sealed lookups for every order and withdrawal the wallet follows, chunked within the
/// shared status limit.
#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_build_status_requests(input_json: &str) -> Result<String, JsValue> {
    let input: StatusInput = from_json(input_json)?;
    let keys = wallet_keys(&input.seed_hex)?;
    let context = envelope_context(&input.chain_id, &input.chain_context)?;
    to_json(
        &status_for_keys(
            &keys,
            context,
            SessionStatusInput {
                registry: input.registry,
                orders: input.orders,
                nullifiers: input.nullifiers,
            },
        )
        .map_err(js_error)?,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransitionRecords {
    pub seq: u32,
    pub outputs: Vec<OutputRecord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransitionOutputRootInput {
    pub outputs: Vec<OutputRecord>,
}

/// recomputes the authenticated output root before browser recovery trusts indexer records.
#[wasm_bindgen]
pub fn zylith_wallet_transition_output_root(input_json: &str) -> Result<String, JsValue> {
    let input: TransitionOutputRootInput = from_json(input_json)?;
    if input.outputs.is_empty() || !input.outputs.len().is_power_of_two() {
        return Err(js_error("transition outputs are not a padded tree"));
    }
    to_json(&format!(
        "{:#x}",
        output_tree_root(
            &input
                .outputs
                .iter()
                .map(|output| output.leaf)
                .collect::<Vec<_>>()
        )
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoverInput {
    pub terms: OrderTerms,
    /// the pair's assets by manifest name, such as strk and usdc.
    pub base_asset: String,
    pub quote_asset: String,
    pub transitions: Vec<TransitionRecords>,
}

/// the order's outputs in the chain's transition records: the operator's report is never
/// trusted for a note, only for where to look.
#[wasm_bindgen]
pub fn zylith_wallet_recover_order_outputs(input_json: &str) -> Result<String, JsValue> {
    let input: RecoverInput = from_json(input_json)?;
    let (base, quote) = (asset_id(&input.base_asset), asset_id(&input.quote_asset));
    let recovered = input
        .transitions
        .iter()
        .flat_map(|transition| {
            recover_order_outputs(
                &input.terms,
                base,
                quote,
                transition.seq,
                &transition.outputs,
            )
        })
        .collect::<Vec<RecoveredOutput>>();
    to_json(&recovered)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoverResidualInput {
    pub chain_context: String,
    pub terms: OrderTerms,
    pub base_asset: String,
    pub quote_asset: String,
    pub transitions: Vec<TransitionRecords>,
}

/// the order's residual generations recoverable from public transition records.
#[wasm_bindgen]
pub fn zylith_wallet_recover_order_residuals(input_json: &str) -> Result<String, JsValue> {
    let input: RecoverResidualInput = from_json(input_json)?;
    let (base, quote) = (asset_id(&input.base_asset), asset_id(&input.quote_asset));
    let chain_context = felt(&input.chain_context)?;
    to_json(
        &input
            .transitions
            .iter()
            .filter_map(|transition| {
                recover_order_residual(
                    chain_context,
                    &input.terms,
                    base,
                    quote,
                    transition.seq,
                    &transition.outputs,
                )
            })
            .collect::<Vec<_>>(),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResidualRecoveryQuoteInput {
    pub note: ResidualNote,
    pub capacity: RecoveryCapacity,
    #[serde(with = "u128_decimal")]
    pub fee_bps: u128,
}

#[derive(Serialize)]
pub struct ResidualRecoveryQuoteOutput {
    pub input_amount: String,
    pub output_amount: String,
    pub fee_amount: String,
}

#[wasm_bindgen]
pub fn zylith_wallet_quote_residual_recovery(input_json: &str) -> Result<String, JsValue> {
    let input: ResidualRecoveryQuoteInput = from_json(input_json)?;
    let (input_amount, output_amount, fee_amount) =
        residual_recovery_amounts(&input.note, input.capacity, input.fee_bps).map_err(js_error)?;
    to_json(&ResidualRecoveryQuoteOutput {
        input_amount: input_amount.to_string(),
        output_amount: output_amount.to_string(),
        fee_amount: fee_amount.to_string(),
    })
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildResidualRecoveryInput {
    pub seed_hex: String,
    pub note_root: String,
    pub note: ResidualNote,
    pub membership: NoteMembership,
    pub output_asset_id: String,
    #[serde(with = "u128_decimal")]
    pub fee_bps: u128,
    pub capacity: RecoveryCapacity,
    #[serde(default)]
    pub input_exit_commitment: Option<String>,
    #[serde(default)]
    pub output_exit_commitment: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionBuildResidualRecoveryInput {
    note_root: String,
    note: ResidualNote,
    membership: NoteMembership,
    output_asset_id: String,
    #[serde(with = "u128_decimal")]
    fee_bps: u128,
    capacity: RecoveryCapacity,
    #[serde(default)]
    input_exit_commitment: Option<String>,
    #[serde(default)]
    output_exit_commitment: Option<String>,
}

#[derive(Serialize)]
pub struct BuildResidualRecoveryOutput {
    pub public: zylith_core::exchange::ResidualRecoveryPublic,
    pub witness: Vec<String>,
    pub calldata: Vec<String>,
    pub input_exit_commitment: Option<String>,
    pub output_exit_commitment: Option<String>,
}

fn residual_exit_nonce(keys: &WalletKeys, note: &ResidualNote, leg: u64) -> Felt {
    let nonce = sponge(&[
        short_string("zylith_res_exit_nonce_v1"),
        keys.withdraw_key,
        note.chain_context,
        note.commitment(),
        Felt::from(leg),
    ]);
    if nonce == Felt::ZERO {
        Felt::ONE
    } else {
        nonce
    }
}

fn residual_recovery_for_keys(
    keys: &WalletKeys,
    input: SessionBuildResidualRecoveryInput,
) -> Result<BuildResidualRecoveryOutput, &'static str> {
    if input.note.owner != keys.owner(input.note.owner.nonce) {
        return Err(INVALID_SESSION_OPERATION_ERROR);
    }
    let (input_amount, output_amount, _) =
        residual_recovery_amounts(&input.note, input.capacity, input.fee_bps)
            .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let exit = |amount: u128,
                leg: u64,
                supplied: Option<&String>|
     -> Result<(RecoveryExit, Option<Felt>), &'static str> {
        if amount == 0 {
            if supplied.is_some() {
                return Err(INVALID_SESSION_OPERATION_ERROR);
            }
            return Ok((RecoveryExit::default(), None));
        }
        let commitment = match supplied {
            Some(value) => Felt::from_hex(value).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
            None => residual_exit_nonce(keys, &input.note, leg),
        };
        let authority = public_key(&keys.exit_key(input.note.chain_context, commitment));
        Ok((
            RecoveryExit {
                commitment,
                authority,
            },
            Some(commitment),
        ))
    };
    let (input_exit, input_exit_commitment) =
        exit(input_amount, 0, input.input_exit_commitment.as_ref())?;
    let (output_exit, output_exit_commitment) =
        exit(output_amount, 1, input.output_exit_commitment.as_ref())?;
    let mut recovery = ResidualRecoveryInput {
        note_root: Felt::from_hex(&input.note_root).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
        note: input.note,
        membership: input.membership,
        output_asset_id: Felt::from_hex(&input.output_asset_id)
            .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?,
        fee_bps: input.fee_bps,
        capacity: input.capacity,
        input_exit,
        output_exit,
        authorization: Signature {
            r: Felt::ZERO,
            s: Felt::ZERO,
        },
    };
    let preview =
        preview_residual_recovery(&recovery).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    recovery.authorization = sign_message(
        &keys.withdraw_key,
        &residual_recovery_authorization_message(preview.commitment),
    )
    .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let (public, witness) =
        build_residual_recovery(&recovery).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let calldata = residual_recovery_calldata(&public);
    Ok(BuildResidualRecoveryOutput {
        public,
        witness: witness.iter().map(|value| format!("{value:#x}")).collect(),
        calldata: calldata.iter().map(|value| format!("{value:#x}")).collect(),
        input_exit_commitment: input_exit_commitment.map(|value| format!("{value:#x}")),
        output_exit_commitment: output_exit_commitment.map(|value| format!("{value:#x}")),
    })
}

impl WalletSession {
    fn build_residual_recovery_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionBuildResidualRecoveryInput =
            session_json_validated(input_json, validate_residual_input_value)?;
        if input.note.chain_context != self.deployment_id {
            return Err(INVALID_SESSION_OPERATION_ERROR);
        }
        let keys = WalletKeys::from_seed(seed).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        session_output(&residual_recovery_for_keys(&keys, input)?)
    }
}

#[wasm_bindgen]
impl WalletSession {
    #[wasm_bindgen(js_name = buildResidualRecovery)]
    pub fn build_residual_recovery(&self, input_json: &str) -> Result<String, JsValue> {
        self.build_residual_recovery_inner(input_json)
            .map_err(js_error)
    }
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_build_residual_recovery(input_json: &str) -> Result<String, JsValue> {
    let input: BuildResidualRecoveryInput = from_json(input_json)?;
    let keys = wallet_keys(&input.seed_hex)?;
    to_json(
        &residual_recovery_for_keys(
            &keys,
            SessionBuildResidualRecoveryInput {
                note_root: input.note_root,
                note: input.note,
                membership: input.membership,
                output_asset_id: input.output_asset_id,
                fee_bps: input.fee_bps,
                capacity: input.capacity,
                input_exit_commitment: input.input_exit_commitment,
                output_exit_commitment: input.output_exit_commitment,
            },
        )
        .map_err(js_error)?,
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildNoteMembershipInput {
    pub batch_roots: Vec<String>,
    pub batch_index: usize,
    pub batch_leaves: Vec<String>,
    pub leaf_index: usize,
}

#[derive(Serialize)]
pub struct BuildNoteMembershipOutput {
    pub note_root: String,
    pub membership: NoteMembership,
}

/// rebuilds one membership from the public, globally ordered note-batch history.
#[wasm_bindgen]
pub fn zylith_wallet_build_note_membership(input_json: &str) -> Result<String, JsValue> {
    let input: BuildNoteMembershipInput = from_json(input_json)?;
    if input.batch_roots.is_empty()
        || input.batch_index >= input.batch_roots.len()
        || input.batch_leaves.is_empty()
        || input.leaf_index >= input.batch_leaves.len()
    {
        return Err(js_error("note membership position is out of range"));
    }
    let roots = input
        .batch_roots
        .iter()
        .map(|root| felt(root))
        .collect::<Result<Vec<_>, _>>()?;
    let leaves = input
        .batch_leaves
        .iter()
        .map(|leaf| felt(leaf))
        .collect::<Result<Vec<_>, _>>()?;
    if output_tree_root(&leaves) != roots[input.batch_index] {
        return Err(js_error(
            "the note batch leaves do not match its public root",
        ));
    }
    let mut accumulator = NoteAccumulator::default();
    for root in roots {
        accumulator.append(root);
    }
    let membership = accumulator
        .membership(input.batch_index, &leaves, input.leaf_index)
        .ok_or_else(|| js_error("the note membership cannot be constructed"))?;
    to_json(&BuildNoteMembershipOutput {
        note_root: format!("{:#x}", accumulator.root()),
        membership,
    })
}

#[derive(Serialize)]
pub struct NoteSummary {
    pub commitment: String,
    pub nullifier: String,
    pub leaf: String,
}

#[wasm_bindgen]
pub fn zylith_wallet_note_summary(note_json: &str) -> Result<String, JsValue> {
    let note: NoteFields = from_json(note_json)?;
    to_json(&NoteSummary {
        commitment: format!("{:#x}", note.commitment()),
        nullifier: format!("{:#x}", note.nullifier()),
        leaf: format!("{:#x}", note.output_leaf()),
    })
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoverySnapshotInput {
    pub seed_hex: String,
    pub sequence: u64,
    pub created_at_unix_ms: u64,
    pub payload_json: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionRecoverySnapshotInput {
    sequence: u64,
    created_at_unix_ms: u64,
    payload_json: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoverySnapshotPayload {
    #[serde(
        deserialize_with = "zylith_core::wallet_crypto::deserialize_wallet_key_schedule_version"
    )]
    version: u16,
    #[serde(
        deserialize_with = "zylith_core::wallet_crypto::deserialize_wallet_key_schedule_version"
    )]
    key_schedule_version: u16,
    scope: String,
    state: RecoveryWalletState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    padding: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecoveryWalletState {
    #[serde(
        deserialize_with = "zylith_core::wallet_crypto::deserialize_wallet_key_schedule_version"
    )]
    version: u16,
    #[serde(
        deserialize_with = "zylith_core::wallet_crypto::deserialize_wallet_key_schedule_version"
    )]
    key_schedule_version: u16,
    notes: Vec<serde_json::Value>,
    orders: Vec<serde_json::Value>,
    scanned_seq: u64,
}

fn validate_recovery_snapshot_payload_value(value: &serde_json::Value) -> Result<(), &'static str> {
    validate_object_fields(
        value,
        &[
            "version",
            "key_schedule_version",
            "scope",
            "state",
            "padding",
        ],
    )?;
    let state = value.get("state").ok_or(INVALID_SESSION_OPERATION_ERROR)?;
    validate_object_fields(
        state,
        &[
            "version",
            "key_schedule_version",
            "notes",
            "orders",
            "scanned_seq",
        ],
    )?;
    state
        .get("notes")
        .and_then(serde_json::Value::as_array)
        .ok_or(INVALID_SESSION_OPERATION_ERROR)?;
    state
        .get("orders")
        .and_then(serde_json::Value::as_array)
        .ok_or(INVALID_SESSION_OPERATION_ERROR)?;
    Ok(())
}

fn validate_recovery_snapshot_payload_string(source: &str) -> Result<(), &'static str> {
    let value = unique_wallet_json(source).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    validate_recovery_snapshot_payload_value(&value)
}

fn recovery_snapshot_payload(value: &str) -> Result<serde_json::Value, JsValue> {
    let payload: RecoverySnapshotPayload = serde_json::from_value(unique_wallet_json(value)?)
        .map_err(|_| js_error("wallet migration required"))?;
    serde_json::to_value(payload).map_err(js_error)
}

fn unique_wallet_json(value: &str) -> Result<serde_json::Value, JsValue> {
    let mut deserializer = serde_json::Deserializer::from_str(value);
    let parsed = zylith_core::deserialize_unique_wallet_json(&mut deserializer)
        .map_err(|_| js_error("wallet migration required"))?;
    deserializer
        .end()
        .map_err(|_| js_error("wallet migration required"))?;
    Ok(parsed)
}

fn create_recovery_snapshot_for_seed(
    seed: &RecoverySeed,
    input: SessionRecoverySnapshotInput,
) -> Result<RecoveryArtifact, &'static str> {
    let payload = recovery_snapshot_payload(&input.payload_json)
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    create_recovery_artifact(
        seed,
        RecoveryArtifactKind::Snapshot,
        input.sequence,
        input.created_at_unix_ms,
        &payload,
    )
    .map_err(|_| INVALID_SESSION_OPERATION_ERROR)
}

fn decrypt_recovery_artifact_for_seed(
    seed: &RecoverySeed,
    artifact: RecoveryArtifact,
) -> Result<serde_json::Value, &'static str> {
    let payload = decrypt_recovery_artifact_payload(seed, &artifact)
        .map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let encoded = serde_json::to_string(&payload).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    recovery_snapshot_payload(&encoded).map_err(|_| INVALID_SESSION_OPERATION_ERROR)
}

fn classify_recovery_artifact_shape(value: &serde_json::Value) -> Result<(), WalletDataError> {
    let object = value.as_object().ok_or(WalletDataError::DataInvalid)?;
    let fields = [
        "key_schedule_version",
        "artifact_id",
        "account_id",
        "kind",
        "sequence",
        "created_at_unix_ms",
        "payload",
    ];
    if object.len() != fields.len() || object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(WalletDataError::MigrationRequired);
    }
    if object
        .get("key_schedule_version")
        .and_then(serde_json::Value::as_u64)
        != Some(u64::from(WALLET_KEY_SCHEDULE_VERSION))
    {
        return Err(WalletDataError::MigrationRequired);
    }
    let payload = object
        .get("payload")
        .and_then(serde_json::Value::as_object)
        .ok_or(WalletDataError::DataInvalid)?;
    let payload_fields = ["key_schedule_version", "algorithm", "nonce", "ciphertext"];
    if payload.len() != payload_fields.len()
        || payload
            .keys()
            .any(|key| !payload_fields.contains(&key.as_str()))
    {
        return Err(WalletDataError::MigrationRequired);
    }
    if payload
        .get("key_schedule_version")
        .and_then(serde_json::Value::as_u64)
        != Some(u64::from(WALLET_KEY_SCHEDULE_VERSION))
        || payload.get("algorithm").and_then(serde_json::Value::as_str)
            != Some("aes-256-gcm/recovery-v1")
    {
        return Err(WalletDataError::MigrationRequired);
    }
    for field in ["artifact_id", "account_id", "kind"] {
        if object
            .get(field)
            .and_then(serde_json::Value::as_str)
            .is_none()
        {
            return Err(WalletDataError::DataInvalid);
        }
    }
    for field in ["sequence", "created_at_unix_ms"] {
        if object
            .get(field)
            .and_then(serde_json::Value::as_u64)
            .is_none()
        {
            return Err(WalletDataError::DataInvalid);
        }
    }
    for field in ["nonce", "ciphertext"] {
        if payload
            .get(field)
            .and_then(serde_json::Value::as_str)
            .is_none()
        {
            return Err(WalletDataError::DataInvalid);
        }
    }
    Ok(())
}

fn classify_recovery_snapshot_payload(value: &serde_json::Value) -> Result<(), WalletDataError> {
    let object = value
        .as_object()
        .ok_or(WalletDataError::MigrationRequired)?;
    let fields = [
        "version",
        "key_schedule_version",
        "scope",
        "state",
        "padding",
    ];
    if object.len() < 4
        || object.len() > 5
        || object.keys().any(|key| !fields.contains(&key.as_str()))
        || !object.contains_key("version")
        || !object.contains_key("key_schedule_version")
        || !object.contains_key("scope")
        || !object.contains_key("state")
    {
        return Err(WalletDataError::MigrationRequired);
    }
    if object.get("version").and_then(serde_json::Value::as_u64) != Some(2)
        || object
            .get("key_schedule_version")
            .and_then(serde_json::Value::as_u64)
            != Some(u64::from(WALLET_KEY_SCHEDULE_VERSION))
    {
        return Err(WalletDataError::MigrationRequired);
    }
    let state = object
        .get("state")
        .and_then(serde_json::Value::as_object)
        .ok_or(WalletDataError::DataInvalid)?;
    let state_fields = [
        "version",
        "key_schedule_version",
        "notes",
        "orders",
        "scanned_seq",
    ];
    if state.len() != state_fields.len()
        || state
            .keys()
            .any(|key| !state_fields.contains(&key.as_str()))
    {
        return Err(WalletDataError::MigrationRequired);
    }
    if state.get("version").and_then(serde_json::Value::as_u64) != Some(2)
        || state
            .get("key_schedule_version")
            .and_then(serde_json::Value::as_u64)
            != Some(u64::from(WALLET_KEY_SCHEDULE_VERSION))
    {
        return Err(WalletDataError::MigrationRequired);
    }
    if object
        .get("scope")
        .and_then(serde_json::Value::as_str)
        .is_none()
        || object
            .get("padding")
            .is_some_and(|padding| !padding.is_string())
        || state
            .get("notes")
            .and_then(serde_json::Value::as_array)
            .is_none()
        || state
            .get("orders")
            .and_then(serde_json::Value::as_array)
            .is_none()
        || state
            .get("scanned_seq")
            .and_then(serde_json::Value::as_u64)
            .is_none()
    {
        return Err(WalletDataError::DataInvalid);
    }
    Ok(())
}

fn decrypt_recovery_artifact_classified_for_seed(
    seed: &RecoverySeed,
    artifact_json: &str,
) -> Result<String, WalletDataError> {
    let value = unique_wallet_json(artifact_json).map_err(|_| WalletDataError::DataInvalid)?;
    classify_recovery_artifact_shape(&value)?;
    let artifact: RecoveryArtifact =
        serde_json::from_value(value).map_err(|_| WalletDataError::DataInvalid)?;
    let payload = decrypt_recovery_artifact_payload_classified(seed, &artifact)?;
    classify_recovery_snapshot_payload(&payload)?;
    serde_json::to_string(&payload).map_err(|_| WalletDataError::DataInvalid)
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_create_recovery_snapshot(input_json: &str) -> Result<String, JsValue> {
    let input: RecoverySnapshotInput = serde_json::from_value(unique_wallet_json(input_json)?)
        .map_err(|_| js_error("wallet migration required"))?;
    let seed = seed(&input.seed_hex)?;
    let artifact = create_recovery_snapshot_for_seed(
        &seed,
        SessionRecoverySnapshotInput {
            sequence: input.sequence,
            created_at_unix_ms: input.created_at_unix_ms,
            payload_json: input.payload_json,
        },
    )
    .map_err(js_error)?;
    to_json(&artifact)
}

#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_decrypt_recovery_artifact(
    seed_hex: &str,
    artifact_json: &str,
) -> Result<String, JsValue> {
    let seed = seed(seed_hex)?;
    decrypt_recovery_artifact_classified_for_seed(&seed, artifact_json)
        .map_err(legacy_wallet_data_error)
}

impl WalletSession {
    fn create_recovery_snapshot_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionRecoverySnapshotInput = session_json_validated(input_json, |value| {
            validate_object_fields(value, &["sequence", "created_at_unix_ms", "payload_json"])
        })?;
        validate_recovery_snapshot_payload_string(&input.payload_json)?;
        let artifact = create_recovery_snapshot_for_seed(seed, input)?;
        session_output(&artifact)
    }

    fn decrypt_recovery_artifact_inner(&self, artifact_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let artifact: RecoveryArtifact =
            session_json_validated(artifact_json, validate_recovery_artifact)?;
        let validated = decrypt_recovery_artifact_for_seed(seed, artifact)?;
        validate_recovery_snapshot_payload_value(&validated)?;
        session_output(&validated)
    }

    fn decrypt_recovery_artifact_classified_inner(
        &self,
        artifact_json: &str,
    ) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        classified_decrypt_output(decrypt_recovery_artifact_classified_for_seed(
            seed,
            artifact_json,
        ))
    }
}

#[wasm_bindgen]
impl WalletSession {
    #[wasm_bindgen(js_name = createRecoverySnapshot)]
    pub fn create_recovery_snapshot(&self, input_json: &str) -> Result<String, JsValue> {
        self.create_recovery_snapshot_inner(input_json)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = decryptRecoveryArtifact)]
    pub fn decrypt_recovery_artifact(&self, artifact_json: &str) -> Result<String, JsValue> {
        self.decrypt_recovery_artifact_inner(artifact_json)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = decryptRecoveryArtifactClassified)]
    pub fn decrypt_recovery_artifact_classified(
        &self,
        artifact_json: &str,
    ) -> Result<String, JsValue> {
        self.decrypt_recovery_artifact_classified_inner(artifact_json)
            .map_err(js_error)
    }
}

#[cfg(test)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExitClaimInput {
    pub seed_hex: String,
    pub chain_id: String,
    pub bridge_address: String,
    pub privacy_pool_address: String,
    pub exchange_address: String,
    pub asset_id: String,
    pub token_address: String,
    pub amount: String,
    pub exit_commitment: String,
    pub claim_account: String,
    pub open_note_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionExitClaimInput {
    bridge_address: String,
    privacy_pool_address: String,
    asset_id: String,
    token_address: String,
    amount: String,
    exit_commitment: String,
    claim_account: String,
    open_note_id: String,
}

fn sign_exit_claim_for_keys(
    keys: &WalletKeys,
    chain_id: Felt,
    exchange_address: Felt,
    input: &SessionExitClaimInput,
) -> Result<SpendAuthorization, &'static str> {
    let exit_commitment =
        Felt::from_hex(&input.exit_commitment).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
    let exit_key = keys.exit_key(exchange_address, exit_commitment);
    let exit_key = Zeroizing::new(format!("{exit_key:#x}"));
    let chain_id = felt_hex(&chain_id);
    let exchange_address = felt_hex(&exchange_address);
    sign_strk20_exit_claim_authorization(
        &exit_key,
        Strk20ExitClaimMessage {
            chain_id: &chain_id,
            bridge_address: &input.bridge_address,
            privacy_pool_address: &input.privacy_pool_address,
            exchange_address: &exchange_address,
            asset_id: &input.asset_id,
            token_address: &input.token_address,
            amount: &input.amount,
            exit_commitment: &input.exit_commitment,
            claim_account: &input.claim_account,
            open_note_id: &input.open_note_id,
        },
    )
    .map_err(|_| INVALID_SESSION_OPERATION_ERROR)
}

impl WalletSession {
    fn sign_strk20_exit_claim_inner(&self, input_json: &str) -> Result<String, &'static str> {
        let seed = self.seed_ref()?;
        let input: SessionExitClaimInput = session_json_validated(input_json, |value| {
            validate_object_fields(
                value,
                &[
                    "bridge_address",
                    "privacy_pool_address",
                    "asset_id",
                    "token_address",
                    "amount",
                    "exit_commitment",
                    "claim_account",
                    "open_note_id",
                ],
            )
        })?;
        let keys = WalletKeys::from_seed(seed).map_err(|_| INVALID_SESSION_OPERATION_ERROR)?;
        session_output(&sign_exit_claim_for_keys(
            &keys,
            self.chain_id,
            self.deployment_id,
            &input,
        )?)
    }
}

#[wasm_bindgen]
impl WalletSession {
    #[wasm_bindgen(js_name = signStrk20ExitClaim)]
    pub fn sign_strk20_exit_claim(&self, input_json: &str) -> Result<String, JsValue> {
        self.sign_strk20_exit_claim_inner(input_json)
            .map_err(js_error)
    }
}

/// signs the privacy pool claim of a finalized withdrawal's exit.
#[cfg(test)]
#[wasm_bindgen]
pub fn zylith_wallet_sign_strk20_exit_claim(input_json: &str) -> Result<String, JsValue> {
    let input: ExitClaimInput = from_json(input_json)?;
    let keys = wallet_keys(&input.seed_hex)?;
    let chain_id = canonical_session_felt(&input.chain_id).map_err(js_error)?;
    let exchange_address = canonical_session_felt(&input.exchange_address).map_err(js_error)?;
    to_json(
        &sign_exit_claim_for_keys(
            &keys,
            chain_id,
            exchange_address,
            &SessionExitClaimInput {
                bridge_address: input.bridge_address,
                privacy_pool_address: input.privacy_pool_address,
                asset_id: input.asset_id,
                token_address: input.token_address,
                amount: input.amount,
                exit_commitment: input.exit_commitment,
                claim_account: input.claim_account,
                open_note_id: input.open_note_id,
            },
        )
        .map_err(js_error)?,
    )
}

mod u128_decimal {
    use serde::{Deserialize, Deserializer, de::Error};

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

mod u64_decimal {
    use serde::{Deserialize, Deserializer, de::Error};

    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Decimal {
        Number(u64),
        Text(String),
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        match Decimal::deserialize(deserializer)? {
            Decimal::Number(value) => Ok(value),
            Decimal::Text(value) => value.parse().map_err(D::Error::custom),
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn local_state_exports_round_trip_and_decrypt_the_independent_kat() {
        let seed = "00".repeat(32);
        let encrypted = zylith_wallet_encrypt_local_state(
            &serde_json::json!({ "seed_hex": seed, "value": { "count": 1, "orders": ["0xabc"] } })
                .to_string(),
        )
        .unwrap();
        let record: serde_json::Value = serde_json::from_str(&encrypted).unwrap();
        assert_eq!(record["version"], 2);
        assert_eq!(record["kdf"], "zylith-wallet-hkdf-sha256-v2");
        assert_eq!(record["purpose"], "wallet-state");
        assert_eq!(
            zylith_wallet_decrypt_local_state(&seed, &encrypted).unwrap(),
            r#"{"count":1,"orders":["0xabc"]}"#
        );
        let mut kat = record;
        kat["nonce"] = serde_json::json!("AAECAwQFBgcICQoL");
        kat["ciphertext"] =
            serde_json::json!("0ejOU+vTAH0Uz/aV2Jg287Xl6wCx2lHnOJqXQ+2AQhbkByXGLlXYbcUE+qj8Iw==");
        assert_eq!(
            zylith_wallet_decrypt_local_state(&seed, &kat.to_string()).unwrap(),
            r#"{"count":1,"orders":["0xabc"]}"#
        );
        assert!(zylith_wallet_decrypt_local_state(&"01".repeat(32), &kat.to_string()).is_err());
    }

    #[test]
    fn local_state_request_rejects_recursive_and_escaped_duplicate_keys() {
        let seed = "00".repeat(32);
        for raw in [
            format!(r#"{{"seed_hex":"{seed}","seed_hex":"{seed}","value":{{}}}}"#),
            format!(r#"{{"seed_hex":"{seed}","seed_\u0068ex":"{seed}","value":{{}}}}"#),
            format!(r#"{{"seed_hex":"{seed}","value":{{"outer":{{"a":1,"a":2}}}}}}"#),
            format!(r#"{{"seed_hex":"{seed}","value":[{{"outer":{{"a":1,"\u0061":2}}}}]}}"#),
        ] {
            assert!(zylith_wallet_encrypt_local_state(&raw).is_err());
        }
    }

    #[test]
    fn local_state_request_rejects_missing_extra_invalid_and_oversized_inputs() {
        let seed = "00".repeat(32);
        for request in [
            serde_json::json!({"seed_hex": seed}),
            serde_json::json!({"value": {}}),
            serde_json::json!({"seed_hex": seed, "value": {}, "account_id": "other"}),
            serde_json::json!({"seed_hex": seed, "value": {}, "label": "orders"}),
            serde_json::json!({"seed_hex": "0x01", "value": {}}),
            serde_json::json!({"seed_hex": null, "value": {}}),
            serde_json::json!({"seed_hex": seed, "value": "a".repeat(4 * 1024 * 1024)}),
        ] {
            assert!(zylith_wallet_encrypt_local_state(&request.to_string()).is_err());
        }
    }

    use serde_json::{Value, json};
    use zylith_core::exchange::NoteAccumulator;
    use zylith_core::exchange::fixtures::input;
    use zylith_core::exchange::{
        Market, NewOrder, Signature, build_transition, open_request, public_key, verify_message,
    };
    use zylith_core::{PrivateExecutionKeyPrivateConfig, PrivateExecutionKeyPublicConfig};

    use super::*;

    fn execution_key(
        id: &str,
        _byte: u8,
    ) -> (
        PrivateExecutionKeyPublicConfig,
        PrivateExecutionKeyPrivateConfig,
    ) {
        let public_key =
            "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a".to_owned();
        (
            PrivateExecutionKeyPublicConfig {
                key_id: id.into(),
                algorithm: zylith_core::private_envelope::HPKE_PROFILE_ID.into(),
                public_key: public_key.clone(),
            },
            PrivateExecutionKeyPrivateConfig {
                key_id: id.into(),
                algorithm: zylith_core::private_envelope::HPKE_PROFILE_ID.into(),
                public_key,
                private_key: "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb"
                    .into(),
            },
        )
    }

    fn call(function: fn(&str) -> Result<String, JsValue>, input: Value) -> Value {
        match function(&input.to_string()) {
            Ok(output) => serde_json::from_str(&output).unwrap(),
            Err(_) => panic!("the wallet call must succeed"),
        }
    }

    fn wallet_session(seed_byte: u8) -> WalletSession {
        WalletSession::try_new(vec![seed_byte; 32], "0x534e5f5345504f4c4941", "0x5eed").unwrap()
    }

    #[test]
    fn wallet_session_constructor_requires_exact_bytes_and_canonical_nonzero_context() {
        for length in [0, 31, 33] {
            assert_eq!(
                WalletSession::try_new(vec![0x5a; length], "0x1", "0x2")
                    .err()
                    .unwrap(),
                "invalid wallet session"
            );
        }
        for (chain_id, deployment_id) in [
            ("0", "0x2"),
            ("0x1", "0x0"),
            ("0x", "0x2"),
            ("-0x1", "0x2"),
            (" 0x1", "0x2"),
            (
                "0x800000000000011000000000000000000000000000000000000000000000001",
                "0x2",
            ),
            (
                "0x1",
                "0x800000000000011000000000000000000000000000000000000000000000001",
            ),
        ] {
            assert_eq!(
                WalletSession::try_new(vec![0x5a; 32], chain_id, deployment_id)
                    .err()
                    .unwrap(),
                "invalid wallet session"
            );
        }

        let normalized = WalletSession::try_new(vec![0x5a; 32], "00001", "0x0002").unwrap();
        assert_eq!(normalized.chain_id, Felt::ONE);
        assert_eq!(normalized.deployment_id, Felt::from(2_u8));
    }

    #[test]
    fn wallet_session_lock_is_idempotent_and_precedes_argument_parsing() {
        let mut session = wallet_session(1);
        assert!(!session.is_locked());
        session.lock();
        session.lock();
        assert!(session.is_locked());
        assert_eq!(session.seed_ref().unwrap_err(), "wallet session is locked");
        assert_eq!(
            session
                .build_order_request_inner(r#"{"seed_hex":"secret","broken":}"#)
                .unwrap_err(),
            "wallet session is locked"
        );
        assert_eq!(
            session
                .decrypt_recovery_artifact_inner("the seed is deadbeef")
                .unwrap_err(),
            "wallet session is locked"
        );
    }

    #[test]
    fn wallet_session_seed_type_is_zeroizable_and_lock_removes_it() {
        fn assert_zeroize<T: zeroize::Zeroize>() {}
        assert_zeroize::<RecoverySeed>();
        let mut session = wallet_session(1);
        assert!(session.seed.is_some());
        session.lock();
        assert!(session.seed.is_none());
    }

    #[test]
    fn wallet_session_deterministic_operations_match_legacy_exports_without_seed_fields() {
        let seed_hex = "01".repeat(32);
        let session = wallet_session(1);
        assert_eq!(
            session.public_config_inner().unwrap(),
            zylith_wallet_derive_public_config(&seed_hex).unwrap()
        );
        assert_eq!(
            session.recovery_auth_tag_inner().unwrap(),
            zylith_wallet_recovery_auth_tag(&seed_hex).unwrap()
        );

        let proof_input = json!({ "proof_signer_class_hash": "0x123" }).to_string();
        let proof = session.derive_proof_signer_inner(&proof_input).unwrap();
        assert_eq!(
            proof,
            zylith_wallet_derive_proof_signer(
                &json!({
                    "seed_hex": seed_hex,
                    "chain_id": "0x534e5f5345504f4c4941",
                    "proof_signer_class_hash": "0x123",
                })
                .to_string()
            )
            .unwrap()
        );
        assert!(
            session
                .derive_proof_signer_inner(
                    &json!({
                        "proof_signer_class_hash": "0x123",
                        "seed_hex": seed_hex,
                    })
                    .to_string(),
                )
                .is_err()
        );

        let deposit_input = json!({
            "bridge_address": "0x123",
            "asset_id": "STRK",
            "amount": "10",
            "deposit_nonce": "42",
        })
        .to_string();
        let deposit = session
            .build_deposit_submission_plan_inner(&deposit_input)
            .unwrap();
        assert_eq!(
            deposit,
            zylith_wallet_build_deposit_submission_plan(
                &json!({
                    "seed_hex": seed_hex,
                    "chain_id": "0x534e5f5345504f4c4941",
                    "bridge_address": "0x123",
                    "asset_id": "STRK",
                    "amount": "10",
                    "deposit_nonce": "42",
                })
                .to_string()
            )
            .unwrap()
        );
        assert!(
            session
                .build_deposit_submission_plan_inner(
                    &json!({
                        "bridge_address": "0x123", "asset_id": "STRK", "amount": "10",
                        "deposit_nonce": "42", "seed_hex": seed_hex,
                    })
                    .to_string(),
                )
                .is_err()
        );
        for output in [proof, deposit] {
            assert!(!output.contains("seed_hex"));
            assert!(!output.contains(&seed_hex));
        }
    }

    #[test]
    fn wallet_session_local_state_and_recovery_artifacts_match_legacy_semantics() {
        let seed_hex = "01".repeat(32);
        let session = wallet_session(1);
        let value = json!({"notes": [{"commitment": "0x1"}], "orders": []});
        let encrypted = session
            .encrypt_local_state_inner(&json!({"value": value}).to_string())
            .unwrap();
        assert_eq!(
            session.decrypt_local_state_inner(&encrypted).unwrap(),
            value.to_string()
        );
        assert_eq!(
            zylith_wallet_decrypt_local_state(&seed_hex, &encrypted).unwrap(),
            value.to_string()
        );

        let snapshot_input = json!({
            "sequence": 7,
            "created_at_unix_ms": 1_700_000_000_000_u64,
            "payload_json": json!({
                "version": 2,
                "key_schedule_version": 2,
                "scope": "test",
                "state": {
                    "version": 2,
                    "key_schedule_version": 2,
                    "notes": [],
                    "orders": [1],
                    "scanned_seq": 0,
                }
            }).to_string(),
        })
        .to_string();
        let session_artifact = session
            .create_recovery_snapshot_inner(&snapshot_input)
            .unwrap();
        let mut forbidden_snapshot: Value = serde_json::from_str(&snapshot_input).unwrap();
        forbidden_snapshot["seed_hex"] = json!(seed_hex);
        assert!(
            session
                .create_recovery_snapshot_inner(&forbidden_snapshot.to_string())
                .is_err()
        );
        let legacy_artifact = zylith_wallet_create_recovery_snapshot(
            &json!({
                "seed_hex": seed_hex,
                "sequence": 7,
                "created_at_unix_ms": 1_700_000_000_000_u64,
                "payload_json": json!({
                    "version": 2,
                    "key_schedule_version": 2,
                    "scope": "test",
                    "state": {
                        "version": 2,
                        "key_schedule_version": 2,
                        "notes": [],
                        "orders": [1],
                        "scanned_seq": 0,
                    }
                }).to_string(),
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            session
                .decrypt_recovery_artifact_inner(&session_artifact)
                .unwrap(),
            session
                .decrypt_recovery_artifact_inner(&legacy_artifact)
                .unwrap()
        );
    }

    #[test]
    fn wallet_session_parsers_fail_closed_on_unknown_and_recursive_duplicate_fields() {
        let session = wallet_session(1);
        for invalid in [
            r#"{"proof_signer_class_hash":"0x123","seed_hex":"secret"}"#,
            r#"{"proof_signer_class_hash":"0x123","proof_signer_class_hash":"0x124"}"#,
            r#"{"proof_signer_class_hash":"0x123","proof_signer_class_\u0068ash":"0x124"}"#,
        ] {
            assert!(session.derive_proof_signer_inner(invalid).is_err());
        }
        for invalid in [
            r#"{"value":{"nested":{"a":1,"a":2}}}"#,
            r#"{"value":{"nested":{"a":1,"\u0061":2}}}"#,
            r#"{"value":{},"seed_hex":"secret"}"#,
        ] {
            assert!(session.encrypt_local_state_inner(invalid).is_err());
        }
        assert!(
            session
                .build_order_request_inner(
                    r#"{"pair":"STRK/USDC","sell":true,"external":false,"amount":"1","limit":"1","expiry_ms":1,"funding":[{"asset_id":"0x1","amount":"1","amou\u006et":"2","owner_public_key":"0x2","spend_authority":"0x3","withdraw_authority":"0x4","blinding":"0x5","nonce":"1","metadata_commitment":"0x6"}],"registry":{"keys":[]}}"#,
                )
                .is_err()
        );
        assert!(
            session
                .build_status_requests_inner(
                    r#"{"registry":{"keys":[]},"orders":[{"order_id":"0x1","order_\u0069d":"0x2","after_seq":0}],"nullifiers":[]}"#,
                )
                .is_err()
        );
        assert!(
            session
                .build_residual_recovery_inner(
                    r#"{"note_root":"0x1","note":{"chain_context":"0x5eed","input_asset_id":"0x1","pair_id":"0x2","sell":true,"external":false,"remaining":"1","limit":"1","funding":"1","reserved":"0","reserved_offset":"0","reserved_seq":0,"expiry_ms":1,"order_id":"0x3","generation":1,"owner":{"owner_public_key":"0x1","spend_authority":"0x2","withdraw_authority":"0x3","cancel_authority":"0x4","nonce":"0x5","n\u006fnce":"0x6"},"blinding":"0x4"},"membership":{"subtree_path":[],"subtree_directions":[],"accumulator_path":[],"accumulator_directions":[]},"output_asset_id":"0x2","fee_bps":"0","capacity":{"generation":0,"status":0,"total":"0","consumed_base":"0","pool_quote":"0","scale":"0"}}"#,
                )
                .is_err()
        );
    }

    #[test]
    fn wallet_session_nested_protocol_schemas_reject_unknown_and_owned_context_fields() {
        let note = json!({
            "asset_id": "0x1", "amount": "1", "owner_public_key": "0x2",
            "spend_authority": "0x3", "withdraw_authority": "0x4", "blinding": "0x5",
            "nonce": "1", "metadata_commitment": "0x6",
        });
        let registry = json!({"keys": [{
            "key_id": "active", "algorithm": zylith_core::private_envelope::HPKE_PROFILE_ID,
            "public_key": "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
        }]});
        let membership = json!({
            "subtree_path": [], "subtree_directions": [],
            "accumulator_path": [], "accumulator_directions": [],
        });
        let capacity = json!({
            "generation": 0, "status": 0, "total": "0", "consumed_base": "0",
            "pool_quote": "0", "scale": "0",
        });
        let owner = json!({
            "owner_public_key": "0x1", "spend_authority": "0x2",
            "withdraw_authority": "0x3", "cancel_authority": "0x4", "nonce": "0x5",
        });
        let residual = json!({
            "chain_context": "0x5eed", "input_asset_id": "0x1", "pair_id": "0x2",
            "sell": true, "external": false, "remaining": "1", "limit": "1",
            "funding": "1", "reserved": "0", "reserved_offset": "0", "reserved_seq": 0,
            "expiry_ms": 1, "order_id": "0x3", "generation": 1, "owner": owner,
            "blinding": "0x4",
        });
        let artifact = json!({
            "key_schedule_version": 2, "artifact_id": "id", "account_id": "account",
            "kind": "Snapshot", "sequence": 1, "created_at_unix_ms": 1,
            "payload": {"key_schedule_version": 2, "algorithm": "AES-256-GCM", "nonce": "n", "ciphertext": "c"},
        });
        let execution_key = registry["keys"][0].clone();
        let recovery_payload = artifact["payload"].clone();

        for (mut value, validate) in [
            (
                note.clone(),
                validate_note_fields as fn(&Value) -> Result<(), &'static str>,
            ),
            (execution_key, validate_execution_key),
            (registry.clone(), validate_execution_registry),
            (
                json!({"order_id": "0x1", "after_seq": 0}),
                validate_order_query,
            ),
            (membership.clone(), validate_note_membership),
            (capacity.clone(), validate_recovery_capacity),
            (owner.clone(), validate_order_owner),
            (residual.clone(), validate_residual_note),
            (recovery_payload, validate_recovery_payload),
            (artifact.clone(), validate_recovery_artifact),
        ] {
            validate(&value).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .insert("seed_hex".into(), json!("secret"));
            assert_eq!(
                validate(&value).unwrap_err(),
                INVALID_SESSION_OPERATION_ERROR
            );
            let escaped = value
                .to_string()
                .replacen("\"seed_hex\"", "\"seed_\\u0068ex\"", 1);
            let decoded = unique_wallet_json(&escaped).unwrap();
            assert_eq!(
                validate(&decoded).unwrap_err(),
                INVALID_SESSION_OPERATION_ERROR
            );
        }

        let nested_key = |field: &str| {
            let mut key = json!({
                "key_id": "active", "algorithm": zylith_core::private_envelope::HPKE_PROFILE_ID,
                "public_key": "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
            });
            key.as_object_mut()
                .unwrap()
                .insert(field.to_owned(), json!("secret"));
            key
        };
        for field in [
            "seedHex",
            "chainId",
            "chainContext",
            "deploymentId",
            "exchangeAddress",
        ] {
            assert!(validate_execution_registry(&json!({"keys": [nested_key(field)]})).is_err());
        }
        let mut payload_owned = artifact.clone();
        payload_owned["payload"]["seed_hex"] = json!("secret");
        assert!(validate_recovery_artifact(&payload_owned).is_err());
        let escaped_payload =
            payload_owned
                .to_string()
                .replacen("\"seed_hex\"", "\"seed_\\u0068ex\"", 1);
        assert!(
            validate_recovery_artifact(&unique_wallet_json(&escaped_payload).unwrap()).is_err()
        );

        let mut nested_note = note.clone();
        nested_note["chain_id"] = json!("0x1");
        assert!(
            validate_order_input_value(&json!({
                "pair": "STRK/USDC", "sell": true, "external": false, "amount": "1",
                "limit": "1", "expiry_ms": 1, "funding": [nested_note], "registry": registry,
            }))
            .is_err()
        );
        assert!(
            validate_status_input_value(&json!({
                "orders": [{"order_id": "0x1", "after_seq": 0, "chain_id": "0x1"}],
                "nullifiers": [], "registry": registry,
            }))
            .is_err()
        );

        let mut nested_owner = residual.clone();
        nested_owner["owner"]["deploymentId"] = json!("0x5eed");
        assert!(
            validate_residual_input_value(&json!({
                "note_root": "0x1", "note": nested_owner, "membership": membership,
                "output_asset_id": "0x2", "fee_bps": "0", "capacity": capacity,
            }))
            .is_err()
        );
        let mut nested_payload = artifact;
        nested_payload["payload"]["exchangeAddress"] = json!("0x5eed");
        assert!(validate_recovery_artifact(&nested_payload).is_err());

        let escaped = unique_wallet_json(
            r#"{"pair":"STRK/USDC","sell":true,"external":false,"amount":"1","limit":"1","expiry_ms":1,"funding":[{"asset_id":"0x1","amount":"1","owner_public_key":"0x2","spend_authority":"0x3","withdraw_authority":"0x4","blinding":"0x5","nonce":"1","metadata_commitment":"0x6","seed_\u0068ex":"secret"}],"registry":{"keys":[]}}"#,
        )
        .unwrap();
        assert!(validate_order_input_value(&escaped).is_err());

        let session = wallet_session(1);
        let order_input = |funding: Value, registry: Value| {
            json!({
                "pair": "STRK/USDC", "sell": true, "external": false, "amount": "1",
                "limit": "1", "expiry_ms": 1, "funding": [funding], "registry": registry,
            })
        };
        let mut bad_note = note.clone();
        bad_note["seed_hex"] = json!("secret");
        assert!(
            session
                .build_order_request_inner(&order_input(bad_note, registry.clone()).to_string())
                .is_err()
        );
        let mut bad_registry = registry.clone();
        bad_registry["keys"][0]["chainId"] = json!("0x1");
        assert!(
            session
                .build_cancel_request_inner(
                    &json!({"order_id": "0x1", "registry": bad_registry}).to_string()
                )
                .is_err()
        );
        assert!(
            session
                .build_status_requests_inner(
                    &json!({
                        "registry": registry,
                        "orders": [{"order_id": "0x1", "after_seq": 0, "chain_id": "0x1"}],
                        "nullifiers": [],
                    })
                    .to_string()
                )
                .is_err()
        );

        for (field, nested) in [
            ("note", "seed_hex"),
            ("membership", "chainId"),
            ("capacity", "deployment_id"),
        ] {
            let mut input = json!({
                "note_root": "0x1", "note": residual, "membership": membership,
                "output_asset_id": "0x2", "fee_bps": "0", "capacity": capacity,
            });
            input[field][nested] = json!("secret");
            assert!(
                session
                    .build_residual_recovery_inner(&input.to_string())
                    .is_err()
            );
        }
        assert!(
            session
                .decrypt_recovery_artifact_inner(&nested_payload.to_string())
                .is_err()
        );

        let snapshot_payload = json!({
            "version": 2,
            "key_schedule_version": 2,
            "scope": "test",
            "state": {
                "version": 2,
                "key_schedule_version": 2,
                "notes": [],
                "orders": [],
                "scanned_seq": 0,
                "seed_hex": "secret",
            },
        });
        assert_eq!(
            validate_recovery_snapshot_payload_value(&snapshot_payload).unwrap_err(),
            INVALID_SESSION_OPERATION_ERROR
        );
        let escaped_snapshot =
            snapshot_payload
                .to_string()
                .replacen("\"seed_hex\"", "\"seed_\\u0068ex\"", 1);
        assert_eq!(
            validate_recovery_snapshot_payload_string(&escaped_snapshot).unwrap_err(),
            INVALID_SESSION_OPERATION_ERROR
        );
        assert!(
            session
                .create_recovery_snapshot_inner(
                    &json!({
                        "sequence": 1,
                        "created_at_unix_ms": 1,
                        "payload_json": snapshot_payload.to_string(),
                    })
                    .to_string()
                )
                .is_err()
        );
    }

    #[test]
    fn wallet_session_opaque_state_preserves_authenticated_residual_context() {
        let session = wallet_session(1);
        let value = json!({
            "version": 2,
            "key_schedule_version": 2,
            "notes": [],
            "orders": [{
                "order_id": "0x1",
                "residual": {"note": {"chain_context": "0x5eed"}},
            }],
            "scanned_seq": 0,
        });
        let encrypted = session
            .encrypt_local_state_inner(&json!({"value": value}).to_string())
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&session.decrypt_local_state_inner(&encrypted).unwrap())
                .unwrap(),
            value
        );

        let payload = json!({
            "version": 2,
            "key_schedule_version": 2,
            "scope": "test",
            "state": value,
        });
        let artifact = session
            .create_recovery_snapshot_inner(
                &json!({
                    "sequence": 1,
                    "created_at_unix_ms": 1,
                    "payload_json": payload.to_string(),
                })
                .to_string(),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(
                &session.decrypt_recovery_artifact_inner(&artifact).unwrap()
            )
            .unwrap(),
            payload
        );
    }

    #[test]
    fn wallet_session_classified_decrypt_outcomes_are_closed_and_non_stringly_typed() {
        let session = wallet_session(1);
        let other = wallet_session(2);
        let value = json!({"version": 2, "orders": []});
        let encrypted = session
            .encrypt_local_state_inner(&json!({"value": value}).to_string())
            .unwrap();
        let success: Value = serde_json::from_str(
            &session
                .decrypt_local_state_classified_inner(&encrypted)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            success,
            json!({
                "status": "OK",
                "result_b64": "eyJvcmRlcnMiOltdLCJ2ZXJzaW9uIjoyfQ==",
            })
        );

        let mut old: Value = serde_json::from_str(&encrypted).unwrap();
        old["version"] = json!(1);
        assert_eq!(
            serde_json::from_str::<Value>(
                &session
                    .decrypt_local_state_classified_inner(&old.to_string())
                    .unwrap()
            )
            .unwrap(),
            json!({"status": "MIGRATION_REQUIRED"})
        );
        let duplicate = encrypted.replacen("{", r#"{"version":2,"#, 1);
        let mut damaged_local: Value = serde_json::from_str(&encrypted).unwrap();
        let ciphertext = damaged_local["ciphertext"].as_str().unwrap();
        damaged_local["ciphertext"] = json!(format!(
            "{}{}",
            if ciphertext.starts_with('A') {
                "B"
            } else {
                "A"
            },
            &ciphertext[1..]
        ));
        let damaged_local = damaged_local.to_string();
        for invalid in [
            encrypted.as_str(),
            "{",
            duplicate.as_str(),
            damaged_local.as_str(),
        ] {
            let candidate = if invalid == encrypted.as_str() {
                other.decrypt_local_state_classified_inner(invalid).unwrap()
            } else {
                session
                    .decrypt_local_state_classified_inner(invalid)
                    .unwrap()
            };
            assert_eq!(
                serde_json::from_str::<Value>(&candidate).unwrap(),
                json!({"status": "DATA_INVALID"})
            );
        }

        let authenticated_old = create_recovery_artifact(
            session.seed_ref().unwrap(),
            RecoveryArtifactKind::Snapshot,
            1,
            1,
            &json!({
                "version": 1,
                "key_schedule_version": 2,
                "scope": "test",
                "state": {"version": 2, "key_schedule_version": 2, "notes": [], "orders": [], "scanned_seq": 0},
            }),
        )
        .unwrap();
        let old_raw = serde_json::to_string(&authenticated_old).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(
                &session
                    .decrypt_recovery_artifact_classified_inner(&old_raw)
                    .unwrap()
            )
            .unwrap(),
            json!({"status": "MIGRATION_REQUIRED"})
        );
        assert_eq!(
            serde_json::from_str::<Value>(
                &other
                    .decrypt_recovery_artifact_classified_inner(&old_raw)
                    .unwrap()
            )
            .unwrap(),
            json!({"status": "DATA_INVALID"})
        );
        let mut damaged_recovery: Value = serde_json::from_str(&old_raw).unwrap();
        let ciphertext = damaged_recovery["payload"]["ciphertext"].as_str().unwrap();
        damaged_recovery["payload"]["ciphertext"] = json!(format!(
            "{}{}",
            if ciphertext.starts_with('0') {
                "1"
            } else {
                "0"
            },
            &ciphertext[1..]
        ));
        let duplicate_recovery = old_raw.replacen("{", r#"{"key_schedule_version":2,"#, 1);
        for invalid in [damaged_recovery.to_string(), duplicate_recovery] {
            assert_eq!(
                serde_json::from_str::<Value>(
                    &session
                        .decrypt_recovery_artifact_classified_inner(&invalid)
                        .unwrap()
                )
                .unwrap(),
                json!({"status": "DATA_INVALID"})
            );
        }
    }

    #[test]
    fn locked_wallet_session_rejects_before_parsing_every_secret_operation() {
        let mut session = wallet_session(1);
        session.lock();
        assert_eq!(
            session.public_config_inner().unwrap_err(),
            LOCKED_SESSION_ERROR
        );
        assert_eq!(
            session.recovery_auth_tag_inner().unwrap_err(),
            LOCKED_SESSION_ERROR
        );
        for result in [
            session.derive_proof_signer_inner("{"),
            session.encrypt_local_state_inner("{"),
            session.decrypt_local_state_inner("{"),
            session.build_deposit_submission_plan_inner("{"),
            session.build_order_request_inner("{"),
            session.build_cancel_request_inner("{"),
            session.build_withdraw_request_inner("{"),
            session.build_status_requests_inner("{"),
            session.build_residual_recovery_inner("{"),
            session.create_recovery_snapshot_inner("{"),
            session.decrypt_recovery_artifact_inner("{"),
            session.sign_strk20_exit_claim_inner("{"),
        ] {
            assert_eq!(result.unwrap_err(), LOCKED_SESSION_ERROR);
        }
    }

    fn opened_request(built: &Value, private: &PrivateExecutionKeyPrivateConfig) -> PrivateRequest {
        let sealed: SealedRequest = serde_json::from_value(built["sealed"].clone()).unwrap();
        open_request(
            &sealed,
            zylith_core::private_envelope::PrivateEnvelopeContext {
                chain_id: Felt::from_hex("0x534e5f5345504f4c4941").unwrap(),
                deployment_id: Felt::from_hex("0x5eed").unwrap(),
            },
            std::slice::from_ref(private),
        )
        .unwrap()
        .request
    }

    #[test]
    fn wallet_session_private_request_methods_preserve_semantics_and_bound_context() {
        let seed_hex = "01".repeat(32);
        let session = wallet_session(1);
        let (public, private) = execution_key("active", 1);
        let registry = PrivateExecutionKeyRegistry { keys: vec![public] };
        let note = deposit(&seed_hex, "STRK", 10, 42);

        let session_order = serde_json::from_str::<Value>(
            &session
                .build_order_request_inner(
                    &json!({
                        "pair": "STRK/USDC", "sell": true, "external": false,
                        "amount": "10", "limit": "100", "expiry_ms": 9_999_999_u64,
                        "funding": [note], "registry": registry,
                    })
                    .to_string(),
                )
                .unwrap(),
        )
        .unwrap();
        let forbidden = |mut input: Value| {
            input["seed_hex"] = json!(seed_hex);
            input.to_string()
        };
        assert!(
            session
                .build_order_request_inner(&forbidden(json!({
                    "pair": "STRK/USDC", "sell": true, "external": false,
                    "amount": "10", "limit": "100", "expiry_ms": 9_999_999_u64,
                    "funding": [note], "registry": registry,
                })))
                .is_err()
        );
        let legacy_order = call(
            zylith_wallet_build_order_request,
            json!({
                "seed_hex": seed_hex, "chain_id": "0x534e5f5345504f4c4941",
                "chain_context": "0x5eed", "pair": "STRK/USDC", "sell": true,
                "external": false, "amount": "10", "limit": "100",
                "expiry_ms": 9_999_999_u64, "funding": [note], "registry": registry,
            }),
        );
        for built in [&session_order, &legacy_order] {
            let PrivateRequest::Order(order) = opened_request(built, &private) else {
                panic!("an order method must seal an order");
            };
            assert_eq!(order.terms.pair_id, pair_id("STRK/USDC"));
            assert_eq!(order.terms.amount, 10);
            assert_eq!(order.terms.limit, 100);
            assert_eq!(order.funding, vec![note.clone()]);
            order
                .validate(Felt::from_hex("0x5eed").unwrap(), note.asset_id, 1, 1, 1)
                .unwrap();
        }
        let sealed: SealedRequest =
            serde_json::from_value(session_order["sealed"].clone()).unwrap();
        assert!(
            open_request(
                &sealed,
                zylith_core::private_envelope::PrivateEnvelopeContext {
                    chain_id: Felt::from_hex("0x534e5f5345504f4c4941").unwrap(),
                    deployment_id: Felt::from_hex("0x5eee").unwrap(),
                },
                std::slice::from_ref(&private),
            )
            .is_err()
        );

        let session_cancel: Value = serde_json::from_str(
            &session
                .build_cancel_request_inner(
                    &json!({"order_id": "0x77", "registry": registry}).to_string(),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(
            session
                .build_cancel_request_inner(&forbidden(json!({
                    "order_id": "0x77", "registry": registry,
                })))
                .is_err()
        );
        let legacy_cancel = call(
            zylith_wallet_build_cancel_request,
            json!({
                "seed_hex": seed_hex, "chain_id": "0x534e5f5345504f4c4941",
                "chain_context": "0x5eed", "order_id": "0x77", "registry": registry,
            }),
        );
        assert_eq!(
            opened_request(&session_cancel, &private),
            opened_request(&legacy_cancel, &private)
        );

        let status_input = json!({
            "orders": [{"order_id": "0x77", "after_seq": 3}],
            "nullifiers": ["0x9"], "registry": registry,
        });
        let session_status: Vec<Value> = serde_json::from_str(
            &session
                .build_status_requests_inner(&status_input.to_string())
                .unwrap(),
        )
        .unwrap();
        assert!(
            session
                .build_status_requests_inner(&forbidden(status_input.clone()))
                .is_err()
        );
        let legacy_status = call(
            zylith_wallet_build_status_requests,
            json!({
                "seed_hex": seed_hex, "chain_id": "0x534e5f5345504f4c4941",
                "chain_context": "0x5eed", "orders": status_input["orders"],
                "nullifiers": status_input["nullifiers"], "registry": registry,
            }),
        );
        assert_eq!(
            opened_request(&session_status[0], &private),
            opened_request(&legacy_status[0], &private)
        );

        let withdraw_input = json!({
            "note": note, "exit_commitment": "0x99", "registry": registry,
        });
        let session_withdraw: Value = serde_json::from_str(
            &session
                .build_withdraw_request_inner(&withdraw_input.to_string())
                .unwrap(),
        )
        .unwrap();
        assert!(
            session
                .build_withdraw_request_inner(&forbidden(withdraw_input.clone()))
                .is_err()
        );
        let legacy_withdraw = call(
            zylith_wallet_build_withdraw_request,
            json!({
                "seed_hex": seed_hex, "chain_id": "0x534e5f5345504f4c4941",
                "chain_context": "0x5eed", "note": note, "exit_commitment": "0x99",
                "registry": registry,
            }),
        );
        assert_eq!(
            opened_request(&session_withdraw, &private),
            opened_request(&legacy_withdraw, &private)
        );
    }

    #[test]
    fn wallet_session_residual_recovery_matches_legacy_and_rejects_another_deployment() {
        let seed_hex = "01".repeat(32);
        let session = wallet_session(1);
        let keys = wallet_keys(&seed_hex).unwrap();
        let chain = Felt::from_hex("0x5eed").unwrap();
        let base = deposit(&seed_hex, "STRK", 10, 42);
        let quote = asset_id("USDC");
        let mut notes = NoteAccumulator::default();
        notes.append(base.output_leaf());
        let order = keys
            .order(
                chain,
                pair_id("STRK/USDC"),
                true,
                false,
                10,
                95,
                1_000_000,
                vec![base.clone()],
            )
            .unwrap();
        let membership = notes.membership(0, &[base.output_leaf()], 0).unwrap();
        let mut transition = input(
            1,
            vec![],
            vec![order.try_into_new_order(vec![membership]).unwrap()],
            notes.root(),
            100,
        );
        transition.chain_context = chain;
        transition.objective_numeraire_asset_id = quote;
        transition.markets = vec![Market {
            pair_id: pair_id("STRK/USDC"),
            base_asset_id: base.asset_id,
            quote_asset_id: quote,
            ..transition.markets[0].clone()
        }];
        let result = build_transition(&transition).unwrap();
        let residual = result.residual_outputs[0].clone();
        notes.append(result.public.output_root);
        let membership = notes
            .membership(
                1,
                &result
                    .public
                    .output_records
                    .iter()
                    .map(|record| record.leaf)
                    .collect::<Vec<_>>(),
                residual.index,
            )
            .unwrap();
        let session_input = json!({
            "note_root": format!("{:#x}", notes.root()),
            "note": residual.note,
            "membership": membership,
            "output_asset_id": format!("{quote:#x}"),
            "fee_bps": "30",
            "capacity": RecoveryCapacity::default(),
        });
        let session_result = session
            .build_residual_recovery_inner(&session_input.to_string())
            .unwrap();
        let mut forbidden = session_input.clone();
        forbidden["seed_hex"] = json!(seed_hex);
        assert!(
            session
                .build_residual_recovery_inner(&forbidden.to_string())
                .is_err()
        );
        let mut legacy_input = session_input.clone();
        legacy_input["seed_hex"] = json!(seed_hex);
        assert_eq!(
            session_result,
            zylith_wallet_build_residual_recovery(&legacy_input.to_string()).unwrap()
        );

        let mut wrong = session_input;
        wrong["note"]["chain_context"] = json!("0x5eee");
        assert_eq!(
            session
                .build_residual_recovery_inner(&wrong.to_string())
                .unwrap_err(),
            "invalid wallet session operation"
        );
    }

    #[test]
    fn wallet_session_exit_claim_uses_immutable_chain_and_exchange_context() {
        let seed_hex = "01".repeat(32);
        let session = wallet_session(1);
        let session_input = json!({
            "bridge_address": "0x1", "privacy_pool_address": "0x2",
            "asset_id": "STRK", "token_address": "0x4", "amount": "7",
            "exit_commitment": "0x5", "claim_account": "0x6", "open_note_id": "0x8",
        });
        let signed = session
            .sign_strk20_exit_claim_inner(&session_input.to_string())
            .unwrap();
        let mut forbidden = session_input.clone();
        forbidden["seed_hex"] = json!(seed_hex);
        assert!(
            session
                .sign_strk20_exit_claim_inner(&forbidden.to_string())
                .is_err()
        );
        assert_eq!(
            signed,
            zylith_wallet_sign_strk20_exit_claim(
                &json!({
                    "seed_hex": seed_hex,
                    "chain_id": "0x534e5f5345504f4c4941",
                    "bridge_address": "0x1",
                    "privacy_pool_address": "0x2",
                    "exchange_address": "0x5eed",
                    "asset_id": "STRK", "token_address": "0x4", "amount": "7",
                    "exit_commitment": "0x5", "claim_account": "0x6", "open_note_id": "0x8",
                })
                .to_string()
            )
            .unwrap()
        );
        assert!(!signed.contains("seed_hex"));
        assert!(!signed.contains(&seed_hex));
    }

    fn deposit(seed_hex: &str, asset: &str, amount: u128, nonce: u64) -> NoteFields {
        let plan = call(
            zylith_wallet_build_deposit_submission_plan,
            json!({ "seed_hex": seed_hex, "chain_id": "0x534e5f5345504f4c4941", "bridge_address": "0x123", "asset_id": asset, "amount": amount.to_string(), "deposit_nonce": nonce.to_string() }),
        );
        assert_eq!(plan["note"]["nonce"], nonce.to_string());
        serde_json::from_value(plan["note_fields"].clone()).unwrap()
    }

    fn proof_signer_v2_request(seed_byte: &str) -> Value {
        json!({
            "seed_hex": seed_byte.repeat(32),
            "chain_id": "0x534e5f5345504f4c4941",
            "proof_signer_class_hash": "0x123",
        })
    }

    #[test]
    fn proof_signer_v2_wasm_known_answers_and_numeric_targets_are_stable() {
        let order =
            Felt::from_hex("0x800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f")
                .unwrap();
        for (seed_byte, private_key, salt) in [
            (
                "00",
                "0x61e92aa2f68fab50076a57d60f9a65fd953242fd5b5a4ce0c05f3b8a1d4b6db",
                "0x788689130ce49a08cf4ad92ac95537b9629dc5dea84c26a3d56301466a943f3",
            ),
            (
                "01",
                "0x7a22e19566683233efedfa4d595a6faf3ca1f62a5e74a3ee9fe631714fce6d8",
                "0x749be86411fe1f66ae6e9e4cbcf00a326d242efe8930673d199e5b2a358d3d8",
            ),
        ] {
            let input = proof_signer_v2_request(seed_byte);
            let output = call(zylith_wallet_derive_proof_signer, input.clone());
            assert_eq!(
                output,
                json!({
                    "key_schedule_version": 2,
                    "proof_signer_private_key": private_key,
                    "proof_signer_salt": salt,
                })
            );
            assert_eq!(output, call(zylith_wallet_derive_proof_signer, input));
            let scalar =
                Felt::from_hex(output["proof_signer_private_key"].as_str().unwrap()).unwrap();
            assert!(scalar > Felt::ZERO && scalar < order);
            let salt = Felt::from_hex(output["proof_signer_salt"].as_str().unwrap()).unwrap();
            assert!(salt > Felt::ZERO);
            assert!(
                salt.to_bytes_be().as_slice()
                    < hex::decode(
                        "0800000000000011000000000000000000000000000000000000000000000001"
                    )
                    .unwrap()
                    .as_slice()
            );
        }
    }

    #[test]
    fn proof_signer_v2_wasm_binds_ordered_canonical_chain_and_class_context() {
        let input = proof_signer_v2_request("01");
        let base = call(zylith_wallet_derive_proof_signer, input.clone());
        for (field, value) in [
            ("chain_id", "0x534e5f4d41494e"),
            ("proof_signer_class_hash", "0x124"),
        ] {
            let mut changed = input.clone();
            changed[field] = json!(value);
            let output = call(zylith_wallet_derive_proof_signer, changed);
            assert_ne!(
                output["proof_signer_private_key"],
                base["proof_signer_private_key"]
            );
            assert_ne!(output["proof_signer_salt"], base["proof_signer_salt"]);
        }
        let mut equivalent = input.clone();
        equivalent["chain_id"] = json!("0000534E5F5345504F4C4941");
        equivalent["proof_signer_class_hash"] = json!("0x0000123");
        assert_eq!(base, call(zylith_wallet_derive_proof_signer, equivalent));
        let mut swapped = input.clone();
        swapped["chain_id"] = input["proof_signer_class_hash"].clone();
        swapped["proof_signer_class_hash"] = input["chain_id"].clone();
        let swapped = call(zylith_wallet_derive_proof_signer, swapped);
        assert_ne!(
            swapped["proof_signer_private_key"],
            base["proof_signer_private_key"]
        );
        assert_ne!(swapped["proof_signer_salt"], base["proof_signer_salt"]);
    }

    #[test]
    fn proof_signer_v2_wasm_rejects_invalid_context_and_seed_without_defaults() {
        for field in ["chain_id", "proof_signer_class_hash"] {
            for invalid in [
                "",
                "0",
                "0x0",
                "0x",
                "-0x1",
                "+0x1",
                " 0x1",
                "0x1 ",
                "0x1g",
                "0X1",
                "sn_sepolia",
                "0x800000000000011000000000000000000000000000000000000000000000001",
                "0x800000000000011000000000000000000000000000000000000000000000002",
                "0x10000000000000000000000000000000000000000000000000000000000000000",
            ] {
                let mut input = proof_signer_v2_request("01");
                input[field] = json!(invalid);
                assert!(
                    zylith_wallet_derive_proof_signer(&input.to_string()).is_err(),
                    "accepted {field}"
                );
            }
            for invalid in [Value::Null, json!(1), json!([]), json!({})] {
                let mut input = proof_signer_v2_request("01");
                input[field] = invalid;
                assert!(zylith_wallet_derive_proof_signer(&input.to_string()).is_err());
            }
        }
        for invalid in [
            "",
            "01",
            &"01".repeat(31),
            &"01".repeat(33),
            &"gg".repeat(32),
            &format!(" {}", "01".repeat(32)),
        ] {
            let mut input = proof_signer_v2_request("01");
            input["seed_hex"] = json!(invalid);
            assert!(zylith_wallet_derive_proof_signer(&input.to_string()).is_err());
        }
    }

    #[test]
    fn proof_signer_v2_wasm_rejects_missing_extra_and_duplicate_decoded_json_fields() {
        for field in ["seed_hex", "chain_id", "proof_signer_class_hash"] {
            let mut input = proof_signer_v2_request("01");
            input.as_object_mut().unwrap().remove(field);
            assert!(zylith_wallet_derive_proof_signer(&input.to_string()).is_err());
        }
        for field in [
            "label",
            "context",
            "key_schedule_version",
            "proof_signer_private_key",
        ] {
            let mut input = proof_signer_v2_request("01");
            input[field] = json!("caller-selected");
            assert!(zylith_wallet_derive_proof_signer(&input.to_string()).is_err());
        }
        let input = proof_signer_v2_request("01").to_string();
        for extra in [
            "\"seed_hex\":\"00\"",
            "\"chain_id\":\"0x2\"",
            "\"chain_\\u0069d\":\"0x2\"",
            "\"proof_signer_class_hash\":\"0x124\"",
            "\"proof_signer_class_\\u0068ash\":\"0x124\"",
            "\"context\":{\"chain_id\":\"0x1\",\"chain_\\u0069d\":\"0x2\"}",
        ] {
            let duplicate = input.replacen('{', &format!("{{{extra},"), 1);
            assert!(zylith_wallet_derive_proof_signer(&duplicate).is_err());
        }
        for invalid in ["null", "[]", "{}", "{", &format!("{input} {{}}")] {
            assert!(zylith_wallet_derive_proof_signer(invalid).is_err());
        }
    }

    fn deposit_blinding_v2_request() -> Value {
        json!({
            "seed_hex": "01".repeat(32),
            "chain_id": "0x534e5f5345504f4c4941",
            "bridge_address": "0x123",
            "asset_id": "STRK",
            "amount": "10",
            "deposit_nonce": "42",
        })
    }

    #[test]
    fn deposit_blinding_v2_wasm_known_answer_and_restored_ownership_are_stable() {
        let input = deposit_blinding_v2_request();
        let plan = call(zylith_wallet_build_deposit_submission_plan, input.clone());
        assert_eq!(
            plan,
            call(zylith_wallet_build_deposit_submission_plan, input)
        );
        assert_eq!(
            plan["note"]["blinding"],
            "0x2a42e91204c369dbb01b8b97e31b7bd090cdd1cc97f38d19ba1f8b207428342"
        );
        assert_eq!(
            plan["note"]["metadata_commitment"],
            "0x1672f907af0d37906f30b919955d01f137467cf023d959a89a8b04747895958"
        );
        assert_eq!(
            plan["note_commitment"],
            "0x67773e0920cef3dd570a87a4f919ac20519b32b412fca03a88c0bfe70072a6"
        );
        let fields: NoteFields = serde_json::from_value(plan["note_fields"].clone()).unwrap();
        assert!(wallet_keys(&"01".repeat(32)).unwrap().owns(&fields));
        assert!(!wallet_keys(&"02".repeat(32)).unwrap().owns(&fields));
        assert_eq!(
            felt(plan["note_commitment"].as_str().unwrap()).unwrap(),
            fields.commitment()
        );
        assert_eq!(
            plan["encoded_args"]["note_commitments"][0],
            plan["note_commitment"]
        );
        assert_eq!(plan["note"]["nonce"], "42");
    }

    #[test]
    fn deposit_blinding_v2_wasm_separates_chain_bridge_asset_amount_and_nonce() {
        let input = deposit_blinding_v2_request();
        let base = call(zylith_wallet_build_deposit_submission_plan, input.clone());
        for (field, value) in [
            ("chain_id", "0x1"),
            ("bridge_address", "0x124"),
            ("asset_id", "USDC"),
            ("amount", "11"),
            ("deposit_nonce", "43"),
        ] {
            let mut changed = input.clone();
            changed[field] = json!(value);
            let plan = call(zylith_wallet_build_deposit_submission_plan, changed);
            assert_ne!(
                plan["note"]["blinding"], base["note"]["blinding"],
                "unbound {field}"
            );
            assert_ne!(
                plan["note"]["metadata_commitment"], base["note"]["metadata_commitment"],
                "unbound metadata {field}"
            );
            assert_ne!(plan["note_commitment"], base["note_commitment"]);
        }
    }

    #[test]
    fn deposit_blinding_v2_wasm_requires_seed_and_canonical_nonzero_deployment_context() {
        for missing in ["seed_hex", "chain_id", "bridge_address"] {
            let mut input = deposit_blinding_v2_request();
            input.as_object_mut().unwrap().remove(missing);
            assert!(
                zylith_wallet_build_deposit_submission_plan(&input.to_string()).is_err(),
                "accepted missing {missing}"
            );
        }
        for field in ["chain_id", "bridge_address"] {
            for invalid in [
                "",
                "0",
                "0x0",
                "0x0000",
                "-1",
                "0xno",
                " 0x1",
                "0x1 ",
                "0x0800000000000011000000000000000000000000000000000000000000000001",
                "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            ] {
                let mut input = deposit_blinding_v2_request();
                input[field] = json!(invalid);
                assert!(
                    zylith_wallet_build_deposit_submission_plan(&input.to_string()).is_err(),
                    "accepted {field}: {invalid}"
                );
            }
        }
        let mut equivalent = deposit_blinding_v2_request();
        equivalent["chain_id"] = json!("0x0000534E5F5345504F4C4941");
        equivalent["bridge_address"] = json!("0x000123");
        assert_eq!(
            call(zylith_wallet_build_deposit_submission_plan, equivalent),
            call(
                zylith_wallet_build_deposit_submission_plan,
                deposit_blinding_v2_request()
            )
        );
        let mut overflow_nonce = deposit_blinding_v2_request();
        overflow_nonce["deposit_nonce"] = json!("18446744073709551616");
        assert!(zylith_wallet_build_deposit_submission_plan(&overflow_nonce.to_string()).is_err());
    }

    #[test]
    fn public_config_v2_known_answer_has_only_the_explicit_v2_fields() {
        let config: Value =
            serde_json::from_str(&zylith_wallet_derive_public_config(&"01".repeat(32)).unwrap())
                .unwrap();
        assert_eq!(
            config,
            json!({
                "key_schedule_version": 2,
                "account_id": "3142846eff7f5cd3bea9c020fcf9eb1e07554647daa520b0d065a0ac86292bc0",
                "spend_authority": "0x243f889e32d8c58c3782e1451d535e0a0fc6d989b53f13faf5f9f00dee1439c",
                "owner_tag": "0x28204bd403e2e99dbbbc654d2cc20f3a0ec2a15d43f58235b8a5dfb02f6c0d1",
                "withdraw_authority": "0x2fce9fc2142d4041978ed24ec83d33c1d22b8c857d2ca1c0cf250164648324f",
            })
        );
        for version in [
            Value::Null,
            json!(1),
            json!(3),
            json!("2"),
            json!(2.5),
            json!(true),
        ] {
            let mut wrong = config.clone();
            wrong["key_schedule_version"] = version;
            assert!(serde_json::from_value::<WalletPublicConfig>(wrong).is_err());
        }
        let mut missing = config.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("key_schedule_version");
        assert!(serde_json::from_value::<WalletPublicConfig>(missing).is_err());
        let mut alias = config.clone();
        alias["note_recognition_public_key"] = alias["owner_tag"].clone();
        assert!(serde_json::from_value::<WalletPublicConfig>(alias.clone()).is_err());
        alias.as_object_mut().unwrap().remove("owner_tag");
        assert!(serde_json::from_value::<WalletPublicConfig>(alias).is_err());
        let duplicate = config
            .to_string()
            .replacen('{', "{\"key_schedule_version\":2,", 1);
        assert!(serde_json::from_str::<WalletPublicConfig>(&duplicate).is_err());
    }

    #[test]
    fn owner_tag_public_config_deposit_and_note_commitment_match_the_wallet() {
        let seed_hex = "01".repeat(32);
        let keys = wallet_keys(&seed_hex).unwrap();
        let config: WalletPublicConfig =
            serde_json::from_str(&zylith_wallet_derive_public_config(&seed_hex).unwrap()).unwrap();
        assert_eq!(
            config,
            serde_json::from_str::<WalletPublicConfig>(
                &zylith_wallet_derive_public_config(&seed_hex).unwrap()
            )
            .unwrap()
        );
        assert_eq!(
            config.owner_tag,
            "0x28204bd403e2e99dbbbc654d2cc20f3a0ec2a15d43f58235b8a5dfb02f6c0d1"
        );
        let owner_tag = felt(&config.owner_tag).unwrap();
        assert_eq!(owner_tag, keys.owner_public_key);
        assert_eq!(
            felt(&config.spend_authority).unwrap(),
            public_key(&keys.spend_key)
        );
        assert_eq!(
            felt(&config.withdraw_authority).unwrap(),
            public_key(&keys.withdraw_key)
        );
        let plan = call(
            zylith_wallet_build_deposit_submission_plan,
            json!({
                "seed_hex": seed_hex,
                "chain_id": "0x534e5f5345504f4c4941",
                "bridge_address": "0x123",
                "asset_id": "STRK",
                "amount": "10",
                "deposit_nonce": "42",
            }),
        );
        let note: NoteFields = serde_json::from_value(plan["note_fields"].clone()).unwrap();
        let source_note: zylith_core::Note = serde_json::from_value(plan["note"].clone()).unwrap();
        assert_eq!(source_note.owner_public_key, config.owner_tag);
        assert_eq!(note.owner_public_key, owner_tag);
        assert!(keys.owns(&note));
        assert!(wallet_keys(&seed_hex).unwrap().owns(&note));
        assert!(!wallet_keys(&"02".repeat(32)).unwrap().owns(&note));
        assert_eq!(
            felt(&source_note.commitment().unwrap().0).unwrap(),
            note.commitment()
        );
        assert_eq!(
            felt(plan["note_commitment"].as_str().unwrap()).unwrap(),
            note.commitment()
        );
    }

    #[test]
    fn deposit_note_nonce_is_serialized_losslessly_for_javascript() {
        let plan = call(
            zylith_wallet_build_deposit_submission_plan,
            json!({
                "seed_hex": "11".repeat(32),
                "chain_id": "0x534e5f5345504f4c4941",
                "bridge_address": "0x123",
                "asset_id": "USDC",
                "amount": "2000000",
                "deposit_nonce": u64::MAX.to_string(),
            }),
        );
        assert_eq!(plan["note_fields"]["nonce"], u64::MAX.to_string());
    }

    #[test]
    fn transition_output_root_rejects_unpadded_records_and_matches_core() {
        let record = |leaf: u64| OutputRecord {
            leaf: Felt::from(leaf),
            enc: Felt::ZERO,
            enc_remaining: Felt::ZERO,
            enc_reserved: Felt::ZERO,
            enc_reserved_offset: Felt::ZERO,
        };
        let outputs = vec![record(1), record(2), record(3), record(4)];
        let computed = call(
            zylith_wallet_transition_output_root,
            json!({ "outputs": outputs }),
        );
        assert_eq!(
            computed,
            json!(format!(
                "{:#x}",
                output_tree_root(&[
                    Felt::ONE,
                    Felt::from(2_u8),
                    Felt::from(3_u8),
                    Felt::from(4_u8)
                ])
            ))
        );
        assert!(
            zylith_wallet_transition_output_root(
                &json!({ "outputs": [record(1), record(2), record(3)] }).to_string()
            )
            .is_err()
        );
    }

    #[test]
    fn market_ids_use_the_protocol_encodings() {
        let encoded = call(
            zylith_wallet_market_ids,
            json!({
                "pair": "STRK/USDC",
                "base_asset": "STRK",
                "quote_asset": "USDC",
            }),
        );
        assert_eq!(encoded["pair_id"], format!("{:#x}", pair_id("STRK/USDC")));
        assert_eq!(encoded["base_asset_id"], format!("{:#x}", asset_id("STRK")));
        assert_eq!(
            encoded["quote_asset_id"],
            format!("{:#x}", asset_id("USDC"))
        );
    }

    #[test]
    fn a_deposited_note_funds_a_sealed_order_whose_outputs_recover_from_the_chain() {
        let (seller, buyer) = ("11".repeat(32), "22".repeat(32));
        let (public, private) = execution_key("k1", 5);
        let registry = PrivateExecutionKeyRegistry { keys: vec![public] };
        let base = deposit(&seller, "STRK", 10, 1);
        let quote = deposit(&buyer, "USDC", 2_000, 2);
        let chain = "0x5eed";

        let mut tree = NoteAccumulator::default();
        tree.append(base.output_leaf());
        tree.append(quote.output_leaf());
        let mut orders: Vec<NewOrder> = Vec::new();
        let mut terms = Vec::new();
        for (index, (seed_hex, sell, note, limit)) in
            [(&seller, true, &base, 95), (&buyer, false, &quote, 105)]
                .into_iter()
                .enumerate()
        {
            let built = call(
                zylith_wallet_build_order_request,
                json!({
                    "seed_hex": seed_hex, "chain_context": chain, "chain_id": "0x1", "pair": "STRK/USDC", "sell": sell, "external": false,
                    "amount": "10", "limit": limit.to_string(), "expiry_ms": 1_000_000, "funding": [note], "registry": registry,
                }),
            );
            assert_eq!(built["nullifiers"][0], format!("{:#x}", note.nullifier()));
            let sealed: SealedRequest = serde_json::from_value(built["sealed"].clone()).unwrap();
            let PrivateRequest::Order(request) = open_request(
                &sealed,
                envelope_context("0x1", chain).unwrap(),
                std::slice::from_ref(&private),
            )
            .unwrap()
            .request
            else {
                panic!("an order seals as an order");
            };
            assert_eq!(built["order_id"], format!("{:#x}", request.order_id()));
            let membership = tree.membership(index, &[note.output_leaf()], 0).unwrap();
            terms.push(request.terms.clone());
            orders.push(request.try_into_new_order(vec![membership]).unwrap());
        }
        let mut transition = input(1, vec![], orders, tree.root(), 100);
        transition.chain_context = Felt::from_hex(chain).unwrap();
        transition.objective_numeraire_asset_id = quote.asset_id;
        transition.markets = vec![Market {
            pair_id: pair_id("STRK/USDC"),
            base_asset_id: base.asset_id,
            quote_asset_id: quote.asset_id,
            ..transition.markets[0].clone()
        }];
        let result = build_transition(&transition).unwrap();

        let membership = call(
            zylith_wallet_build_note_membership,
            json!({
                "batch_roots": [
                    format!("{:#x}", base.output_leaf()),
                    format!("{:#x}", quote.output_leaf()),
                    format!("{:#x}", result.public.output_root),
                ],
                "batch_index": 2,
                "batch_leaves": result.public.output_records.iter().map(|record| format!("{:#x}", record.leaf)).collect::<Vec<_>>(),
                "leaf_index": 0,
            }),
        );
        assert_eq!(
            membership["note_root"],
            format!("{:#x}", {
                let mut accumulator = NoteAccumulator::default();
                accumulator.append(base.output_leaf());
                accumulator.append(quote.output_leaf());
                accumulator.append(result.public.output_root);
                accumulator.root()
            })
        );

        for terms in terms {
            let recovered: Vec<RecoveredOutput> = serde_json::from_value(call(
                zylith_wallet_recover_order_outputs,
                json!({
                    "terms": terms, "base_asset": "STRK", "quote_asset": "USDC",
                    "transitions": [{ "seq": 1, "outputs": result.public.output_records }],
                }),
            ))
            .unwrap();
            let expected = result
                .outputs
                .iter()
                .filter(|output| output.order_id == terms.order_id())
                .map(|output| output.note.clone())
                .collect::<Vec<_>>();
            assert!(!expected.is_empty());
            assert_eq!(
                recovered
                    .into_iter()
                    .map(|output| output.note)
                    .collect::<Vec<_>>(),
                expected
            );
        }
    }

    #[test]
    fn residual_recovery_retries_reuse_the_same_one_time_exit() {
        let seed_hex = "44".repeat(32);
        let keys = wallet_keys(&seed_hex).unwrap();
        let base = deposit(&seed_hex, "STRK", 10, 9);
        let chain = Felt::from_hex("0x5eed").unwrap();
        let pair = pair_id("STRK/USDC");
        let quote = asset_id("USDC");
        let mut notes = NoteAccumulator::default();
        notes.append(base.output_leaf());
        let order = keys
            .order(
                chain,
                pair,
                true,
                false,
                10,
                95,
                1_000_000,
                vec![base.clone()],
            )
            .unwrap();
        let membership = notes.membership(0, &[base.output_leaf()], 0).unwrap();
        let mut transition = input(
            1,
            vec![],
            vec![order.try_into_new_order(vec![membership]).unwrap()],
            notes.root(),
            100,
        );
        transition.chain_context = chain;
        transition.objective_numeraire_asset_id = quote;
        transition.markets = vec![Market {
            pair_id: pair,
            base_asset_id: base.asset_id,
            quote_asset_id: quote,
            ..transition.markets[0].clone()
        }];
        let result = build_transition(&transition).unwrap();
        let residual = result.residual_outputs[0].clone();
        notes.append(result.public.output_root);
        let membership = notes
            .membership(
                1,
                &result
                    .public
                    .output_records
                    .iter()
                    .map(|record| record.leaf)
                    .collect::<Vec<_>>(),
                residual.index,
            )
            .unwrap();
        let input = json!({
            "seed_hex": seed_hex,
            "note_root": format!("{:#x}", notes.root()),
            "note": residual.note,
            "membership": membership,
            "output_asset_id": format!("{quote:#x}"),
            "fee_bps": "30",
            "capacity": RecoveryCapacity::default(),
        });
        let first = call(zylith_wallet_build_residual_recovery, input.clone());
        let retry = call(zylith_wallet_build_residual_recovery, input);
        assert_eq!(
            first["input_exit_commitment"],
            retry["input_exit_commitment"]
        );
        assert_eq!(
            first["output_exit_commitment"],
            retry["output_exit_commitment"]
        );
        assert_eq!(first["public"]["commitment"], retry["public"]["commitment"]);
    }

    #[test]
    fn a_registry_fingerprint_accepts_one_canonical_x25519_v2_key() {
        let registry = PrivateExecutionKeyRegistry {
            keys: vec![PrivateExecutionKeyPublicConfig {
                key_id: "active".into(),
                algorithm: zylith_core::private_envelope::HPKE_PROFILE_ID.into(),
                public_key: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a"
                    .into(),
            }],
        };
        let fingerprint =
            zylith_wallet_registry_fingerprint(&serde_json::to_string(&registry).unwrap()).unwrap();
        assert_eq!(
            fingerprint,
            "d2c009f2ef19ce5f504d4948424f2686711ad06d7b8d83d401912ea7fc514b4d"
        );
    }

    #[test]
    fn a_status_request_is_answered_under_its_response_key() {
        let (public, private) = execution_key("k1", 7);
        let registry = PrivateExecutionKeyRegistry { keys: vec![public] };
        let seed_hex = "11".repeat(32);
        let chain_context = "0x123";
        let idle = call(
            zylith_wallet_build_status_requests,
            json!({ "registry": registry, "seed_hex": seed_hex, "chain_context": chain_context, "chain_id": "0x1", "orders": [], "nullifiers": [] }),
        );
        assert!(idle.as_array().unwrap().is_empty());
        let many = call(
            zylith_wallet_build_status_requests,
            json!({ "registry": registry, "seed_hex": seed_hex, "chain_context": chain_context, "chain_id": "0x1", "orders": vec![json!({ "order_id": "0x77" }); 40], "nullifiers": [] }),
        );
        assert_eq!(many.as_array().unwrap().len(), 5);
        let built = call(
            zylith_wallet_build_status_requests,
            json!({ "registry": registry, "seed_hex": seed_hex, "chain_context": chain_context, "chain_id": "0x1", "orders": [{ "order_id": "0x77", "after_seq": 3 }], "nullifiers": ["0x9"] }),
        )[0]
        .clone();
        let sealed: SealedRequest = serde_json::from_value(built["sealed"].clone()).unwrap();
        let wire = built["sealed"].as_object().unwrap();
        assert_eq!(
            wire.keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
            [
                "ciphertext",
                "digest",
                "encapsulated_key",
                "key_id",
                "version",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect()
        );
        assert_eq!(sealed.version, 3);
        assert_eq!(sealed.key_id, "k1");
        assert_eq!(sealed.digest.len(), 64);
        assert_eq!(sealed.encapsulated_key.len(), 64);
        assert_eq!(sealed.ciphertext.len(), 8_224);
        let opened = open_request(
            &sealed,
            envelope_context("0x1", chain_context).unwrap(),
            std::slice::from_ref(&private),
        )
        .unwrap();
        assert!(
            open_request(
                &sealed,
                envelope_context("0x2", chain_context).unwrap(),
                std::slice::from_ref(&private),
            )
            .is_err()
        );
        assert!(
            open_request(
                &sealed,
                envelope_context("0x1", "0x124").unwrap(),
                std::slice::from_ref(&private),
            )
            .is_err()
        );
        let PrivateRequest::Status(status) = &opened.request else {
            panic!("a status request seals as one");
        };
        assert_eq!(status.orders[0].after_seq, 3);
        assert_eq!(status.withdrawals[0].nullifier, Felt::from(9_u8));
        let keys = wallet_keys(&seed_hex).unwrap();
        assert!(verify_message(
            &public_key(&keys.withdraw_key),
            &withdrawal_status_message(Felt::from_hex(chain_context).unwrap(), Felt::from(9_u8),),
            &status.withdrawals[0].authorization,
        ));
        let answer = json!({ "ok": true, "orders": [], "withdrawals": [] });
        let response =
            zylith_core::exchange::seal_response(&opened.response_key, &sealed.digest, &answer)
                .unwrap();
        let key: [u8; 32] = hex::decode(built["response_key"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            zylith_core::exchange::open_response(&key, &sealed.digest, &response).unwrap(),
            answer
        );
    }

    #[test]
    fn cancel_and_withdraw_requests_seal_to_the_registry() {
        let seed_hex = "33".repeat(32);
        let (public, private) = execution_key("k1", 6);
        let registry = PrivateExecutionKeyRegistry { keys: vec![public] };
        let note = deposit(&seed_hex, "STRK", 7, 3);
        let cancel = call(
            zylith_wallet_build_cancel_request,
            json!({ "seed_hex": seed_hex, "chain_context": "0x5eed", "chain_id": "0x1", "order_id": "0x77", "registry": registry }),
        );
        let cancel: SealedRequest = serde_json::from_value(cancel["sealed"].clone()).unwrap();
        assert!(matches!(
            open_request(
                &cancel,
                envelope_context("0x1", "0x5eed").unwrap(),
                std::slice::from_ref(&private)
            )
            .unwrap()
            .request,
            PrivateRequest::Cancel(_)
        ));
        let withdraw = call(
            zylith_wallet_build_withdraw_request,
            json!({ "seed_hex": seed_hex, "chain_context": "0x5eed", "chain_id": "0x1", "note": note, "registry": registry }),
        );
        assert_eq!(withdraw["nullifier"], format!("{:#x}", note.nullifier()));
        let sealed: SealedRequest = serde_json::from_value(withdraw["sealed"].clone()).unwrap();
        let PrivateRequest::Withdraw(request) = open_request(
            &sealed,
            envelope_context("0x1", "0x5eed").unwrap(),
            &[private],
        )
        .unwrap()
        .request
        else {
            panic!("a withdrawal seals as a withdrawal");
        };
        request.validate(Felt::from_hex("0x5eed").unwrap()).unwrap();
        assert_eq!(
            format!("{:#x}", request.exit_commitment),
            withdraw["exit_commitment"]
        );
        assert_ne!(request.exit_authority, request.note.withdraw_authority);
        // a retry keeps its exit.
        let retried = call(
            zylith_wallet_build_withdraw_request,
            json!({ "seed_hex": seed_hex, "chain_context": "0x5eed", "chain_id": "0x1", "note": note, "exit_commitment": withdraw["exit_commitment"], "registry": registry }),
        );
        assert_eq!(retried["exit_commitment"], withdraw["exit_commitment"]);
        // another wallet cannot withdraw it.
        assert!(zylith_wallet_build_withdraw_request(&json!({ "seed_hex": "44".repeat(32), "chain_context": "0x5eed", "chain_id": "0x1", "note": note, "registry": registry }).to_string()).is_err());
    }

    #[test]
    fn the_exit_claim_is_signed_by_its_one_time_authority() {
        let seed_hex = "55".repeat(32);
        let note = deposit(&seed_hex, "STRK", 7, 3);
        let message = |exchange_address, claim_account, open_note_id| Strk20ExitClaimMessage {
            chain_id: "0x534e5f5345504f4c4941",
            bridge_address: "0x1",
            privacy_pool_address: "0x2",
            exchange_address,
            asset_id: "STRK",
            token_address: "0x4",
            amount: "7",
            exit_commitment: "0x5",
            claim_account,
            open_note_id,
        };
        let signed = call(
            zylith_wallet_sign_strk20_exit_claim,
            json!({
                "seed_hex": seed_hex, "chain_id": "0x534e5f5345504f4c4941", "bridge_address": "0x1", "privacy_pool_address": "0x2",
                "exchange_address": "0x3", "asset_id": "STRK", "token_address": "0x4", "amount": "7", "exit_commitment": "0x5", "claim_account": "0x6", "open_note_id": "0x8",
            }),
        );
        let signature = Signature {
            r: felt(signed["signature_r"].as_str().unwrap()).unwrap(),
            s: felt(signed["signature_s"].as_str().unwrap()).unwrap(),
        };
        let hash = |exchange, claim_account, open_note_id| {
            felt(
                &zylith_core::strk20_exit_claim_message_hash(message(
                    exchange,
                    claim_account,
                    open_note_id,
                ))
                .unwrap(),
            )
            .unwrap()
        };
        let exit_authority = public_key(
            &wallet_keys(&seed_hex)
                .unwrap()
                .exit_key(Felt::from(3_u8), Felt::from(5_u8)),
        );
        assert!(verify_message(
            &exit_authority,
            &hash("0x3", "0x6", "0x8"),
            &signature
        ));
        assert!(!verify_message(
            &exit_authority,
            &hash("0x33", "0x6", "0x8"),
            &signature
        ));
        assert!(!verify_message(
            &exit_authority,
            &hash("0x3", "0x66", "0x8"),
            &signature
        ));
        assert!(!verify_message(
            &exit_authority,
            &hash("0x3", "0x6", "0x88"),
            &signature
        ));
        assert_ne!(exit_authority, note.withdraw_authority);
        let config: WalletPublicConfig =
            serde_json::from_str(&zylith_wallet_derive_public_config(&seed_hex).unwrap()).unwrap();
        assert_eq!(
            felt(&config.withdraw_authority).unwrap(),
            note.withdraw_authority
        );
    }

    #[test]
    fn recovery_v2_stamps_both_envelopes_and_refuses_missing_or_wrong_versions() {
        let seed_hex = "01".repeat(32);
        let artifact = zylith_wallet_create_recovery_snapshot(
            &json!({
                "seed_hex": seed_hex, "sequence": 1, "created_at_unix_ms": 1,
                "payload_json": json!({ "version": 2, "key_schedule_version": 2, "scope": "test", "state": { "version": 2, "key_schedule_version": 2, "notes": [], "orders": [], "scanned_seq": 0 } }).to_string(),
            }).to_string(),
        ).unwrap();
        let value: Value = serde_json::from_str(&artifact).unwrap();
        assert_eq!(value["key_schedule_version"], 2);
        assert_eq!(value["payload"]["key_schedule_version"], 2);
        assert_eq!(
            value["account_id"],
            "3142846eff7f5cd3bea9c020fcf9eb1e07554647daa520b0d065a0ac86292bc0"
        );
        for version in [
            Value::Null,
            json!(1),
            json!(3),
            json!("2"),
            json!(2.5),
            json!(true),
            json!({}),
            json!([]),
        ] {
            for nested in [false, true] {
                let mut wrong = value.clone();
                let envelope = if nested {
                    &mut wrong["payload"]
                } else {
                    &mut wrong
                };
                envelope["key_schedule_version"] = version.clone();
                assert!(
                    zylith_wallet_decrypt_recovery_artifact(&seed_hex, &wrong.to_string()).is_err()
                );
                let envelope = if nested {
                    &mut wrong["payload"]
                } else {
                    &mut wrong
                };
                envelope
                    .as_object_mut()
                    .unwrap()
                    .remove("key_schedule_version");
                assert!(
                    zylith_wallet_decrypt_recovery_artifact(&seed_hex, &wrong.to_string()).is_err()
                );
            }
        }
        let duplicate = artifact.replacen('{', "{\"key_schedule_version\":2,", 1);
        assert!(zylith_wallet_decrypt_recovery_artifact(&seed_hex, &duplicate).is_err());
    }

    #[test]
    fn recovery_snapshot_creation_rejects_duplicate_decoded_note_and_order_keys() {
        let seed_hex = "01".repeat(32);
        let canonical = json!({
            "version": 2,
            "key_schedule_version": 2,
            "scope": "test",
            "state": {
                "version": 2,
                "key_schedule_version": 2,
                "notes": [{ "commitment": "a" }],
                "orders": [{ "order_id": "b" }],
                "scanned_seq": 0,
            },
        })
        .to_string();
        for malformed in [
            canonical.replace(
                "\"commitment\":\"a\"",
                "\"commitment\":\"a\",\"commitment\":\"b\"",
            ),
            canonical.replace(
                "\"commitment\":\"a\"",
                "\"commitment\":\"a\",\"commi\\u0074ment\":\"b\"",
            ),
            canonical.replace(
                "\"order_id\":\"b\"",
                "\"order_id\":\"b\",\"order_id\":\"c\"",
            ),
            canonical.replace(
                "\"order_id\":\"b\"",
                "\"order_id\":\"b\",\"order_\\u0069d\":\"c\"",
            ),
        ] {
            let input = json!({
                "seed_hex": seed_hex,
                "sequence": 1,
                "created_at_unix_ms": 1,
                "payload_json": malformed,
            });
            assert!(zylith_wallet_create_recovery_snapshot(&input.to_string()).is_err());
        }
    }

    #[test]
    fn recovery_snapshots_round_trip_under_the_seed() {
        let seed_hex = "44".repeat(32);
        assert_eq!(
            zylith_wallet_recovery_auth_tag(&seed_hex).unwrap(),
            zylith_wallet_recovery_auth_tag(&seed_hex).unwrap()
        );
        let artifact = zylith_wallet_create_recovery_snapshot(
            &json!({ "seed_hex": seed_hex, "sequence": 7, "created_at_unix_ms": 1_700_000_000_000_u64, "payload_json": json!({ "version": 2, "key_schedule_version": 2, "scope": "test", "state": { "version": 2, "key_schedule_version": 2, "notes": [], "orders": [1], "scanned_seq": 0 } }).to_string() }).to_string(),
        )
        .unwrap();
        let payload: Value = serde_json::from_str(
            &zylith_wallet_decrypt_recovery_artifact(&seed_hex, &artifact).unwrap(),
        )
        .unwrap();
        assert_eq!(payload["state"]["orders"][0], 1);
        assert!(zylith_wallet_decrypt_recovery_artifact(&"45".repeat(32), &artifact).is_err());
    }
}
