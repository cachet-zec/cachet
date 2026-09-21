import type { Metadata } from "next";

import { IssuerAssets } from "@/components/issuer-assets";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ issuer: string }>;
}): Promise<Metadata> {
  const { issuer } = await params;
  return pageMetadata({
    title: `Issuer ${issuer.slice(0, 10)}… · Cachet`,
    description:
      "Every asset minted under one issuance key on the public ZSA testnet: the one provenance statement the chain itself makes.",
    path: /^[0-9a-f]{66}$/i.test(issuer) ? `/issuers/${issuer.toLowerCase()}` : "/issuers",
  });
}

export default async function IssuerPage({ params }: { params: Promise<{ issuer: string }> }) {
  const { issuer } = await params;
  return (
    <div className="rise">
      <IssuerAssets issuer={issuer} />
    </div>
  );
}
