"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const STORAGE_KEY = "cachet-onboarding-dismissed";

/**
 * First-visit orientation strip. Dismissable; the choice is stored
 * locally and never leaves the browser.
 */
export function Onboarding() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      setVisible(localStorage.getItem(STORAGE_KEY) === null);
    } catch {
      // Storage unavailable (private mode): keep the strip hidden.
    }
  }, []);

  if (!visible) return null;

  return (
    <div className="relative flex flex-col gap-2.5 rounded-lg border border-[#e8b23a]/25 bg-[#e8b23a]/[0.04] py-3 pl-4 pr-10 sm:flex-row sm:items-center sm:gap-6">
      <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-neutral-300">
        <span className="font-data mr-2 text-[11px] uppercase tracking-[0.18em] text-[#e8b23a]">
          New here?
        </span>
        This console talks to a real ZSA chain. Mint something on the left: the name you pick gets
        hashed into the asset&apos;s id, so it can never be changed. Then find it in the registry,
        where anyone can check the math.
      </p>
      <Link
        href="/"
        className="font-data shrink-0 self-start text-[11px] text-neutral-400 underline decoration-white/20 transition hover:text-[#e8b23a] sm:self-auto"
      >
        how it works →
      </Link>
      <button
        type="button"
        aria-label="Dismiss"
        className="absolute right-3 top-3 text-neutral-600 transition hover:text-neutral-300"
        onClick={() => {
          setVisible(false);
          try {
            localStorage.setItem(STORAGE_KEY, "1");
          } catch {
            // Ignore: the strip just reappears next visit.
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}
