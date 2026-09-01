import Link from "next/link";

import { ghostButton } from "@/lib/ui";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-6 py-24 text-center">
      <p className="font-data text-[11px] uppercase tracking-[0.24em] text-neutral-500">
        404 · nothing at this address
      </p>
      <h1 className="font-display text-4xl font-semibold tracking-tight text-neutral-50">
        Not on this ledger
      </h1>
      <p className="max-w-md text-sm leading-relaxed text-neutral-400">
        The page you asked for doesn&apos;t exist. If you followed an asset link, the id may be
        malformed: asset ids are 64 hex characters.
      </p>
      <div className="flex gap-3">
        <Link href="/" className={ghostButton}>
          Landing
        </Link>
        <Link href="/console" className={ghostButton}>
          Console
        </Link>
      </div>
    </div>
  );
}
