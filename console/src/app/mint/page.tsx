import type { Metadata } from "next";

import { MintStudio } from "@/components/mint-studio";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Browser mint · Cachet",
  description:
    "Mint a Zcash Shielded Asset with keys that never leave your browser. The proof is built on your machine; the server only relays the signed bytes.",
  path: "/mint",
});

export default function MintPage() {
  return <MintStudio />;
}
