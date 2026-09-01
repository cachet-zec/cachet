import type { Metadata } from "next";

import { AssetList } from "@/components/asset-list";
import { ChainStatus } from "@/components/chain-status";
import { ConsoleTabs } from "@/components/console-tabs";
import { Onboarding } from "@/components/onboarding";
import { WalletPanel } from "@/components/wallet-panel";

export const metadata: Metadata = {
  title: "Console · Cachet",
  description: "Mint shielded assets, browse the registry, verify metadata.",
};

export default function ConsolePage() {
  return (
    <div className="rise flex flex-col gap-5">
      <ChainStatus />
      <Onboarding />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <ConsoleTabs />
          <WalletPanel />
        </div>
        <div className="min-w-0">
          <AssetList />
        </div>
      </div>
    </div>
  );
}
