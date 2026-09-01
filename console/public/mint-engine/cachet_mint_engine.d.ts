/* tslint:disable */
/* eslint-disable */

/**
 * Build, prove and sign a complete issuance transaction in the browser.
 *
 * Heavy: constructs the Halo2 proving key and proves the mandatory
 * Orchard action (~30-60s single-threaded). Run inside a Web Worker.
 *
 * `first_issuance` and `target_height` come from the public chain API —
 * they are public facts, not secrets.
 */
export function build_issuance_tx(seed_phrase: string, description: string, amount: bigint, finalize: boolean, first_issuance: boolean, target_height: number): any;

/**
 * Build, prove and sign a transfer (recipient given) or a burn
 * (recipient null) of `amount` units of `asset_id`, spending notes the
 * scanned wallet owns. Change returns to the wallet's own address.
 *
 * Heavy: Halo2 proving. Run inside the Web Worker, ideally after
 * `prepare_proving` has warmed the proving key.
 */
export function build_spend_tx(seed_phrase: string, asset_id: string, amount: bigint, recipient: string | null | undefined, target_height: number): any;

/**
 * Generate a fresh 24-word BIP-39 seed phrase. Called in the browser;
 * the phrase is displayed to the user and never leaves the page.
 */
export function generate_seed_phrase(): string;

/**
 * Derive the issuer identity a phrase produces, and the asset id a given
 * description would mint under it (ZIP 227: identity is derived, never
 * assigned).
 */
export function issuer_info(seed_phrase: string, description: string): any;

/**
 * Build (and cache, process-wide) the Orchard proving key so the next
 * `build_issuance_tx` skips its most expensive step. The worker calls
 * this off the critical path, while the user is still filling the form;
 * the vendored proving-key cache (vendor/librustzcash/README.md) keeps
 * the key for every later mint in the session.
 */
export function prepare_proving(): void;

/**
 * Reset the in-module wallet to a fresh state for this seed. Returns the
 * wallet state (empty, scanned_height 0).
 */
export function wallet_reset(seed_phrase: string): any;

/**
 * Feed a page of raw blocks (from `GET /api/v1/chain/transactions`) into
 * the wallet, in consensus order. Blocks must be contiguous and start at
 * `scanned_height + 1` — the note commitment tree is order-sensitive.
 * Returns the updated wallet state.
 */
export function wallet_scan(seed_phrase: string, blocks: any): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_issuance_tx: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number) => [number, number, number];
    readonly build_spend_tx: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number) => [number, number, number];
    readonly generate_seed_phrase: () => [number, number];
    readonly issuer_info: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly wallet_reset: (a: number, b: number) => [number, number, number];
    readonly wallet_scan: (a: number, b: number, c: any) => [number, number, number];
    readonly prepare_proving: () => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
