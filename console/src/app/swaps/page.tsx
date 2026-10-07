import type { Metadata } from "next";

import { SwapBoard } from "@/components/swap-board";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Swaps · Cachet",
  description:
    "Open offers to trade Zcash Shielded Assets, one shielded transaction per trade, built and signed in each person's browser. Testnet only.",
  path: "/swaps",
});

export default function SwapsPage() {
  return (
    <div className="rise">
      <SwapBoard />
    </div>
  );
}
