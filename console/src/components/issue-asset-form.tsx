"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, problemMessage } from "@/lib/api";
import { ImagePicker } from "@/components/image-picker";
import { card, cardTitle, input, label, primaryButton } from "@/lib/ui";

export function IssueAssetForm() {
  const [name, setName] = useState("");
  const [longDescription, setLongDescription] = useState("");
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [finalize, setFinalize] = useState(false);
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<string | null>(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);

  const issue = useMutation({
    mutationFn: async () => {
      // 1. Register the metadata bundle; its hash becomes part of the
      //    immutable on-chain description.
      setStage("Sealing metadata…");
      const meta = await api.POST("/api/v1/metadata", {
        body: {
          name,
          description: longDescription || undefined,
          image_data_uri: imageDataUri ?? undefined,
        },
      });
      if (meta.error) throw new Error(problemMessage(meta.error));

      // 2. Issue under the composed description.
      setStage("Building proofs & mining the block… (~30–60s)");
      const issued = await api.POST("/api/v1/assets", {
        body: {
          description: meta.data.chain_description,
          amount: Number(amount),
          finalize,
        },
      });
      if (issued.error) throw new Error(problemMessage(issued.error));
      return issued.data;
    },
    onSettled: () => setStage(null),
    onSuccess: () => {
      setConfirmFinalize(false);
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      queryClient.invalidateQueries({ queryKey: ["chain"] });
    },
  });

  return (
    <section className={card}>
      <h2 className={`${cardTitle} mb-4`}>Mint an asset</h2>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          // Finalization is irreversible: ask for a second click.
          if (finalize && !confirmFinalize) {
            setConfirmFinalize(true);
            return;
          }
          issue.mutate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label className={label} htmlFor="issue-name">
            Name <span className="text-neutral-600">· immutable, sealed into the asset id</span>
          </label>
          <input
            id="issue-name"
            data-testid="issue-name"
            className={input}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            required
            placeholder="Zcon Ticket 2027"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className={label} htmlFor="issue-long-description">
            Description <span className="text-neutral-600">· optional, stored in the registry</span>
          </label>
          <textarea
            id="issue-long-description"
            data-testid="issue-long-description"
            className={`${input} min-h-[72px] resize-y font-sans`}
            value={longDescription}
            onChange={(event) => setLongDescription(event.target.value)}
            maxLength={4096}
            placeholder="What this asset represents, terms, links…"
          />
        </div>
        <ImagePicker value={imageDataUri} onChange={setImageDataUri} />
        <div className="flex flex-col gap-1.5">
          <label className={label} htmlFor="issue-amount">
            Amount
          </label>
          <input
            id="issue-amount"
            data-testid="issue-amount"
            className={input}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            type="number"
            min={1}
            required
            placeholder="1000"
          />
        </div>

        {/* Finalization: a real choice, not a checkbox. The chain enforces
            whichever state is stamped here. */}
        <button
          type="button"
          role="switch"
          aria-checked={finalize}
          onClick={() => {
            setFinalize(!finalize);
            setConfirmFinalize(false);
          }}
          className={
            finalize
              ? "flex w-full items-center gap-3 rounded-md border border-[#e8b23a]/60 bg-[#e8b23a]/[0.07] px-3.5 py-2.5 text-left transition"
              : "flex w-full items-center gap-3 rounded-md border border-dashed border-white/15 px-3.5 py-2.5 text-left transition hover:border-white/30"
          }
        >
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden className="shrink-0">
            <circle
              cx="16"
              cy="16"
              r="13"
              fill="none"
              stroke={finalize ? "#e8b23a" : "rgba(255,255,255,0.25)"}
              strokeWidth="1.4"
              strokeDasharray={finalize ? "none" : "2.4 2.4"}
            />
            {finalize && (
              <text
                x="16"
                y="21"
                textAnchor="middle"
                fontFamily="Georgia, serif"
                fontSize="13"
                fontWeight="700"
                fill="#e8b23a"
              >
                C
              </text>
            )}
          </svg>
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
        <div className="flex items-center gap-3">
          <button
            data-testid="issue-submit"
            className={`${primaryButton} self-start`}
            type="submit"
            disabled={issue.isPending}
          >
            {issue.isPending
              ? "Working…"
              : confirmFinalize
                ? "Confirm: mint & finalize forever?"
                : "Mint asset"}
          </button>
          {stage && (
            <span className="flex items-center gap-2 text-xs text-[#e8b23a]/90">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#e8b23a]" />
              {stage}
            </span>
          )}
        </div>
      </form>
      {issue.isSuccess && (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border border-emerald-400/25 p-3.5 text-xs">
          <dt className="text-neutral-400">Accepted, txid</dt>
          <dd className="font-data break-all text-emerald-300">{issue.data.txid}</dd>
          <dt className="text-neutral-400">Asset id</dt>
          <dd data-testid="issue-receipt-asset-id" className="font-data break-all text-[#e8b23a]">
            {issue.data.asset_id}
          </dd>
        </dl>
      )}
      {issue.isError && <p className="mt-3 text-sm text-red-400">{issue.error.message}</p>}
    </section>
  );
}
