"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { AssetThumb, AssetTitle } from "@/components/asset-chip";
import { AssetPicker, FIELD_HEIGHT, type PickableAsset } from "@/components/asset-picker";
import { CopyButton } from "@/components/copy-button";
import { OfferSide } from "@/components/swap-board";
import { api, problemMessage } from "@/lib/api";
import { type Call, useBrowserWallet } from "@/lib/browser-wallet";
import { askToNotify, useSwapMaker } from "@/lib/swap-maker";
import { card, cardTitle, ghostButton, input, label, primaryButton } from "@/lib/ui";
import { scanToTip, type WalletState } from "@/lib/wallet-scan";

/** The parts of an offer a person decides on (the rest is for the engine). */
type OfferSummary = {
  give_asset: string;
  give_amount: number;
  want_asset: string;
  want_amount: number;
};

/** What a listed offer's status says first. */
const LISTED =
  "Listed on the board. Takers are answered from any Cachet page of this tab while it stays open; close it and the offer comes down within a minute.";

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
  takeId = null,
  wantId = null,
  onChange = () => undefined,
}: {
  /** A board offer to take, chosen on this page or named in its address. */
  takeId?: string | null;
  /** An asset to ask for, when the visitor came from its page. */
  wantId?: string | null;
  /** Told after a swap step moved funds. */
  onChange?: () => void;
}) {
  const { call, seed, seedSaved, issuer } = useBrowserWallet();
  const enabled = issuer !== null && seedSaved;
  const [role, setRole] = useState<"make" | "take">("make");
  const [wallet, setWallet] = useState<WalletState | null>(null);
  const [assets, setAssets] = useState<PickableAsset[] | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Maker
  const [giveAsset, setGiveAsset] = useState("");
  const [giveAmount, setGiveAmount] = useState("1");
  const [wantAsset, setWantAsset] = useState("");
  const [wantAmount, setWantAmount] = useState("1");
  const [answer, setAnswer] = useState("");
  const [countersignature, setCountersignature] = useState<string | null>(null);

  // The maker's listed offer lives above the pages, so takes are answered
  // from any page of this tab (lib/swap-maker.tsx).
  const {
    madeOffer,
    setMadeOffer,
    listing,
    setListing,
    status: boardStatus,
    setStatus: setBoardStatus,
    done: makerDone,
    txid: makerTxid,
    height: makerHeight,
    clear: clearOffer,
    fundsVersion,
    unseen,
    markSeen,
  } = useSwapMaker();
  const [listOnBoard, setListOnBoard] = useState(true);
  // Putting units already in a slot back on the board (after a reload).
  const [relistSlot, setRelistSlot] = useState<number | null>(null);
  const [relistWant, setRelistWant] = useState("");
  const [relistAmount, setRelistAmount] = useState("1");
  const [takeFrom, setTakeFrom] = useState<string | null>(null);
  const [takerToken, setTakerToken] = useState<string | null>(null);

  // Taker
  const [offerText, setOfferText] = useState("");
  const [takeJson, setTakeJson] = useState<string | null>(null);
  const [signatureText, setSignatureText] = useState("");
  const [swapped, setSwapped] = useState<string | null>(null);

  useEffect(() => {
    setWallet(null);
    setCountersignature(null);
    setTakeJson(null);
    setSwapped(null);
    setTakerToken(null);
    setRelistSlot(null);
  }, [seed]);

  // The offer being answered elsewhere moved funds: read the wallet again.
  useEffect(() => {
    if (fundsVersion === 0 || !enabled) return;
    void scanToTip(call, seed.trim())
      .then(setWallet)
      .catch(() => undefined);
    onChange();
    // onChange is the parent's callback of this render; only a new
    // version of the funds should trigger a read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fundsVersion]);

  // What happened to the offer is on screen here: nothing left unseen.
  useEffect(() => {
    if (unseen > 0) markSeen();
  }, [unseen, markSeen]);

  // An offer taken from the board: load it on the taker's side.
  useEffect(() => {
    if (!enabled) return;
    const id = takeId;
    if (!id || !/^[0-9a-f]{32}$/.test(id)) return;
    setError(null);
    setTakeJson(null);
    setSwapped(null);
    setTakerToken(null);
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
  }, [enabled, takeId]);

  // Asking for a given asset: the maker's form starts with it.
  useEffect(() => {
    if (!wantId || !/^[0-9a-f]{64}$/.test(wantId)) return;
    setRole("make");
    setWantAsset(wantId);
  }, [wantId]);

  // Names from the whole registry listing (one request identical for every
  // caller), never per asset: a lookup per id would tell the operator what
  // this browser trades.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    api.GET("/api/v1/assets").then(({ data }) => {
      if (cancelled || !data) return;
      setAssets(data);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

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

  // A first scan reads the whole chain: say how far it has come.
  const scan = (trimmed: string) =>
    scanToTip(call, trimmed, (state, tip) =>
      setStage(
        state.scanned_height >= tip
          ? "Scanning the chain…"
          : `Scanning the chain… block ${state.scanned_height.toLocaleString("en-US")} of ${tip.toLocaleString("en-US")}`,
      ),
    );

  const refresh = () =>
    step("Scanning the chain…", async () => {
      setWallet(await scan(seed.trim()));
    });

  // An offer to take: read the wallet now, so the page can say before
  // anything is proved whether it holds what the offer asks.
  useEffect(() => {
    if (!enabled || role !== "take" || wallet || offerText.trim() === "") return;
    void refresh();
    // refresh is a plain function of this render; the scan only needs to
    // start when an offer arrives and the wallet is still unread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, role, offerText, wallet]);

  // --- maker ----------------------------------------------------------------

  const prepareOffer = () => {
    if (listOnBoard) askToNotify();
    return step("Parking the units in a swap slot…", async () => {
      const trimmed = seed.trim();
      let state = await scan(trimmed);
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
        setListing({ id: posted.data.id, token: posted.data.maker_token });
        setBoardStatus(LISTED);
      }
    });
  };

  // Units still in a slot, from an offer this tab no longer holds: write a
  // new offer on them and list it, without moving them again.
  const relist = (slot: number) => {
    askToNotify();
    return step("Writing the offer…", async () => {
      const trimmed = seed.trim();
      if (!/^[0-9a-f]{64}$/.test(relistWant.trim().toLowerCase())) {
        throw new Error("Choose the asset you want in exchange.");
      }
      setWallet(await scan(trimmed));
      const json = await call<string>("swap_make_offer", {
        seed: trimmed,
        slot,
        want_asset: relistWant.trim().toLowerCase(),
        want_amount: Number(relistAmount),
      });
      setStage("Listing it on the board…");
      const posted = await api.POST("/api/v1/swaps", { body: { offer: json } });
      if (posted.error) throw new Error(problemMessage(posted.error));
      setMadeOffer({ slot, json });
      setListing({ id: posted.data.id, token: posted.data.maker_token });
      setBoardStatus(LISTED);
      setRelistSlot(null);
    });
  };

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
      const state = await scan(trimmed);
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
      setWallet(await scan(trimmed));
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
  const heldRow = wallet?.holdings.find((holding) => holding.asset_id === giveAsset);
  const held = heldRow ? Number(heldRow.amount) : null;
  const byId = new Map((assets ?? []).map((asset) => [asset.asset_id, asset]));
  const holdings: PickableAsset[] = (wallet?.holdings ?? []).map((holding) => ({
    ...(byId.get(holding.asset_id) ?? {}),
    asset_id: holding.asset_id,
  }));
  const heldOf = (assetId: string) =>
    Number(wallet?.holdings.find((holding) => holding.asset_id === assetId)?.amount ?? "0");
  const wantChosen = wantAsset.trim().toLowerCase();
  const offerReady =
    giveAsset !== "" &&
    /^[0-9a-f]{64}$/.test(wantChosen) &&
    Number(giveAmount) > 0 &&
    Number(wantAmount) > 0 &&
    (held === null || Number(giveAmount) <= held);
  const inFlight = madeOffer !== null || listing !== null;
  let made: OfferSummary | null = null;
  try {
    made = madeOffer ? (JSON.parse(madeOffer.json) as OfferSummary) : null;
  } catch {
    made = null;
  }
  // What the taker holds of what the offer asks, once the wallet is read.
  const canPay = offer && wallet ? heldOf(offer.want_asset) >= offer.want_amount : null;
  const fieldRow = "grid grid-cols-[minmax(0,1fr)_8.5rem] gap-x-3 gap-y-1.5";
  const hint = "min-h-5 text-[13px] text-neutral-500";
  const caption = "font-data text-[12px] uppercase tracking-[0.14em] text-neutral-500";
  const statusStrip =
    "flex items-start gap-3 rounded-md border border-accent/30 bg-accent/[0.04] px-4 py-3 text-sm leading-relaxed text-neutral-200";
  const doneStrip =
    "flex items-start gap-3 rounded-md border border-emerald-300/30 bg-emerald-300/[0.05] px-4 py-3 text-sm leading-relaxed text-emerald-200";
  const pulse = (
    <span className="mt-[7px] h-2 w-2 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />
  );
  const offerCard = (title: string, give: OfferSummary) => (
    <div className="rounded-md border border-line bg-black/20 px-4 py-3.5">
      <p className={caption}>{title}</p>
      <div className="mt-2.5 grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <OfferSide
          compact
          amount={give.give_amount}
          id={give.give_asset}
          asset={byId.get(give.give_asset)}
        />
        <span aria-hidden className="text-lg text-accent">
          →
        </span>
        <OfferSide
          compact
          amount={give.want_amount}
          id={give.want_asset}
          asset={byId.get(give.want_asset)}
        />
      </div>
    </div>
  );

  return (
    <section id="swap" className={`${card} rise scroll-mt-8`} data-testid="swap-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className={cardTitle}>2 · Make or take an offer</h2>
        <button
          type="button"
          className="font-data text-[13px] text-neutral-500 transition hover:text-accent disabled:opacity-40"
          onClick={refresh}
          disabled={busy}
          title={wallet ? `Scanned to block ${wallet.scanned_height}` : undefined}
        >
          {wallet ? "Rescan" : "Scan my holdings"}
        </button>
      </div>

      <div
        role="radiogroup"
        aria-label="Your side"
        className="mt-4 inline-flex overflow-hidden rounded-md border border-white/10 bg-black/30"
      >
        {(
          [
            ["make", "Make an offer"],
            ["take", "Take an offer"],
          ] as const
        ).map(([value, text], index) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={role === value}
            data-testid={`swap-role-${value}`}
            onClick={() => setRole(value)}
            className={`px-4 py-2 text-sm transition ${index > 0 ? "border-l border-white/[0.07]" : ""} ${
              role === value
                ? "bg-accent/[0.09] text-accent"
                : "text-neutral-400 hover:bg-white/[0.03] hover:text-neutral-200"
            }`}
          >
            {text}
          </button>
        ))}
      </div>

      {role === "make" && (
        <div className="mt-6 flex flex-col gap-4">
          {inFlight && made && offerCard(makerDone ? "Your offer, filled" : "Your offer", made)}

          {!inFlight && (
            <>
              <div className={fieldRow}>
                <label className={label} htmlFor="swap-give-asset">
                  You give
                </label>
                <label className={label} htmlFor="swap-give-amount">
                  Units
                </label>
                {wallet ? (
                  <AssetPicker
                    id="swap-give-asset"
                    testId="swap-give-asset"
                    value={giveAsset}
                    onChange={setGiveAsset}
                    assets={holdings}
                    showAll
                    detail={(asset) => `${heldOf(asset.asset_id).toLocaleString("en-US")} held`}
                    placeholder={holdings.length > 0 ? "choose what you give" : "nothing held yet"}
                    empty="You hold nothing by that name."
                  />
                ) : (
                  <button
                    type="button"
                    id="swap-give-asset"
                    className={`${FIELD_HEIGHT} rounded-md border border-dashed border-line-strong px-3.5 text-left text-sm text-neutral-400 transition hover:border-accent/60 hover:text-accent disabled:opacity-40`}
                    onClick={refresh}
                    disabled={busy}
                  >
                    Scan to choose from what you hold
                  </button>
                )}
                <input
                  id="swap-give-amount"
                  data-testid="swap-give-amount"
                  className={`${input} ${FIELD_HEIGHT} tabular-nums`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={held ?? undefined}
                  value={giveAmount}
                  onChange={(event) => setGiveAmount(event.target.value)}
                />
                <span className={hint} />
                <span className={hint}>
                  {held !== null && (
                    <button
                      type="button"
                      className="transition hover:text-accent"
                      onClick={() => setGiveAmount(String(held))}
                    >
                      of {held.toLocaleString("en-US")} · <span className="underline">all</span>
                    </button>
                  )}
                </span>
              </div>

              <div className={fieldRow}>
                <label className={label} htmlFor="swap-want-asset">
                  You want
                </label>
                <label className={label} htmlFor="swap-want-amount">
                  Units
                </label>
                <AssetPicker
                  id="swap-want-asset"
                  testId="swap-want-asset"
                  value={wantAsset}
                  onChange={setWantAsset}
                  assets={assets ?? []}
                  loading={assets === null}
                  exclude={giveAsset}
                />
                <input
                  id="swap-want-amount"
                  data-testid="swap-want-amount"
                  className={`${input} ${FIELD_HEIGHT} tabular-nums`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={wantAmount}
                  onChange={(event) => setWantAmount(event.target.value)}
                />
              </div>

              {offerReady &&
                offerCard("Your offer", {
                  give_asset: giveAsset,
                  give_amount: Number(giveAmount),
                  want_asset: wantChosen,
                  want_amount: Number(wantAmount),
                })}

              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <button
                  type="button"
                  data-testid="swap-prepare"
                  className={primaryButton}
                  disabled={busy || !offerReady}
                  onClick={prepareOffer}
                >
                  {listOnBoard ? "Post the offer" : "Prepare the offer"}
                </button>
                <label className="flex cursor-pointer items-center gap-2.5 text-sm text-neutral-300">
                  <input
                    type="checkbox"
                    data-testid="swap-list-on-board"
                    className="h-4 w-4 accent-accent"
                    checked={listOnBoard}
                    onChange={(event) => setListOnBoard(event.target.checked)}
                  />
                  List it on the board
                </label>
              </div>
              <p className="text-[13px] leading-relaxed text-neutral-500">
                Your units wait in a one-off slot of your seed until someone takes the offer; the
                offer shows that slot, never your main holdings. Cancel any time: the units come
                back to your wallet.
                {!listOnBoard &&
                  " Unlisted, the offer and its answers pass between the two of you by hand."}
              </p>
            </>
          )}

          {boardStatus && (
            <div
              role="status"
              data-testid="swap-board-status"
              className={makerDone ? doneStrip : statusStrip}
            >
              {makerDone ? <span aria-hidden>✓</span> : pulse}
              <span>
                {boardStatus}
                {makerTxid && (
                  <>
                    {" "}
                    <Link
                      href={`/tx/${makerTxid}`}
                      data-testid="swap-maker-tx"
                      className={`font-data underline underline-offset-2 ${makerDone ? "decoration-emerald-300/40" : "decoration-white/20"}`}
                    >
                      {makerTxid.slice(0, 16)}…
                    </Link>
                    {makerDone && makerHeight !== null && (
                      <span className="font-data">
                        {` · block ${makerHeight.toLocaleString("en-US")}`}
                      </span>
                    )}
                  </>
                )}
              </span>
            </div>
          )}
          {makerDone && (
            <button
              type="button"
              className={`${ghostButton} self-start !px-5 !py-2.5 !text-sm`}
              onClick={() => {
                clearOffer();
                setCountersignature(null);
                setAnswer("");
                setGiveAsset("");
              }}
            >
              Make another offer
            </button>
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
            <div>
              <p className={caption}>Waiting in swap slots</p>
              <ul className="mt-2 divide-y divide-line rounded-md border border-line">
                {wallet.swap_slots.flatMap((parked) =>
                  parked.holdings.map((holding) => {
                    const offered = madeOffer?.slot === parked.slot;
                    return (
                      <li key={`${parked.slot}-${holding.asset_id}`} className="px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <AssetThumb asset={byId.get(holding.asset_id)} id={holding.asset_id} />
                          <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                            <span className="font-display text-lg tabular-nums text-neutral-50">
                              {Number(holding.amount).toLocaleString("en-US")}
                            </span>{" "}
                            <AssetTitle asset={byId.get(holding.asset_id)} />
                            <span className="font-data ml-2 text-[12px] text-neutral-500">
                              {offered ? "on offer" : "no offer"} · slot {parked.slot + 1}
                            </span>
                          </span>
                          {!offered && listing === null && (
                            <button
                              type="button"
                              data-testid="swap-relist"
                              className="shrink-0 rounded-sm px-2 py-1 text-[13px] text-accent transition hover:text-accent-hover disabled:opacity-40"
                              disabled={busy}
                              onClick={() =>
                                setRelistSlot(relistSlot === parked.slot ? null : parked.slot)
                              }
                            >
                              Post again
                            </button>
                          )}
                          <button
                            type="button"
                            className="shrink-0 rounded-sm px-2 py-1 text-[13px] text-neutral-400 transition hover:text-accent disabled:opacity-40"
                            disabled={busy}
                            title="Moves the units back to your wallet; an offer on them is taken down."
                            onClick={() => withdraw(parked.slot, holding.asset_id, holding.amount)}
                          >
                            {offered ? "Cancel offer" : "Return to wallet"}
                          </button>
                        </div>
                        {relistSlot === parked.slot && !offered && (
                          <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
                            <div className={fieldRow}>
                              <label className={label} htmlFor="swap-relist-want">
                                In exchange, you want
                              </label>
                              <label className={label} htmlFor="swap-relist-amount">
                                Units
                              </label>
                              <AssetPicker
                                id="swap-relist-want"
                                testId="swap-relist-want"
                                value={relistWant}
                                onChange={setRelistWant}
                                assets={assets ?? []}
                                loading={assets === null}
                                exclude={holding.asset_id}
                              />
                              <input
                                id="swap-relist-amount"
                                className={`${input} ${FIELD_HEIGHT} tabular-nums`}
                                type="number"
                                inputMode="numeric"
                                min={1}
                                value={relistAmount}
                                onChange={(event) => setRelistAmount(event.target.value)}
                              />
                            </div>
                            <button
                              type="button"
                              className={`${primaryButton} self-start !px-5 !py-2.5 !text-sm`}
                              disabled={
                                busy ||
                                !/^[0-9a-f]{64}$/.test(relistWant.trim().toLowerCase()) ||
                                Number(relistAmount) <= 0
                              }
                              onClick={() => relist(parked.slot)}
                            >
                              Post these {Number(holding.amount).toLocaleString("en-US")} units
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  }),
                )}
              </ul>
            </div>
          )}
        </div>
      )}

      {role === "take" && (
        <div className="mt-6 flex flex-col gap-4">
          {!takeFrom && (
            <>
              <label className={label} htmlFor="swap-offer-in">
                Paste an offer
              </label>
              <textarea
                id="swap-offer-in"
                data-testid="swap-offer-in"
                className={textarea}
                value={offerText}
                onChange={(event) => setOfferText(event.target.value)}
                placeholder="the offer message the maker sent you"
              />
            </>
          )}
          {!takeFrom && !offer && (
            <p className="text-[13px] text-neutral-500">
              Or pick one on the board above: it loads here.
            </p>
          )}
          {offer && (
            <div
              data-testid="swap-offer-summary"
              className="grid gap-4 rounded-md border border-line bg-black/20 px-4 py-3.5 sm:grid-cols-2"
            >
              <div>
                <p className={caption}>You get</p>
                <div className="mt-2">
                  <OfferSide
                    compact
                    amount={offer.give_amount}
                    id={offer.give_asset}
                    asset={byId.get(offer.give_asset)}
                  />
                </div>
              </div>
              <div>
                <p className={caption}>You pay</p>
                <div className="mt-2">
                  <OfferSide
                    compact
                    amount={offer.want_amount}
                    id={offer.want_asset}
                    asset={byId.get(offer.want_asset)}
                  />
                </div>
                {wallet && (
                  <p
                    data-testid="swap-pay-held"
                    className={`mt-2 text-[13px] ${canPay ? "text-neutral-500" : "text-red-300"}`}
                  >
                    You hold {heldOf(offer.want_asset).toLocaleString("en-US")}
                    {canPay
                      ? "."
                      : `: not enough to pay ${offer.want_amount.toLocaleString("en-US")}.`}
                  </p>
                )}
              </div>
            </div>
          )}
          {!swapped && (
            <button
              type="button"
              data-testid="swap-take"
              className={`${primaryButton} self-start`}
              disabled={busy || offer === null || canPay === false}
              onClick={takeOffer}
            >
              Take it: build and sign
            </button>
          )}
          {takeJson && takeFrom && !swapped && (
            <div role="status" data-testid="swap-take-status" className={statusStrip}>
              {pulse}
              <span>
                {takerToken
                  ? "Sent to the maker through the board. The swap completes here as soon as their page countersigns."
                  : "Building your side…"}
              </span>
            </div>
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
            <div data-testid="swap-done" className={doneStrip}>
              <span aria-hidden>✓</span>
              <span>
                Swapped in one transaction:{" "}
                <Link
                  href={`/tx/${swapped}`}
                  className="font-data underline decoration-emerald-300/40 underline-offset-2"
                >
                  {swapped.slice(0, 16)}…
                </Link>
              </span>
            </div>
          )}
        </div>
      )}

      {stage && (
        <p role="status" className="mt-5 flex items-center gap-2.5 text-[13px] text-accent/90">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse" />
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
