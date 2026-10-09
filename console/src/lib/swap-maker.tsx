"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

import { api, problemMessage } from "@/lib/api";
import { useBrowserWallet } from "@/lib/browser-wallet";
import { scanToTip } from "@/lib/wallet-scan";

/** An offer made by this page: the swap slot it parks units in, and the message. */
export type MadeOffer = { slot: number; json: string };
/** Where it is listed on the board, and the token that manages it. */
export type Listing = { id: string; token: string };

type SwapMaker = {
  madeOffer: MadeOffer | null;
  setMadeOffer: (offer: MadeOffer | null) => void;
  listing: Listing | null;
  setListing: (listing: Listing | null) => void;
  status: string | null;
  setStatus: (status: string | null) => void;
  /** The taker relayed the swap. */
  done: boolean;
  /** Forget the offer, after it was filled or cancelled. */
  clear: () => void;
  /** Bumped when the answering loop moved funds: wallets read the chain again. */
  fundsVersion: number;
  /** Takes answered or swaps filled since the swaps page was last looked at. */
  unseen: number;
  markSeen: () => void;
};

const SwapMakerContext = createContext<SwapMaker | null>(null);

/** Tell the maker through the system when the tab is not in view. */
function notify(body: string) {
  if (typeof document === "undefined" || document.visibilityState === "visible") return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification("Cachet swap", { body, tag: "cachet-swap" });
  } catch {
    // Some browsers allow notifications only from a service worker.
  }
}

/** Ask once, from the click that posts an offer (a user gesture). */
export function askToNotify() {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission().catch(() => undefined);
}

/**
 * The maker's side of a listed offer, kept above the pages: the page that
 * answers takes with the maker's keys is any page of this tab, not only
 * the swaps page. The keys stay where they are, in the browser wallet's
 * memory; nothing is stored, and a reload still forgets the offer (it
 * comes down from the board a minute later; the units stay in their slot).
 */
export function SwapMakerProvider({ children }: { children: React.ReactNode }) {
  const { call, seed } = useBrowserWallet();
  const [madeOffer, setMadeOffer] = useState<MadeOffer | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [fundsVersion, setFundsVersion] = useState(0);
  const [unseen, setUnseen] = useState(0);
  const answeredTake = useRef<number | null>(null);
  // Posting the offer again on a newer root (the board said it went stale).
  const reposting = useRef(false);

  const clear = () => {
    setMadeOffer(null);
    setListing(null);
    setStatus(null);
    setDone(false);
    answeredTake.current = null;
  };

  // Another seed is another wallet: its offer is not this one.
  useEffect(clear, [seed]);

  // Answer takes as they arrive: the engine checks each against the offer
  // before signing, so answering is safe unattended.
  useEffect(() => {
    if (!listing || !madeOffer) return;
    answeredTake.current = null;
    const headers = { "x-swap-token": listing.token };
    const path = { id: listing.id };
    let stopped = false;
    const tick = async () => {
      const board = await api.GET("/api/v1/swaps/{id}", { params: { path } });
      if (board.data?.status === "closed") {
        stopped = true;
        setStatus("Swapped: the taker relayed the transaction.");
        setDone(true);
        setUnseen((count) => count + 1);
        setFundsVersion((version) => version + 1);
        notify("Your offer was filled: the swap landed in one transaction.");
        return;
      }
      // Takers' wallets build on the roots of their last 100 blocks: an
      // offer older than that cannot be taken. The board takes it down a
      // little before; this page puts the same units up again on the
      // chain's current root, and withdraws the old listing.
      if (board.data?.status === "stale") {
        if (reposting.current) return;
        reposting.current = true;
        setStatus(
          "Your offer got too old for takers' wallets: posting it again on a recent block…",
        );
        try {
          const trimmed = seed.trim();
          await scanToTip(call, trimmed);
          const asked = JSON.parse(madeOffer.json) as { want_asset: string; want_amount: number };
          const json = await call<string>("swap_make_offer", {
            seed: trimmed,
            slot: madeOffer.slot,
            want_asset: asked.want_asset,
            want_amount: asked.want_amount,
          });
          const posted = await api.POST("/api/v1/swaps", { body: { offer: json } });
          if (posted.error) throw new Error(problemMessage(posted.error));
          await api
            .DELETE("/api/v1/swaps/{id}", { params: { path }, headers })
            .catch(() => undefined);
          stopped = true;
          answeredTake.current = null;
          setMadeOffer({ slot: madeOffer.slot, json });
          setListing({ id: posted.data.id, token: posted.data.maker_token });
          setStatus("Listed again on a recent block. Takers are answered from this tab.");
        } catch (failure) {
          stopped = true;
          setStatus(
            `Your offer got too old for takers, and posting it again failed (${failure instanceof Error ? failure.message : String(failure)}). Cancel it to get the units back.`,
          );
        } finally {
          reposting.current = false;
        }
        return;
      }
      const take = await api.GET("/api/v1/swaps/{id}/take", { params: { path }, headers });
      const takenAt = take.data?.taken_at;
      if (!take.data?.take || takenAt === null || takenAt === undefined) return;
      if (answeredTake.current === takenAt) return;
      answeredTake.current = takenAt;
      setStatus("A taker answered: checking their transaction against your offer…");
      notify("A taker answered your offer: checking it and countersigning.");
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
        setStatus("Countersigned. Waiting for the taker to relay the swap…");
      } catch (refusal) {
        // Refused: release it, so the offer reopens now rather than after
        // the hold, for a taker whose swap does pay.
        await api
          .DELETE("/api/v1/swaps/{id}/take", { params: { path }, headers })
          .catch(() => undefined);
        setStatus(
          `Refused a take: ${refusal instanceof Error ? refusal.message : String(refusal)}. Still listed.`,
        );
      }
    };
    const timer = setInterval(() => {
      if (!stopped)
        void tick().catch((failure: unknown) =>
          setStatus(
            `Listed, but the board is unreachable right now (${failure instanceof Error ? failure.message : String(failure)}). Retrying…`,
          ),
        );
    }, 4_000);
    return () => clearInterval(timer);
  }, [listing, madeOffer, call, seed]);

  // Leaving with an offer up takes it off the board: say so before.
  useEffect(() => {
    if (!listing || done) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [listing, done]);

  return (
    <SwapMakerContext.Provider
      value={{
        madeOffer,
        setMadeOffer,
        listing,
        setListing,
        status,
        setStatus,
        done,
        clear,
        fundsVersion,
        unseen,
        markSeen: () => setUnseen(0),
      }}
    >
      {children}
    </SwapMakerContext.Provider>
  );
}

export function useSwapMaker(): SwapMaker {
  const maker = useContext(SwapMakerContext);
  if (!maker) throw new Error("useSwapMaker outside SwapMakerProvider");
  return maker;
}
