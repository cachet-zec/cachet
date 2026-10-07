"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { HoldingsPanel } from "@/components/holdings-panel";
import { ImagePicker } from "@/components/image-picker";
import { MintGauge } from "@/components/mint-gauge";
import { SignedTransaction, type SignedTx } from "@/components/signed-transaction";
import { SeedCard } from "@/components/seed-card";
import { api, problemMessage } from "@/lib/api";
import { fetchKept, loadSealedContent } from "@/lib/kept";
import { useBrowserWallet } from "@/lib/browser-wallet";
import { assertSealsWhatWasTyped } from "@/lib/sealed-check";
import { safeImageDataUri } from "@/lib/sealed-name";
import { card, cardTitle, input, label, primaryButton, stamp } from "@/lib/ui";

/**
 * The browser mint studio: keys are generated and held in this page's
 * memory only, the Halo2 proof is computed in a Web Worker on the user's
 * machine, and the server merely relays the signed transaction. Works on
 * read-only deployments by design — the instance signs nothing.
 */
export function MintStudio() {
  const router = useRouter();
  const { call, seed, seedSaved, issuer, warm, engineReady, engineThreads, provingReady } =
    useBrowserWallet();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  // Minting a kept asset again (/mint?remint=<asset id>): the sealed content
  // is loaded, checked against its hash, and locked, since changing any of
  // it would make a different asset. `remintId` is the id this seed gives it.
  const [remint, setRemint] = useState<{
    assetId: string;
    description: string;
    externalUrl: string | undefined;
  } | null>(null);
  const [remintError, setRemintError] = useState<string | null>(null);
  const [remintId, setRemintId] = useState<string | null>(null);
  const [finalize, setFinalize] = useState(true);
  // Sealing an asset that exists, with no new units (/mint?seal=<asset id>):
  // its asset description is loaded and locked, and only the seed that
  // issued it gives the same id. `remintId` holds the id this seed gives.
  const [sealing, setSealing] = useState<{ assetId: string; description: string } | null>(null);
  // The asset this page is bound to, if any: content locked, id checked.
  const locked = remint ?? sealing;

  const [stage, setStage] = useState<string | null>(null);
  // Which step of the mint is running (1-based), for the gauge.
  const [phase, setPhase] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    txid: string;
    asset_id: string;
    reissue: boolean;
    sealed: boolean;
  } | null>(null);
  const [mintCount, setMintCount] = useState(0);
  // The relay is optional: the signed bytes can be handed over instead,
  // by choice or because the relay did not take them.
  const [holdRelay, setHoldRelay] = useState(false);
  const [signed, setSigned] = useState<{ tx: SignedTx; relayFailed: boolean } | null>(null);

  // The operator's pause switch, read from the public chain info and
  // re-read every 15 s so a flip reaches an open page without a reload.
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const chain = await api.GET("/api/v1/chain");
      if (!cancelled && chain.data) setPaused(Boolean(chain.data.mints_paused));
    };
    void poll();
    const timer = setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Warm up on mount: let the browser download and compile the wasm
  // engine while the visitor reads the page.
  useEffect(() => warm(), [warm]);

  // Old links to take an offer here: swaps have their own page now.
  useEffect(() => {
    const take = new URLSearchParams(window.location.search).get("take");
    if (take) router.replace(`/swaps?take=${encodeURIComponent(take)}`);
  }, [router]);

  // A kept asset to bring back, named in the address.
  useEffect(() => {
    const assetId = new URLSearchParams(window.location.search).get("remint")?.toLowerCase();
    if (!assetId) return;
    let cancelled = false;
    (async () => {
      if (!/^[0-9a-f]{64}$/.test(assetId)) throw new Error("That is not an asset id.");
      const kept = await fetchKept(assetId);
      if (!kept) throw new Error("This registry keeps nothing to mint again for that asset id.");
      const sealed = await loadSealedContent(kept.description);
      if (cancelled) return;
      setName(sealed.name);
      setDescription(sealed.description ?? "");
      setImageDataUri(sealed.imageDataUri ?? null);
      setRemint({ assetId, description: kept.description, externalUrl: sealed.externalUrl });
    })().catch((error: unknown) => {
      if (!cancelled) setRemintError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // An asset to seal, named in the address. Its content is shown so the
  // issuer recognises it; the seal itself signs only its description hash.
  useEffect(() => {
    const assetId = new URLSearchParams(window.location.search).get("seal")?.toLowerCase();
    if (!assetId) return;
    let cancelled = false;
    (async () => {
      if (!/^[0-9a-f]{64}$/.test(assetId)) throw new Error("That is not an asset id.");
      const { data } = await api.GET("/api/v1/assets/{asset_id}", {
        params: { path: { asset_id: assetId } },
      });
      if (!data) throw new Error("This registry does not know that asset on the chain it reads.");
      if (data.finalized) throw new Error("This asset is already sealed: its supply is permanent.");
      if (!data.description) {
        throw new Error(
          "This registry does not know the asset's description, so the seed cannot be checked against it. Register the description from the asset page first.",
        );
      }
      const chainDescription = data.description;
      let shown = {
        name: data.display_name ?? chainDescription,
        text: "",
        image: null as string | null,
      };
      try {
        const sealed = await loadSealedContent(chainDescription);
        shown = {
          name: sealed.name,
          text: sealed.description ?? "",
          image: sealed.imageDataUri ?? null,
        };
      } catch {
        // A free-text label, or content this registry no longer serves: the
        // name it lists under is enough to recognise the asset.
      }
      if (cancelled) return;
      setName(shown.name);
      setDescription(shown.text);
      setImageDataUri(shown.image);
      setAmount("0");
      setFinalize(true);
      setSealing({ assetId, description: chainDescription });
    })().catch((error: unknown) => {
      if (!cancelled) setRemintError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The id this seed gives the bound description: the same one, or not.
  useEffect(() => {
    setRemintId(null);
    if (!locked || !issuer) return;
    let cancelled = false;
    call<{ asset_id: string }>("issuer_info", {
      seed: seed.trim(),
      description: locked.description,
    })
      .then((info) => !cancelled && setRemintId(info.asset_id))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [locked, issuer, seed, call]);

  const mint = async () => {
    setError(null);
    setReceipt(null);
    setSigned(null);
    // Kept from proof to relay: a failure in between must not lose the transaction.
    let unrelayed: SignedTx | null = null;
    try {
      const trimmedSeed = seed.trim();

      // 1. Seal the full bundle — name, optional description and image —
      //    into a metadata bundle; its hash goes into the asset
      //    description and thus the asset id itself. Sealing an existing
      //    asset reuses its asset description: nothing new is stored.
      setPhase(1);
      let chainDescription: string;
      if (sealing) {
        chainDescription = sealing.description;
      } else {
        setStage("Sealing metadata…");
        const meta = await api.POST("/api/v1/metadata", {
          body: {
            name,
            description: description.trim() === "" ? undefined : description,
            image_data_uri: imageDataUri ?? undefined,
            external_url: remint?.externalUrl,
          },
        });
        if (meta.error) throw new Error(problemMessage(meta.error));
        chainDescription = meta.data.chain_description;
        if (remint) {
          // The kept description was checked against its bundle in this page
          // when it was loaded. Sealing the same content must give the same
          // description, to the character, or it is not the same asset.
          if (chainDescription !== remint.description) {
            throw new Error(
              "The registry sealed this content differently: it would not be the same asset. Nothing was signed.",
            );
          }
        } else {
          // The registry wrote this description and the seed is about to sign
          // it for good: check it seals exactly what is in the form.
          await assertSealsWhatWasTyped(chainDescription, {
            name,
            description: description.trim() === "" ? undefined : description,
            imageDataUri: imageDataUri ?? undefined,
          });
        }
      }

      // 2. Public chain facts: target height, and whether this asset id
      //    already exists (reissue) or is brand new.
      setPhase(2);
      setStage("Reading the chain…");
      const chain = await api.GET("/api/v1/chain");
      if (chain.error) throw new Error(problemMessage(chain.error));
      const info = await call<{ asset_id: string }>("issuer_info", {
        seed: trimmedSeed,
        description: chainDescription,
      });
      if (remint && info.asset_id !== remint.assetId) {
        throw new Error("This seed gives a different asset id. Nothing was signed.");
      }
      if (sealing && info.asset_id !== sealing.assetId) {
        throw new Error("This seed did not issue this asset. Nothing was signed.");
      }
      const existing = await api.GET("/api/v1/assets/{asset_id}", {
        params: { path: { asset_id: info.asset_id } },
      });
      if (existing.data?.finalized) {
        throw new Error("this asset is finalized: its supply is permanent");
      }
      const firstIssuance = !existing.data;
      if (sealing && firstIssuance) {
        throw new Error("This asset is not on the chain this registry reads. Nothing was signed.");
      }
      if (sealing) {
        setStage(
          `Sealing ${info.asset_id.slice(0, 8)}…: no new units, the supply becomes permanent.`,
        );
      } else if (!firstIssuance) {
        // Reissuing was silent, so a minter could inflate an existing
        // asset believing they had made a new one. Identical metadata
        // means the identical asset, by construction.
        setStage(
          `This metadata already names asset ${info.asset_id.slice(0, 8)}… — ` +
            `adding to its supply, not creating a new one.`,
        );
      }

      // 3. The heavy part, entirely on this machine.
      setPhase(3);
      setStage(
        engineThreads > 1
          ? `Proving in your browser on ${engineThreads} threads… ${provingReady ? "about ten seconds" : "about 15 seconds"}, your keys never leave this page`
          : `Proving in your browser… ${provingReady ? "about half a minute" : "about a minute"}, your keys never leave this page`,
      );
      const built = await call<{ tx_hex: string; txid: string; asset_id: string }>("build", {
        seed: trimmedSeed,
        description: chainDescription,
        amount: sealing ? 0 : Number(amount),
        finalize: sealing ? true : finalize,
        first_issuance: firstIssuance,
        target_height: chain.data.tip_height + 1,
      });

      unrelayed = {
        tx_hex: built.tx_hex,
        txid: built.txid,
        asset_id: built.asset_id,
        description: chainDescription,
      };
      if (holdRelay) {
        setSigned({ tx: unrelayed, relayFailed: false });
        return;
      }

      // 4. Hand the signed bytes to the relay. A 429 here is the relay
      //    saying "queue" - the per-client in-flight cap or the rate limit
      //    answered before anything was submitted - so waiting and
      //    retrying is safe and is exactly what a room full of people
      //    behind one NAT needs. Bounded: the proof is not thrown away for
      //    a busy minute, but nobody waits forever. A spent minute budget
      //    is the one 429 that will not clear in seconds: say so instead
      //    of spinning.
      setPhase(4);
      setStage("Relaying the signed transaction…");
      let relayed = await api.POST("/api/v1/relay", { body: { tx_hex: built.tx_hex } });
      const budgetSpent = () =>
        relayed.response.status === 429 &&
        String((relayed.error as { type?: string } | undefined)?.type ?? "").endsWith(
          "/relay-budget-spent",
        );
      for (
        let attempt = 1;
        relayed.response.status === 429 && !budgetSpent() && attempt <= 8;
        attempt += 1
      ) {
        setStage(`Relay busy, waiting for a slot (attempt ${attempt} of 8)…`);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        relayed = await api.POST("/api/v1/relay", { body: { tx_hex: built.tx_hex } });
      }
      if (relayed.error) throw new Error(problemMessage(relayed.error));
      unrelayed = null;

      // 5. Teach the registry the description we minted under — accepted
      //    only because it hashes to the on-chain commitment. This is NOT
      //    cosmetic: the registry keeps a sealed bundle only while a
      //    resolved description references it, so a lost call here means
      //    the description and image are swept within the hour. Retry, and
      //    if it still fails, hand the user the exact bytes to re-resolve
      //    with (anyone can, permissionlessly, from the asset page).
      // A seal adds no description: the asset already has its own.
      let resolved = sealing !== null;
      if (!resolved) {
        setPhase(5);
        setStage("Registering the sealed metadata…");
      }
      for (let attempt = 1; attempt <= 4 && !resolved; attempt += 1) {
        const registered = await api
          .POST("/api/v1/assets/{asset_id}/description", {
            params: { path: { asset_id: built.asset_id } },
            body: { description: chainDescription },
          })
          .catch(() => ({ error: { detail: "network error" } }) as const);
        resolved = !("error" in registered && registered.error);
        if (!resolved && attempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 700 * attempt));
        }
      }
      if (!resolved) {
        setError(
          `Minted, but the registry did not record the metadata. Re-register it from the ` +
            `asset page with this exact description, or the sealed description and image are ` +
            `dropped within the hour: ${chainDescription}`,
        );
      }

      // The txid we show is the one computed locally from the bytes we
      // signed — not the server's word. If the relay reports a different
      // one, surface it rather than trusting the response.
      if (relayed.data.txid !== built.txid) {
        setError(
          `Relay reported a different txid (${relayed.data.txid}) than the one your browser computed. Showing yours.`,
        );
      }
      setReceipt({
        txid: built.txid,
        asset_id: built.asset_id,
        reissue: !firstIssuance,
        sealed: sealing !== null,
      });
      setMintCount((count) => count + 1);
    } catch (mintError) {
      const message = mintError instanceof Error ? mintError.message : String(mintError);
      if (unrelayed) {
        setSigned({ tx: unrelayed, relayFailed: true });
        setError(
          `${message} Your transaction is signed and shown below: another instance's relay can land it.`,
        );
      } else {
        setError(message);
      }
    } finally {
      setStage(null);
      setPhase(0);
    }
  };

  const canMint =
    issuer !== null &&
    seedSaved &&
    name.trim() !== "" &&
    (sealing !== null || Number(amount) > 0) &&
    !stage &&
    !paused &&
    (!locked || remintId === locked.assetId);

  return (
    <div className="flex flex-col gap-8">
      {/* Site width: the statement stays on the left, the steps run down the right. */}
      <div className="grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-12">
        <div className="rise lg:sticky lg:top-8 lg:self-start">
          <h1 className="font-display text-4xl font-medium leading-[1.08] text-neutral-50 sm:text-5xl">
            Mint under your own identity.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-neutral-300">
            The seed and the keys never leave this page, and the zero-knowledge proof is computed in
            it. The server only relays signed bytes, and even that is optional.
          </p>
          <ul className="mt-7 flex max-w-md flex-col gap-4">
            {[
              ["Keys born in this page", "generated and held in memory, never sent"],
              ["Proof computed locally", "in a worker, on your own processor"],
              ["The server never signs", "it forwards finished bytes, or you keep them"],
            ].map(([fact, detail]) => (
              <li key={fact}>
                <span className="block text-base font-medium text-neutral-100">{fact}</span>
                <span className="font-data block text-[13px] text-neutral-500">{detail}</span>
              </li>
            ))}
          </ul>
          {/* Said where the decision is made, not only in the terms. */}
          <div
            data-testid="mint-testnet-notice"
            className="mt-6 max-w-md rounded-[3px] border border-accent/40 px-4 py-3.5"
          >
            <p className="text-base font-medium text-accent">A test network, and not ours</p>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-300">
              QEDIT, the team building ZSAs, runs this chain, not Cachet. They can reset it at any
              time, and a reset erases every asset and every balance: it has happened more than
              once. Nothing here has value. Your sealed name, text and image are kept by this
              registry: minted again unchanged, with the same seed, they give the same asset id.
            </p>
            <Link
              href="/continuity"
              className="mt-2.5 inline-block text-sm text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent"
            >
              What survives, and what does not
            </Link>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {/* Step 1: identity */}
          <SeedCard
            title="1 · Issuer identity"
            savedNote="It IS the issuer identity: lose it and nobody can ever mint under this identity again."
            busy={!!stage}
            className="rise rise-2"
          />

          {/* Step 2: the asset */}
          <section className={`${card} rise rise-3`}>
            <h2 className={`${cardTitle} mb-3`}>2 · The asset</h2>
            {remintError && (
              <p data-testid="remint-error" className="mb-3 text-sm text-red-400">
                {remintError}
              </p>
            )}
            {remint && (
              <div
                data-testid="remint-notice"
                className="mb-4 rounded-[3px] border border-accent/40 px-4 py-3.5"
              >
                <p className="text-base font-medium text-accent">Minting a kept asset again</p>
                <p className="mt-1.5 text-sm leading-relaxed text-neutral-300">
                  Name, text and image are the sealed ones, checked against their hash in this page,
                  and locked: change any of them and it is another asset. The amount and the seal on
                  the supply are yours to choose again. Go on only if you recognise this content as
                  yours: an asset id matching your seed does not say who wrote it.
                </p>
                {remint.externalUrl && (
                  <p className="mt-2.5 text-sm leading-relaxed text-neutral-300">
                    It also seals this link, shown as text:{" "}
                    <span
                      data-testid="remint-link"
                      className="font-data break-all text-neutral-200"
                    >
                      {remint.externalUrl}
                    </span>
                  </p>
                )}
                <p
                  data-testid="remint-match"
                  className="font-data mt-2.5 break-all text-[13px] leading-relaxed text-neutral-400"
                >
                  {!issuer
                    ? `Enter the seed that minted ${remint.assetId.slice(0, 12)}… above.`
                    : remintId === null
                      ? "Deriving the asset id…"
                      : remintId === remint.assetId
                        ? `Same asset id with this seed: ${remint.assetId}`
                        : `Not the seed that minted it. It would give ${remintId.slice(0, 12)}…, not ${remint.assetId.slice(0, 12)}….`}
                </p>
                <a
                  href="/mint"
                  className="mt-2.5 inline-block text-sm text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent"
                >
                  Mint a new asset instead
                </a>
              </div>
            )}
            {sealing && (
              <div
                data-testid="seal-notice"
                className="mb-4 rounded-[3px] border border-accent/40 px-4 py-3.5"
              >
                <p className="text-base font-medium text-accent">Sealing the supply</p>
                <p className="mt-1.5 text-sm leading-relaxed text-neutral-300">
                  One issuance with no new units and the seal set: the chain then refuses any more
                  of this asset, from anyone, you included. Only the seed that issued it can sign
                  it. This cannot be undone.
                </p>
                <p
                  data-testid="seal-match"
                  className="font-data mt-2.5 break-all text-[13px] leading-relaxed text-neutral-400"
                >
                  {!issuer
                    ? `Enter the seed that issued ${sealing.assetId.slice(0, 12)}… above.`
                    : remintId === null
                      ? "Deriving the asset id…"
                      : remintId === sealing.assetId
                        ? `This seed issued it: ${sealing.assetId}`
                        : "Not the seed that issued this asset."}
                </p>
              </div>
            )}
            <div className="flex flex-col gap-3.5">
              <div className="flex flex-col gap-1.5">
                <label className={label} htmlFor="mint-name">
                  Name{" "}
                  <span className="text-neutral-600">· immutable, sealed into the asset id</span>
                </label>
                <input
                  id="mint-name"
                  data-testid="mint-name"
                  className={input}
                  value={name}
                  readOnly={locked !== null}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                  placeholder="My first shielded asset"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className={label} htmlFor="mint-description">
                  Description{" "}
                  <span className="text-neutral-600">· optional, sealed with the asset</span>
                </label>
                <textarea
                  id="mint-description"
                  data-testid="mint-description"
                  className={`${input} min-h-[72px] resize-y font-sans`}
                  value={description}
                  readOnly={locked !== null}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={4096}
                  placeholder="What this asset represents, its terms…"
                />
              </div>
              {locked ? (
                // The sealed bytes, never re-encoded: a picker would let a
                // browser rewrite them and the id would change.
                imageDataUri &&
                safeImageDataUri(imageDataUri) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={safeImageDataUri(imageDataUri)!}
                    alt=""
                    data-testid="remint-image"
                    className="h-28 w-28 border border-line-strong bg-ground object-cover"
                  />
                )
              ) : (
                <ImagePicker value={imageDataUri} onChange={setImageDataUri} />
              )}
              {sealing ? (
                <p className="font-data text-sm text-neutral-400">
                  Amount 0: no new units, only the seal.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <label className={label} htmlFor="mint-amount">
                    Amount
                  </label>
                  <input
                    id="mint-amount"
                    data-testid="mint-amount"
                    className={input}
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    type="number"
                    min={1}
                  />
                </div>
              )}
              <button
                type="button"
                role="switch"
                aria-checked={finalize}
                disabled={sealing !== null}
                onClick={() => setFinalize(!finalize)}
                className={
                  finalize
                    ? "flex w-full items-center gap-3 rounded-md border border-accent/60 bg-accent/[0.07] px-3.5 py-2.5 text-left transition"
                    : "flex w-full items-center gap-3 rounded-md border border-dashed border-white/15 px-3.5 py-2.5 text-left transition hover:border-white/30"
                }
              >
                {/* The switch itself — so the row reads as a toggle at a glance. */}
                <span
                  aria-hidden
                  className={
                    finalize
                      ? "relative h-5 w-9 shrink-0 rounded-full border border-accent/70 bg-accent/25 transition-colors"
                      : "relative h-5 w-9 shrink-0 rounded-full border border-white/25 bg-black/40 transition-colors"
                  }
                >
                  <span
                    className={
                      finalize
                        ? "absolute left-[17px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-accent transition-all"
                        : "absolute left-[2px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-neutral-400 transition-all"
                    }
                  />
                </span>
                <span className="min-w-0">
                  <span
                    className={
                      finalize
                        ? "font-data block text-sm text-accent"
                        : "font-data block text-sm text-neutral-300"
                    }
                  >
                    {finalize ? "Seal at mint" : "Reissuable"}
                  </span>
                  <span className="block text-[13px] leading-snug text-neutral-500">
                    {finalize
                      ? "last issuance ever: the chain will refuse further units, even from you"
                      : "you can mint more of this asset later; click to seal the supply instead"}
                  </span>
                </span>
              </button>
            </div>
          </section>

          {/* Step 3: go */}
          <section className={`${card} rise rise-4`}>
            <h2 className={`${cardTitle} mb-3`}>3 · Prove &amp; relay</h2>
            {paused && (
              <p
                data-testid="mint-paused"
                className="mb-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent"
              >
                Minting through this instance is paused by its operator. Your keys and this page
                keep working, and the button comes back the moment it is lifted.
              </p>
            )}
            {/* Asked before the button: the answer changes what it does. */}
            <div role="radiogroup" aria-label="After signing" className="mb-4">
              <p className="mb-2 text-sm font-medium text-neutral-300">After signing</p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {[
                  {
                    hold: false,
                    testId: "mint-relay-here",
                    title: "Relay it here",
                    text: "One step. This instance places the transaction in a block; it never sees your keys.",
                  },
                  {
                    hold: true,
                    testId: "mint-hold-relay",
                    title: "Hand it to me",
                    text: "Keep the signed bytes and land them through another instance or your own tooling.",
                  },
                ].map((option) => {
                  const selected = holdRelay === option.hold;
                  return (
                    <button
                      key={option.testId}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={option.testId}
                      disabled={Boolean(stage)}
                      onClick={() => setHoldRelay(option.hold)}
                      className={
                        selected
                          ? "flex items-start gap-3 rounded-[3px] border border-accent/60 bg-accent/[0.07] px-3.5 py-3 text-left transition"
                          : "flex items-start gap-3 rounded-[3px] border border-line px-3.5 py-3 text-left transition hover:border-line-strong disabled:opacity-50"
                      }
                    >
                      <span
                        aria-hidden
                        className={
                          selected
                            ? "mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-accent"
                            : "mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-neutral-600"
                        }
                      >
                        {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={
                            selected
                              ? "block text-base font-medium text-accent"
                              : "block text-base font-medium text-neutral-200"
                          }
                        >
                          {option.title}
                        </span>
                        <span className="mt-0.5 block text-sm leading-snug text-neutral-400">
                          {option.text}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                data-testid="mint-submit"
                className={primaryButton}
                onClick={mint}
                disabled={!canMint}
              >
                {sealing
                  ? holdRelay
                    ? "Sign the seal in my browser"
                    : "Seal the supply"
                  : holdRelay
                    ? "Prove & sign in my browser"
                    : "Mint in my browser"}
              </button>
            </div>
            {stage && <MintGauge phase={phase} steps={holdRelay ? 3 : 5} message={stage} />}
            {engineReady && !stage && (
              <p className="font-data mt-3 text-[13px] text-neutral-500">
                engine ready · {engineThreads} {engineThreads > 1 ? "threads" : "thread"}
                {provingReady && (
                  <>
                    {" "}
                    · <span className="text-accent">proving key warm</span>
                  </>
                )}
              </p>
            )}
            {receipt && (
              <div className="mt-4 rounded-md border border-emerald-400/25 p-3.5 text-[13px]">
                <p className="flex flex-wrap items-center gap-2">
                  <span className={stamp}>
                    {receipt.sealed
                      ? "supply sealed under your key"
                      : receipt.reissue
                        ? "reissued under your key"
                        : "minted under your key"}
                  </span>
                  <span className="text-neutral-400">
                    {receipt.sealed
                      ? "no new units; once in a block, the chain refuses any more"
                      : receipt.reissue
                        ? "supply added to an asset this metadata already names"
                        : "proof built on your machine, relayed as-is"}
                  </span>
                </p>
                {/* Labels in a fixed column, so a wrapping id never breaks them. */}
                <dl className="font-data mt-2 grid grid-cols-[3rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-neutral-400">
                  <dt>txid</dt>
                  <dd className="break-all text-emerald-300">{receipt.txid}</dd>
                  <dt>asset</dt>
                  <dd className="flex items-start gap-2">
                    <Link
                      data-testid="mint-receipt-asset"
                      className="min-w-0 break-all text-accent underline decoration-accent/30"
                      href={`/assets/${receipt.asset_id}`}
                    >
                      {receipt.asset_id}
                    </Link>
                    <CopyButton value={receipt.asset_id} />
                  </dd>
                </dl>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Link
                    data-testid="mint-receipt-view"
                    className={`${primaryButton} !px-5 !py-2.5 !text-sm`}
                    href={`/assets/${receipt.asset_id}?just=minted`}
                  >
                    View my asset
                  </Link>
                  <span className="text-[13px] text-neutral-500">
                    it appears once the next block lands, usually within a minute
                  </span>
                </div>
              </div>
            )}
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
            {signed && <SignedTransaction tx={signed.tx} relayFailed={signed.relayFailed} />}
          </section>

          {/* Exit rights, where the sceptic looks for them: after the machinery. */}
          <p className="rise rise-5 px-1 text-[13px] leading-relaxed text-neutral-500">
            Don&apos;t trust us. The code is open (MIT) and you can run it yourself. With &quot;Hand
            it to me&quot;, the signed transaction is yours to land through any other instance.
          </p>
        </div>
      </div>

      {/* The browser wallet: scan, transfer, burn — same worker, same keys-never-leave rule. */}
      <HoldingsPanel
        call={call}
        seed={seed}
        enabled={issuer !== null && seedSaved}
        engineThreads={engineThreads}
        provingReady={provingReady}
        mintCount={mintCount}
      />

      {/* Swaps have their own page; the seed above carries over to it. */}
      <p className="px-1 text-sm leading-relaxed text-neutral-400">
        Trade what you hold for another asset, in one shielded transaction:{" "}
        <Link
          href="/swaps"
          className="text-accent underline decoration-accent/30 underline-offset-4"
        >
          open the swap board
        </Link>
        . This seed goes with you.
      </p>
    </div>
  );
}
