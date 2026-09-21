import type { Metadata } from "next";

import { CollectionsList } from "@/components/collections-list";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Issuers · Cachet",
  description:
    "Every issuance key observed on the chain, with its assets, sealed counts and circulating supplies. Exact public chain data.",
  path: "/issuers",
});

export default function IssuersPage() {
  return (
    <div className="rise">
      <CollectionsList />
    </div>
  );
}
