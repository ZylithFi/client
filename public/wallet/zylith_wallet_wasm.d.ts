/* tslint:disable */
/* eslint-disable */

/**
 * an unlocked wallet bound to one immutable chain and deployment context.
 *
 * the session deliberately has no debug representation that could grow to expose retained
 * secret state.
 *
 * ```compile_fail
 * use std::fmt::Debug;
 * use zylith_wallet_wasm::WalletSession;
 * fn requires_debug<T: Debug>() {}
 * requires_debug::<WalletSession>();
 * ```
 */
export class WalletSession {
    free(): void;
    [Symbol.dispose](): void;
    buildCancelRequest(input_json: string): string;
    buildDepositSubmissionPlan(input_json: string): string;
    buildOrderRequest(input_json: string): string;
    buildResidualRecovery(input_json: string): string;
    buildStatusRequests(input_json: string): string;
    buildWithdrawRequest(input_json: string): string;
    createRecoverySnapshot(input_json: string): string;
    decryptLocalState(record_json: string): string;
    decryptLocalStateClassified(record_json: string): string;
    decryptRecoveryArtifact(artifact_json: string): string;
    decryptRecoveryArtifactClassified(artifact_json: string): string;
    deriveProofSigner(input_json: string): string;
    encryptLocalState(input_json: string): string;
    isLocked(): boolean;
    lock(): void;
    constructor(seed_bytes: Uint8Array, chain_id: string, deployment_id: string);
    publicConfig(): string;
    recoveryAuthTag(): string;
    signStrk20ExitClaim(input_json: string): string;
}

export function init(): void;

/**
 * rebuilds one membership from the public, globally ordered note-batch history.
 */
export function zylith_wallet_build_note_membership(input_json: string): string;

/**
 * the canonical protocol ids for a manifest market.
 */
export function zylith_wallet_market_ids(input_json: string): string;

export function zylith_wallet_note_summary(note_json: string): string;

export function zylith_wallet_quote_residual_recovery(input_json: string): string;

/**
 * the order's outputs in the chain's transition records: the operator's report is never
 * trusted for a note, only for where to look.
 */
export function zylith_wallet_recover_order_outputs(input_json: string): string;

/**
 * the order's residual generations recoverable from public transition records.
 */
export function zylith_wallet_recover_order_residuals(input_json: string): string;

/**
 * the fingerprint a deployment manifest pins for an execution key registry.
 */
export function zylith_wallet_registry_fingerprint(registry_json: string): string;

/**
 * recomputes the authenticated output root before browser recovery trusts indexer records.
 */
export function zylith_wallet_transition_output_root(input_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_walletsession_free: (a: number, b: number) => void;
    readonly walletsession_buildCancelRequest: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_buildDepositSubmissionPlan: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_buildOrderRequest: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_buildResidualRecovery: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_buildStatusRequests: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_buildWithdrawRequest: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_createRecoverySnapshot: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_decryptLocalState: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_decryptLocalStateClassified: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_decryptRecoveryArtifact: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_decryptRecoveryArtifactClassified: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_deriveProofSigner: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_encryptLocalState: (a: number, b: number, c: number) => [number, number, number, number];
    readonly walletsession_isLocked: (a: number) => number;
    readonly walletsession_lock: (a: number) => void;
    readonly walletsession_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly walletsession_publicConfig: (a: number) => [number, number, number, number];
    readonly walletsession_recoveryAuthTag: (a: number) => [number, number, number, number];
    readonly walletsession_signStrk20ExitClaim: (a: number, b: number, c: number) => [number, number, number, number];
    readonly zylith_wallet_build_note_membership: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_market_ids: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_note_summary: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_quote_residual_recovery: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_recover_order_outputs: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_recover_order_residuals: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_registry_fingerprint: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_transition_output_root: (a: number, b: number) => [number, number, number, number];
    readonly init: () => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
