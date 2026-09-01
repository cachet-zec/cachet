import type { Metadata } from "next";

import { IssuerAssets } from "@/components/issuer-assets";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ issuer: string }>;
}): Promise<Metadata> {
  const { issuer } = await params;
  return { title: `Issuer ${issuer.slice(0, 10)}… · Cachet` };
}

export default async function IssuerPage({ params }: { params: Promise<{ issuer: string }> }) {
  const { issuer } = await params;
  return (
    <div className="rise">
      <IssuerAssets issuer={issuer} />
    </div>
  );
}
