"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { AssetLookup } from "@/components/asset-lookup";
import { BatchMintForm } from "@/components/batch-mint-form";
import { IssueAssetForm } from "@/components/issue-asset-form";
import { ManageAsset } from "@/components/manage-asset";
import { api } from "@/lib/api";
import { card } from "@/lib/ui";

type Tab = "mint" | "batch" | "manage" | "lookup";

const TABS: { id: Tab; label: string }[] = [
  { id: "mint", label: "Mint" },
  { id: "batch", label: "Batch" },
  { id: "manage", label: "Transfer / Burn" },
  { id: "lookup", label: "Look up" },
];

/**
 * One action at a time: the console's forms live behind tabs so the page
 * reads as a workspace, not a wall of inputs. Read-only deployments show
 * only the browsing actions.
 */
export function ConsoleTabs() {
  const [tab, setTab] = useState<Tab>("mint");
  const chain = useQuery({
    queryKey: ["chain"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/chain");
      if (error) throw new Error(error.detail);
      return data;
    },
  });

  if (chain.data?.read_only) {
    return (
      <>
        <section className={card}>
          <p className="text-sm leading-relaxed text-neutral-400">
            This is a <span className="text-neutral-200">read-only</span> deployment: this instance
            holds no keys and signs nothing. You can still mint,{" "}
            <a href="/mint" className="text-[#e8b23a] underline decoration-[#e8b23a]/30">
              in your own browser
            </a>
            , under your own identity; the server only relays what you sign.
          </p>
        </section>
        <AssetLookup />
      </>
    );
  }

  return (
    <div>
      <div
        role="tablist"
        className="flex flex-wrap gap-x-5 gap-y-1 border-b border-white/[0.08] px-1"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-testid={`tab-${id}`}
            aria-selected={tab === id}
            className={
              tab === id
                ? "font-data -mb-px border-b-2 border-[#e8b23a] pb-2 text-[13px] text-[#e8b23a]"
                : "font-data -mb-px border-b-2 border-transparent pb-2 text-[13px] text-neutral-400 transition hover:text-neutral-200"
            }
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {tab === "mint" && <IssueAssetForm />}
        {tab === "batch" && <BatchMintForm />}
        {tab === "manage" && <ManageAsset />}
        {tab === "lookup" && <AssetLookup />}
      </div>
    </div>
  );
}
