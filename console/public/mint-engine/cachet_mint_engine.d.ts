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
 *
 * `amount == 0` seals an existing asset without minting more: the issue
 * action carries no note and sets `finalize`, which consensus accepts
 * (an action with no note is refused only when it does not finalize).
 * It must name an asset that already exists, and must finalize.
 */
export function build_issuance_tx(seed_phrase: string, description: string, amount: bigint, finalize: boolean, first_issuance: boolean, target_height: number): any;

/**
 * Build, prove and sign a transfer (recipient given) or a burn
 * (recipient null) of `amount` units of `asset_id`, spending notes the
 * scanned wallet owns. Change returns to the wallet's own address.
 *
 * `from_slot` spends from a swap slot instead of the main account: how an
 * offer is withdrawn (to the main address) or cancelled.
 *
 * Heavy: Halo2 proving. Run inside the Web Worker, ideally after
 * `prepare_proving` has warmed the proving key.
 */
export function build_spend_tx(seed_phrase: string, asset_id: string, amount: bigint, recipient: string | null | undefined, target_height: number, from_slot?: number | null): any;

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
 * The maker's side: check the taker's transaction against the offer this
 * seed made from `slot` and countersign it, or refuse. Returns the
 * signature message as JSON.
 */
export function swap_countersign(seed_phrase: string, slot: number, offer_json: string, take_json: string): string;

/**
 * The taker's last step: add the maker's signature to the pending swap
 * and return the finished transaction, ready to relay.
 */
export function swap_finish(countersignature_json: string): any;

/**
 * The maker's offer, as JSON: the one note waiting in `slot`, for
 * `want_amount` of `want_asset`. Paid to a fresh address of the main
 * account, so the taker cannot link it to the address this seed hands out.
 */
export function swap_make_offer(seed_phrase: string, slot: number, want_asset: string, want_amount: bigint): string;

/**
 * The address of swap slot `slot` (unified encoding): where a maker sends
 * the exact units it is about to offer.
 */
export function swap_slot_address(seed_phrase: string, slot: number): string;

/**
 * The taker's side: build the swap the offer describes, from this
 * wallet's main account (witnessed at the offer's anchor), prove it and
 * sign its own spends. Returns the message for the maker, as JSON; the
 * half-built swap stays here for `swap_finish`.
 *
 * Heavy: one Halo2 proof for the whole bundle.
 */
export function swap_take(seed_phrase: string, offer_json: string, target_height: number): string;

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

/**
 * Start this seed's wallet after block `height`, from the Orchard tree the
 * registry reports there (`GET /api/v1/chain/orchard-tree`, zcashd's
 * `CommitmentTree` encoding in hex), checked against `final_root` when
 * given. For a seed created now, which can own nothing in an earlier
 * block: its first scan reads only the blocks that follow. A wallet this
 * seed already scanned further is left as it is.
 */
export function wallet_start_after(seed_phrase: string, height: number, tree_state: string, final_root?: string | null): any;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_issuance_tx: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number) => [number, number, number];
    readonly build_spend_tx: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number];
    readonly generate_seed_phrase: () => [number, number];
    readonly issuer_info: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly swap_countersign: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
    readonly swap_finish: (a: number, b: number) => [number, number, number];
    readonly swap_make_offer: (a: number, b: number, c: number, d: number, e: number, f: bigint) => [number, number, number, number];
    readonly swap_slot_address: (a: number, b: number, c: number) => [number, number, number, number];
    readonly swap_take: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly wallet_reset: (a: number, b: number) => [number, number, number];
    readonly wallet_scan: (a: number, b: number, c: any) => [number, number, number];
    readonly wallet_start_after: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number];
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
