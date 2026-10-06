/* tslint:disable */
/* eslint-disable */

/**
 * What ZIP 227 derives from one issuer key and one description, as
 * lowercase hex.
 */
export class Identity {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * BLAKE2b-256 of the description, personalized "ZSA-AssetDescCRH".
     */
    asset_desc_hash: string;
    /**
     * BLAKE2b-512 of the encoded Asset Identifier, personalized
     * "ZSA-Asset-Digest". The Asset Base is this digest hashed to the curve.
     */
    asset_digest: string;
    /**
     * The Asset Base: the id the chain, the registry and the URLs use.
     */
    asset_id: string;
}

/**
 * Derive the asset id, description hash and Asset Digest for the browser,
 * as lowercase hex.
 *
 * `issuance_key_hex` is the 66-character ZIP 227 encoding served as an
 * asset's `issuer`. Every input comes off the wire, so malformed values
 * are errors rather than panics.
 */
export function derive_identity(issuance_key_hex: string, description: string): Identity;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_get_identity_asset_desc_hash: (a: number) => [number, number];
    readonly __wbg_get_identity_asset_digest: (a: number) => [number, number];
    readonly __wbg_get_identity_asset_id: (a: number) => [number, number];
    readonly __wbg_identity_free: (a: number, b: number) => void;
    readonly __wbg_set_identity_asset_desc_hash: (a: number, b: number, c: number) => void;
    readonly __wbg_set_identity_asset_digest: (a: number, b: number, c: number) => void;
    readonly __wbg_set_identity_asset_id: (a: number, b: number, c: number) => void;
    readonly derive_identity: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
