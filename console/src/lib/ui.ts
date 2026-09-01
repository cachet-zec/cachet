/**
 * Shared className recipes — the console's design language.
 *
 * Direction: an official ledger. Flat warm-black surfaces, hairline
 * borders, serif display type, monospace data, one gold accent used
 * sparingly. Depth comes from hairlines and a faint top-light on cards —
 * no glass, no glow, no gradient text.
 */

export const card =
  "rounded-lg border border-white/[0.08] bg-[#12100d] p-5 " +
  "[background-image:linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0)_45%)] " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_3px_rgba(0,0,0,0.35)]";

export const cardTitle =
  "font-data text-[11px] font-medium uppercase tracking-[0.22em] text-neutral-500";

export const label = "text-xs font-medium text-neutral-400";

// text-base on mobile: below 16px, iOS zooms the page on input focus.
export const input =
  "w-full rounded-md border border-white/10 bg-black/30 px-3.5 py-2.5 font-data text-base sm:text-sm " +
  "text-neutral-100 placeholder:text-neutral-600 outline-none transition " +
  "shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] " +
  "focus:border-[#e8b23a]/60 focus:ring-1 focus:ring-[#e8b23a]/30";

export const primaryButton =
  "rounded-md bg-[#e8b23a] px-5 py-2.5 text-sm font-semibold text-[#0b0a08] transition " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_1px_2px_rgba(0,0,0,0.45)] " +
  "hover:-translate-y-px hover:bg-[#f0c052] active:translate-y-px active:bg-[#d9a52e] " +
  "disabled:opacity-40 disabled:hover:translate-y-0";

export const ghostButton =
  "rounded-md border border-white/12 px-4 py-2 text-sm text-neutral-300 transition " +
  "hover:border-[#e8b23a]/60 hover:bg-white/[0.03] hover:text-[#e8b23a] " +
  "active:translate-y-px disabled:opacity-40";

export const dangerButton =
  "rounded-md border border-red-400/40 px-5 py-2.5 text-sm font-semibold text-red-300 " +
  "transition hover:bg-red-400/10 hover:border-red-400/70 active:translate-y-px " +
  "disabled:opacity-40";

export const mono = "break-all font-data text-xs text-neutral-500";

/**
 * A stamp for a fact the reader should weigh, not one that is wrong: gold
 * is the interface's attention colour, red is reserved for failures. An
 * asset whose issuer can still mint more is not defective - the holder
 * simply needs to see it.
 */
export const stampNotable =
  "rounded-sm border border-[#e8b23a]/40 px-1.5 py-0.5 font-data text-[10px] " +
  "uppercase tracking-[0.14em] text-[#e8b23a]/90";

/** Small stamped tag, e.g. FINALIZED. */
export const stamp =
  "rounded-sm border border-neutral-500/50 px-1.5 py-0.5 font-data text-[10px] " +
  "uppercase tracking-[0.14em] text-neutral-400";

/** The ledger's numbered left column: a ruled margin, like an account book. */
export const rowIndex =
  "font-data w-9 shrink-0 border-r border-white/[0.06] pr-2.5 text-right text-xs text-neutral-600";
