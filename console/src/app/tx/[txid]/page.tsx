import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TxDetail } from "@/components/tx-detail";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ txid: string }>;
}): Promise<Metadata> {
  const { txid } = await params;
  return pageMetadata({
    title: `Transaction ${txid.slice(0, 8)}… · Cachet`,
    description:
      "What this transaction published about Zcash Shielded Assets: issuance, seals and burns, decoded from its bytes.",
    path: `/tx/${txid.toLowerCase()}`,
  });
}

export default async function TxPage({ params }: { params: Promise<{ txid: string }> }) {
  const { txid } = await params;
  if (!/^[0-9a-f]{64}$/i.test(txid)) notFound();
  return (
    <div className="rise">
      <TxDetail txid={txid.toLowerCase()} />
    </div>
  );
}
