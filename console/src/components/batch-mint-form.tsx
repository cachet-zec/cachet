"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, problemMessage } from "@/lib/api";
import { card, cardTitle, ghostButton, input, label, primaryButton } from "@/lib/ui";

const MAX_ITEMS = 16;

interface Row {
  name: string;
  amount: string;
  finalize: boolean;
}

const emptyRow = (): Row => ({ name: "", amount: "1", finalize: true });

/**
 * Mint several assets in ONE transaction: each item's name is sealed into
 * its own asset id, the whole batch shares one issuance bundle and one
 * txid. For rich metadata (image, long description), use the single mint
 * form — batch items carry a name-only bundle.
 */
export function BatchMintForm() {
  const [rows, setRows] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [stage, setStage] = useState<string | null>(null);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const queryClient = useQueryClient();

  const setRow = (index: number, patch: Partial<Row>) =>
    setRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const mint = useMutation({
    mutationFn: async () => {
      // 1. Seal each item's metadata; the bundle hash becomes part of the
      //    immutable on-chain description.
      setStage(`Sealing metadata (${rows.length} items)…`);
      const items = [];
      for (const row of rows) {
        const meta = await api.POST("/api/v1/metadata", { body: { name: row.name } });
        if (meta.error) throw new Error(problemMessage(meta.error));
        items.push({
          description: meta.data.chain_description,
          amount: Number(row.amount),
          finalize: row.finalize,
        });
      }
      // 2. One issuance bundle, one transaction, all-or-nothing.
      setStage("Building proofs & mining the block… (~30–60s)");
      const issued = await api.POST("/api/v1/assets/batch", { body: { items } });
      if (issued.error) throw new Error(problemMessage(issued.error));
      return issued.data;
    },
    onSettled: () => setStage(null),
    onSuccess: () => {
      setConfirmFinalize(false);
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      queryClient.invalidateQueries({ queryKey: ["collections"] });
      queryClient.invalidateQueries({ queryKey: ["chain"] });
    },
  });

  const anyFinalize = rows.some((row) => row.finalize);

  return (
    <section className={card}>
      <h2 className={`${cardTitle} mb-1`}>Batch mint</h2>
      <p className="mb-4 text-xs leading-relaxed text-neutral-500">
        Up to {MAX_ITEMS} assets in one transaction: one issuance bundle, one signature, all or
        nothing. Name-only metadata; use the single mint for images.
      </p>
      <form
        className="flex flex-col gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          // Finalization is irreversible: ask for a second click.
          if (anyFinalize && !confirmFinalize) {
            setConfirmFinalize(true);
            return;
          }
          mint.mutate();
        }}
      >
        <div className="hidden grid-cols-[1fr_90px_auto_auto] items-center gap-2.5 sm:grid">
          <span className={label}>Name</span>
          <span className={label}>Amount</span>
          <span className={label}>Seal</span>
          <span />
        </div>
        {rows.map((row, index) => (
          <div key={index} className="grid grid-cols-[1fr_90px_auto_auto] items-center gap-2.5">
            <input
              className={input}
              data-testid={`batch-name-${index}`}
              value={row.name}
              onChange={(event) => setRow(index, { name: event.target.value })}
              maxLength={120}
              required
              placeholder={`Edition #${index + 1}`}
            />
            <input
              className={input}
              value={row.amount}
              onChange={(event) => setRow(index, { amount: event.target.value })}
              type="number"
              min={1}
              required
            />
            <input
              type="checkbox"
              className="h-4 w-4 accent-[#e8b23a]"
              title="Finalize: supply becomes permanent"
              checked={row.finalize}
              onChange={(event) => setRow(index, { finalize: event.target.checked })}
            />
            <button
              type="button"
              className="px-1 text-neutral-600 transition hover:text-red-400 disabled:opacity-30"
              title="Remove item"
              onClick={() => setRows((rows) => rows.filter((_, i) => i !== index))}
              disabled={rows.length <= 1}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={`${ghostButton} px-3 py-1.5 text-xs`}
            onClick={() => setRows((rows) => [...rows, emptyRow()])}
            disabled={rows.length >= MAX_ITEMS}
          >
            + Add item
          </button>
          <button
            data-testid="batch-submit"
            className={primaryButton}
            type="submit"
            disabled={mint.isPending}
          >
            {mint.isPending
              ? "Working…"
              : confirmFinalize
                ? "Confirm: mint & finalize forever?"
                : `Mint ${rows.length} asset${rows.length > 1 ? "s" : ""}`}
          </button>
          {stage && (
            <span className="flex items-center gap-2 text-xs text-[#e8b23a]/90">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#e8b23a]" />
              {stage}
            </span>
          )}
        </div>
      </form>
      {mint.isSuccess && (
        <div className="mt-4 rounded-md border border-emerald-400/25 p-3.5 text-xs">
          <p className="text-neutral-400">
            One transaction, {mint.data.asset_ids.length} assets. Txid{" "}
            <span className="font-data break-all text-emerald-300">{mint.data.txid}</span>
          </p>
          <ul className="mt-2 flex flex-col gap-1">
            {mint.data.asset_ids.map((assetId) => (
              <li key={assetId} className="font-data break-all text-[#e8b23a]">
                {assetId}
              </li>
            ))}
          </ul>
        </div>
      )}
      {mint.isError && <p className="mt-3 text-sm text-red-400">{mint.error.message}</p>}
    </section>
  );
}
