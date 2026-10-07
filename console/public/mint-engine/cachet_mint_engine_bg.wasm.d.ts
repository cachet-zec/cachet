/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const build_issuance_tx: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number) => [number, number, number];
export const build_spend_tx: (a: number, b: number, c: number, d: number, e: bigint, f: number, g: number, h: number, i: number) => [number, number, number];
export const generate_seed_phrase: () => [number, number];
export const issuer_info: (a: number, b: number, c: number, d: number) => [number, number, number];
export const swap_countersign: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
export const swap_finish: (a: number, b: number) => [number, number, number];
export const swap_make_offer: (a: number, b: number, c: number, d: number, e: number, f: bigint) => [number, number, number, number];
export const swap_slot_address: (a: number, b: number, c: number) => [number, number, number, number];
export const swap_take: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
export const wallet_reset: (a: number, b: number) => [number, number, number];
export const wallet_scan: (a: number, b: number, c: any) => [number, number, number];
export const prepare_proving: () => void;
export const rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
export const rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
export const rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
export const rustsecp256k1_v0_10_0_context_create: (a: number) => number;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_start: () => void;
