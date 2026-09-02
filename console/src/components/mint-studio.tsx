"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { HoldingsPanel } from "@/components/holdings-panel";
import { ImagePicker } from "@/components/image-picker";
import { api, problemMessage } from "@/lib/api";
import { card, cardTitle, ghostButton, input, label, primaryButton, stamp } from "@/lib/ui";

/**
 * The browser mint studio: keys are generated and held in this page's
 * memory only, the Halo2 proof is computed in a Web Worker on the user's
 * machine, and the server merely relays the signed transaction. Works on
 * read-only deployments by design — the instance signs nothing.
 */
export function MintStudio() {
  const workerRef = useRef<Worker | null>(null);
  const nextId = useRef(0);

  const [seed, setSeed] = useState("");
  // Masked by default: a phrase on screen is on every screenshot and
  // stream. Copy works while masked, so revealing is never required.
  const [seedRevealed, setSeedRevealed] = useState(false);
  const [seedSaved, setSeedSaved] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [issuer, setIssuer] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [amount, setAmount] = useState("1");
  const [finalize, setFinalize] = useState(true);

  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    txid: string;
    asset_id: string;
    reissue: boolean;
  } | null>(null);
  const [mintCount, setMintCount] = useState(0);

  const call = useCallback(<T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (!workerRef.current) {
      workerRef.current = new Worker("/mint-worker.js", { type: "module" });
    }
    const worker = workerRef.current;
    const id = nextId.current++;
    return new Promise<T>((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        worker.removeEventListener("message", onMessage);
        if (event.data.ok) resolve(event.data.result as T);
        else reject(new Error(event.data.error));
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ id, cmd, args });
    });
  }, []);

  const [engineThreads, setEngineThreads] = useState(1);
  const [engineReady, setEngineReady] = useState(false);
  const [provingReady, setProvingReady] = useState(false);
  const provingWarmed = useRef(false);

  // Warm up on mount: spawn the worker and let the browser download and
  // compile the wasm engine while the visitor reads the page. On
  // cross-origin-isolated pages the worker picks the threaded build;
  // remember the pool size so progress copy can be honest about speed.
  useEffect(() => {
    call<{ threads: number }>("engine_info")
      .then((info) => {
        setEngineThreads(info.threads);
        setEngineReady(true);
      })
      .catch(() => {});
    return () => workerRef.current?.terminate();
  }, [call]);

  const generateSeed = async () => {
    setError(null);
    const { seed } = await call<{ seed: string }>("generate_seed");
    setSeed(seed);
    setSeedSaved(false);
    setSeedRevealed(false);
  };

  // The moment the user has confirmed the seed is saved, start building
  // the proving key in the worker: it takes seconds, is seed-independent,
  // and the user is about to spend those seconds typing a name anyway.
  // Fired once per page; the vendored proving-key cache keeps it for
  // every mint of the session.
  useEffect(() => {
    if (!seedSaved || provingWarmed.current) return;
    provingWarmed.current = true;
    call("prepare_proving")
      .then(() => setProvingReady(true))
      .catch(() => {});
  }, [seedSaved, call]);

  // Derive the issuer identity whenever a plausible seed is present.
  useEffect(() => {
    const words = seed.trim().split(/\s+/).length;
    if (words !== 24 && words !== 12) {
      setIssuer(null);
      return;
    }
    let cancelled = false;
    call<{ issuer: string }>("issuer_info", { seed: seed.trim(), description: "probe" })
      .then((info) => !cancelled && setIssuer(info.issuer))
      .catch(() => !cancelled && setIssuer(null));
    return () => {
      cancelled = true;
    };
  }, [seed, call]);

  const mint = async () => {
    setError(null);
    setReceipt(null);
    try {
      const trimmedSeed = seed.trim();

      // 1. Seal the full bundle — name, optional description and image —
      //    into a metadata bundle; its hash goes into the on-chain
      //    description and thus the asset id itself.
      setStage("Sealing metadata…");
      const meta = await api.POST("/api/v1/metadata", {
        body: {
          name,
          description: description.trim() === "" ? undefined : description,
          image_data_uri: imageDataUri ?? undefined,
        },
      });
      if (meta.error) throw new Error(problemMessage(meta.error));
      const chainDescription = meta.data.chain_description;

      // 2. Public chain facts: target height, and whether this asset id
      //    already exists (reissue) or is brand new.
      setStage("Reading the chain…");
      const chain = await api.GET("/api/v1/chain");
      if (chain.error) throw new Error(problemMessage(chain.error));
      const info = await call<{ asset_id: string }>("issuer_info", {
        seed: trimmedSeed,
        description: chainDescription,
      });
      const existing = await api.GET("/api/v1/assets/{asset_id}", {
        params: { path: { asset_id: info.asset_id } },
      });
      if (existing.data?.finalized) {
        throw new Error("this asset is finalized: its supply is permanent");
      }
      const firstIssuance = !existing.data;
      if (!firstIssuance) {
        // Reissuing was silent, so a minter could inflate an existing
        // asset believing they had made a new one. Identical metadata
        // means the identical asset, by construction.
        setStage(
          `This metadata already names asset ${info.asset_id.slice(0, 8)}… — ` +
            `adding to its supply, not creating a new one.`,
        );
      }

      // 3. The heavy part, entirely on this machine.
      setStage(
        engineThreads > 1
          ? `Proving in your browser on ${engineThreads} threads… ${provingReady ? "about ten seconds" : "about 15 seconds"}, your keys never leave this page`
          : `Proving in your browser… ${provingReady ? "about half a minute" : "about a minute"}, your keys never leave this page`,
      );
      const built = await call<{ tx_hex: string; txid: string; asset_id: string }>("build", {
        seed: trimmedSeed,
        description: chainDescription,
        amount: Number(amount),
        finalize,
        first_issuance: firstIssuance,
        target_height: chain.data.tip_height + 1,
      });

      // 4. Hand the signed bytes to the relay. A 429 here is the relay
      //    saying "queue" - the per-client in-flight cap or the rate limit
      //    answered before anything was submitted - so waiting and
      //    retrying is safe and is exactly what a room full of people
      //    behind one NAT needs. Bounded: the proof is not thrown away for
      //    a busy minute, but nobody waits forever.
      setStage("Relaying the signed transaction…");
      let relayed = await api.POST("/api/v1/relay", { body: { tx_hex: built.tx_hex } });
      for (let attempt = 1; relayed.response.status === 429 && attempt <= 8; attempt += 1) {
        setStage(`Relay busy, waiting for a slot (attempt ${attempt} of 8)…`);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        relayed = await api.POST("/api/v1/relay", { body: { tx_hex: built.tx_hex } });
      }
      if (relayed.error) throw new Error(problemMessage(relayed.error));

      // 5. Teach the registry the description we minted under — accepted
      //    only because it hashes to the on-chain commitment. This is NOT
      //    cosmetic: the registry keeps a sealed bundle only while a
      //    resolved description references it, so a lost call here means
      //    the description and image are swept within the hour. Retry, and
      //    if it still fails, hand the user the exact bytes to re-resolve
      //    with (anyone can, permissionlessly, from the asset page).
      setStage("Registering the sealed metadata…");
      let resolved = false;
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
      setReceipt({ txid: built.txid, asset_id: built.asset_id, reissue: !firstIssuance });
      setMintCount((count) => count + 1);
    } catch (mintError) {
      setError(mintError instanceof Error ? mintError.message : String(mintError));
    } finally {
      setStage(null);
    }
  };

  const canMint =
    issuer !== null && seedSaved && name.trim() !== "" && Number(amount) > 0 && !stage;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div className="rise">
        <p className="font-data text-[11px] uppercase tracking-[0.24em] text-[#e8b23a]">
          Browser mint
        </p>
        <h1 className="font-display mt-2 text-3xl font-semibold tracking-tight text-neutral-50">
          Mint under your own identity.
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          The seed, the keys and the zero-knowledge proof never leave this page - the server only
          relays signed bytes.
        </p>
        <ul className="mt-4 flex flex-wrap gap-2">
          {["keys born in-page", "proof computed locally", "server relays, never signs"].map(
            (fact) => (
              <li
                key={fact}
                className="font-data rounded-sm border border-white/10 px-2.5 py-1 text-[11px] text-neutral-400"
              >
                {fact}
              </li>
            ),
          )}
        </ul>
      </div>

      {/* Step 1: identity */}
      <section className={`${card} rise rise-2`}>
        <h2 className={`${cardTitle} mb-3`}>1 · Issuer identity</h2>
        {/* Empty state: two clearly separate paths. */}
        {!seed && !pasteOpen && (
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className={ghostButton} onClick={generateSeed} disabled={!!stage}>
              Generate a new seed
            </button>
            <button
              type="button"
              className="text-xs text-neutral-500 underline decoration-white/20 underline-offset-2 transition hover:text-neutral-300"
              onClick={() => setPasteOpen(true)}
            >
              I already have one
            </button>
          </div>
        )}

        {/* Generated: the phrase is a credential being issued, not a form —
            a numbered, read-only word grid. */}
        {seed !== "" && !pasteOpen && (
          <>
            <ol
              data-testid="mint-seed-grid"
              className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-white/10 bg-black/30 p-3.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] sm:grid-cols-4"
            >
              {seed
                .trim()
                .split(/\s+/)
                .map((word, index) => (
                  <li
                    key={`${index}-${word}`}
                    className="font-data flex items-baseline gap-1.5 text-[13px] text-neutral-200"
                  >
                    <span className="w-4 shrink-0 text-right text-[10px] text-neutral-600">
                      {index + 1}
                    </span>
                    {/* Fixed-width mask: even word lengths stay private. */}
                    {seedRevealed ? word : <span className="text-neutral-500">••••••</span>}
                  </li>
                ))}
            </ol>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <CopyButton value={seed} label="Copy phrase" />
              <button
                type="button"
                data-testid="mint-seed-reveal"
                aria-pressed={seedRevealed}
                title="Copy works while hidden: the clipboard gets the real phrase either way."
                className="text-[11px] text-neutral-500 underline decoration-white/20 underline-offset-2 transition hover:text-neutral-300"
                onClick={() => setSeedRevealed(!seedRevealed)}
              >
                {seedRevealed ? "hide words" : "show words"}
              </button>
              <button
                type="button"
                className="text-[11px] text-neutral-500 underline decoration-white/20 underline-offset-2 transition hover:text-neutral-300"
                onClick={generateSeed}
                disabled={!!stage}
              >
                generate another
              </button>
              <button
                type="button"
                className="text-[11px] text-neutral-500 underline decoration-white/20 underline-offset-2 transition hover:text-neutral-300"
                onClick={() => {
                  setSeed("");
                  setSeedSaved(false);
                  setPasteOpen(true);
                }}
                disabled={!!stage}
              >
                use my own instead
              </button>
              <span className="font-data text-[10px] uppercase tracking-[0.16em] text-[#e8b23a]/70">
                testnet identity
              </span>
            </div>
          </>
        )}

        {/* Import: the one case where typing makes sense. */}
        {pasteOpen && (
          <>
            <textarea
              data-testid="mint-seed"
              className={`${input} min-h-20 resize-y`}
              value={seed}
              onChange={(event) => {
                setSeed(event.target.value);
                setSeedSaved(false);
              }}
              placeholder="24 words…"
              spellCheck={false}
              autoFocus
            />
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
              <p className="text-[11px] text-neutral-600">
                Testnet only - never paste a seed that guards real funds.
              </p>
              <button
                type="button"
                className="text-[11px] text-neutral-500 underline decoration-white/20 underline-offset-2 transition hover:text-neutral-300"
                onClick={() => {
                  setPasteOpen(false);
                  void generateSeed();
                }}
                disabled={!!stage}
              >
                generate a new one instead
              </button>
            </div>
          </>
        )}

        {seed && (issuer || !pasteOpen) && (
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-neutral-400">
            <input
              type="checkbox"
              data-testid="mint-seed-saved"
              className="mt-0.5 h-4 w-4 accent-[#e8b23a]"
              checked={seedSaved}
              onChange={(event) => setSeedSaved(event.target.checked)}
            />
            <span>
              I saved this phrase somewhere safe. It IS the issuer identity: lose it and nobody can
              ever mint under this identity again; this page keeps it in memory only and forgets it
              on reload.
            </span>
          </label>
        )}
        {issuer && (
          <p className="font-data mt-3 break-all text-xs text-neutral-500">
            issuer key <span className="text-neutral-300">{issuer}</span>
          </p>
        )}
        {pasteOpen && seed !== "" && !issuer && (
          <p className="mt-3 text-xs text-neutral-500">Enter a valid 24-word phrase.</p>
        )}
      </section>

      {/* Step 2: the asset */}
      <section className={`${card} rise rise-3`}>
        <h2 className={`${cardTitle} mb-3`}>2 · The asset</h2>
        <div className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <label className={label} htmlFor="mint-name">
              Name <span className="text-neutral-600">· immutable, sealed into the asset id</span>
            </label>
            <input
              id="mint-name"
              data-testid="mint-name"
              className={input}
              value={name}
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
              onChange={(event) => setDescription(event.target.value)}
              maxLength={4096}
              placeholder="What this asset represents, terms, links…"
            />
          </div>
          <ImagePicker value={imageDataUri} onChange={setImageDataUri} />
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
          <button
            type="button"
            role="switch"
            aria-checked={finalize}
            onClick={() => setFinalize(!finalize)}
            className={
              finalize
                ? "flex w-full items-center gap-3 rounded-md border border-[#e8b23a]/60 bg-[#e8b23a]/[0.07] px-3.5 py-2.5 text-left transition"
                : "flex w-full items-center gap-3 rounded-md border border-dashed border-white/15 px-3.5 py-2.5 text-left transition hover:border-white/30"
            }
          >
            {/* The switch itself — so the row reads as a toggle at a glance. */}
            <span
              aria-hidden
              className={
                finalize
                  ? "relative h-5 w-9 shrink-0 rounded-full border border-[#e8b23a]/70 bg-[#e8b23a]/25 transition-colors"
                  : "relative h-5 w-9 shrink-0 rounded-full border border-white/25 bg-black/40 transition-colors"
              }
            >
              <span
                className={
                  finalize
                    ? "absolute left-[17px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-[#e8b23a] transition-all"
                    : "absolute left-[2px] top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-neutral-400 transition-all"
                }
              />
            </span>
            <span className="min-w-0">
              <span
                className={
                  finalize
                    ? "font-data block text-[13px] text-[#e8b23a]"
                    : "font-data block text-[13px] text-neutral-300"
                }
              >
                {finalize ? "Seal at mint" : "Reissuable"}
              </span>
              <span className="block text-xs leading-snug text-neutral-500">
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
        <div className="flex flex-wrap items-center gap-3">
          <button
            data-testid="mint-submit"
            className={primaryButton}
            onClick={mint}
            disabled={!canMint}
          >
            Mint in my browser
          </button>
          {stage && (
            <span className="flex items-center gap-2 text-xs text-[#e8b23a]/90">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#e8b23a]" />
              {stage}
            </span>
          )}
        </div>
        {engineReady && !stage && (
          <p className="font-data mt-3 text-[11px] text-neutral-500">
            engine ready · {engineThreads} {engineThreads > 1 ? "threads" : "thread"}
            {provingReady && (
              <>
                {" "}
                · <span className="text-[#e8b23a]/80">proving key warm</span>
              </>
            )}
          </p>
        )}
        {receipt && (
          <div className="mt-4 rounded-md border border-emerald-400/25 p-3.5 text-xs">
            <p className="flex flex-wrap items-center gap-2">
              <span className={stamp}>
                {receipt.reissue ? "reissued under your key" : "minted under your key"}
              </span>
              <span className="text-neutral-400">
                {receipt.reissue
                  ? "supply added to an asset this metadata already names"
                  : "proof built on your machine, relayed as-is"}
              </span>
            </p>
            <p className="font-data mt-2 break-all text-neutral-400">
              txid <span className="text-emerald-300">{receipt.txid}</span>
            </p>
            <p className="font-data mt-1 flex items-center gap-2 break-all text-neutral-400">
              asset{" "}
              <Link
                data-testid="mint-receipt-asset"
                className="text-[#e8b23a] underline decoration-[#e8b23a]/30"
                href={`/assets/${receipt.asset_id}`}
              >
                {receipt.asset_id}
              </Link>
              <CopyButton value={receipt.asset_id} />
            </p>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </section>

      {/* Exit rights, where the sceptic looks for them: after the machinery. */}
      <p className="rise rise-5 px-1 text-xs leading-relaxed text-neutral-500">
        Don&apos;t trust us: the console is MIT-licensed and self-hostable, and the public node
        accepts transactions directly at{" "}
        <span className="font-data text-neutral-400">dev.zebra.zsa-test.net</span> - this instance
        is a convenience, not a chokepoint.
      </p>

      {/* The browser wallet: scan, transfer, burn — same worker, same keys-never-leave rule. */}
      <HoldingsPanel
        call={call}
        seed={seed}
        enabled={issuer !== null && seedSaved}
        engineThreads={engineThreads}
        provingReady={provingReady}
        mintCount={mintCount}
      />
    </div>
  );
}
