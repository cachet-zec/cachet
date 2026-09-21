"use client";

import { useState } from "react";

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 whitespace-nowrap rounded-sm border border-white/10 px-2 py-0.5 text-[13px] text-neutral-400 transition hover:border-accent/50 hover:text-accent"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard unavailable (permissions/insecure context): ignore.
        }
      }}
    >
      {copied ? "Copied ✓" : (label ?? "Copy")}
    </button>
  );
}
