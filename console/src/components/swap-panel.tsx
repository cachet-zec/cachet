"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { api, problemMessage } from "@/lib/api";
import { card, cardTitle, ghostButton, input, label, primaryButton, stamp } from "@/lib/ui";
import { scanToTip, type WalletState } from "@/lib/wallet-scan";

type Call = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** The parts of an offer a person decides on (the rest is for the engine). */
type OfferSummary = {
  give_asset: string;
  give_amount: number;
  want_asset: string;
  want_amount: number;
};

const textarea = `${input} min-h-[96px] resize-y font-data text-[13px]`;

/** Relay signed bytes and wait until the wallet sees them in a block. */
async function relayAndConfirm(
  call: Call,
  seed: string,
  txHex: string,
  landed: (state: WalletState) => boolean,
): Promise<WalletState> {
  const relayed = await api.POST("/api/v1/relay", { body: { tx_hex: txHex } });
  if (relayed.error) throw new Error(problemMessage(relayed.error));
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await scanToTip(call, seed);
    if (landed(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error("Relayed, but not seen in a block after three minutes. Rescan later.");
}

/**
 * Atomic swaps between two browsers, one OrchardZSA transaction for both
 * sides: it lands whole or not at all. The maker parks the units it offers
 * in a one-off slot account and hands out an offer; the taker builds,
 * proves and signs the whole swap; the maker checks it and countersigns
 * its own spend. The messages travel through the registry's public board
 * (polled by both pages), or by hand between the two pages.
 */
export function SwapPanel({
  call,
  seed,
  enabled,
  onChange,
}: {
  call: Call;
  seed: string;
  enabled: boolean;
  /** Told after a swap step moved funds, so the holdings refresh. */
  onChange: () => void;
}) {
  const [role, setRole] = useState<"make" | "take">("make");
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Maker
  const [giveAsset, setGiveAsset] = useState("");
  const [giveAmount, setGiveAmount] = useState("1");
  const [wantAsset, setWantAsset] = useState("");
  const [wantAmount, setWantAmount] = useState("1");
  const [madeOffer, setMadeOffer] = useState<{ slot: number; json: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [countersignature, setCountersignature] = useState<string | null>(null);

  // The public board: the maker's listing and the take it last answered;
  // the board offer a taker came from, and the token to read the answer.
  const [listOnBoard, setListOnBoard] = useState(true);
  const [listing, setListing] = useState<{ id: string; token: string } | null>(null);
  const [boardStatus, setBoardStatus] = useState<string | null>(null);
  const answeredTake = useRef<number | null>(null);
  // The parent passes a new callback on every render; the board's polling
  // must not restart (and never fire) because of it.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  const [takeFrom, setTakeFrom] = useState<string | null>(null);
  const [takerToken, setTakerToken] = useState<string | null>(null);

  // Taker
  const [offerText, setOfferText] = useState("");
  const [takeJson, setTakeJson] = useState<string | null>(null);
  const [signatureText, setSignatureText] = useState("");
  const [swapped, setSwapped] = useState<string | null>(null);

  useEffect(() => {
    setWallet(null);
    setMadeOffer(null);
    setCountersignature(null);
    setTakeJson(null);
    setSwapped(null);
    setListing(null);
    setBoardStatus(null);
    setTakerToken(null);
  }, [seed]);

  // Arriving from the board (/mint?take=<id>): load that offer to take.
  useEffect(() => {
    if (!enabled) return;
    const id = new URLSearchParams(window.location.search).get("take");
    if (!id || !/^[0-9a-f]{32}$/.test(id)) return;
    let cancelled = false;
    api.GET("/api/v1/swaps/{id}", { params: { path: { id } } }).then(({ data, error }) => {
      if (cancelled) return;
      if (error || !data?.offer) {
        setError("That offer is not on the board any more.");
        return;
      }
      if (data.status !== "open") {
        setError("That offer is not open right now: someone may be taking it.");
      }
      setRole("take");
      setOfferText(data.offer);
      setTakeFrom(id);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  // Names from the whole registry listing (one request identical for every
  // caller), never per asset: a lookup per id would tell the operator what
  // this browser trades.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.GET("/api/v1/assets").then(({ data }) => {
      if (cancelled || !data) return;
      setNames(Object.fromEntries(data.map((a) => [a.asset_id, a.display_name ?? ""])));
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const nameOf = (assetId: string) => names[assetId] || `${assetId.slice(0, 12)}…`;

  async function step(label: string, work: () => Promise<void>) {
    setError(null);
    setStage(label);
    try {
      await work();
    } catch (stepError) {
      setError(stepError instanceof Error ? stepError.message : String(stepError));
    } finally {
      setStage(null);
    }
  }

  const refresh = () =>
    step("Scanning the chain…", async () => {
      setWallet(await scanToTip(call, seed.trim()));
    });

  // --- maker ----------------------------------------------------------------

  const prepareOffer = () =>
    step("Parking the units in a swap slot…", async () => {
      const trimmed = seed.trim();
      let state = await scanToTip(call, trimmed);
      const used = new Set(state.swap_slots.map((s) => s.slot));
      const slot = [0, 1, 2, 3].find((candidate) => !used.has(candidate));
      if (slot === undefined) throw new Error("All four swap slots are in use: withdraw one.");
      if (!/^[0-9a-f]{64}$/.test(wantAsset.trim().toLowerCase())) {
        throw new Error("The asset you want must be an asset id (64 hex characters).");
      }
      const slotAddress = await call<string>("swap_slot_address", { seed: trimmed, slot });
      const chain = await api.GET("/api/v1/chain");
      if (chain.error) throw new Error(problemMessage(chain.error));
      setStage("Proving the move to the swap slot in your browser…");
      const moved = await call<{ tx_hex: string }>("build_spend", {
        seed: trimmed,
        asset_id: giveAsset,
        amount: Number(giveAmount),
        recipient: slotAddress,
        target_height: chain.data.tip_height + 1,
      });
      setStage("Relaying, then waiting for the block…");
      state = await relayAndConfirm(call, trimmed, moved.tx_hex, (s) =>
        s.swap_slots.some((parked) => parked.slot === slot),
      );
      setWallet(state);
      onChange();
      setStage("Writing the offer…");
      const json = await call<string>("swap_make_offer", {
        seed: trimmed,
        slot,
        want_asset: wantAsset.trim().toLowerCase(),
        want_amount: Number(wantAmount),
      });
      setMadeOffer({ slot, json });
      if (listOnBoard) {
        setStage("Listing it on the board…");
        const posted = await api.POST("/api/v1/swaps", { body: { offer: json } });
        if (posted.error) throw new Error(problemMessage(posted.error));
        answeredTake.current = null;
        setListing({ id: posted.data.id, token: posted.data.maker_token });
        setBoardStatus(
          "Listed on the board. Keep this page open: it answers takers with your keys, and the offer leaves the board a minute after it closes.",
        );
      }
    });

  // The maker's page answers takes as they arrive: the engine checks each
  // against the offer before signing, so answering is safe unattended.
  useEffect(() => {
    if (!listing || !madeOffer) return;
    const headers = { "x-swap-token": listing.token };
    const path = { id: listing.id };
    let stopped = false;
    const tick = async () => {
      const board = await api.GET("/api/v1/swaps/{id}", { params: { path } });
      if (board.data?.status === "closed") {
        stopped = true;
        setBoardStatus("Swapped: the taker relayed the transaction.");
        onChangeRef.current();
        return;
      }
      const take = await api.GET("/api/v1/swaps/{id}/take", { params: { path }, headers });
      const takenAt = take.data?.taken_at;
      if (!take.data?.take || takenAt === null || takenAt === undefined) return;
      if (answeredTake.current === takenAt) return;
      answeredTake.current = takenAt;
      setBoardStatus("A taker answered: checking their transaction against your offer…");
      try {
        const signed = await call<string>("swap_countersign", {
          seed: seed.trim(),
          slot: madeOffer.slot,
          offer: madeOffer.json,
          take: take.data.take,
        });
        const posted = await api.POST("/api/v1/swaps/{id}/countersignature", {
          params: { path },
          headers,
          body: { countersignature: signed, taken_at: takenAt },
        });
        if (posted.error) throw new Error(problemMessage(posted.error));
        setBoardStatus("Countersigned. Waiting for the taker to relay the swap…");
      } catch (refusal) {
        setBoardStatus(
          `Refused a take: ${refusal instanceof Error ? refusal.message : String(refusal)}. Still listed.`,
        );
      }
    };
    const timer = setInterval(() => {
      if (!stopped)
        void tick().catch((failure: unknown) =>
          setBoardStatus(
            `Listed, but the board is unreachable right now (${failure instanceof Error ? failure.message : String(failure)}). Retrying…`,
          ),
        );
    }, 4_000);
    return () => clearInterval(timer);
  }, [listing, madeOffer, call, seed]);

  const countersign = () =>
    step("Checking the swap against your offer…", async () => {
      if (!madeOffer) return;
      setCountersignature(
        await call<string>("swap_countersign", {
          seed: seed.trim(),
          slot: madeOffer.slot,
          offer: madeOffer.json,
          take: answer.trim(),
        }),
      );
    });

  const withdraw = (slot: number, assetId: string, amount: string) =>
    step("Proving the withdrawal in your browser…", async () => {
      const trimmed = seed.trim();
      if (listing && madeOffer?.slot === slot) {
        await api.DELETE("/api/v1/swaps/{id}", {
          params: { path: { id: listing.id } },
          headers: { "x-swap-token": listing.token },
        });
        setListing(null);
        setBoardStatus(null);
      }
      const state = await scanToTip(call, trimmed);
      const chain = await api.GET("/api/v1/chain");
      if (chain.error) throw new Error(problemMessage(chain.error));
      const built = await call<{ tx_hex: string }>("build_spend", {
        seed: trimmed,
        asset_id: assetId,
        amount: Number(amount),
        recipient: state.address,
        target_height: chain.data.tip_height + 1,
        from_slot: slot,
      });
      setStage("Relaying, then waiting for the block…");
      setWallet(
        await relayAndConfirm(call, trimmed, built.tx_hex, (s) =>
          s.swap_slots.every((parked) => parked.slot !== slot),
        ),
      );
      if (madeOffer?.slot === slot) setMadeOffer(null);
      onChange();
    });

  // --- taker ----------------------------------------------------------------

  let offer: OfferSummary | null = null;
  try {
    const parsed = JSON.parse(offerText) as OfferSummary;
    if (typeof parsed.give_asset === "string" && typeof parsed.want_amount === "number") {
      offer = parsed;
    }
  } catch {
    offer = null;
  }

  const takeOffer = () =>
    step("Scanning the chain…", async () => {
      const trimmed = seed.trim();
      setWallet(await scanToTip(call, trimmed));
      const chain = await api.GET("/api/v1/chain");
      if (chain.error) throw new Error(problemMessage(chain.error));
      setStage("Proving the whole swap in your browser…");
      const take = await call<string>("swap_take", {
        seed: trimmed,
        offer: offerText.trim(),
        target_height: chain.data.tip_height + 1,
      });
      setTakeJson(take);
      if (takeFrom) {
        setStage("Sending it to the maker through the board…");
        const posted = await api.POST("/api/v1/swaps/{id}/take", {
          params: { path: { id: takeFrom } },
          body: { take },
        });
        if (posted.error) {
          throw new Error(
            posted.response.status === 409
              ? "Someone else is taking this offer right now. Try again in a few minutes."
              : problemMessage(posted.error),
          );
        }
        setTakerToken(posted.data.taker_token);
      }
    });

  // The taker's page waits for the maker's answer, then completes the swap.
  useEffect(() => {
    if (!takeFrom || !takerToken || swapped) return;
    let done = false;
    const timer = setInterval(() => {
      if (done) return;
      void api
        .GET("/api/v1/swaps/{id}/countersignature", {
          params: { path: { id: takeFrom } },
          headers: { "x-swap-token": takerToken },
        })
        .then(({ data }) => {
          if (done || !data?.countersignature) return;
          done = true;
          setSignatureText(data.countersignature);
          void finishSwap(data.countersignature);
        })
        .catch(() => undefined);
    }, 4_000);
    return () => clearInterval(timer);
    // finishSwap is a plain function of this render; the effect only needs
    // to restart when the take or its token change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeFrom, takerToken, swapped]);

  const finishSwap = (signature?: string) =>
    step("Adding the maker's signature…", async () => {
      const trimmed = seed.trim();
      const finished = await call<{ tx_hex: string; txid: string }>("swap_finish", {
        countersignature: (signature ?? signatureText).trim(),
      });
      setStage("Relaying, then waiting for the block…");
      const before = wallet?.scanned_height ?? 0;
      setWallet(
        await relayAndConfirm(call, trimmed, finished.tx_hex, (s) => s.scanned_height > before),
      );
      setSwapped(finished.txid);
      if (takeFrom && takerToken) {
        // Tell the board, and through it the maker's page, that it landed.
        await api.DELETE("/api/v1/swaps/{id}", {
          params: { path: { id: takeFrom } },
          headers: { "x-swap-token": takerToken },
        });
      }
      onChange();
    });

  if (!enabled) return null;

  const busy = stage !== null;

  return (
    <section id="swap" className={`${card} rise scroll-mt-8`} data-testid="swap-panel">
      <h2 className={`${cardTitle} mb-3`}>Swap · one transaction, both sides</h2>
      <p className="max-w-prose text-[13px] leading-relaxed text-neutral-500">
        Both payments travel in one shielded transaction: it lands whole or not at all. Nobody holds
        anything in between. Offers go on the public{" "}
        <Link href="/swaps" className="underline decoration-white/20 hover:text-accent">
          swap board
        </Link>
        , or pass between two pages by hand; keys stay in each browser. Testnet only: these assets
        have no value and the chain can be reset at any time.
      </p>

      <div role="radiogroup" aria-label="Your side" className="mt-4 flex flex-wrap gap-2">
        {(
          [
            ["make", "Make an offer"],
            ["take", "Take an offer"],
          ] as const
        ).map(([value, text]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={role === value}
            data-testid={`swap-role-${value}`}
            onClick={() => setRole(value)}
            className={
              role === value
                ? "rounded-[3px] border border-accent/60 bg-accent/[0.07] px-3.5 py-2 text-sm text-accent"
                : "rounded-[3px] border border-line px-3.5 py-2 text-sm text-neutral-300 hover:border-line-strong"
            }
          >
            {text}
          </button>
        ))}
        <button type="button" className={ghostButton} onClick={refresh} disabled={busy}>
          {wallet ? "Rescan" : "Scan my holdings"}
        </button>
      </div>

      {role === "make" && (
        <div className="mt-5 flex flex-col gap-3.5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="flex flex-col gap-1.5">
              <label className={label} htmlFor="swap-give-asset">
                You give
              </label>
              <select
                id="swap-give-asset"
                data-testid="swap-give-asset"
                className={input}
                value={giveAsset}
                onChange={(event) => setGiveAsset(event.target.value)}
              >
                <option value="">{wallet ? "choose a holding" : "scan your holdings first"}</option>
                {wallet?.holdings.map((holding) => (
                  <option key={holding.asset_id} value={holding.asset_id}>
                    {nameOf(holding.asset_id)} · {holding.amount} held
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={label} htmlFor="swap-give-amount">
                Units
              </label>
              <input
                id="swap-give-amount"
                data-testid="swap-give-amount"
                className={input}
                type="number"
                min={1}
                value={giveAmount}
                onChange={(event) => setGiveAmount(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <div className="flex flex-col gap-1.5">
              <label className={label} htmlFor="swap-want-asset">
                You want <span className="text-neutral-600">· asset id</span>
              </label>
              <input
                id="swap-want-asset"
                data-testid="swap-want-asset"
                className={`${input} font-data`}
                value={wantAsset}
                onChange={(event) => setWantAsset(event.target.value)}
                placeholder="64 hex characters"
                spellCheck={false}
              />
              {/^[0-9a-f]{64}$/.test(wantAsset.trim().toLowerCase()) && (
                <span className="text-[13px] text-neutral-500">
                  {nameOf(wantAsset.trim().toLowerCase())}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={label} htmlFor="swap-want-amount">
                Units
              </label>
              <input
                id="swap-want-amount"
                data-testid="swap-want-amount"
                className={input}
                type="number"
                min={1}
                value={wantAmount}
                onChange={(event) => setWantAmount(event.target.value)}
              />
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid="swap-list-on-board"
              className="accent-[var(--color-accent)]"
              checked={listOnBoard}
              onChange={(event) => setListOnBoard(event.target.checked)}
            />
            List it on the public swap board (otherwise, pass the messages by hand)
          </label>
          <button
            type="button"
            data-testid="swap-prepare"
            className={`${primaryButton} self-start`}
            disabled={busy || !giveAsset || Number(giveAmount) <= 0 || Number(wantAmount) <= 0}
            onClick={prepareOffer}
          >
            Prepare the offer
          </button>
          <p className="text-[13px] leading-relaxed text-neutral-500">
            The units move to a one-off swap slot of your seed first: the offer shows the taker that
            slot, never your main holdings. Withdraw them any time to cancel.
          </p>

          {boardStatus && (
            <p
              role="status"
              data-testid="swap-board-status"
              className="rounded-[3px] border border-accent/40 px-3.5 py-2.5 text-sm text-accent"
            >
              {boardStatus}
            </p>
          )}

          {madeOffer && !listing && (
            <div className="flex flex-col gap-2">
              <span className={label}>1 · Send this offer to the taker</span>
              <div className="flex items-start gap-2">
                <textarea
                  readOnly
                  data-testid="swap-offer-out"
                  className={textarea}
                  value={madeOffer.json}
                />
                <CopyButton value={madeOffer.json} />
              </div>
              <label className={label} htmlFor="swap-answer">
                2 · Paste the taker&apos;s answer
              </label>
              <textarea
                id="swap-answer"
                data-testid="swap-answer-in"
                className={textarea}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
              />
              <button
                type="button"
                data-testid="swap-countersign"
                className={`${primaryButton} self-start`}
                disabled={busy || answer.trim() === ""}
                onClick={countersign}
              >
                Check and countersign
              </button>
              {countersignature && (
                <>
                  <span className={label}>3 · Send this signature back</span>
                  <div className="flex items-start gap-2">
                    <textarea
                      readOnly
                      data-testid="swap-signature-out"
                      className={textarea}
                      value={countersignature}
                    />
                    <CopyButton value={countersignature} />
                  </div>
                </>
              )}
            </div>
          )}

          {wallet && wallet.swap_slots.length > 0 && (
            <ul className="flex flex-col gap-2">
              {wallet.swap_slots.flatMap((parked) =>
                parked.holdings.map((holding) => (
                  <li
                    key={`${parked.slot}-${holding.asset_id}`}
                    className="flex flex-wrap items-center gap-3 text-sm text-neutral-300"
                  >
                    <span className={stamp}>slot {parked.slot + 1}</span>
                    {nameOf(holding.asset_id)} × {holding.amount}
                    <button
                      type="button"
                      className={ghostButton}
                      disabled={busy}
                      onClick={() => withdraw(parked.slot, holding.asset_id, holding.amount)}
                    >
                      Withdraw
                    </button>
                  </li>
                )),
              )}
            </ul>
          )}
        </div>
      )}

      {role === "take" && (
        <div className="mt-5 flex flex-col gap-3.5">
          <label className={label} htmlFor="swap-offer-in">
            1 · Paste the offer
          </label>
          <textarea
            id="swap-offer-in"
            data-testid="swap-offer-in"
            className={textarea}
            value={offerText}
            onChange={(event) => setOfferText(event.target.value)}
          />
          {offer && (
            <p data-testid="swap-offer-summary" className="text-base text-neutral-200">
              You get <strong>{offer.give_amount}</strong> {nameOf(offer.give_asset)} for{" "}
              <strong>{offer.want_amount}</strong> {nameOf(offer.want_asset)}.
            </p>
          )}
          <button
            type="button"
            data-testid="swap-take"
            className={`${primaryButton} self-start`}
            disabled={busy || offer === null}
            onClick={takeOffer}
          >
            Build and sign my side
          </button>
          {takeJson && takeFrom && !swapped && (
            <p
              role="status"
              data-testid="swap-take-status"
              className="rounded-[3px] border border-accent/40 px-3.5 py-2.5 text-sm text-accent"
            >
              {takerToken
                ? "Sent to the maker through the board. The swap completes here as soon as they countersign."
                : "Building your side…"}
            </p>
          )}
          {takeJson && !takeFrom && (
            <>
              <span className={label}>2 · Send this answer to the maker</span>
              <div className="flex items-start gap-2">
                <textarea
                  readOnly
                  data-testid="swap-answer-out"
                  className={textarea}
                  value={takeJson}
                />
                <CopyButton value={takeJson} />
              </div>
              <label className={label} htmlFor="swap-signature-in">
                3 · Paste the maker&apos;s signature
              </label>
              <textarea
                id="swap-signature-in"
                data-testid="swap-signature-in"
                className={textarea}
                value={signatureText}
                onChange={(event) => setSignatureText(event.target.value)}
              />
              <button
                type="button"
                data-testid="swap-finish"
                className={`${primaryButton} self-start`}
                disabled={busy || signatureText.trim() === ""}
                onClick={() => finishSwap()}
              >
                Complete the swap
              </button>
            </>
          )}
          {swapped && (
            <p data-testid="swap-done" className="text-sm text-emerald-300">
              Swapped in one transaction:{" "}
              <Link
                href={`/tx/${swapped}`}
                className="font-data underline decoration-emerald-300/40"
              >
                {swapped.slice(0, 16)}…
              </Link>
            </p>
          )}
        </div>
      )}

      {stage && (
        <p role="status" className="mt-4 flex items-center gap-2 text-[13px] text-accent/90">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
          {stage}
        </p>
      )}
      {error && (
        <p role="alert" data-testid="swap-error" className="mt-4 text-sm text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
