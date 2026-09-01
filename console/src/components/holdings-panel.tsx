"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { api, problemMessage } from "@/lib/api";
import { card, cardTitle, ghostButton, input, label, primaryButton, stamp } from "@/lib/ui";

/**
 * The browser wallet: scan the public chain locally (raw blocks are the
 * same for every caller — the server never learns which notes are ours),
 * then transfer or burn what the seed holds. Proofs and signatures are
 * computed in the same Web Worker as minting.
 */
type WalletState = {
  address: string;
  scanned_height: number;
  holdings: { asset_id: string; amount: string }[];
};

type SpendForm = {
  asset_id: string;
  mode: "transfer" | "burn";
  recipient: string;
  amount: string;
};

export function HoldingsPanel({
  call,
  seed,
  enabled,
  engineThreads,
  provingReady,
  mintCount,
}: {
  call: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  seed: string;
  enabled: boolean;
  engineThreads: number;
  provingReady: boolean;
  /** Bumped by the mint studio after each successful mint, so the fresh
   *  asset shows up here without a manual rescan. */
  mintCount: number;
}) {
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ height: number; tip: number } | null>(null);
  const [form, setForm] = useState<SpendForm | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ txid: string; kind: string } | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  // Synchronous re-entrancy guard: the button, the post-mint refresh and
  // the post-spend refresh can all ask for a scan; the wallet feed is
  // order-sensitive, so exactly one runs at a time.
  const scanInFlight = useRef(false);

  // A different seed is a different wallet: drop the scanned state.
  useEffect(() => {
    setWallet(null);
    setProgress(null);
    setForm(null);
    setReceipt(null);
    setError(null);
  }, [seed]);

  // The registry knows most assets by name: label the holdings instead
  // of showing raw ids. Crucially this reads the WHOLE registry with one
  // request identical for every caller — never a per-held-id lookup, which
  // would tell the operator exactly which assets this browser holds and
  // undo the local-scan privacy the whole panel is built on.
  useEffect(() => {
    const held = wallet?.holdings ?? [];
    if (held.length === 0 || held.every((h) => h.asset_id in names)) return;
    let cancelled = false;
    api.GET("/api/v1/assets").then(({ data }) => {
      if (cancelled || !data) return;
      const byId = new Map(data.map((a) => [a.asset_id, a.display_name ?? ""]));
      setNames((known) => {
        const next = { ...known };
        for (const h of held)
          if (!(h.asset_id in next)) next[h.asset_id] = byId.get(h.asset_id) ?? "";
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [wallet, names]);

  const scan = useCallback(async () => {
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    setError(null);
    setScanning(true);
    try {
      const trimmedSeed = seed.trim();
      let height = wallet?.scanned_height ?? 0;
      if (height === 0) {
        setWallet(await call<WalletState>("wallet_reset", { seed: trimmedSeed }));
      }
      for (;;) {
        // A full scan is dozens of heavy pages; a transient network drop
        // must not force the user to click again. Retry with backoff —
        // the incremental design makes retries always safe (the wallet
        // only advances when a page is fed in order).
        const fetchPage = () =>
          api.GET("/api/v1/chain/transactions", {
            params: { query: { start_height: height + 1, limit: 25 } },
          });
        let page: Awaited<ReturnType<typeof fetchPage>> | null = null;
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          try {
            page = await fetchPage();
            if (!page.error) break;
            if (attempt === 4) throw new Error(problemMessage(page.error));
          } catch (fetchError) {
            if (attempt === 4) throw fetchError;
          }
          await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
        }
        if (!page || page.error || !page.data) throw new Error("chain fetch failed");
        if (page.data.blocks.length > 0) {
          const state = await call<WalletState>("wallet_scan", {
            seed: trimmedSeed,
            blocks: page.data.blocks,
          });
          height = state.scanned_height;
          setWallet(state);
        }
        setProgress({ height, tip: page.data.tip_height });
        if (height >= page.data.tip_height || page.data.blocks.length === 0) break;
        // The server cache makes pages near-instant; pace the loop so a
        // full scan stays well under the API's per-client rate limit.
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    } finally {
      scanInFlight.current = false;
      setScanning(false);
    }
  }, [call, seed, wallet]);

  // A fresh mint advanced the chain: pick it up so the new asset appears
  // here without a manual rescan.
  useEffect(() => {
    if (mintCount === 0 || scanning || !wallet) return;
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintCount]);

  const spend = useCallback(async () => {
    if (!form) return;
    setError(null);
    setReceipt(null);
    try {
      const trimmedSeed = seed.trim();
      setStage("Reading the chain…");
      const fetchChain = () => api.GET("/api/v1/chain");
      let chain: Awaited<ReturnType<typeof fetchChain>> | null = null;
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        chain = await fetchChain().catch(() => null);
        if (chain && !chain.error) break;
        if (attempt === 4)
          throw new Error(chain?.error ? problemMessage(chain.error) : "chain fetch failed");
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
      if (!chain?.data) throw new Error("chain fetch failed");

      setStage(
        engineThreads > 1
          ? `Proving in your browser on ${engineThreads} threads… ${provingReady ? "about ten seconds" : "about 15 seconds"}`
          : `Proving in your browser… ${provingReady ? "about half a minute" : "about a minute"}`,
      );
      const built = await call<{ tx_hex: string; txid: string }>("build_spend", {
        seed: trimmedSeed,
        asset_id: form.asset_id,
        amount: Number(form.amount),
        recipient: form.mode === "transfer" ? form.recipient.trim() : null,
        target_height: chain.data.tip_height + 1,
      });

      setStage("Relaying the signed transaction…");
      const relayed = await api.POST("/api/v1/relay", { body: { tx_hex: built.tx_hex } });
      if (relayed.error) throw new Error(problemMessage(relayed.error));

      // Show the locally computed txid, not the relay's word.
      if (relayed.data.txid !== built.txid) {
        setError(
          `Relay reported a different txid (${relayed.data.txid}) than your browser computed. Showing yours.`,
        );
      }
      setReceipt({ txid: built.txid, kind: form.mode });
      setForm(null);

      // Our own spend advanced the chain: rescan the new blocks so the
      // change note is spendable and the spent notes disappear.
      setStage("Updating your holdings…");
      await scan();
    } catch (spendError) {
      setError(spendError instanceof Error ? spendError.message : String(spendError));
    } finally {
      setStage(null);
    }
  }, [call, form, seed, scan, engineThreads, provingReady]);

  if (!enabled) return null;

  const canSpend =
    form !== null &&
    Number(form.amount) > 0 &&
    (form.mode === "burn" || form.recipient.trim() !== "") &&
    !stage &&
    !scanning;

  return (
    <section className={`${card} rise`}>
      <h2 className={`${cardTitle} mb-3`}>Your holdings · transfer &amp; burn</h2>
      <p className="text-xs leading-relaxed text-neutral-500">
        The chain is scanned locally: raw blocks are public data, identical for every visitor, and
        the trial decryption happens in this page. The server never learns which notes are yours.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="holdings-scan"
          className={ghostButton}
          onClick={scan}
          disabled={scanning || !!stage}
        >
          {wallet && wallet.scanned_height > 0 ? "Rescan the chain" : "Scan my holdings"}
        </button>
        {scanning && progress && (
          <span className="flex items-center gap-2 text-xs text-[#e8b23a]/90">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#e8b23a]" />
            scanning block {progress.height} / {progress.tip}
          </span>
        )}
        {!scanning && wallet && progress && (
          <span className="font-data text-xs text-neutral-500">
            synced to block {wallet.scanned_height}
          </span>
        )}
      </div>

      {wallet && (
        <p className="font-data mt-3 flex items-center gap-2 break-all text-xs text-neutral-500">
          <span className="shrink-0 whitespace-nowrap">your address</span>{" "}
          <span data-testid="wallet-address" className="text-neutral-300">
            {wallet.address}
          </span>
          <CopyButton value={wallet.address} />
        </p>
      )}

      {wallet && wallet.scanned_height > 0 && wallet.holdings.length === 0 && (
        <p className="mt-3 text-xs text-neutral-500">
          Nothing spendable under this seed yet. Mint an asset above, or receive one at the address
          shown.
        </p>
      )}

      {wallet && wallet.holdings.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {wallet.holdings.map((holding) => (
            <li
              key={holding.asset_id}
              className="rounded-md border border-white/10 px-3.5 py-2.5"
              data-testid={`holding-${holding.asset_id.slice(0, 8)}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link
                  className="min-w-0 text-xs text-[#e8b23a] underline decoration-[#e8b23a]/30"
                  href={`/assets/${holding.asset_id}`}
                >
                  {names[holding.asset_id] ? (
                    <span className="break-words">{names[holding.asset_id]}</span>
                  ) : (
                    <span className="font-data break-all">{holding.asset_id.slice(0, 16)}…</span>
                  )}
                </Link>
                <span className="font-data text-xs text-neutral-300">× {holding.amount}</span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    data-testid="holding-transfer"
                    className={ghostButton}
                    onClick={() =>
                      setForm({
                        asset_id: holding.asset_id,
                        mode: "transfer",
                        recipient: "",
                        amount: "1",
                      })
                    }
                    disabled={!!stage || scanning}
                  >
                    Transfer
                  </button>
                  <button
                    type="button"
                    data-testid="holding-burn"
                    className={ghostButton}
                    onClick={() =>
                      setForm({
                        asset_id: holding.asset_id,
                        mode: "burn",
                        recipient: "",
                        amount: "1",
                      })
                    }
                    disabled={!!stage || scanning}
                  >
                    Burn
                  </button>
                </span>
              </div>

              {form && form.asset_id === holding.asset_id && (
                <div className="mt-3 flex flex-col gap-2.5 border-t border-white/[0.06] pt-3">
                  {form.mode === "transfer" && (
                    <div className="flex flex-col gap-1.5">
                      <label className={label} htmlFor="spend-recipient">
                        Recipient · unified address
                      </label>
                      <input
                        id="spend-recipient"
                        data-testid="spend-recipient"
                        className={input}
                        value={form.recipient}
                        onChange={(event) => setForm({ ...form, recipient: event.target.value })}
                        placeholder="u1…"
                        spellCheck={false}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex flex-col gap-1.5">
                      <label className={label} htmlFor="spend-amount">
                        Amount
                      </label>
                      <input
                        id="spend-amount"
                        data-testid="spend-amount"
                        className={`${input} w-28`}
                        value={form.amount}
                        onChange={(event) => setForm({ ...form, amount: event.target.value })}
                        type="number"
                        min={1}
                      />
                    </div>
                    <button
                      type="button"
                      data-testid="spend-submit"
                      className={primaryButton}
                      onClick={spend}
                      disabled={!canSpend}
                    >
                      {form.mode === "transfer" ? "Transfer in my browser" : "Burn in my browser"}
                    </button>
                    <button
                      type="button"
                      className={ghostButton}
                      onClick={() => setForm(null)}
                      disabled={!!stage}
                    >
                      Cancel
                    </button>
                  </div>
                  {form.mode === "burn" && (
                    <p className="text-xs leading-snug text-neutral-500">
                      Burning destroys the units permanently: the public supply decreases, on chain,
                      forever.
                    </p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {stage && (
        <p className="mt-3 flex items-center gap-2 text-xs text-[#e8b23a]/90">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#e8b23a]" />
          {stage}
        </p>
      )}
      {receipt && (
        <div
          data-testid="spend-receipt"
          className="mt-4 rounded-md border border-emerald-400/25 p-3.5 text-xs"
        >
          <p className="flex flex-wrap items-center gap-2">
            <span className={stamp}>
              {receipt.kind === "transfer" ? "transferred" : "burned"} from your key
            </span>
            <span className="text-neutral-400">proof built on your machine, relayed as-is</span>
          </p>
          <p className="font-data mt-2 break-all text-neutral-400">
            txid <span className="text-emerald-300">{receipt.txid}</span>
          </p>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
    </section>
  );
}
