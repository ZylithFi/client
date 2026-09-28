//! the browser wallet's cryptography. every function takes and returns json; the seed never
//! leaves wasm memory except as the caller's own input.

use serde::{Deserialize, Serialize};
use starknet_crypto::Felt;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;
use zylith_core::exchange::{
    NoteFields, OrderTerms, OutputRecord, PrivateRequest, RecoveredOutput, SealedRequest,
    StatusRequest, WalletKeys, asset_id, chunk_status, pair_id, random_felt, recover_order_outputs,
    seal_request,
};
use zylith_core::{
    AssetId, DepositIntent, DepositSubmissionPlan, PrivateExecutionKeyRegistry, RecoveryArtifact,
    RecoveryArtifactKind, RecoverySeed, SpendAuthorization, Strk20ExitClaimMessage,
    build_deposit_submission_plan, create_recovery_artifact, decrypt_recovery_artifact_payload,
    derive_account_id, derive_recovery_auth_tag, derive_user_keys,
    note_recognition_public_key_from_raw_key_hex, sign_strk20_exit_claim_authorization,
    spend_authority_from_raw_key_hex, withdraw_authority_from_raw_key_hex,
};

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

fn seed(seed_hex: &str) -> Result<RecoverySeed, JsValue> {
    RecoverySeed::from_hex(seed_hex).map_err(js_error)
}

fn wallet_keys(seed_hex: &str) -> Result<WalletKeys, JsValue> {
    WalletKeys::from_seed(&seed(seed_hex)?).map_err(js_error)
}

fn felt(value: &str) -> Result<Felt, JsValue> {
    Felt::from_hex(value).map_err(|_| js_error(format!("{value} is not a hex felt")))
}

/// a sealed request and the one-time key its answer opens with.
#[derive(Serialize)]
pub struct Sealed {
    pub sealed: SealedRequest,
    pub response_key: String,
}

fn seal(
    registry: &PrivateExecutionKeyRegistry,
    request: PrivateRequest,
) -> Result<Sealed, JsValue> {
    let (sealed, response_key) = seal_request(registry, &request).map_err(js_error)?;
    Ok(Sealed {
        sealed,
        response_key: hex::encode(response_key.as_slice()),
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_generate_seed_hex() -> String {
    RecoverySeed::generate().to_hex()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WalletPublicConfig {
    pub account_id: String,
    pub spend_authority: String,
    pub note_recognition_public_key: String,
    pub withdraw_authority: String,
}

#[wasm_bindgen]
pub fn zylith_wallet_derive_public_config(seed_hex: &str) -> Result<String, JsValue> {
    let seed = seed(seed_hex)?;
    let keys = derive_user_keys(&seed);
    to_json(&WalletPublicConfig {
        account_id: derive_account_id(&seed),
        spend_authority: spend_authority_from_raw_key_hex(&Zeroizing::new(hex::encode(
            keys.spend_auth_key,
        )))
        .map_err(js_error)?,
        note_recognition_public_key: note_recognition_public_key_from_raw_key_hex(&Zeroizing::new(
            hex::encode(keys.note_recognition_key),
        ))
        .map_err(js_error)?,
        withdraw_authority: withdraw_authority_from_raw_key_hex(&Zeroizing::new(hex::encode(
            keys.withdraw_auth_key,
        )))
        .map_err(js_error)?,
    })
}

#[wasm_bindgen]
pub fn zylith_wallet_recovery_auth_tag(seed_hex: &str) -> Result<String, JsValue> {
    let seed = seed(seed_hex)?;
    let recovery_key_hex = Zeroizing::new(hex::encode(derive_user_keys(&seed).recovery_key));
    Ok(derive_recovery_auth_tag(
        &derive_account_id(&seed),
        &recovery_key_hex,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DepositRequest {
    pub seed_hex: String,
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

#[wasm_bindgen]
pub fn zylith_wallet_build_deposit_submission_plan(input_json: &str) -> Result<String, JsValue> {
    let request: DepositRequest = from_json(input_json)?;
    let keys = derive_user_keys(&seed(&request.seed_hex)?);
    let intent = DepositIntent {
        asset_id: request.asset_id,
        amount: request.amount,
        deposit_nonce: request.deposit_nonce,
        recipient_owner_public_key: note_recognition_public_key_from_raw_key_hex(&Zeroizing::new(
            hex::encode(keys.note_recognition_key),
        ))
        .map_err(js_error)?,
        recipient_spend_authority: spend_authority_from_raw_key_hex(&Zeroizing::new(hex::encode(
            keys.spend_auth_key,
        )))
        .map_err(js_error)?,
        recipient_withdraw_authority: withdraw_authority_from_raw_key_hex(&Zeroizing::new(
            hex::encode(keys.withdraw_auth_key),
        ))
        .map_err(js_error)?,
    };
    let plan = build_deposit_submission_plan(&intent).map_err(js_error)?;
    let note_fields = NoteFields::from_note(&plan.note).map_err(js_error)?;
    to_json(&DepositResponse { plan, note_fields })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderInput {
    pub seed_hex: String,
    /// the exchange's address, which every signature binds.
    pub chain_context: String,
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

#[wasm_bindgen]
pub fn zylith_wallet_build_order_request(input_json: &str) -> Result<String, JsValue> {
    let input: OrderInput = from_json(input_json)?;
    let keys = wallet_keys(&input.seed_hex)?;
    let request = keys
        .order(
            felt(&input.chain_context)?,
            pair_id(&input.pair),
            input.sell,
            input.external,
            input.amount,
            input.limit,
            input.expiry_ms,
            input.funding,
        )
        .map_err(js_error)?;
    to_json(&OrderOutput {
        order_id: format!("{:#x}", request.order_id()),
        nullifiers: request
            .funding
            .iter()
            .map(|note| format!("{:#x}", note.nullifier()))
            .collect(),
        terms: request.terms.clone(),
        sealed: seal(&input.registry, PrivateRequest::Order(request))?,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelInput {
    pub seed_hex: String,
    pub chain_context: String,
    pub order_id: String,
    pub registry: PrivateExecutionKeyRegistry,
}

#[wasm_bindgen]
pub fn zylith_wallet_build_cancel_request(input_json: &str) -> Result<String, JsValue> {
    let input: CancelInput = from_json(input_json)?;
    let request = wallet_keys(&input.seed_hex)?
        .cancel(felt(&input.chain_context)?, felt(&input.order_id)?)
        .map_err(js_error)?;
    to_json(&seal(&input.registry, PrivateRequest::Cancel(request))?)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WithdrawInput {
    pub seed_hex: String,
    pub chain_context: String,
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

#[wasm_bindgen]
pub fn zylith_wallet_build_withdraw_request(input_json: &str) -> Result<String, JsValue> {
    let input: WithdrawInput = from_json(input_json)?;
    let exit_commitment = match &input.exit_commitment {
        Some(exit) => felt(exit)?,
        None => random_felt(),
    };
    let request = wallet_keys(&input.seed_hex)?
        .withdraw(felt(&input.chain_context)?, input.note, exit_commitment)
        .map_err(js_error)?;
    to_json(&WithdrawOutput {
        nullifier: format!("{:#x}", request.note.nullifier()),
        exit_commitment: format!("{exit_commitment:#x}"),
        sealed: seal(&input.registry, PrivateRequest::Withdraw(request))?,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusInput {
    pub registry: PrivateExecutionKeyRegistry,
    #[serde(flatten)]
    pub status: StatusRequest,
}

/// the fingerprint a deployment manifest pins for an execution key registry.
#[wasm_bindgen]
pub fn zylith_wallet_registry_fingerprint(registry_json: &str) -> Result<String, JsValue> {
    let registry: PrivateExecutionKeyRegistry = from_json(registry_json)?;
    registry.fingerprint().map_err(js_error)
}

/// the sealed lookups for every order and withdrawal the wallet follows, chunked within the
/// shared status limit.
#[wasm_bindgen]
pub fn zylith_wallet_build_status_requests(input_json: &str) -> Result<String, JsValue> {
    let input: StatusInput = from_json(input_json)?;
    to_json(
        &chunk_status(input.status)
            .into_iter()
            .map(|status| seal(&input.registry, PrivateRequest::Status(status)))
            .collect::<Result<Vec<_>, _>>()?,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecoverySnapshotInput {
    pub seed_hex: String,
    pub sequence: u64,
    pub created_at_unix_ms: u64,
    pub payload_json: String,
}

#[wasm_bindgen]
pub fn zylith_wallet_create_recovery_snapshot(input_json: &str) -> Result<String, JsValue> {
    let input: RecoverySnapshotInput = from_json(input_json)?;
    let payload: serde_json::Value = from_json(&input.payload_json)?;
    let artifact = create_recovery_artifact(
        &seed(&input.seed_hex)?,
        RecoveryArtifactKind::Snapshot,
        input.sequence,
        input.created_at_unix_ms,
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
    let artifact: RecoveryArtifact = from_json(artifact_json)?;
    to_json(&decrypt_recovery_artifact_payload(&seed(seed_hex)?, &artifact).map_err(js_error)?)
}

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
    pub open_note_id: String,
}

/// signs the privacy pool claim of a finalized withdrawal's exit.
#[wasm_bindgen]
pub fn zylith_wallet_sign_strk20_exit_claim(input_json: &str) -> Result<String, JsValue> {
    let input: ExitClaimInput = from_json(input_json)?;
    let keys = wallet_keys(&input.seed_hex)?;
    let exit_key = keys.exit_key(
        felt(&input.exchange_address)?,
        felt(&input.exit_commitment)?,
    );
    let exit_key = Zeroizing::new(format!("{exit_key:#x}"));
    let signed: SpendAuthorization = sign_strk20_exit_claim_authorization(
        &exit_key,
        Strk20ExitClaimMessage {
            chain_id: &input.chain_id,
            bridge_address: &input.bridge_address,
            privacy_pool_address: &input.privacy_pool_address,
            exchange_address: &input.exchange_address,
            asset_id: &input.asset_id,
            token_address: &input.token_address,
            amount: &input.amount,
            exit_commitment: &input.exit_commitment,
            open_note_id: &input.open_note_id,
        },
    )
    .map_err(js_error)?;
    to_json(&signed)
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
    use p256::elliptic_curve::sec1::ToEncodedPoint;
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
        byte: u8,
    ) -> (
        PrivateExecutionKeyPublicConfig,
        PrivateExecutionKeyPrivateConfig,
    ) {
        let secret = p256::SecretKey::from_slice(&[byte; 32]).unwrap();
        let public_key = hex::encode(secret.public_key().to_encoded_point(false).as_bytes());
        (
            PrivateExecutionKeyPublicConfig {
                key_id: id.into(),
                public_key: public_key.clone(),
            },
            PrivateExecutionKeyPrivateConfig {
                key_id: id.into(),
                public_key,
                private_key: hex::encode([byte; 32]),
            },
        )
    }

    fn call(function: fn(&str) -> Result<String, JsValue>, input: Value) -> Value {
        serde_json::from_str(&function(&input.to_string()).expect("the wallet call succeeds"))
            .unwrap()
    }

    fn deposit(seed_hex: &str, asset: &str, amount: u128, nonce: u64) -> NoteFields {
        let plan = call(
            zylith_wallet_build_deposit_submission_plan,
            json!({ "seed_hex": seed_hex, "asset_id": asset, "amount": amount.to_string(), "deposit_nonce": nonce.to_string() }),
        );
        assert_eq!(plan["note"]["nonce"], nonce.to_string());
        serde_json::from_value(plan["note_fields"].clone()).unwrap()
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
                    "seed_hex": seed_hex, "chain_context": chain, "pair": "STRK/USDC", "sell": sell, "external": false,
                    "amount": "10", "limit": limit.to_string(), "expiry_ms": 1_000_000, "funding": [note], "registry": registry,
                }),
            );
            assert_eq!(built["nullifiers"][0], format!("{:#x}", note.nullifier()));
            let sealed: SealedRequest = serde_json::from_value(built["sealed"].clone()).unwrap();
            let PrivateRequest::Order(request) =
                open_request(&sealed, std::slice::from_ref(&private))
                    .unwrap()
                    .request
            else {
                panic!("an order seals as an order");
            };
            assert_eq!(built["order_id"], format!("{:#x}", request.order_id()));
            let membership = tree.membership(index, &[note.output_leaf()], 0).unwrap();
            terms.push(request.terms.clone());
            orders.push(request.into_new_order(vec![membership]));
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
    fn a_registry_fingerprint_ignores_key_order_but_not_keys() {
        let (first, _) = execution_key("k1", 8);
        let (second, _) = execution_key("k2", 9);
        let fingerprint = |keys: Vec<PrivateExecutionKeyPublicConfig>| {
            zylith_wallet_registry_fingerprint(
                &serde_json::to_string(&PrivateExecutionKeyRegistry { keys }).unwrap(),
            )
            .unwrap()
        };
        let pinned = fingerprint(vec![first.clone(), second.clone()]);
        assert_eq!(pinned.len(), 64);
        assert_eq!(fingerprint(vec![second.clone(), first.clone()]), pinned);
        let (swapped, _) = execution_key("k2", 10);
        assert_ne!(fingerprint(vec![first.clone(), swapped]), pinned);
        assert_ne!(fingerprint(vec![first]), pinned);
    }

    #[test]
    fn a_status_request_is_answered_under_its_response_key() {
        let (public, private) = execution_key("k1", 7);
        let registry = PrivateExecutionKeyRegistry { keys: vec![public] };
        let heartbeat = call(
            zylith_wallet_build_status_requests,
            json!({ "registry": registry, "orders": [], "nullifiers": [] }),
        );
        assert_eq!(heartbeat.as_array().unwrap().len(), 1);
        let many = call(
            zylith_wallet_build_status_requests,
            json!({ "registry": registry, "orders": vec![json!({ "order_id": "0x77" }); 40], "nullifiers": [] }),
        );
        assert_eq!(many.as_array().unwrap().len(), 5);
        let built = call(
            zylith_wallet_build_status_requests,
            json!({ "registry": registry, "orders": [{ "order_id": "0x77", "after_seq": 3 }], "nullifiers": ["0x9"] }),
        )[0]
        .clone();
        let sealed: SealedRequest = serde_json::from_value(built["sealed"].clone()).unwrap();
        let opened = open_request(&sealed, &[private]).unwrap();
        let PrivateRequest::Status(status) = &opened.request else {
            panic!("a status request seals as one");
        };
        assert_eq!(status.orders[0].after_seq, 3);
        assert_eq!(status.nullifiers, vec![Felt::from(9_u8)]);
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
            json!({ "seed_hex": seed_hex, "chain_context": "0x5eed", "order_id": "0x77", "registry": registry }),
        );
        let cancel: SealedRequest = serde_json::from_value(cancel["sealed"].clone()).unwrap();
        assert!(matches!(
            open_request(&cancel, std::slice::from_ref(&private))
                .unwrap()
                .request,
            PrivateRequest::Cancel(_)
        ));
        let withdraw = call(
            zylith_wallet_build_withdraw_request,
            json!({ "seed_hex": seed_hex, "chain_context": "0x5eed", "note": note, "registry": registry }),
        );
        assert_eq!(withdraw["nullifier"], format!("{:#x}", note.nullifier()));
        let sealed: SealedRequest = serde_json::from_value(withdraw["sealed"].clone()).unwrap();
        let PrivateRequest::Withdraw(request) = open_request(&sealed, &[private]).unwrap().request
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
            json!({ "seed_hex": seed_hex, "chain_context": "0x5eed", "note": note, "exit_commitment": withdraw["exit_commitment"], "registry": registry }),
        );
        assert_eq!(retried["exit_commitment"], withdraw["exit_commitment"]);
        // another wallet cannot withdraw it.
        assert!(zylith_wallet_build_withdraw_request(&json!({ "seed_hex": "44".repeat(32), "chain_context": "0x5eed", "note": note, "registry": registry }).to_string()).is_err());
    }

    #[test]
    fn the_exit_claim_is_signed_by_its_one_time_authority() {
        let seed_hex = "55".repeat(32);
        let note = deposit(&seed_hex, "STRK", 7, 3);
        let message = |exchange_address| Strk20ExitClaimMessage {
            chain_id: "0x534e5f5345504f4c4941",
            bridge_address: "0x1",
            privacy_pool_address: "0x2",
            exchange_address,
            asset_id: "STRK",
            token_address: "0x4",
            amount: "7",
            exit_commitment: "0x5",
            open_note_id: "0x6",
        };
        let signed = call(
            zylith_wallet_sign_strk20_exit_claim,
            json!({
                "seed_hex": seed_hex, "chain_id": "0x534e5f5345504f4c4941", "bridge_address": "0x1", "privacy_pool_address": "0x2",
                "exchange_address": "0x3", "asset_id": "STRK", "token_address": "0x4", "amount": "7", "exit_commitment": "0x5", "open_note_id": "0x6",
            }),
        );
        let signature = Signature {
            r: felt(signed["signature_r"].as_str().unwrap()).unwrap(),
            s: felt(signed["signature_s"].as_str().unwrap()).unwrap(),
        };
        let hash = |exchange| {
            felt(&zylith_core::strk20_exit_claim_message_hash(message(exchange)).unwrap()).unwrap()
        };
        let exit_authority = public_key(
            &wallet_keys(&seed_hex)
                .unwrap()
                .exit_key(Felt::from(3_u8), Felt::from(5_u8)),
        );
        assert!(verify_message(&exit_authority, &hash("0x3"), &signature));
        assert!(!verify_message(&exit_authority, &hash("0x33"), &signature));
        assert_ne!(exit_authority, note.withdraw_authority);
        let config: WalletPublicConfig =
            serde_json::from_str(&zylith_wallet_derive_public_config(&seed_hex).unwrap()).unwrap();
        assert_eq!(
            felt(&config.withdraw_authority).unwrap(),
            note.withdraw_authority
        );
    }

    #[test]
    fn recovery_snapshots_round_trip_under_the_seed() {
        let seed_hex = "44".repeat(32);
        assert_eq!(
            zylith_wallet_recovery_auth_tag(&seed_hex).unwrap(),
            zylith_wallet_recovery_auth_tag(&seed_hex).unwrap()
        );
        let artifact = zylith_wallet_create_recovery_snapshot(
            &json!({ "seed_hex": seed_hex, "sequence": 7, "created_at_unix_ms": 1_700_000_000_000_u64, "payload_json": json!({ "orders": [1] }).to_string() }).to_string(),
        )
        .unwrap();
        let payload: Value = serde_json::from_str(
            &zylith_wallet_decrypt_recovery_artifact(&seed_hex, &artifact).unwrap(),
        )
        .unwrap();
        assert_eq!(payload["orders"][0], 1);
        assert!(zylith_wallet_decrypt_recovery_artifact(&"45".repeat(32), &artifact).is_err());
    }
}
