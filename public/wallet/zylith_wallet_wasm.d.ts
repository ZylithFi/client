/* tslint:disable */
/* eslint-disable */

export function init(): void;

export function zylith_wallet_build_deposit_submission_plan(input_json: string): string;

export function zylith_wallet_build_private_order_submission(input_json: string): string;

export function zylith_wallet_build_renewal_parent_cancel_submission_plan(input_json: string): string;

export function zylith_wallet_build_settlement_output_withdrawal_submission_plan(input_json: string): string;

export function zylith_wallet_build_strategy_parent(input_json: string): string;

export function zylith_wallet_build_withdrawal_submission_plan(input_json: string): string;

export function zylith_wallet_create_recovery_snapshot(input_json: string): string;

export function zylith_wallet_decrypt_maker_attribution_artifact(seed_hex: string, artifact_json: string): string;

export function zylith_wallet_decrypt_recovery_artifact(seed_hex: string, artifact_json: string): string;

export function zylith_wallet_derive_public_config(seed_hex: string): string;

export function zylith_wallet_generate_mnemonic(): string;

export function zylith_wallet_generate_seed_hex(): string;

export function zylith_wallet_mnemonic_to_seed_hex(phrase: string): string;

export function zylith_wallet_recovery_auth_tag(seed_hex: string): string;

export function zylith_wallet_scan_output_bundle(seed_hex: string, bundle_json: string): string;

export function zylith_wallet_scan_output_bundle_with_root(seed_hex: string, bundle_json: string, expected_output_note_root: string): string;

export function zylith_wallet_seed_hex_to_mnemonic(seed_hex: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly zylith_wallet_build_deposit_submission_plan: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_build_private_order_submission: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_build_renewal_parent_cancel_submission_plan: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_build_settlement_output_withdrawal_submission_plan: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_build_strategy_parent: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_build_withdrawal_submission_plan: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_create_recovery_snapshot: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_decrypt_maker_attribution_artifact: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly zylith_wallet_decrypt_recovery_artifact: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly zylith_wallet_derive_public_config: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_generate_mnemonic: () => [number, number, number, number];
    readonly zylith_wallet_generate_seed_hex: () => [number, number];
    readonly zylith_wallet_mnemonic_to_seed_hex: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_recovery_auth_tag: (a: number, b: number) => [number, number, number, number];
    readonly zylith_wallet_scan_output_bundle: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly zylith_wallet_scan_output_bundle_with_root: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly zylith_wallet_seed_hex_to_mnemonic: (a: number, b: number) => [number, number, number, number];
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
