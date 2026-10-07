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
 * Blocks per page. A wallet witnesses its notes in the whole note
 * commitment tree, so a first scan reads every block from the first one:
 * on the testnet, pages of 100 cost barely more than pages of 25 (0.75 s
 * against 0.6 s on the public instance), for four times fewer round trips.
 */
const PAGE_BLOCKS = 100;

/** One page of raw blocks; a dropped connection is retried, with backoff. */
async function fetchPage(startHeight: number) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const page = await api.GET("/api/v1/chain/transactions", {
        params: { query: { start_height: startHeight, limit: PAGE_BLOCKS } },
      });
      if (!page.error) return page.data;
      if (attempt === 4) throw new Error(problemMessage(page.error));
    } catch (failure) {
      if (attempt === 4) throw failure;
    }
    await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
  }
}

/**
 * Bring the engine's wallet for `seed` up to the chain tip. Raw blocks are
 * public data identical for every caller; decryption stays in the worker.
 * The next page downloads while the worker reads the current one. Resumes
 * from wherever the engine's wallet already is, so it is cheap when
 * nothing new happened. `onProgress` hears each page as it lands.
 */
export async function scanToTip(
  call: Call,
  seed: string,
  onProgress?: (state: WalletState, tip: number) => void,
): Promise<WalletState> {
  // An empty page reports where the wallet stands (and creates it if this
  // seed has none yet).
  let state = await call<WalletState>("wallet_scan", { seed, blocks: [] });
  let pending: ReturnType<typeof fetchPage> | null = fetchPage(state.scanned_height + 1);
  while (pending) {
    const page: Awaited<ReturnType<typeof fetchPage>> = await pending;
    const blocks = page.blocks;
    const last = blocks.at(-1)?.height ?? state.scanned_height;
    pending = blocks.length > 0 && last < page.tip_height ? fetchPage(last + 1) : null;
    // If reading this page fails, the next one is never awaited: its own
    // failure must not surface as an unhandled rejection.
    pending?.catch(() => undefined);
    if (blocks.length > 0) {
      state = await call<WalletState>("wallet_scan", { seed, blocks });
    }
    onProgress?.(state, page.tip_height);
  }
  return state;
}
