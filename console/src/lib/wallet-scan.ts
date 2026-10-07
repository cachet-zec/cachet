import { api, problemMessage } from "@/lib/api";

/** The browser wallet's state, as the engine reports it. */
export type WalletState = {
  address: string;
  scanned_height: number;
  holdings: { asset_id: string; amount: string }[];
  swap_slots: { slot: number; holdings: { asset_id: string; amount: string }[] }[];
};

type Call = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * Bring the engine's wallet for `seed` up to the chain tip, page by page.
 * Raw blocks are public data identical for every caller; decryption stays
 * in the worker. Resumes from wherever the engine's wallet already is, so
 * it is cheap when nothing new happened.
 */
export async function scanToTip(call: Call, seed: string): Promise<WalletState> {
  // An empty page reports where the wallet stands (and creates it if this
  // seed has none yet).
  let state = await call<WalletState>("wallet_scan", { seed, blocks: [] });
  for (;;) {
    const page = await api.GET("/api/v1/chain/transactions", {
      params: { query: { start_height: state.scanned_height + 1, limit: 25 } },
    });
    if (page.error) throw new Error(problemMessage(page.error));
    if (page.data.blocks.length > 0) {
      state = await call<WalletState>("wallet_scan", { seed, blocks: page.data.blocks });
    }
    if (state.scanned_height >= page.data.tip_height || page.data.blocks.length === 0) {
      return state;
    }
    // Paced like the holdings panel, well under the per-client rate limit.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
