"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api, problemMessage } from "@/lib/api";
import { card, cardTitle, dangerButton, input, label, primaryButton } from "@/lib/ui";

export function ManageAsset() {
  const [assetId, setAssetId] = useState("");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("account:1");
  const [confirmBurn, setConfirmBurn] = useState(false);

  const transfer = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/v1/assets/{asset_id}/transfers", {
        params: { path: { asset_id: assetId.trim() } },
        body: { amount: Number(amount), recipient },
      });
      if (error) throw new Error(problemMessage(error));
      return data;
    },
  });

  const burn = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/v1/assets/{asset_id}/burns", {
        params: { path: { asset_id: assetId.trim() } },
        body: { amount: Number(amount) },
      });
      if (error) throw new Error(problemMessage(error));
      return data;
    },
  });

  const pending = transfer.isPending || burn.isPending;
  const result = transfer.isSuccess
    ? { label: "Transfer", txid: transfer.data.txid }
    : burn.isSuccess
      ? { label: "Burn", txid: burn.data.txid }
      : null;
  const error = transfer.error ?? burn.error;

  return (
    <section className={card}>
      <h2 className={`${cardTitle} mb-4`}>Transfer / burn</h2>
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <label className={label} htmlFor="manage-asset-id">
            Asset id
          </label>
          <input
            id="manage-asset-id"
            data-testid="manage-asset-id"
            className={input}
            value={assetId}
            onChange={(event) => setAssetId(event.target.value)}
            placeholder="asset id (64 hex chars)"
          />
        </div>
        <div className="flex gap-3.5">
          <div className="flex flex-1 flex-col gap-1.5">
            <label className={label} htmlFor="manage-amount">
              Amount
            </label>
            <input
              id="manage-amount"
              data-testid="manage-amount"
              className={input}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              type="number"
              min={1}
              placeholder="100"
            />
          </div>
          <div className="flex flex-[2] flex-col gap-1.5">
            <label className={label} htmlFor="manage-recipient">
              Recipient <span className="text-neutral-600">· transfers only</span>
            </label>
            <input
              id="manage-recipient"
              data-testid="manage-recipient"
              className={input}
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="account:1 or unified address"
            />
          </div>
        </div>
        <div className="flex gap-2.5">
          <button
            data-testid="transfer-submit"
            className={primaryButton}
            disabled={pending || !assetId || !amount}
            onClick={() => {
              burn.reset();
              transfer.mutate();
            }}
          >
            {transfer.isPending ? "Transferring…" : "Transfer"}
          </button>
          <button
            data-testid="burn-submit"
            className={dangerButton}
            disabled={pending || !assetId || !amount}
            onClick={() => {
              // Burning destroys units permanently: two-click confirm.
              if (!confirmBurn) {
                setConfirmBurn(true);
                setTimeout(() => setConfirmBurn(false), 4000);
                return;
              }
              setConfirmBurn(false);
              transfer.reset();
              burn.mutate();
            }}
          >
            {burn.isPending ? "Burning…" : confirmBurn ? "Confirm: destroy units?" : "Burn"}
          </button>
        </div>
      </div>
      {result && (
        <p
          data-testid="manage-result"
          className="font-data mt-4 break-all rounded-md border border-emerald-400/25 p-3.5 text-xs text-emerald-300"
        >
          {result.label} accepted. Txid {result.txid}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-red-400">{error.message}</p>}
    </section>
  );
}
