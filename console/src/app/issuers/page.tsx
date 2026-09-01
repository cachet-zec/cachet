import type { Metadata } from "next";

import { CollectionsList } from "@/components/collections-list";

export const metadata: Metadata = {
  title: "Issuers · Cachet",
  description:
    "Every issuance key observed on the chain, with its assets, sealed counts and circulating supplies. Exact public chain data.",
};

export default function IssuersPage() {
  return (
    <div className="rise">
      <CollectionsList />
    </div>
  );
}
